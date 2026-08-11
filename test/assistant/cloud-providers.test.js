'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ReadableStream } = require('node:stream/web');
const { OpenRouterProvider } = require('../../src/main/assistant/openrouter-provider');
const {
  OpenCodeGoProvider,
  anthropicPayload,
  protocolForModel,
  responseInput
} = require('../../src/main/assistant/opencode-go-provider');

function responseJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function responseSse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

const conversation = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'search' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'brave_search', arguments: { query: 'test' } }] },
  { role: 'tool', content: 'result', toolCallId: 'call-1', toolName: 'brave_search' }
];

test('OpenRouter applies no-data-collection routing and validates key metadata', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/key')) return responseJson({ data: { label: 'eDEX', limit: 25 } });
    return responseJson({ id: 'r1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] });
  };
  const provider = new OpenRouterProvider({ apiKey: 'secret', fetchImpl });
  assert.deepEqual(await provider.testConnection(), { ok: true, label: 'eDEX', limit: 25 });
  await provider.complete({ model: 'example/model', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(requests[1].options.body).provider.data_collection, 'deny');
});

test('OpenCode Go exposes dynamic catalog but disables models without a protocol mapping', async () => {
  const provider = new OpenCodeGoProvider({ fetchImpl: async () => responseJson({ data: [
    { id: 'opencode-go/gpt-5.6-luna' },
    { id: 'opencode-go/future-model' }
  ] }) });
  const models = await provider.listModels();
  assert.equal(models[0].protocol, 'responses');
  assert.equal(models[0].available, true);
  assert.equal(models[1].protocol, null);
  assert.equal(models[1].available, false);
  assert.equal(protocolForModel('opencode-go/minimax-m3'), 'messages');
});

test('Responses codec preserves function calls and tool results', async () => {
  const requests = [];
  const provider = new OpenCodeGoProvider({ apiKey: 'go-key', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return responseJson({ id: 'resp-1', status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'call-2', name: 'brave_search', arguments: '{"query":"news"}' }
    ] });
  } });
  const result = await provider.complete({ model: 'opencode-go/gpt-5.6-luna', messages: conversation });
  assert.equal(requests[0].url.endsWith('/responses'), true);
  assert.equal(responseInput(conversation).at(-1).type, 'function_call_output');
  assert.equal(result.content, 'done');
  assert.deepEqual(result.toolCalls[0].arguments, { query: 'news' });
});

test('Anthropic codec separates system and parses streamed tool arguments', async () => {
  const requests = [];
  const provider = new OpenCodeGoProvider({ apiKey: 'go-key', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return responseSse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-3', name: 'brave_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"test"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }
    ]);
  } });
  const chunks = [];
  const result = await provider.complete({
    model: 'minimax-m3', messages: conversation, stream: true,
    onEvent: (event) => chunks.push(event.text)
  });
  const encoded = anthropicPayload(conversation, []);
  assert.equal(encoded.system, 'system');
  assert.equal(encoded.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(requests[0].url.endsWith('/messages'), true);
  assert.equal(chunks.join(''), 'OK');
  assert.deepEqual(result.toolCalls[0].arguments, { query: 'test' });
});

test('OpenCode Go rejects unknown model protocol before making a request', () => {
  const provider = new OpenCodeGoProvider({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.throws(
    () => provider.complete({ model: 'opencode-go/future-model', messages: [{ role: 'user', content: 'test' }] }),
    { code: 'UNSUPPORTED_MODEL_PROTOCOL' }
  );
});
