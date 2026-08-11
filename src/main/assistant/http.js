'use strict';

const { AssistantError, normalizeNetworkError, providerHttpError } = require('./errors');

function combineAbortSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out.', 'TimeoutError')), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

async function parseErrorBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(provider, url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeout = combineAbortSignals(options.signal, options.timeoutMs || 30_000);
  try {
    const response = await fetchImpl(url, { ...options, signal: timeout.signal, fetchImpl: undefined, timeoutMs: undefined });
    if (!response.ok) throw providerHttpError(provider, response.status, await parseErrorBody(response), response.headers);
    return response;
  } catch (error) {
    throw normalizeNetworkError(provider, error);
  } finally {
    timeout.dispose();
  }
}

async function requestJson(provider, url, options = {}) {
  const response = await request(provider, url, options);
  try {
    return await response.json();
  } catch (error) {
    throw new AssistantError('INVALID_RESPONSE', `${provider} returned invalid JSON.`, { provider, cause: error });
  }
}

async function* textChunks(body) {
  if (!body?.getReader) throw new AssistantError('INVALID_RESPONSE', 'Response body is not streamable.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

async function* parseNdjson(body) {
  let buffer = '';
  for await (const chunk of textChunks(body)) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail);
}

async function* parseSse(body) {
  let buffer = '';
  for await (const chunk of textChunks(body)) {
    buffer += chunk.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
  if (buffer.trim()) {
    const data = buffer.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}

module.exports = { parseNdjson, parseSse, request, requestJson };
