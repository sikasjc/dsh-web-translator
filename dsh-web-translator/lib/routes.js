/**
 * Public entry point for the host half, imported by `index.js`.
 *
 * `createApi({ctx, config, logger})` builds the request-level API facade and
 * `createHttpHandler(api, {connection})` adapts it to the `(req, res)` handler
 * the DSH web server expects for the `/dsh-immersive/api` prefix route.
 */
export { createApi } from './api.js';
export { createHttpHandler } from './http.js';
