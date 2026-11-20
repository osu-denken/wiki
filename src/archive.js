// 簡易アーカイブ形式 (ビルド時の app.bin / seed.bin と R2 上のパックで共用)
//   "PKA1" | u32 LE: JSON 長 | JSON [{p: パス, t: mtime(ms), l: バイト長}] | 本体を連結
// Node (ビルドスクリプト) と Workers の両方から使う。

const MAGIC = 0x31414b50; // "PKA1"
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * @param {{p: string, t: number, data: Uint8Array}[]} files
 * @returns {Uint8Array}
 */
export function encodeArchive(files) {
	const index = files.map(f => ({p: f.p, t: f.t, l: f.data.byteLength}));
	const json = enc.encode(JSON.stringify(index));
	const total = 8 + json.byteLength + index.reduce((n, e) => n + e.l, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint32(4, json.byteLength, true);
	out.set(json, 8);
	let offset = 8 + json.byteLength;
	for (const f of files) {
		out.set(f.data, offset);
		offset += f.data.byteLength;
	}
	return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{p: string, t: number, data: Uint8Array}[]}
 */
export function decodeArchive(buffer) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== MAGIC) throw new Error('invalid archive');
	const jsonLength = view.getUint32(4, true);
	const index = JSON.parse(dec.decode(bytes.subarray(8, 8 + jsonLength)));
	let offset = 8 + jsonLength;
	return index.map(e => {
		const data = bytes.subarray(offset, offset + e.l);
		offset += e.l;
		return {p: e.p, t: e.t, data};
	});
}

export async function gzip(bytes) {
	return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

export async function gunzip(bytes) {
	return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
