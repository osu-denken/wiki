// PukiWiki のデータディレクトリと R2 の同期
//
// R2 のレイアウト
//   manifest.json          書き込みのコミット点 (etag で楽観ロック)。
//                          {shards: [シャードのキー × SHARDS], lazy: [{p, t, l}]}
//   pack/<n>-<uuid>.bin.gz 小さなファイル (wiki/ diff/ cache/ counter/ attach/*.log) をパスのハッシュで
//                          SHARDS 個に分けたアーカイブ。書き込みでは変更のあったシャードだけ新しいキーで作り直す
//   files/<path>           遅延ファイル (attach/ の添付本体, backup/) を 1 ファイル 1 オブジェクトで保存
//   pack.bin.gz            旧形式 (単一の pack)。読み込めるようにしてあり、次の書き込みで manifest 形式に移行する
//
// isolate 内では MEMFS に展開した状態を保持し、manifest の etag だけ確認する。
// 遅延ファイルは空のプレースホルダを置き、リクエストに必要なものだけ R2 から読み込む。
// プレースホルダの stat は記録済みのサイズを返すので、filesize() などは中身を読まずに正しく動く。
import seedBin from '../build/seed.bin';
import {decodeArchive, encodeArchive, gzip, gunzip} from './archive.js';
import {DOCROOT} from './php.js';

export const DATA_DIRS = ['wiki', 'backup', 'diff', 'cache', 'counter', 'attach'];
export const MANIFEST_KEY = 'manifest.json';
const LEGACY_PACK_KEY = 'pack.bin.gz';
const LEGACY_LAZY_INDEX = '.lazy.json';
const SHARDS = 16;
const FETCH_CONCURRENCY = 20;
export const REFRESH_INTERVAL = 1500;
const REFRESH_RETRIES = 3;

// manifest が無いときの状態 (etag の代わり)
const SEED = 'seed';
const LEGACY = 'legacy';

export const isLazy = p => p.startsWith('backup/') || (p.startsWith('attach/') && !p.endsWith('.log'));

// FNV-1a
const shardOf = p => {
	let h = 0x811c9dc5;
	for (let i = 0; i < p.length; i++) {
		h ^= p.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) % SHARDS;
};

export class WikiState {
	constructor(php) {
		this.php = php;
		this.etag = null;                          // 展開済みの manifest の etag (または SEED / LEGACY)
		this.shardKeys = new Array(SHARDS).fill(null);
		this.known = new Map();                    // 最後に同期した時点の {path: {t, l, mt}}
		this.loaded = new Set();                   // 中身を読み込み済みの遅延ファイル
		this.placeholders = new Map();             // 未読み込みの遅延ファイル (フルパス -> {t, l})
		this.checkedAt = 0;                        // 最後に R2 を確認した時刻
		this.patchStat();
	}

	get FS() { return this.php.FS; }

	/** R2 の manifest を読み込んだ状態か (seed / 旧形式ではない) */
	get hasManifest() { return Boolean(this.etag) && this.etag !== SEED && this.etag !== LEGACY; }

	/** プレースホルダの stat に記録済みのサイズを返させる (PHP の stat 系システムコールは FS.stat を通る) */
	patchStat() {
		const FS = this.FS;
		const stat = FS.stat.bind(FS);
		FS.stat = (path, dontFollow) => {
			const st = stat(path, dontFollow);
			if (st.size !== 0 || !this.placeholders.size) return st;
			const full = path.startsWith('/') ? path : `${FS.cwd()}/${path}`.replace(/\/\.\//g, '/');
			const ph = this.placeholders.get(full);
			// PHP が書き換えたファイルには適用しない
			if (!ph || st.mtime.getTime() !== ph.t) return st;
			return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {size: ph.l});
		};
	}

	/**
	 * R2 の最新状態を FS に反映する。変化がなければ何もしない
	 * @param {boolean} force false なら直近 REFRESH_INTERVAL 以内の確認結果を信用して R2 に問い合わせない
	 *   (他の isolate での更新が最大その時間だけ遅れて見える。書き込みは etag の条件付き put なので安全)
	 */
	async refresh(bucket, force = false) {
		if (!force && this.etag && Date.now() - this.checkedAt < REFRESH_INTERVAL) return;
		this.checkedAt = Date.now();

		for (let attempt = 1; ; attempt++) {
			try {
				return await this.refreshOnce(bucket);
			} catch (e) {
				// 読み込み中に他の isolate がシャードを差し替えた場合など
				if (attempt >= REFRESH_RETRIES) throw e;
				console.warn('refresh retry', e);
				this.etag = null;
			}
		}
	}

