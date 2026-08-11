'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ReadableStream } = require('node:stream/web');
const { parseSse } = require('../../src/main/assistant/http');
const { LMStudioProvider } = require('../../src/main/assistant/lmstudio-provider');
const { OllamaProvider } = require('../../src/main/assistant/ollama-provider');

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('SSE parser handles fragmented events, comments and DONE', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      ['data: {"a":', '1}\n\n: keepalive\n\ndata: {"b":2}\n', '\ndata: [DONE]\n\n']
        .forEach((part) => controller.enqueue(encoder.encode(part)));
      controller.close();
    }
  });
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test('Ollama provider discovers completion models and parses object tool arguments', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/tags')) return responseJson({ models: [
      { name: 'gemma4:e4b', capabilities: ['completion', 'tools'] },
      { name: 'embed', capabilities: ['embedding'] }
    ] });
    return responseJson({
      message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'echo', arguments: { token: 'OK' } } }] },
      done: true,
      done_reason: 'stop'
    });
  };
  const provider = new OllamaProvider({ fetchImpl });
  const models = await provider.listModels();
  assert.deepEqual(models.map((model) => model.id), ['gemma4:e4b']);
  const result = await provider.complete({ model: 'gemma4:e4b', messages: [{ role: 'user', content: 'test' }] });
  assert.deepEqual(result.toolCalls[0], { id: 'call-1', name: 'echo', arguments: { token: 'OK' } });
});

test('LM Studio provider filters embedding models and parses string tool arguments', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return responseJson({ data: [
      { id: 'google/gemma-4-12b', object: 'model' },
      { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' }
    ] });
    return responseJson({
      id: 'chat-1',
      choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: '', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'echo', arguments: '{"token":"OK"}' } }]
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    });
  };
  const provider = new LMStudioProvider({ fetchImpl });
  const models = await provider.listModels();
  assert.deepEqual(models.map((model) => model.id), ['google/gemma-4-12b']);
  assert.equal(models[0].toolSupportKnown, false);
  const result = await provider.complete({ model: models[0].id, messages: [{ role: 'user', content: 'test' }] });
  assert.deepEqual(result.toolCalls[0], { id: 'call-2', name: 'echo', arguments: { token: 'OK' } });
});
