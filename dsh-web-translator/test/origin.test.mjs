/** Origin fence rules for the local API (DESIGN §5). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateOrigin } from '../lib/http.js';

/** Evaluate the fence for one (origin, host) pair. */
function check(origin, host, options) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  return evaluateOrigin({ headers }, options);
}

test('requests without an Origin header are allowed', () => {
  assert.equal(check(undefined, '127.0.0.1:3080').ok, true);
  assert.equal(check('', '127.0.0.1:3080').ok, true);
});

test('browser-extension origins are allowed by default', () => {
  assert.equal(check('chrome-extension://abcdefghijklmnop', '127.0.0.1:3080').ok, true);
  assert.equal(check('moz-extension://abcdefghijklmnop', '127.0.0.1:3080').ok, true);
  assert.equal(check('CHROME-EXTENSION://UPPER', '127.0.0.1:3080').ok, true);
});

test('configured extensionOrigins narrows the extension allowlist', () => {
  const options = { extensionOrigins: ['chrome-extension://only-this'] };
  assert.equal(check('chrome-extension://only-this', '127.0.0.1:3080', options).ok, true);
  assert.equal(check('chrome-extension://something-else', '127.0.0.1:3080', options).ok, false);
  assert.equal(check('moz-extension://only-this', '127.0.0.1:3080', options).ok, false);
});

test('same-host origins are allowed', () => {
  assert.equal(check('http://127.0.0.1:3080', '127.0.0.1:3080').ok, true);
  assert.equal(check('http://localhost:3080', 'localhost:3080').ok, true);
  assert.equal(check('https://127.0.0.1:3080', '127.0.0.1:3080').ok, true);
  assert.equal(check('http://127.0.0.1', '127.0.0.1:80').ok, true, 'default port normalization');
  assert.equal(check('http://[::1]:3080', '[::1]:3080').ok, true);
});

test('cross-origin HTTP requests are rejected', () => {
  assert.equal(check('https://evil.example', '127.0.0.1:3080').ok, false);
  assert.equal(check('http://127.0.0.1:9999', '127.0.0.1:3080').ok, false);
  assert.equal(check('http://localhost:3080', '127.0.0.1:3080').ok, false);
});

test('malformed or opaque origins are rejected', () => {
  assert.equal(check('null', '127.0.0.1:3080').ok, false);
  assert.equal(check('not a url', '127.0.0.1:3080').ok, false);
  assert.equal(check('file:///tmp/page.html', '127.0.0.1:3080').ok, false);
});

test('missing Host header is rejected', () => {
  assert.equal(check('http://127.0.0.1:3080', undefined).ok, false);
  assert.equal(check(undefined, undefined).ok, true, 'no origin needs no host');
});
