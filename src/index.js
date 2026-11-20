import {PhpRuntime, DOCROOT} from './php.js';
import {WikiState} from './state.js';
import {cgiEnv} from './cgi.js';
import {SessionStore} from './session.js';
import assets from './assets.js';

const DEFAULT_PAGE = 'FrontPage';
const MAX_ATTEMPTS = 3;
const RENDER_CACHE_ENTRIES = 200;
const RENDER_CACHE_MAX_BODY = 512 * 1024;
// pukiwiki.ini.php の $agents で keitai プロファイルになる UA の大まかな判定 (描画キャッシュのキー用)
const KEITAI_UA = /\b(?:Windows CE|NetFront|CNF|AveFront|AVE-Front|UP\.Browser|DoCoMo|J-PHONE|Vodafone|SoftBank|KDDI|DDIPOCKET|WILLCOM|PDXGW|ASTEL|L-mode)\b/i;

let ready = null;          // Promise<{php, state}>
let queue = Promise.resolve();
// GET の描画結果。キーに pack の etag を含むので、更新されれば自然に使われなくなる
const renderCache = new Map();

// PHP インスタンスは 1 つなので、isolate 内のリクエストは直列に処理する
function exclusive(fn) {
	const run = queue.then(fn, fn);
	queue = run.catch(() => {});
	return run;
}

function boot() {
	ready ??= PhpRuntime.create({
		...assets,
		onSignature: sig => console.error(`関数シグネチャ "${sig}" が事前生成されていません。scripts/harvest-signatures.mjs に該当する操作を追加してください`),
	}).then(php => ({php, state: new WikiState(php), sessions: new SessionStore(php)}));
	ready.catch(() => { ready = null; });
	return ready;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname !== '/' && url.pathname !== '/index.php') {
			// skin/ や image/ は Static Assets が先に返すので、ここに来るのはそれ以外
			return new Response('Not Found', {status: 404});
		}
		if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
			return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'GET, HEAD, POST'}});
		}
		const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
		const form = request.method === 'POST' ? await parseForm(request.headers.get('content-type'), body) : new URLSearchParams();

		const started = Date.now();
		const {php, state, sessions} = await boot();
		const response = await exclusive(() => handle({request, url, body, form, env, php, state, sessions}));
		response.headers.set('Server-Timing', `total;dur=${Date.now() - started}`);
		return response;
	},
};

async function handle({request, url, body, form, env, php, state, sessions}) {
	const bucket = env.WIKI;
	const isWrite = request.method === 'POST';
	const cookie = request.headers.get('cookie') ?? '';
	// ログイン中 (セッションあり) の表示は、他 isolate でのログアウト等を反映するためキャッシュしない
	const cacheable = !isWrite && !/(?:^|;\s*)PHPSESSID=/.test(cookie);
	const cacheKey = `${url.href}\n${cookie}\n${KEITAI_UA.test(request.headers.get('user-agent') ?? '') ? 'k' : 'd'}`;

	for (let attempt = 1; ; attempt++) {
		await state.refresh(bucket);

		const key = `${state.etag}\n${cacheKey}`;
		if (cacheable) {
			const hit = renderCache.get(key);
			if (hit) {
				renderCache.delete(key);
				renderCache.set(key, hit);
				return buildResponse(request, hit, 'cache');
			}
		}

		await Promise.all([
			state.ensure(bucket, lazyMatcher(url, form, isWrite, state)),
			sessions.load(bucket, cookie),
		]);

		const result = await php.run(cgiEnv(request, url, body, env), body);
		if (result.exitCode !== 0) console.error('php-cgi exit code', result.exitCode);
		await sessions.save(bucket);

		let changes;
		try {
			changes = state.diff();
			if (!isWrite && (changes.changed.length || changes.removed.length)) {
				console.log('GET で更新されたファイル', changes.changed, changes.removed);
			}
			const committed = await state.commit(bucket, changes);
			if (!committed) {
				// 他の isolate が先に更新していた。書き込みリクエストは最新の状態でやり直す
				// (PukiWiki 側の更新衝突チェックも最新の状態に対して働く)
				if (isWrite && attempt < MAX_ATTEMPTS) continue;
				console.warn('commit conflict; changes dropped', changes.changed, changes.removed);
			}
		} catch (e) {
			console.error('commit failed', e);
			state.etag = null;
			return new Response('Failed to save data', {status: 500});
		}

		const entry = {status: result.status, headers: [...result.headers], body: result.body};
		if (cacheable && !changes.changed.length && !changes.removed.length && result.status === 200
			&& !result.headers.has('set-cookie') && result.body.byteLength <= RENDER_CACHE_MAX_BODY) {
			renderCache.set(key, entry);
			if (renderCache.size > RENDER_CACHE_ENTRIES) renderCache.delete(renderCache.keys().next().value);
		}
		return buildResponse(request, entry, 'php');
	}
}

