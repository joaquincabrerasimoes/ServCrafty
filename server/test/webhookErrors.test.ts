import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFetchError } from '../src/services/webhooks.js';

const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('maps network error codes to readable messages', () => {
  const url = 'https://hooks.example.com/abc';
  assert.equal(describeFetchError(failed('ECONNREFUSED'), url), 'Connection refused by hooks.example.com');
  assert.equal(describeFetchError(failed('ENOTFOUND'), url), 'Could not resolve host hooks.example.com');
  assert.equal(describeFetchError(failed('ETIMEDOUT'), url), 'Connection to hooks.example.com timed out');
  assert.equal(describeFetchError(failed('UND_ERR_CONNECT_TIMEOUT'), url), 'Connection to hooks.example.com timed out');
  assert.match(describeFetchError(failed('DEPTH_ZERO_SELF_SIGNED_CERT'), url), /TLS error/);
});

test('timeouts and unknown errors never surface as bare "fetch failed"', () => {
  const url = 'https://hooks.example.com/abc';
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(describeFetchError(timeout, url), 'hooks.example.com did not respond in time');
  assert.equal(describeFetchError(new TypeError('fetch failed'), url), 'Could not reach hooks.example.com');
});