	async refreshOnce(bucket) {
		const hasManifest = this.etag && this.etag !== SEED && this.etag !== LEGACY;
		const obj = hasManifest
			? await bucket.get(MANIFEST_KEY, {onlyIf: {etagDoesNotMatch: this.etag}})
			: await bucket.get(MANIFEST_KEY);

		if (!obj) {
			if (this.etag === SEED || this.etag === LEGACY) return;
			const legacy = await bucket.get(LEGACY_PACK_KEY);
			if (legacy) {
				const files = decodeArchive(await gunzip(new Uint8Array(await legacy.arrayBuffer())));
				const indexEntry = files.find(f => f.p === LEGACY_LAZY_INDEX);
				const lazy = indexEntry ? JSON.parse(new TextDecoder().decode(indexEntry.data)) : [];
				this.reset();
				this.writeShardFiles(files.filter(f => f !== indexEntry));
				this.syncPlaceholders(lazy);
				this.etag = LEGACY;
			} else {
				this.reset();
				this.writeShardFiles(decodeArchive(seedBin));
				this.etag = SEED;
			}
			return;
		}
		if (!('body' in obj) || obj.etag === this.etag) return;

		const manifest = await obj.json();
		const full = !hasManifest;
		const targets = manifest.shards
			.map((key, i) => (full || key !== this.shardKeys[i]) ? i : -1)
			.filter(i => i >= 0);
		const shards = await Promise.all(targets.map(async i => {
			const shard = await bucket.get(manifest.shards[i]);
			if (!shard) throw new Error(`shard not found: ${manifest.shards[i]}`);
			return decodeArchive(await gunzip(new Uint8Array(await shard.arrayBuffer())));
		}));

		if (full) {
			this.reset();
		} else {
			// 差し替えるシャードに属していたファイルを消す
			const replaced = new Set(targets);
			for (const p of [...this.known.keys()]) {
				if (!isLazy(p) && replaced.has(shardOf(p))) this.remove(p);
			}
		}
		for (const files of shards) this.writeShardFiles(files);
		this.syncPlaceholders(manifest.lazy);
		this.shardKeys = manifest.shards;
		this.etag = obj.etag;
	}

	reset() {
		for (const dir of DATA_DIRS) {
			rmTree(this.FS, `${DOCROOT}/${dir}`);
			this.FS.mkdirTree(`${DOCROOT}/${dir}`);
		}
		this.known = new Map();
		this.loaded = new Set();
		this.placeholders = new Map();
		this.shardKeys = new Array(SHARDS).fill(null);
	}

	writeShardFiles(files) {
		for (const f of files) {
			this.write(f.p, f.data, f.t);
			if (isLazy(f.p)) this.loaded.add(f.p); // seed 等に遅延対象が含まれていた場合
		}
	}

	/** 遅延ファイルの一覧に合わせてプレースホルダを置き直す (内容の変わらないものはそのまま) */
	syncPlaceholders(lazy) {
		const next = new Map(lazy.map(e => [e.p, e]));
		for (const p of [...this.known.keys()]) {
			if (isLazy(p) && !next.has(p)) this.remove(p);
		}
		for (const e of next.values()) {
			const prev = this.known.get(e.p);
			if (prev && prev.t === e.t && prev.l === e.l) continue;
			this.loaded.delete(e.p);
			this.write(e.p, new Uint8Array(0), e.t, e.l);
			this.placeholders.set(`${DOCROOT}/${e.p}`, {t: e.t, l: e.l});
		}
	}

	write(p, data, t, size = data.byteLength) {
		const full = `${DOCROOT}/${p}`;
		this.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
		this.FS.writeFile(full, data);
		this.FS.utime(full, t, t);
		this.placeholders.delete(full);
		this.known.set(p, {t, l: size, mt: this.FS.lstat(full).mtime.getTime()});
	}

