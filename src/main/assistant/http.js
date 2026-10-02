'use strict';

const { AssistantError, normalizeNetworkError, providerHttpError } = require('./errors');

function timeoutError(message) {
  return new DOMException(message, 'TimeoutError');
}

// A child signal that follows the caller's signal and can also be aborted on
// its own (timeouts). dispose() only detaches it from the caller — it must
// not run until the response body has been fully consumed, or a cancel that
// arrives mid-stream never reaches the fetch.
function linkAbortSignals(signal) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onParentAbort = () => abort(signal.reason);
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    abort,
    dispose() {
      signal?.removeEventListener('abort', onParentAbort);
    }
  };
}

// Re-wraps the body so the request's abort signal and an idle timeout keep
// governing it after the headers arrive: a cancel or a stalled stream errors
// the body (as a normalized AssistantError) instead of leaving the reader
// waiting until the provider decides to finish. Done explicitly rather than
// trusting fetch to tear the body down on abort, so it holds for any
// fetchImpl.
function guardBody(provider, response, link, idleTimeoutMs) {
  const source = response.body;
  if (!source?.getReader) {
    link.dispose();
    return response;
  }
  const reader = source.getReader();
  let streamController = null;
  let idleTimer = null;
  let finished = false;
  const finish = () => {
    if (finished) return false;
    finished = true;
    clearTimeout(idleTimer);
    link.signal.removeEventListener('abort', onAbort);
    link.dispose();
    return true;
  };
  function onAbort() {
    if (!finish()) return;
    const error = normalizeNetworkError(provider, link.signal.reason);
    reader.cancel(error).catch(() => {});
    streamController.error(error);
  }
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => link.abort(timeoutError('Response stream went idle.')), idleTimeoutMs);
  };
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      if (link.signal.aborted) {
        onAbort();
        return;
      }
      link.signal.addEventListener('abort', onAbort, { once: true });
      armIdleTimer();
    },
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (finish()) controller.error(normalizeNetworkError(provider, error));
        return;
      }
      if (finished) return;
      if (chunk.done) {
        finish();
        controller.close();
        return;
      }
      armIdleTimer();
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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

// timeoutMs bounds the wait for response headers; idleTimeoutMs (default:
// the same value) bounds every gap between body chunks afterwards. The
// caller's signal stays wired to the request until the body is consumed.
async function request(provider, url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 30_000;
  const idleTimeoutMs = options.idleTimeoutMs || timeoutMs;
  const link = linkAbortSignals(options.signal);
  const headersTimer = setTimeout(() => link.abort(timeoutError('Request timed out.')), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options, signal: link.signal, fetchImpl: undefined, timeoutMs: undefined, idleTimeoutMs: undefined
    });
    if (!response.ok) throw providerHttpError(provider, response.status, await parseErrorBody(response), response.headers);
    return guardBody(provider, response, link, idleTimeoutMs);
  } catch (error) {
    link.dispose();
    throw normalizeNetworkError(provider, error);
  } finally {
    clearTimeout(headersTimer);
  }
}

async function requestJson(provider, url, options = {}) {
  const response = await request(provider, url, options);
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof AssistantError) throw error;
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

// `onDone` fires on the `[DONE]` sentinel, which is otherwise swallowed —
// callers use it to tell a finished stream from a truncated one.
async function* parseSse(body, { onDone = () => {} } = {}) {
  let buffer = '';
  const dataOf = (block) => block.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  for await (const chunk of textChunks(body)) {
    // Normalised on the joined buffer, not per chunk: a CRLF split across
    // two chunks would otherwise leave a stray \r and hide the event boundary.
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const data = dataOf(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (data === '[DONE]') onDone();
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
  if (buffer.trim()) {
    const data = dataOf(buffer.replace(/\r$/, ''));
    if (data === '[DONE]') onDone();
    else if (data) yield JSON.parse(data);
  }
}

module.exports = { parseNdjson, parseSse, request, requestJson };
