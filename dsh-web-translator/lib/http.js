/**
 * Local HTTP API plumbing (DESIGN §5).
 *
 * The DSH `webServer` prefix route calls `createHttpHandler(api, {connection})`
 * with the raw Node request/response pair, so this module owns:
 *  - the plugin-owned Origin fence (no `ctx.connection.requestRejection`; the
 *    browser extension origins must pass);
 *  - JSON body reading capped at 1 MiB;
 *  - the `{ok:true,...}` / `{ok:false,error}` envelopes and status mapping;
 *  - method/path routing (404 unknown path, 405 wrong method).
 */
import { LIMITS } from './constants.js';
import { apiError, errorEnvelope, isApiError, statusOf } from './errors.js';
import { isPlainObject } from './validate.js';

/** Route prefix registered with the DSH web server. */
export const API_BASE = '/dsh-immersive/api';

/** Origin schemes treated as browser-extension origins (DESIGN §5). */
const EXTENSION_SCHEME_PREFIXES = Object.freeze(['chrome-extension://', 'moz-extension://']);

/** Supported endpoint -> allowed method names (DESIGN §5). */
const ROUTES = Object.freeze({
  '/health': Object.freeze(['GET']),
  '/models': Object.freeze(['GET']),
  '/models/resolve': Object.freeze(['GET']),
  '/settings': Object.freeze(['GET', 'PUT']),
  '/usage': Object.freeze(['GET', 'DELETE']),
  '/records': Object.freeze(['DELETE']),
  '/usage/events': Object.freeze(['GET']),
  '/usage/turns': Object.freeze(['GET']),
  '/conversations': Object.freeze(['GET']),
  '/cache': Object.freeze(['DELETE']),
  '/translate': Object.freeze(['POST']),
  '/lookup': Object.freeze(['POST']),
  '/ball-sites': Object.freeze(['GET']),
  '/ball-sites/add': Object.freeze(['POST']),
  '/ball-sites/remove': Object.freeze(['POST']),
  '/wordbook': Object.freeze(['GET']),
  '/wordbook/add': Object.freeze(['POST']),
  '/wordbook/update': Object.freeze(['POST']),
  '/wordbook/review': Object.freeze(['POST']),
  '/wordbook/remove': Object.freeze(['POST']),
});

/**
 * Decide whether a request may use the local API (DESIGN §5 Origin fence):
 * absent Origin, configured/all extension origins, or same-host Origin.
 * @param {{headers?: Record<string, unknown>}} request - Node request or headers holder.
 * @param {{extensionOrigins?: string[]}} [options] - configured extension origin allowlist.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function evaluateOrigin(request, { extensionOrigins = [] } = {}) {
  const headers = request?.headers ?? {};
  const rawOrigin = headers.origin;
  const origin = typeof rawOrigin === 'string' ? rawOrigin.trim() : '';
  if (origin.length === 0) return { ok: true };
  const normalized = origin.toLowerCase();

  if (EXTENSION_SCHEME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    const configured = (Array.isArray(extensionOrigins) ? extensionOrigins : [])
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter((value) => value.length > 0);
    if (configured.length === 0) return { ok: true };
    return configured.includes(normalized)
      ? { ok: true }
      : { ok: false, reason: 'extension origin is not in the configured allowlist' };
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: 'malformed Origin header' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported Origin scheme' };
  }
  const rawHost = headers.host;
  const hostHeader = typeof rawHost === 'string' ? rawHost.trim().toLowerCase() : '';
  if (hostHeader.length === 0) return { ok: false, reason: 'missing Host header' };

  const originHost = parsed.host.toLowerCase();
  if (originHost === hostHeader) return { ok: true };

  const originPort = parsed.port.length > 0 ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80');
  const parsedHost = splitHostPort(hostHeader);
  if (parsedHost.host.length > 0 && originHost === parsedHost.host) return { ok: true };
  if (parsed.hostname.toLowerCase() === parsedHost.host && originPort === parsedHost.port) return { ok: true };
  return { ok: false, reason: 'origin does not match the request host' };
}

/**
 * Split a Host header value into hostname and port (IPv6 literals supported).
 * @param {string} value - lowercased Host header.
 * @returns {{host: string, port: string}}
 */
function splitHostPort(value) {
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return { host: value, port: '80' };
    const rest = value.slice(close + 1);
    return { host: value.slice(1, close), port: rest.startsWith(':') ? rest.slice(1) : '80' };
  }
  const separator = value.lastIndexOf(':');
  if (separator === -1) return { host: value, port: '80' };
  return { host: value.slice(0, separator), port: value.slice(separator + 1) };
}