function buildResponse(request, entry, source) {
	const headers = new Headers(entry.headers);
	headers.set('X-Wiki-Render', source);
	if (!headers.has('content-type')) headers.set('Content-Type', 'text/html; charset=UTF-8');
	return new Response(request.method === 'HEAD' ? null : entry.body, {status: entry.status, headers});
}

async function parseForm(contentType, body) {
	const params = new URLSearchParams();
	if (!contentType || !body.byteLength) return params;
	try {
		if (contentType.startsWith('application/x-www-form-urlencoded')) {
			return new URLSearchParams(new TextDecoder().decode(body));
		}
		if (contentType.startsWith('multipart/form-data')) {
			const data = await new Request('http://localhost/', {method: 'POST', headers: {'content-type': contentType}, body}).formData();
			for (const [name, value] of data) if (typeof value === 'string') params.append(name, value);
		}
	} catch {
		// 解析できなければ先読みしないだけ
	}
	return params;
}

// PukiWiki のファイル名エンコード (strtoupper(bin2hex($page)))
const encodePage = page => [...new TextEncoder().encode(page)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

/** このリクエストで中身が必要になりそうな遅延ファイル (添付・バックアップ) を選ぶ */
function lazyMatcher(url, form, isWrite, state) {
	const param = name => form.get(name) ?? url.searchParams.get(name);
	const cmd = param('cmd');
	const plugin = param('plugin');
	const pcmd = param('pcmd');

	if (plugin === 'rename' && isWrite) return () => true;
	if (plugin === 'attach' && pcmd === 'list' && !param('refer')) return p => p.startsWith('attach/');

	const pages = new Set();
	for (const name of ['page', 'refer']) {
		const value = param(name);
		if (value) pages.add(value);
	}
	const query = url.search.slice(1);
	if (query && !query.includes('=')) pages.add(decodeURIComponent(query.replace(/\+/g, ' ')));
	if (!query && !isWrite) pages.add(DEFAULT_PAGE);

	// 表示するページから &ref(他のページ/ファイル); で参照されている添付も読み込む
	for (const page of [...pages]) {
		let source;
		try {
			source = state.FS.readFile(`${DOCROOT}/wiki/${encodePage(page)}.txt`, {encoding: 'utf8'});
		} catch {
			continue;
		}
		for (const m of source.matchAll(/ref\(([^,)]+)/g)) {
			const slash = m[1].lastIndexOf('/');
			if (slash > 0 && !m[1].includes('://')) pages.add(m[1].slice(0, slash).replace(/^\[\[|\]\]$/g, ''));
		}
	}

	const prefixes = [];
	const needBackup = isWrite || cmd === 'backup' || cmd === 'diff';
	for (const page of pages) {
		const hex = encodePage(page);
		prefixes.push(`attach/${hex}_`);
		if (needBackup) prefixes.push(`backup/${hex}.`);
	}
	return p => prefixes.some(prefix => p.startsWith(prefix));
}
