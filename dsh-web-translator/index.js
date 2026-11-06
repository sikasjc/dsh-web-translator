/**
 * Host half of @local/dsh-web-translator.
 *
 * Registers the local JSON API used by:
 *  - the dsh-web-translator browser extension (translation / lookup / wordbook), and
 *  - the plugin's own Settings page client half (settings / wordbook review).
 *
 * All wiring lives in lib/routes.js; this file only owns the webServer route and
 * the plugin lifecycle. No profile files are written by this plugin.
 */
import { createApi, createHttpHandler } from './lib/routes.js';

export const inject = ['llm', 'webServer'];

export function apply(ctx, config) {
  const api = createApi({ ctx, config: config ?? {}, logger: ctx.logger });
  const handler = createHttpHandler(api, { connection: ctx.get('connection') });
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-immersive/api',
      handler,
    }),
    'dsh-web-translator: /dsh-immersive/api routes',
  );
}