/**
 * Parse a Node request URL relative to a placeholder origin.
 * @param {unknown} rawUrl - `req.url`.
 * @returns {URL | null}
 */
export function parseRequestUrl(rawUrl) {
  try {
    return new URL(typeof rawUrl === 'string' ? rawUrl : '/', 'http://localhost');
  } catch {
    return null;
  }
}

/**
 * Strip the registered route prefix from a pathname.
 * @param {unknown} pathname - request pathname.
 * @returns {string} API sub-path beginning with `/`.
 */
export function apiSubPath(pathname) {
  let path = typeof pathname === 'string' && pathname.length > 0 ? pathname : '/';
  if (path === API_BASE || path.startsWith(`${API_BASE}/`)) {
    path = path.slice(API_BASE.length) || '/';
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/**
 * Write one JSON response.
 * @param {object} res - Node ServerResponse (or a test double).
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON-serializable body.
 * @param {{head?: boolean, headers?: Record<string, string>}} [options] - HEAD mode / extra headers.
 * @returns {void}
 */
export function sendJson(res, status, payload, { head = false, headers = {} } = {}) {
  if (!res || typeof res.writeHead !== 'function' || res.writableEnded === true) return;
  let body;
  try {
    body = JSON.stringify(payload ?? {});
  } catch {
    body = '{"ok":false,"error":{"code":"INTERNAL","message":"response serialization failed"}}';
    status = 500;
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
  } catch {
    return;
  }
  if (head) {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * Read and parse a JSON object request body (1 MiB cap, JSON content-type only).
 * @param {object} req - Node IncomingMessage.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req) {
  const headers = req?.headers ?? {};
  const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
  if (!/(^|[/+])json\b/i.test(contentType)) {
    throw apiError('BAD_REQUEST', 'request body must be JSON (content-type: application/json)');
  }
  const declared = Number(headers['content-length']);
  if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) {
    throw apiError('TEXT_LIMIT', `request body exceeds ${LIMITS.bodyBytes} bytes`);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > LIMITS.bodyBytes) throw apiError('TEXT_LIMIT', `request body exceeds ${LIMITS.bodyBytes} bytes`);
      chunks.push(bytes);
    }
  } catch (error) {
    if (isApiError(error)) throw error;
    throw apiError('BAD_REQUEST', 'failed to read the request body');
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) throw apiError('BAD_REQUEST', 'request body is required');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw apiError('BAD_REQUEST', 'request body is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw apiError('BAD_REQUEST', 'request body must be a JSON object');
  return parsed;
}

/**
 * Dispatch one GET endpoint (DESIGN §5).
 * @param {string} path - API sub-path.
 * @param {URLSearchParams} query - query parameters.
 * @param {object} api - host API facade.
 * @returns {Promise<object>}
 */
async function dispatchGet(path, query, api) {
  switch (path) {
    case '/health':
      return api.health();
    case '/models':
      return api.listModels();
    case '/models/resolve':
      return api.resolveModel(query.get('provider') ?? '', query.get('model') ?? '');
    case '/settings':
      return api.getSettings();
    case '/usage':
      return api.getUsage({ days: query.get('days') ?? undefined });
    case '/usage/events':
      return api.listUsageEvents({
        limit: query.get('limit') ?? undefined,
        kind: query.get('kind') ?? undefined,
        before: query.get('before') ?? undefined,
      });
    case '/conversations':
      return api.listConversations();
    case '/usage/turns':
      return api.getUsageTurns({
        limit: query.get('limit') ?? undefined,
        kind: query.get('kind') ?? undefined,
        status: query.get('status') ?? undefined,
        before: query.get('before') ?? undefined,
      });
    case '/ball-sites':
      return api.getBallSites();
    case '/wordbook':
      return api.listWordbook({
        query: query.get('query') ?? undefined,
        filter: query.get('filter') ?? undefined,
        limit: query.get('limit') ?? undefined,
      });
    default:
      throw apiError('NOT_FOUND', `unknown API path: ${path}`);
  }
}

/**
 * Dispatch one POST/PUT/DELETE endpoint (DESIGN §5, DESIGN-TOKEN-USAGE §2.3).
 * DELETE handlers are called with an empty body; POST/PUT get the parsed JSON body.
 * @param {string} path - API sub-path.
 * @param {object} body - parsed JSON body (empty object for DELETE).
 * @param {object} api - host API facade.
 * @param {AbortSignal} signal - caller abort signal for model calls.
 * @returns {Promise<object>}
 */
async function dispatchWrite(path, body, api, signal) {
  switch (path) {
    case '/settings':
      return api.putSettings(body);
    case '/usage':
      // DELETE /usage carries no body; dispatchWrite is still the write dispatcher.
      return api.clearUsage();
    case '/cache':
      // DELETE /cache clears the persistent translation cache (DESIGN-CACHE §3).
      return api.clearCache();
    case '/records':
      // DELETE /records clears the usage ledger and hides/archives translation conversations.
      return api.clearRecords();
    case '/translate':
      return api.translate(body, { signal });
    case '/lookup':
      return api.lookup(body, { signal });
    case '/ball-sites/add':
      return api.addBallSite(body);
    case '/ball-sites/remove':
      return api.removeBallSite(body);
    case '/wordbook/add':
      return api.addWordbookEntry(body);
    case '/wordbook/update':
      return api.updateWordbookEntry(body);
    case '/wordbook/review':
      return api.reviewWordbookEntry(body);
    case '/wordbook/remove':
      return api.removeWordbookEntry(body);
    default:
      throw apiError('NOT_FOUND', `unknown API path: ${path}`);
  }
}

/**
 * Answer a caught error with the standard failure envelope.
 * @param {object} api - host API facade (used for logging).
 * @param {object} res - Node ServerResponse.
 * @param {unknown} error - caught value.
 * @param {boolean} head - whether the request was HEAD.
 * @returns {void}
 */
function respondError(api, res, error, head) {
  const known = isApiError(error);
  try {
    if (known) api?.logger?.warn?.(`[dsh-web-translator] ${error.code}: ${error.message}`);
    else api?.logger?.error?.('[dsh-web-translator] unhandled API error', error);
  } catch {
    // Logging must not mask the response.
  }
  if (res?.headersSent === true || res?.writableEnded === true) {
    try {
      res.destroy?.();
    } catch {
      // Connection already gone.
    }
    return;
  }
  sendJson(res, statusOf(error), errorEnvelope(error), { head });
}

/**
 * Build the Node http handler registered on the DSH web server prefix route.
 * @param {object} api - facade returned by `createApi`.
 * @param {{connection?: object}} [options] - reserved; the Origin fence is plugin-owned.
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createHttpHandler(api, { connection } = {}) {
  void connection; // DESIGN §5: do not use ctx.connection.requestRejection (extension origins).
  const extensionOrigins = Array.isArray(api?.extensionOrigins) ? api.extensionOrigins : [];

  return async function immersiveTranslateHttpHandler(req, res) {
    const method = String(req?.method ?? 'GET').toUpperCase();
    const headOnly = method === 'HEAD';
    try {
      const url = parseRequestUrl(req?.url);
      if (url === null) throw apiError('BAD_REQUEST', 'invalid request URL');
      const origin = evaluateOrigin(req, { extensionOrigins });
      if (!origin.ok) throw apiError('FORBIDDEN_ORIGIN', 'request origin is not allowed');
      const path = apiSubPath(url.pathname);
      const allowed = ROUTES[path];
      if (allowed === undefined) throw apiError('NOT_FOUND', `unknown API path: ${path}`);
      const dispatchMethod = headOnly ? 'GET' : method;
      if (!allowed.includes(dispatchMethod)) {
        sendJson(res, 405, {
          ok: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: `${method} is not allowed for ${path}` },
        }, { head: headOnly, headers: { allow: allowed.join(', ') } });
        return;
      }

      const abort = new AbortController();
      const onClose = () => {
        if (res?.writableEnded !== true) abort.abort();
      };
      if (typeof res?.on === 'function') res.on('close', onClose);
      let data;
      try {
        if (dispatchMethod === 'GET') {
          data = await dispatchGet(path, url.searchParams, api);
        } else if (dispatchMethod === 'DELETE') {
          data = await dispatchWrite(path, {}, api, abort.signal);
        } else {
          data = await dispatchWrite(path, await readJsonBody(req), api, abort.signal);
        }
      } finally {
        if (typeof res?.off === 'function') res.off('close', onClose);
      }
      sendJson(res, 200, { ok: true, ...(isPlainObject(data) ? data : {}) }, { head: headOnly });
    } catch (error) {
      respondError(api, res, error, headOnly);
    }
  };
}
