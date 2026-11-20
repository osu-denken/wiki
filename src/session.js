// PHP セッション (フォーム認証のログイン状態) を R2 の sessions/ に保存する
// isolate が変わってもログインが切れないように、リクエストのたびに Cookie のセッションだけ同期する
export const SESSION_DIR = '/sessions';
const MAX_AGE = 24 * 3600 * 1000; // php.ini の session.gc_maxlifetime と揃える
const COOKIE = /(?:^|;\s*)PHPSESSID=([A-Za-z0-9,-]{1,128})/;

export class SessionStore {
	constructor(php) {
		this.php = php;
		this.known = new Map(); // ファイル名 -> {etag, content}
	}

	get FS() { return this.php.FS; }

	/** Cookie のセッションを R2 から読み込む (他の isolate での変更・ログアウトも反映) */
	async load(bucket, cookieHeader) {
		const id = cookieHeader?.match(COOKIE)?.[1];
		if (!id) return;
		const name = `sess_${id}`;
		const prev = this.known.get(name);
		const obj = prev
			? await bucket.get(`sessions/${name}`, {onlyIf: {etagDoesNotMatch: prev.etag}})
			: await bucket.get(`sessions/${name}`);

		if (!obj || Date.now() - obj.uploaded.getTime() > MAX_AGE) {
			this.forget(name);
			return;
		}
		if (!('body' in obj)) return;
		const content = new Uint8Array(await obj.arrayBuffer());
		this.FS.writeFile(`${SESSION_DIR}/${name}`, content);
		this.known.set(name, {etag: obj.etag, content});
	}

	forget(name) {
		this.known.delete(name);
		try { this.FS.unlink(`${SESSION_DIR}/${name}`); } catch { /* 無ければよい */ }
	}

	/** PHP が作成・変更・削除したセッションを R2 に反映 */
	async save(bucket) {
		const present = new Set();
		const tasks = [];
		for (const name of this.FS.readdir(SESSION_DIR)) {
			if (!name.startsWith('sess_')) continue;
			const content = this.FS.readFile(`${SESSION_DIR}/${name}`);
			if (!content.byteLength) {
				// 空のセッション (未ログイン) は保存しない
				this.FS.unlink(`${SESSION_DIR}/${name}`);
				continue;
			}
			present.add(name);
			const prev = this.known.get(name);
			// 内容が同じなら書かない (session.lazy_write でも mtime は更新されるため内容で比較)
			if (prev && equals(prev.content, content)) continue;
			tasks.push(bucket.put(`sessions/${name}`, content).then(obj => this.known.set(name, {etag: obj.etag, content})));
		}
		for (const name of [...this.known.keys()]) {
			if (present.has(name)) continue;
			this.known.delete(name);
			tasks.push(bucket.delete(`sessions/${name}`));
		}
		await Promise.all(tasks);
	}
}

function equals(a, b) {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}
