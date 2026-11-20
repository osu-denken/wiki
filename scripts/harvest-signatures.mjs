// Node 上で PukiWiki に代表的なリクエストを流し、addFunction が使う関数シグネチャを収集して
// build/php/sig-*.wasm と build/php/signatures.js を生成する (Workers では実行時に wasm を生成できないため)。
// あわせて各リクエストのステータスを表示するので、簡単な動作確認にもなる。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {PhpRuntime, DOCROOT, OPCACHE_DIR} from '../src/php.js';
import {decodeArchive, encodeArchive} from '../src/archive.js';
import {cgiEnv} from '../src/cgi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpDir = path.join(root, 'build', 'php');
const read = p => fs.readFileSync(path.join(root, 'build', p));

const signatures = new Map();
const php = await PhpRuntime.create({
	PHP: (await import(pathToFileURL(path.join(phpDir, 'php-cgi.mjs')).href)).default,
	phpWasm: await WebAssembly.compile(read('php/php-cgi.wasm')),
	sharedLibs: {
		'mbstring.so': await WebAssembly.compile(read('php/mbstring.so')),
		'libonig.so': await WebAssembly.compile(read('php/libonig.so')),
	},
	sigModules: {},
	appBin: read('app.bin'),
	onSignature: (sig, bytes) => signatures.set(sig, bytes),
});

for (const f of decodeArchive(read('seed.bin'))) {
	const full = `${DOCROOT}/${f.p}`;
	php.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
	php.FS.writeFile(full, f.data);
}
for (const dir of ['backup', 'diff', 'cache', 'counter', 'attach']) php.FS.mkdirTree(`${DOCROOT}/${dir}`);

const cookies = new Map();

async function request(method, target, form) {
	const url = new URL(target, 'https://wiki.example.com/');
	const headers = new Headers({'user-agent': 'Mozilla/5.0 harvest'});
	if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
	let body = new Uint8Array(0);
	if (form instanceof URLSearchParams) {
		headers.set('content-type', 'application/x-www-form-urlencoded');
		body = new TextEncoder().encode(form.toString());
	} else if (form instanceof FormData) {
		const req = new Request(url, {method, body: form});
		headers.set('content-type', req.headers.get('content-type'));
		body = new Uint8Array(await req.arrayBuffer());
	}
	const started = performance.now();
	const res = await php.run(cgiEnv(new Request(url, {method, headers, body: method === 'POST' ? body : undefined}), url, body, {PUKIWIKI_ADMINPASS: 'harvest-pass'}), body);
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const eq = pair.indexOf('=');
		cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
	const text = new TextDecoder().decode(res.body);
	const title = text.match(/<title>([^<]*)/)?.[1] ?? '';
	console.log(`${res.status} ${(performance.now() - started).toFixed(1).padStart(7)}ms ${method} ${target} ${title}`);
	if (res.status >= 500 || /Fatal error|Runtime error/.test(text)) {
		console.log(text.slice(0, 2000));
		process.exitCode = 1;
	}
	return text;
}

const hidden = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? '';

await request('GET', '/');
await request('GET', '/');
// pukiwiki.ini.php で edit_auth が有効なので、編集系の前にログインする
await request('POST', '/?plugin=loginform', new URLSearchParams({plugin: 'loginform', page: 'Test', username: 'admin', password: 'harvest-pass'}));
if (!cookies.has('PHPSESSID')) {
	console.log('login failed');
	process.exitCode = 1;
}
await request('GET', '/?cmd=list');
await request('GET', '/?RecentChanges');
await request('GET', '/?cmd=search&word=PukiWiki');
const edit = await request('GET', '/?cmd=edit&page=Test');
await request('POST', '/', new URLSearchParams({
	cmd: 'edit', page: 'Test', digest: hidden(edit, 'digest'), write: '1',
	msg: '* 電研ウィキ\n動作確認 &ref(Test/test.png);\n#comment\n',
	original: '',
}));
await request('GET', '/?Test');
await request('POST', '/', new URLSearchParams({
	plugin: 'comment', refer: 'Test', comment_no: '0', nodate: '0', name: 'test', msg: 'こんにちは', digest: '',
}));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upload = new FormData();
upload.append('plugin', 'attach');
upload.append('pcmd', 'post');
upload.append('refer', 'Test');
upload.append('max_file_size', '1048576');
upload.append('pass', 'harvest-pass');
upload.append('attach_file', new Blob([png], {type: 'image/png'}), 'test.png');
await request('POST', '/', upload);
await request('GET', '/?Test');
await request('GET', '/?plugin=attach&pcmd=list&refer=Test');
await request('GET', '/?plugin=attach&pcmd=info&refer=Test&file=test.png');
await request('GET', '/?plugin=ref&page=Test&src=test.png');
await request('GET', '/?cmd=backup&page=Test');
await request('GET', '/?cmd=diff&page=Test');
await request('GET', '/?cmd=rss');
await request('GET', '/?cmd=md5');
await request('GET', '/?plugin=newpage');
await request('GET', '/?cmd=freeze&page=FrontPage');
await request('POST', '/', new URLSearchParams({cmd: 'freeze', page: 'FrontPage', pass: 'wrong'}));
await request('GET', '/?plugin=rename&refer=FrontPage');
await request('GET', '/?cmd=unknownplugin');
await request('GET', '/?' + encodeURIComponent('存在しないページ'));

console.log(`requests: ${php.requests}, signatures: ${[...signatures.keys()].join(' ') || '(none)'}`);

// 全 PHP ファイルをコンパイルして OPcache のファイルキャッシュを build/opcache.bin に保存する
// (同じ wasm / php.ini / パスなら Workers でもそのまま使えるので、cold start でもコンパイルを省ける)
const compiler = `${DOCROOT}/__opcache_compile.php`;
php.FS.writeFile(compiler, `<?php
$n = 0;
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator('${DOCROOT}', FilesystemIterator::SKIP_DOTS)) as $f) {
	if ($f->getExtension() === 'php' && $f->getPathname() !== __FILE__ && $f->getFilename() !== 'mbstring.php' && opcache_compile_file($f->getPathname())) $n++;
}
echo $n;
`);
const compiled = await php.run({
	REQUEST_METHOD: 'GET', REDIRECT_STATUS: '200', SCRIPT_FILENAME: compiler, SCRIPT_NAME: '/__opcache_compile.php',
	REQUEST_URI: '/__opcache_compile.php', QUERY_STRING: '', SERVER_NAME: 'localhost', SERVER_PORT: '80',
}, new Uint8Array(0));
const opcache = php.listFiles(OPCACHE_DIR).filter(f => !f.p.includes('__opcache_compile'));
fs.writeFileSync(path.join(root, 'build', 'opcache.bin'), encodeArchive(opcache));
console.log(`opcache: ${new TextDecoder().decode(compiled.body)} scripts compiled, ${opcache.length} cache files, ${(opcache.reduce((n, f) => n + f.data.byteLength, 0) / 1024 / 1024).toFixed(2)} MiB`);

const lines = ['// scripts/harvest-signatures.mjs が生成'];
const entries = [];
[...signatures.entries()].forEach(([sig, bytes], i) => {
	fs.writeFileSync(path.join(phpDir, `sig-${i}.wasm`), bytes);
	lines.push(`import s${i} from './sig-${i}.wasm';`);
	entries.push(`\t${JSON.stringify(sig)}: s${i},`);
});
lines.push(`export default {\n${entries.join('\n')}\n};\n`);
fs.writeFileSync(path.join(phpDir, 'signatures.js'), lines.join('\n'));
