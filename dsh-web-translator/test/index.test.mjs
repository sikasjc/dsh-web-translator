/** `index.js` wiring: inject list, prefix route registration and a live handler. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject } from '../index.js';
import { fakeRequest, invokeHandler } from './helpers.mjs';

/** Cordis-like context capturing web-server route registrations. */
function createApplyContext() {
  const registrations = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get() {
      return undefined;
    },
    effect(callback) {
      return callback();
    },
    webServer: {
      register(route) {
        registrations.push(route);
        return () => {};
      },
    },
  };
  return { ctx, registrations };
}

test('index.js injects exactly the llm and webServer services', () => {
  assert.deepEqual(inject, ['llm', 'webServer']);
});

test('apply registers the /dsh-immersive/api prefix route with a working handler', async () => {
  const { ctx, registrations } = createApplyContext();
  apply(ctx, {});
  assert.equal(registrations.length, 1);
  const [route] = registrations;
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/dsh-immersive/api');
  assert.equal(typeof route.handler, 'function');

  const response = await invokeHandler(route.handler, fakeRequest({ url: '/dsh-immersive/api/health' }));
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.deepEqual(body.llm, { providers: 0, models: 0 });
});
