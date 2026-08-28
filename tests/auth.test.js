import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../server/auth.js';

test('requires a configured hosted access token', () => {
  assert.deepEqual(authorizeRequest({ headers: {} }, ''), {
    ok: false,
    status: 503,
    error: 'THREADLINE_ACCESS_TOKEN is not configured'
  });
});

test('rejects missing or incorrect bearer credentials', () => {
  assert.equal(authorizeRequest({ headers: {} }, 'correct').status, 401);
  assert.equal(authorizeRequest({ headers: { authorization: 'Bearer incorrect' } }, 'correct').status, 401);
  assert.deepEqual(authorizeRequest({ headers: { authorization: 'Bearer correct' } }, 'correct'), { ok: true });
});
