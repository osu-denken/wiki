import {PhpRuntime, DOCROOT} from './php.js';
import {WikiState, MANIFEST_KEY, REFRESH_INTERVAL} from './state.js';
import {cgiEnv} from './cgi.js';
import {SessionStore} from './session.js';
import assets from './assets.js';
import seedBin from '../build/seed.bin';
import {decodeArchive} from './archive.js';

const DEFAULT_PAGE = 'FrontPage';
const MAX_ATTEMPTS = 3;
const RENDER_CACHE_ENTRIES = 200;
const RENDER_CACHE_MAX_BODY = 512 * 1024;
const EDGE_CACHE_TTL = 7 * 24 * 3600;
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
	}).then(async php => {
		await warmUp(php);
		return {php, state: new WikiState(php), sessions: new SessionStore(php)};
	});
	ready.catch(() => { ready = null; });
	return ready;
}

// 初期データでページを 1 回描画して、wasm の遅延コンパイルと OPcache の読み込みを済ませておく。
// 書き込んだデータは最初の refresh で R2 の内容に置き換わる
async function warmUp(php) {
	for (const f of decodeArchive(seedBin)) {
		const p = `${DOCROOT}/${f.p}`;
		php.FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
		php.FS.writeFile(p, f.data);
	}
	// よく使われる処理 (ページ表示・一覧・検索・最終更新・編集画面) を一通り通す
	for (const query of ['', 'FormattingRules', 'cmd=list', 'cmd=search&word=Wiki', 'RecentChanges', 'cmd=edit&page=SandBox']) {
		await php.run({
			REQUEST_METHOD: 'GET', REDIRECT_STATUS: '200', DOCUMENT_ROOT: DOCROOT,
			SCRIPT_FILENAME: `${DOCROOT}/index.php`, SCRIPT_NAME: '/index.php',
			REQUEST_URI: query ? `/?${query}` : '/', QUERY_STRING: query,
			SERVER_NAME: 'localhost', SERVER_PORT: '443', HTTPS: 'on',
		}, new Uint8Array(0));
	}
}

// isolate の起動時 (グローバルスコープ) に PHP を立ち上げておく。
// 起動時の CPU 時間はリクエストの CPU 制限 (Free プランは 10ms) とは別枠
await boot().catch(e => console.error('PHP の起動に失敗しました', e));

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname !== '/' && url.pathname !== '/index.php') {
			// skin/ や image/ は Static Assets が先に返すので、ここに来るのはそれ以外
			return new Response('Not Found', {status: 404});
		}
		if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
			return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'GET, HEAD, POST'}});
		}
		const started = Date.now();
		const isWrite = request.method === 'POST';
		const cookie = request.headers.get('cookie') ?? '';
		// ログイン中 (セッションあり) の表示は、他 isolate でのログアウト等を反映するためキャッシュしない
		const cacheable = !isWrite && !/(?:^|;\s*)PHPSESSID=/.test(cookie);
		const cacheKey = `${url.href}\n${cookie}\n${KEITAI_UA.test(request.headers.get('user-agent') ?? '') ? 'k' : 'd'}`;

		// 未ログインの閲覧は、PHP を起動する前にデータセンター共有のキャッシュを見る
		if (cacheable) {
			const etag = await currentEtag(env.WIKI);
			const hit = etag && await edgeGet(url, `${etag}\n${cacheKey}`);
			if (hit) return withTiming(buildResponse(request, hit, 'edge'), started);
		}

		const body = isWrite ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
		const form = isWrite ? await parseForm(request.headers.get('content-type'), body) : new URLSearchParams();

		const {php, state, sessions} = await boot();
		const response = await exclusive(() => handle({request, url, body, form, env, ctx, php, state, sessions, isWrite, cookie, cacheable, cacheKey}));
		return withTiming(response, started);
	},
};

function withTiming(response, started) {
	response.headers.set('Server-Timing', `total;dur=${Date.now() - started}`);
	return response;
}

