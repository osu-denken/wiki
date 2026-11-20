// wrangler でバンドルするアセット (build/ は npm run build で生成)
import PHP from '../build/php/php-cgi.mjs';
import phpWasm from '../build/php/php-cgi.wasm';
import mbstringSo from '../build/php/mbstring.so';
import libonigSo from '../build/php/libonig.so';
import zlibSo from '../build/php/zlib.so';
import libzSo from '../build/php/libz.so';
import sigModules from '../build/php/signatures.js';
import appBin from '../build/app.bin';
import opcacheBin from '../build/opcache.bin';

export default {
	PHP,
	phpWasm,
	sharedLibs: {'mbstring.so': mbstringSo, 'libonig.so': libonigSo, 'zlib.so': zlibSo, 'libz.so': libzSo},
	sigModules,
	appBin,
	opcacheBin,
};
