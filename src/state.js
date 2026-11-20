// PukiWiki のデータディレクトリと R2 の同期
//
// R2 のレイアウト
//   pack.bin.gz      小さなファイル (wiki/ diff/ cache/ counter/ attach/*.log) をまとめたアーカイブ。
//                    .lazy.json に下記の遅延ファイルの一覧 (パス, mtime, サイズ) を含む。書き込みのコミット点。
//   files/<path>     遅延ファイル (attach/ の添付本体, backup/) を 1 ファイル 1 オブジェクトで保存
//
// isolate 内では MEMFS に展開した状態を保持し、リクエストごとに pack の etag だけ確認する。
// 遅延ファイルは空のプレースホルダを置いておき、リクエストに必要なものだけ R2 から読み込む。
import seedBin from '../build/seed.bin';
import {decodeArchive, encodeArchive, gzip, gunzip} from './archive.js';
import {DOCROOT} from './php.js';

export const DATA_DIRS = ['wiki', 'backup', 'diff', 'cache', 'counter', 'attach'];
const PACK_KEY = 'pack.bin.gz';
const LAZY_INDEX = '.lazy.json';
const FETCH_CONCURRENCY = 20;

export const isLazy = p => p.startsWith('backup/') || (p.startsWith('attach/') && !p.endsWith('.log'));

export class WikiState {
	constructor(php) {
		this.php = php;
		this.etag = null;          // FS に展開済みの pack の etag (R2 に無いときは 'seed')
		this.known = new Map();    // 最後に同期した時点の {path: {t, l}}
		this.loaded = new Set();   // 中身を読み込み済みの遅延ファイル
	}

	get FS() { return this.php.FS; }

	/** R2 の最新状態を FS に反映する。変化がなければ何もしない */
	async refresh(bucket) {
		const obj = this.etag && this.etag !== 'seed'
			? await bucket.get(PACK_KEY, {onlyIf: {etagDoesNotMatch: this.etag}})
			: await bucket.get(PACK_KEY);

		if (!obj) {
			if (this.etag !== 'seed') this.load(decodeArchive(seedBin), [], 'seed');
			return;
		}
		if (!('body' in obj) || obj.etag === this.etag) return;

		const files = decodeArchive(await gunzip(new Uint8Array(await obj.arrayBuffer())));
		const indexEntry = files.find(f => f.p === LAZY_INDEX);
		const lazy = indexEntry ? JSON.parse(new TextDecoder().decode(indexEntry.data)) : [];
		this.load(files.filter(f => f !== indexEntry), lazy, obj.etag);
	}

	load(files, lazy, etag) {
		const FS = this.FS;
		for (const dir of DATA_DIRS) {
			rmTree(FS, `${DOCROOT}/${dir}`);
			FS.mkdirTree(`${DOCROOT}/${dir}`);
		}
		this.known = new Map();
		this.loaded = new Set();
		for (const f of files) {
			this.write(f.p, f.data, f.t);
			if (isLazy(f.p)) this.loaded.add(f.p); // seed に遅延対象が含まれていた場合
		}
		for (const e of lazy) this.write(e.p, new Uint8Array(0), e.t, e.l);
		this.etag = etag;
	}

	write(p, data, t, size = data.byteLength) {
		const full = `${DOCROOT}/${p}`;
		this.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
		this.FS.writeFile(full, data);
		this.FS.utime(full, t, t);
		this.known.set(p, {t, l: size, mt: this.mtimeOf(full)});
	}

	mtimeOf(full) {
		return this.FS.stat(full).mtime.getTime();
	}