// manifest の etag (データの版)。PHP を起動していない isolate でも共有キャッシュを使えるように別に持つ
let knownEtag = null;
let etagCheckedAt = 0;

async function currentEtag(bucket) {
	if (Date.now() - etagCheckedAt < REFRESH_INTERVAL) return knownEtag;
	const head = await bucket.head(MANIFEST_KEY);
	rememberEtag(head?.etag ?? null);
	return knownEtag;
}

function rememberEtag(etag) {
	knownEtag = etag;
	etagCheckedAt = Date.now();
}

// 共有キャッシュ (Cache API)。キーに manifest の etag を含めるので、更新されれば使われなくなる
async function edgeRequest(url, key) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
	const hex = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
	return new Request(`${url.origin}/__render-cache/${hex}`);
}

async function edgeGet(url, key) {
	const res = await caches.default.match(await edgeRequest(url, key));
	if (!res) return null;
	const headers = new Headers(res.headers);
	headers.delete('cache-control');
	const original = res.headers.get('x-original-cache-control');
	if (original) headers.set('Cache-Control', original);
	headers.delete('x-original-cache-control');
	return {status: res.status, headers: [...headers], body: new Uint8Array(await res.arrayBuffer())};
}

async function edgePut(url, key, entry) {
	const headers = new Headers(entry.headers);
	if (headers.has('cache-control')) headers.set('X-Original-Cache-Control', headers.get('cache-control'));
	headers.set('Cache-Control', `public, max-age=${EDGE_CACHE_TTL}`);
	await caches.default.put(await edgeRequest(url, key), new Response(entry.body, {status: entry.status, headers}));
}

async function handle({request, url, body, form, env, ctx, php, state, sessions, isWrite, cookie, cacheable, cacheKey}) {
	const bucket = env.WIKI;

	for (let attempt = 1; ; attempt++) {
		await state.refresh(bucket, isWrite);

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
			if (state.hasManifest) ctx.waitUntil(edgePut(url, key, entry).catch(e => console.warn('edge cache put failed', e)));
		}
		if (state.hasManifest) rememberEtag(state.etag);
		if (isWrite && (changes.changed.length || changes.removed.length) && state.hasManifest) {
			// 更新後に最初に見る人のために、よく見られるページを先に描画してキャッシュしておく
			const targets = [new URL('/', url), new URL('/?RecentChanges', url)];
			const location = result.headers.get('location');
			if (location) targets.push(new URL(location, url));
			ctx.waitUntil(exclusive(() => prerender({targets, env, php, state})).catch(e => console.warn('prerender failed', e)));
		}
		return buildResponse(request, entry, 'php');
	}
}

async function prerender({targets, env, php, state}) {
	const bucket = env.WIKI;
	const seen = new Set();
	for (const target of targets) {
		if (target.pathname !== '/' || seen.has(target.href)) continue;
		seen.add(target.href);
		await state.refresh(bucket);
		const key = `${state.etag}\n${target.href}\n\nd`; // 未ログイン (Cookie なし)・通常の UA 向け
		if (renderCache.has(key)) continue;

		const request = new Request(target, {headers: {'user-agent': 'Mozilla/5.0 (prerender)'}});
		await state.ensure(bucket, lazyMatcher(target, new URLSearchParams(), false, state));
		const result = await php.run(cgiEnv(request, target, new Uint8Array(0), env), new Uint8Array(0));
		const changes = state.diff();
		if (changes.changed.length || changes.removed.length) {
			// キャッシュの再生成などで書き込みがあった場合は保存だけして、描画結果は使わない
			await state.commit(bucket, changes);
			continue;
		}
		if (result.status !== 200 || result.headers.has('set-cookie') || result.body.byteLength > RENDER_CACHE_MAX_BODY) continue;
		const entry = {status: result.status, headers: [...result.headers], body: result.body};
		renderCache.set(key, entry);
		await edgePut(target, key, entry);
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

	if (plugin === 'rename' && isWrite) return () => true;

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
