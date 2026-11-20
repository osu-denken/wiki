// php-cgi (WebAssembly) を Workers 上で動かすラッパー
// isolate ごとに 1 インスタンスを作って使い回す (OPcache もインスタンス内で効く)
// wasm 等のアセットは呼び出し側 (Workers: src/assets.js, ビルド時: scripts/harvest-signatures.mjs) が渡す
import {decodeArchive} from './archive.js';

export const DOCROOT = '/app';
export const OPCACHE_DIR = '/opcache';

const PHP_INI = `
extension_dir=/preload
extension=mbstring.so
extension=zlib.so
date.timezone=Asia/Tokyo
memory_limit=96M
max_execution_time=0
display_errors=0
log_errors=1
error_reporting=E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING
output_buffering=0
upload_max_filesize=2M
post_max_size=4M
upload_tmp_dir=/tmp
session.save_path=/sessions
session.gc_probability=0
session.gc_maxlifetime=86400
session.use_strict_mode=1
session.cookie_httponly=1
session.cookie_samesite=Lax
opcache.enable=1
opcache.enable_cli=1
opcache.validate_timestamps=0
opcache.memory_consumption=32
opcache.interned_strings_buffer=4
opcache.max_accelerated_files=2000
opcache.jit=disable
opcache.file_cache=/opcache
opcache.file_cache_only=1
opcache.file_cache_consistency_checks=0
opcache.file_update_protection=0
`;

class ByteSink {
	constructor() { this.buf = new Uint8Array(64 * 1024); this.length = 0; }
	push(byte) {
		if (this.length === this.buf.length) {
			const next = new Uint8Array(this.buf.length * 2);
			next.set(this.buf);
			this.buf = next;
		}
		this.buf[this.length++] = byte & 0xff;
	}
	pushBytes(bytes) {
		if (this.length + bytes.length > this.buf.length) {
			const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + bytes.length));
			next.set(this.buf.subarray(0, this.length));
			this.buf = next;
		}
		this.buf.set(bytes, this.length);
		this.length += bytes.length;
	}
	bytes() { return this.buf.subarray(0, this.length); }
}

export class PhpRuntime {
	/**
	 * @param {object} assets
	 * @param {Function} assets.PHP php-cgi の Emscripten モジュールファクトリ
	 * @param {WebAssembly.Module} assets.phpWasm
	 * @param {Record<string, WebAssembly.Module>} assets.sharedLibs dlopen されるライブラリ
	 * @param {Record<string, WebAssembly.Module>} assets.sigModules 事前生成した関数ラッパー
	 * @param {ArrayBuffer|Uint8Array} assets.appBin
	 * @param {ArrayBuffer|Uint8Array} [assets.opcacheBin] ビルド時に生成した OPcache のファイルキャッシュ
	 * @param {Function} [assets.onSignature] 未生成のシグネチャが使われたときに呼ばれる
	 */
	static async create({PHP, phpWasm, sharedLibs, sigModules, appBin, opcacheBin, onSignature}) {
		const self = new PhpRuntime();
		self.module = await PHP({
			instantiateWasm(imports, receive) {
				WebAssembly.instantiate(phpWasm, imports).then(instance => receive(instance, phpWasm));
				return {};
			},
			wasmModules: sharedLibs,
			sigModules,
			onSignature,
			locateFile: p => p,
			stdin: () => self.stdinPos < self.stdin.length ? self.stdin[self.stdinPos++] : null,
			stdout: b => self.out.push(b),
			stderr: b => self.err.push(b),
			print: () => {},
			printErr: line => console.error('[php]', line),
		});
		const FS = self.module.FS;
		// 標準出力・標準エラーは既定だと 1 バイトごとに stdout/stderr コールバックを呼ぶので、バッファごとに受け取る
		for (const [fd, sink] of [[1, () => self.out], [2, () => self.err]]) {
			const stream = FS.getStream(fd);
			stream.stream_ops = {
				...stream.stream_ops,
				write(_stream, buffer, offset, length) {
					sink().pushBytes(buffer.subarray(offset, offset + length));
					return length;
				},
			};
		}
		FS.mkdirTree('/preload');
		FS.mkdirTree('/tmp');
		FS.mkdirTree(OPCACHE_DIR);
		FS.mkdirTree('/sessions');
		// dlopen 前のファイル存在チェック用。中身は Module.wasmModules から渡る
		for (const name of Object.keys(sharedLibs)) FS.writeFile(`/preload/${name}`, new Uint8Array(0));
		FS.writeFile('/php.ini', PHP_INI);

		const extract = (archive, dir) => {
			for (const f of decodeArchive(archive)) {
				const p = `${dir}/${f.p}`;
				FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
				FS.writeFile(p, f.data);
			}
		};
		extract(appBin, DOCROOT);
		if (opcacheBin) extract(opcacheBin, OPCACHE_DIR);

		self.putenv('PHPRC', '/php.ini');
		self.putenv('PHP_INI_SCAN_DIR', '');
		await self.module.ccall('wasm_sapi_cgi_init', 'number', [], [], {async: true});
		return self;
	}

	constructor() {
		this.stdin = new Uint8Array(0);
		this.stdinPos = 0;
		this.out = new ByteSink();
		this.err = new ByteSink();
		this.envNames = new Set();
		this.requests = 0;
	}

	get FS() { return this.module.FS; }

	/** ディレクトリ以下のファイルを {p: 相対パス, t, data} の配列で返す */
	listFiles(dir, rel = '') {
		const files = [];
		for (const name of this.FS.readdir(dir)) {
			if (name === '.' || name === '..') continue;
			const full = `${dir}/${name}`;
			const st = this.FS.stat(full);
			if (this.FS.isDir(st.mode)) {
				files.push(...this.listFiles(full, `${rel}${name}/`));
			} else {
				files.push({p: rel + name, t: st.mtime.getTime(), data: this.FS.readFile(full)});
			}
		}
		return files;
	}

	putenv(name, value) {
		this.module.ccall('wasm_sapi_cgi_putenv', 'number', ['string', 'string'], [name, String(value)]);
	}

	/**
	 * CGI リクエストを 1 件実行する
	 * @param {Record<string, string>} env CGI 環境変数
	 * @param {Uint8Array} body リクエストボディ
	 */
	async run(env, body) {
		// 前回のリクエストで設定した変数を消す
		for (const name of this.envNames) {
			if (!(name in env)) this.putenv(name, '');
		}
		this.envNames = new Set(Object.keys(env));
		for (const [name, value] of Object.entries(env)) this.putenv(name, value);

		this.stdin = body;
		this.stdinPos = 0;
		this.out = new ByteSink();
		this.err = new ByteSink();

		const exitCode = Number(await this.module.ccall('wasm_sapi_cgi_main', 'number', ['number', 'number'], [0, 0], {async: true}));
		this.requests++;

		if (this.err.length) console.error('[php stderr]', new TextDecoder().decode(this.err.bytes()));
		return {exitCode, ...parseCgiOutput(this.out.bytes())};
	}
}

function parseCgiOutput(bytes) {
	let end = -1, sep = 0;
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] === 10 && bytes[i + 1] === 10) { end = i; sep = 2; break; }
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) { end = i; sep = 4; break; }
	}
	const headers = new Headers();
	let status = 200;
	if (end < 0) return {status, headers, body: bytes.slice()};

	for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'status') {
			status = parseInt(value, 10) || 200;
		} else {
			headers.append(name, value);
		}
	}
	if (headers.has('location') && status === 200) status = 302;
	return {status, headers, body: bytes.slice(end + sep)};
}