	/** 遅延ファイルのうち、条件に合うものを R2 から読み込む */
	async ensure(bucket, match) {
		const targets = [...this.known.keys()].filter(p => isLazy(p) && !this.loaded.has(p) && match(p));
		for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
			await Promise.all(targets.slice(i, i + FETCH_CONCURRENCY).map(async p => {
				const obj = await bucket.get(`files/${p}`);
				if (!obj) return;
				const {t} = this.known.get(p);
				this.write(p, new Uint8Array(await obj.arrayBuffer()), t);
				this.loaded.add(p);
			}));
		}
	}

	/** 前回同期時からの変更を調べる */
	diff() {
		const current = new Map();
		for (const dir of DATA_DIRS) listFiles(this.FS, `${DOCROOT}/${dir}`, dir, current);

		const changed = [];
		const removed = [];
		for (const [p, st] of current) {
			const prev = this.known.get(p);
			if (!prev) {
				changed.push(p);
			} else if (prev.mt !== st.mt || (this.loaded.has(p) || !isLazy(p)) && prev.l !== st.l) {
				// 未読み込みの遅延ファイル (プレースホルダ) はサイズが 0 なので mtime だけで判定
				changed.push(p);
			}
		}
		for (const p of this.known.keys()) if (!current.has(p)) removed.push(p);
		return {current, changed, removed};
	}

	/**
	 * 変更を R2 に書き込む
	 * @returns {Promise<boolean>} false: 他の isolate が先に書き込んでいた (競合)
	 */
	async commit(bucket, {current, changed, removed}) {
		if (!changed.length && !removed.length) return true;

		for (const p of changed) {
			if (isLazy(p) && !this.loaded.has(p) && this.known.has(p)) {
				// 中身を読み込まずに書き換えられた遅延ファイル。データを失うので書き込まない
				throw new Error(`lazy file modified without being loaded: ${p}`);
			}
		}

		await Promise.all(changed.filter(isLazy).map(p =>
			bucket.put(`files/${p}`, this.FS.readFile(`${DOCROOT}/${p}`))));

		// 未読み込みのプレースホルダは FS 上のサイズが 0 なので、記録済みのサイズを使う
		const sizeOf = (p, st) => isLazy(p) && !this.loaded.has(p) && !changed.includes(p) && this.known.has(p)
			? this.known.get(p).l
			: st.l;

		const files = [];
		const lazy = [];
		for (const [p, st] of current) {
			if (isLazy(p)) {
				lazy.push({p, t: st.mt, l: sizeOf(p, st)});
			} else {
				files.push({p, t: st.mt, data: this.FS.readFile(`${DOCROOT}/${p}`)});
			}
		}
		files.push({p: LAZY_INDEX, t: Date.now(), data: new TextEncoder().encode(JSON.stringify(lazy))});

		const body = await gzip(encodeArchive(files));
		const options = {httpMetadata: {contentType: 'application/gzip'}};
		if (this.etag !== 'seed') options.onlyIf = {etagMatches: this.etag};
		const result = await bucket.put(PACK_KEY, body, options);
		if (!result) {
			this.etag = null; // 次回 refresh で読み直す
			return false;
		}

		// pack のコミット後に、消えた遅延ファイルを削除
		const removedLazy = removed.filter(isLazy);
		if (removedLazy.length) await bucket.delete(removedLazy.map(p => `files/${p}`));

		this.etag = result.etag;
		this.known = new Map();
		for (const [p, st] of current) this.known.set(p, {t: st.mt, l: sizeOf(p, st), mt: st.mt});
		for (const p of changed) if (isLazy(p)) this.loaded.add(p);
		for (const p of removed) this.loaded.delete(p);
		return true;
	}
}

function listFiles(FS, full, rel, out) {
	let names;
	try {
		names = FS.readdir(full);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === '.' || name === '..') continue;
		const childFull = `${full}/${name}`;
		const childRel = `${rel}/${name}`;
		const st = FS.stat(childFull);
		if (FS.isDir(st.mode)) {
			listFiles(FS, childFull, childRel, out);
		} else {
			out.set(childRel, {mt: st.mtime.getTime(), l: st.size});
		}
	}
}

function rmTree(FS, full) {
	let names;
	try {
		names = FS.readdir(full);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === '.' || name === '..') continue;
		const child = `${full}/${name}`;
		if (FS.isDir(FS.stat(child).mode)) {
			rmTree(FS, child);
		} else {
			FS.unlink(child);
		}
	}
	FS.rmdir(full);
}
