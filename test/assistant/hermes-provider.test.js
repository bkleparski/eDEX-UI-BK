'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { HermesProvider } = require('../../src/main/assistant/hermes-provider');
const { OpenAICompatibleClient } = require('../../src/main/assistant/openai-compatible-client');
const { ProviderRegistry } = require('../../src/main/assistant/provider-registry');
const { configureCloudProviders, requireConfiguredCloudProvider } = require('../../src/main/assistant/orchestration');

const prompt = [{ role: 'user', content: 'last prompt' }];

test('Hermes streams the prompt with Bearer/session headers and ignores progress/keepalive SSE', async () => {
  const requests = [];
  const provider = new HermesProvider({
    hermesUrl: 'http://hermes:8642/', apiKey: 'hermes-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(': keepalive\n\nevent: hermes.tool.progress\ndata: {"tool":"terminal"}\n\n'
        + 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    }
  });
  assert.equal(provider.agent, true);
  assert.equal(provider.client.timeoutMs, 120_000);
  const events = [];
  const result = await provider.complete({ model: 'hermes-agent', messages: prompt,
    sessionId: 'edex-thread-1', stream: true, onEvent: (event) => events.push(event) });
  assert.equal(result.content, 'OK');
  assert.equal(requests[0].url, 'http://hermes:8642/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer hermes-key');
  assert.equal(requests[0].options.headers['X-Hermes-Session-Id'], 'edex-thread-1');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.messages, prompt);
  assert.equal(body.tools, undefined);
  assert.deepEqual(events, [{ type: 'text-delta', text: 'OK' }]);
});

test('Hermes lists server models and checks authenticated health', async () => {
  const requests = [];
  const provider = new HermesProvider({ hermesUrl: 'https://hermes', apiKey: 'key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(url.endsWith('/models') ? { data: [{ id: 'hermes-agent' }] } : { status: 'ok' });
    } });
  const models = await provider.listModels();
  assert.equal(models[0].id, 'hermes-agent');
  assert.equal(models[0].provider, 'hermes');
  assert.deepEqual(await provider.testConnection(), { ok: true });
  assert.deepEqual(requests.map(({ url }) => url), ['https://hermes/v1/models', 'https://hermes/health']);
  for (const { options } of requests) assert.equal(options.headers.Authorization, 'Bearer key');
});

test('Hermes health normalizes authentication and network failures', async () => {
  const unauthorized = new HermesProvider({ hermesUrl: 'https://hermes', apiKey: 'bad',
    fetchImpl: async () => Response.json({ error: { message: 'bad key' } }, { status: 401 }) });
  await assert.rejects(unauthorized.testConnection(), (error) => error.code === 'INVALID_API_KEY' && error.status === 401);
  const offline = new HermesProvider({ hermesUrl: 'https://hermes', fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.testConnection(), (error) => error.code === 'PROVIDER_OFFLINE');
});

test('per-completion headers merge without leaking session headers to later calls', async () => {
  const seen = [];
  const client = new OpenAICompatibleClient({ provider: 'test', baseUrl: 'https://hermes/v1', apiKey: 'key',
    defaultHeaders: { 'X-Custom': 'default' }, fetchImpl: async (_url, options) => {
      seen.push(options.headers);
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    } });
  await client.complete({ model: 'm', messages: prompt, headers: { 'X-Hermes-Session-Id': 'one', 'X-Custom': 'override' } });
  await client.complete({ model: 'm', messages: prompt });
  assert.equal(seen[0].Authorization, 'Bearer key');
  assert.equal(seen[0]['X-Custom'], 'override');
  assert.equal(seen[1]['X-Custom'], 'default');
  assert.equal(seen[1]['X-Hermes-Session-Id'], undefined);
});

test('orchestration registers Hermes and requires both URL and API key', () => {
  const config = { secrets: { hermesApiKey: 'key' }, endpoints: { hermesUrl: 'http://hermes:8642' } };
  const registry = new ProviderRegistry([]);
  configureCloudProviders({ get: () => config }, registry);
  assert.equal(registry.get('hermes').agent, true);
  assert.equal(registry.isLocal('hermes'), false);
  assert.doesNotThrow(() => requireConfiguredCloudProvider('hermes', config));
  for (const incomplete of [{ secrets: {} }, { secrets: { hermesApiKey: 'key' } }, { secrets: {}, endpoints: config.endpoints }]) {
    assert.throws(() => requireConfiguredCloudProvider('hermes', incomplete), /URL and API key/);
  }
});
