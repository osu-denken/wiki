import {DOCROOT} from './php.js';

/**
 * Request から CGI 環境変数を組み立てる
 * @param {Request} request
 * @param {URL} url
 * @param {Uint8Array} body
 * @param {Record<string, unknown>} env Workers の env (PUKIWIKI_* を PHP に渡す)
 */
export function cgiEnv(request, url, body, env) {
	const https = url.protocol === 'https:';
	const vars = {
		GATEWAY_INTERFACE: 'CGI/1.1',
		SERVER_SOFTWARE: 'Cloudflare-Workers php-cgi-wasm',
		SERVER_PROTOCOL: 'HTTP/1.1',
		SERVER_NAME: url.hostname,
		SERVER_PORT: url.port || (https ? '443' : '80'),
		HTTPS: https ? 'on' : 'off',
		REQUEST_SCHEME: https ? 'https' : 'http',
		REQUEST_METHOD: request.method,
		REQUEST_URI: url.pathname + url.search,
		QUERY_STRING: url.search.slice(1),
		DOCUMENT_ROOT: DOCROOT,
		SCRIPT_NAME: '/index.php',
		SCRIPT_FILENAME: `${DOCROOT}/index.php`,
		PATH_TRANSLATED: `${DOCROOT}/index.php`,
		REDIRECT_STATUS: '200',
		REMOTE_ADDR: request.headers.get('cf-connecting-ip') ?? '127.0.0.1',
		CONTENT_LENGTH: String(body.byteLength),
		CONTENT_TYPE: request.headers.get('content-type') ?? '',
	};
	for (const [name, value] of request.headers) {
		if (name === 'content-type' || name === 'content-length') continue;
		vars['HTTP_' + name.toUpperCase().replace(/-/g, '_')] = value;
	}
	// PUKIWIKI_ で始まる変数・シークレットを PHP の getenv() に渡す
	for (const [name, value] of Object.entries(env)) {
		if (name.startsWith('PUKIWIKI_') && typeof value === 'string') vars[name] = value;
	}
	return vars;
}