	remove(p) {
		const full = `${DOCROOT}/${p}`;
		try { this.FS.unlink(full); } catch { /* 無ければよい */ }
		this.known.delete(p);
		this.loaded.delete(p);
		this.placeholders.delete(full);
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

	/** 前回同期時からの変更を調べる (プレースホルダのサイズは stat の上書きで記録済みの値になる) */
	diff() {
		const current = new Map();
		for (const dir of DATA_DIRS) listFiles(this.FS, `${DOCROOT}/${dir}`, dir, current);

		const changed = [];
		const removed = [];
		for (const [p, st] of current) {
			const prev = this.known.get(p);
			if (!prev || prev.mt !== st.mt || prev.l !== st.l) changed.push(p);
		}
		for (const p of this.known.keys()) if (!current.has(p)) removed.push(p);
		return {current, changed, removed};
	}

	/**
	 * 変更を R2 に書き込む
	 * @returns {Promise<boolean>} false: 他の isolate が先に書き込んでいた (競合)
	 */
	async commit(bucket, {current, changed, removed}) {
		const migrating = this.etag === SEED || this.etag === LEGACY;
		if (!changed.length && !removed.length) return true;

		for (const p of changed) {
			if (this.placeholders.has(`${DOCROOT}/${p}`)) {
				// 中身を読み込まずに書き換えられた遅延ファイル。データを失うので書き込まない
				throw new Error(`lazy file modified without being loaded: ${p}`);
			}
		}

		// 変更のあったシャード (manifest 形式への移行時は全シャード) を作り直す
		const dirty = new Set();
		for (const p of [...changed, ...removed]) if (!isLazy(p)) dirty.add(shardOf(p));
		if (migrating) for (let i = 0; i < SHARDS; i++) dirty.add(i);

		const shardFiles = new Map([...dirty].map(i => [i, []]));
		const lazy = [];
		for (const [p, st] of current) {
			if (isLazy(p)) {
				lazy.push({p, t: st.mt, l: st.l});
			} else if (shardFiles.has(shardOf(p))) {
				shardFiles.get(shardOf(p)).push({p, t: st.mt, data: this.FS.readFile(`${DOCROOT}/${p}`)});
			}
		}

		const newKeys = [...this.shardKeys];
		const written = [];
		await Promise.all([
			...changed.filter(isLazy).map(p => bucket.put(`files/${p}`, this.FS.readFile(`${DOCROOT}/${p}`))),
			...[...shardFiles].map(async ([i, files]) => {
				const key = `pack/${i}-${crypto.randomUUID()}.bin.gz`;
				await bucket.put(key, await gzip(encodeArchive(files)), {httpMetadata: {contentType: 'application/gzip'}});
				newKeys[i] = key;
				written.push(key);
			}),
		]);

		const options = {httpMetadata: {contentType: 'application/json'}};
		if (!migrating) options.onlyIf = {etagMatches: this.etag};
		const result = await bucket.put(MANIFEST_KEY, JSON.stringify({shards: newKeys, lazy}), options);
		if (!result) {
			await bucket.delete(written);
			this.etag = null; // 次回 refresh で読み直す
			return false;
		}

		// manifest のコミット後に、使われなくなったオブジェクトを消す
		const garbage = [
			...[...dirty].map(i => this.shardKeys[i]).filter(Boolean),
			...removed.filter(isLazy).map(p => `files/${p}`),
		];
		if (this.etag === LEGACY) garbage.push(LEGACY_PACK_KEY);
		if (garbage.length) await bucket.delete(garbage);

		this.etag = result.etag;
		this.shardKeys = newKeys;
		this.known = new Map();
		for (const [p, st] of current) this.known.set(p, {t: st.mt, l: st.l, mt: st.mt});
		for (const p of changed) if (isLazy(p)) this.loaded.add(p);
		for (const p of removed) {
			this.loaded.delete(p);
			this.placeholders.delete(`${DOCROOT}/${p}`);
		}
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
		if (FS.isDir(FS.lstat(child).mode)) {
			rmTree(FS, child);
		} else {
			FS.unlink(child);
		}
	}
	FS.rmdir(full);
}
