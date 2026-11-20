// build/ を生成する
//   build/php/      php-cgi-wasm の glue (パッチ済み) と wasm / 共有ライブラリ
//   build/app.bin   PukiWiki のコード (PHP, 設定, スキン等)
//   build/seed.bin  初期データ (R2 が空のときに使う wiki/ 等)
//   build/public/   静的配信するファイル (Workers Static Assets)
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeArchive} from '../src/archive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const wikiSrc = path.join(root, 'pukiwiki');
const PHP_VERSION = '8.5';

// src/state.js の DATA_DIRS と揃えること
const DATA_DIRS = ['wiki', 'backup', 'diff', 'cache', 'counter', 'attach'];
const STATIC_EXT = new Set(['.css', '.js', '.png', '.gif', '.jpg', '.jpeg', '.ico', '.svg', '.webp']);
const IGNORE = new Set(['.htaccess', 'index.html', '.gitkeep']);

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(path.join(out, 'php'), {recursive: true});

// --- php-cgi-wasm -------------------------------------------------------
const cgiDir = path.join(root, 'node_modules', 'php-cgi-wasm');
let glue = fs.readFileSync(path.join(cgiDir, `php${PHP_VERSION}-cgi-worker.mjs`), 'utf8');
const wasmName = glue.match(/new URL\("([0-9a-f]{40}\.wasm)"/)[1];

// Workers では実行時の wasm コンパイルが禁止されているため、dlopen される共有ライブラリは
// wrangler でコンパイル済みの WebAssembly.Module を Module.wasmModules から渡す
const hook = 'function getExports(){var preloaded=preloadedWasm[libName];';
if (!glue.includes(hook)) throw new Error('php-cgi-wasm の glue が想定と異なります (getExports)');
glue = glue.replace(hook,
	'function getExports(){var __pm=Module["wasmModules"]&&Module["wasmModules"][PATH.basename(libName)];'
	+ 'if(__pm){return loadWebAssemblyModule(__pm,flags,libName,localScope,handle)}'
	+ 'var preloaded=preloadedWasm[libName];');
// addFunction で JS 関数を関数テーブルに入れる際、シグネチャごとの小さな wasm を実行時に生成している。
// ビルド時に使われるシグネチャを収集して事前に生成し、Module.sigModules から渡す
const sigHook = 'var module=new WebAssembly.Module(bytes);var instance=new WebAssembly.Instance(module,{e:{f:func}})';
if (!glue.includes(sigHook)) throw new Error('php-cgi-wasm の glue が想定と異なります (convertJsFunctionToWasm)');
glue = glue.replace(sigHook,
	'var module=Module["sigModules"]&&Module["sigModules"][sig];'
	+ 'if(!module){if(Module["onSignature"])Module["onSignature"](sig,bytes);module=new WebAssembly.Module(bytes)}'
	+ 'var instance=new WebAssembly.Instance(module,{e:{f:func}})');
fs.writeFileSync(path.join(out, 'php', 'php-cgi.mjs'), glue);
fs.copyFileSync(path.join(cgiDir, wasmName), path.join(out, 'php', 'php-cgi.wasm'));

const mbDir = path.join(root, 'node_modules', 'php-wasm-mbstring');
fs.copyFileSync(path.join(mbDir, `php${PHP_VERSION}-mbstring.so`), path.join(out, 'php', 'mbstring.so'));
fs.copyFileSync(path.join(mbDir, 'libonig.so'), path.join(out, 'php', 'libonig.so'));

// --- PukiWiki -------------------------------------------------------------
const app = [];
const seed = [];

function walk(dir) {
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
			continue;
		}
		if (IGNORE.has(entry.name)) continue;
		const rel = path.relative(wikiSrc, full).split(path.sep).join('/');
		const file = {p: rel, t: Math.floor(fs.statSync(full).mtimeMs), data: fs.readFileSync(full)};
		const top = rel.split('/')[0];
		if (DATA_DIRS.includes(top)) {
			seed.push(file);
		} else {
			app.push(file);
		}
		if (STATIC_EXT.has(path.extname(entry.name).toLowerCase()) && !DATA_DIRS.includes(top)) {
			const dest = path.join(out, 'public', rel);
			fs.mkdirSync(path.dirname(dest), {recursive: true});
			fs.copyFileSync(full, dest);
		}
	}
}
walk(wikiSrc);

// 初期ページの更新日時はデプロイ時刻にそろえる
const now = Date.now();
for (const f of seed) f.t = now;

fs.writeFileSync(path.join(out, 'app.bin'), encodeArchive(app));
fs.writeFileSync(path.join(out, 'seed.bin'), encodeArchive(seed));

const size = p => (fs.statSync(path.join(out, p)).size / 1024 / 1024).toFixed(2) + ' MiB';
console.log(`php ${PHP_VERSION}: ${size('php/php-cgi.wasm')} (glue ${size('php/php-cgi.mjs')})`);
console.log(`app.bin: ${app.length} files, ${size('app.bin')}`);
console.log(`seed.bin: ${seed.length} files, ${size('seed.bin')}`);
