'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { requestJson } = require('../../src/main/assistant/http');

test('provider HTTP errors normalize invalid keys, missing models and rate limits', async () => {
  for (const fixture of [
    { status: 401, code: 'INVALID_API_KEY' },
    { status: 404, code: 'MODEL_NOT_FOUND' },
    { status: 429, code: 'RATE_LIMITED', retryAfter: 7 }
  ]) {
    await assert.rejects(
      requestJson('test-provider', 'https://provider.test/request', {
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: fixture.code } }), {
          status: fixture.status,
          headers: fixture.retryAfter ? { 'Retry-After': String(fixture.retryAfter) } : {}
        })
      }),
      (error) => error.code === fixture.code && (fixture.retryAfter === undefined || error.retryAfter === fixture.retryAfter)
    );
  }
});

test('provider connection refusal becomes PROVIDER_OFFLINE', async () => {
  await assert.rejects(
    requestJson('ollama', 'http://127.0.0.1:1/api/tags', {
      fetchImpl: async () => { throw new TypeError('fetch failed'); }
    }),
    { code: 'PROVIDER_OFFLINE', provider: 'ollama' }
  );
});

test('request timeout is distinct from user cancellation', async () => {
  const waitingFetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(
    requestJson('lmstudio', 'http://127.0.0.1:1234/v1/models', { fetchImpl: waitingFetch, timeoutMs: 5 }),
    { code: 'TIMEOUT' }
  );

  const controller = new AbortController();
  const pending = requestJson('ollama', 'http://127.0.0.1:11434/api/tags', {
    fetchImpl: waitingFetch, timeoutMs: 1_000, signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
});
