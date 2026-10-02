'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ReadableStream } = require('node:stream/web');
const { parseSse, request } = require('../../src/main/assistant/http');
const { OllamaProvider } = require('../../src/main/assistant/ollama-provider');
const { OpenAICompatibleClient } = require('../../src/main/assistant/openai-compatible-client');

const encoder = new TextEncoder();

// A body that emits `chunks` one every `intervalMs` and deliberately ignores
// the fetch signal — the guard in http.js has to stop it on its own.
function slowResponse(chunks, intervalMs = 20) {
  let timer;
  return new Response(new ReadableStream({
    start(controller) {
      let index = 0;
      timer = setInterval(() => {
        if (index >= chunks.length) {
          clearInterval(timer);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      }, intervalMs);
    },
    cancel() {
      clearInterval(timer);
    }
  }));
}

function chunkedResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }));
}

async function drain(body) {
  const reader = body.getReader();
  let count = 0;
  while (!(await reader.read()).done) count += 1;
  return count;
}

test('cancelling after the headers arrive stops the body read', async () => {
  const controller = new AbortController();
  const response = await request('test', 'http://unused', {
    signal: controller.signal,
    fetchImpl: async () => slowResponse(Array.from({ length: 50 }, (_, index) => `${index}\n`))
  });
  setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  await assert.rejects(drain(response.body), (error) => error.code === 'ABORTED');
  assert.ok(Date.now() - started < 500, 'body read should stop right after the cancel');
});

test('a stalled body fails with TIMEOUT after idleTimeoutMs', async () => {
  const response = await request('test', 'http://unused', {
    idleTimeoutMs: 80,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('first\n'));
      }
    }))
  });
  await assert.rejects(drain(response.body), (error) => error.code === 'TIMEOUT');
});

test('a body that keeps flowing outlives timeoutMs', async () => {
  const response = await request('test', 'http://unused', {
    timeoutMs: 60,
    fetchImpl: async () => slowResponse(['a', 'b', 'c', 'd', 'e', 'f'], 30)
  });
  assert.equal(await drain(response.body), 6);
});

test('SSE parser joins a CRLF split across chunks', async () => {
  const events = [];
  let done = false;
  const body = chunkedResponse(['data: {"n":1}\r', '\n\r\ndata: {"n":2}\r\n', '\r\ndata: [DONE]\r\n\r\n']).body;
  for await (const event of parseSse(body, { onDone: () => { done = true; } })) events.push(event.n);
  assert.deepEqual(events, [1, 2]);
  assert.equal(done, true);
});

test('OpenAI-compatible stream without finish_reason or [DONE] is reported as incomplete', async () => {
  const client = new OpenAICompatibleClient({
    provider: 'test',
    baseUrl: 'http://unused',
    fetchImpl: async () => chunkedResponse(['data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n'])
  });
  await assert.rejects(
    client.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    (error) => error.code === 'STREAM_INCOMPLETE'
  );
});

test('OpenAI-compatible stream that ends with [DONE] completes', async () => {
  const client = new OpenAICompatibleClient({
    provider: 'test',
    baseUrl: 'http://unused',
    fetchImpl: async () => chunkedResponse(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', 'data: [DONE]\n\n'])
  });
  const result = await client.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(result.content, 'OK');
});

test('Ollama stream without done:true is incomplete, an error line is a stream error', async () => {
  const truncated = new OllamaProvider({
    fetchImpl: async () => chunkedResponse(['{"message":{"content":"Hal"},"done":false}\n'])
  });
  await assert.rejects(
    truncated.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    (error) => error.code === 'STREAM_INCOMPLETE'
  );
  const failing = new OllamaProvider({
    fetchImpl: async () => chunkedResponse(['{"error":"model unloaded"}\n'])
  });
  await assert.rejects(
    failing.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    (error) => error.code === 'STREAM_ERROR' && error.message === 'model unloaded'
  );
});
