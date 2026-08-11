'use strict';

const { PROVIDER_IDS, normalizeMessages, normalizeTools, providerModel } = require('./contracts');
const { AssistantError } = require('./errors');
const { parseNdjson, request, requestJson } = require('./http');

function ollamaMessages(messages) {
  return normalizeMessages(messages).map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_name: message.toolName, content: message.content };
    }
    const result = { role: message.role, content: message.content };
    if (message.toolCalls?.length) {
      result.tool_calls = message.toolCalls.map((call, index) => ({
        id: call.id,
        type: 'function',
        function: { index, name: call.name, arguments: call.arguments }
      }));
    }
    return result;
  });
}

function ollamaTools(tools) {
  return normalizeTools(tools).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

function parseOllamaMessage(data) {
  if (!data?.message) throw new AssistantError('INVALID_RESPONSE', 'Ollama returned no assistant message.', { provider: PROVIDER_IDS.OLLAMA });
  const calls = Array.isArray(data.message.tool_calls) ? data.message.tool_calls : [];
  return {
    role: 'assistant',
    content: typeof data.message.content === 'string' ? data.message.content : '',
    toolCalls: calls.map((call, index) => ({
      id: call.id || `tool-call-${index + 1}`,
      name: call.function?.name,
      arguments: call.function?.arguments || {}
    })),
    finishReason: data.done_reason || null,
    usage: {
      promptTokens: data.prompt_eval_count || 0,
      completionTokens: data.eval_count || 0,
      totalDurationNs: data.total_duration || 0
    },
    providerMessageId: null
  };
}

class OllamaProvider {
  constructor({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
    this.id = PROVIDER_IDS.OLLAMA;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async listModels({ signal } = {}) {
    const data = await requestJson(this.id, `${this.baseUrl}/api/tags`, {
      signal, timeoutMs: 10_000, fetchImpl: this.fetchImpl
    });
    if (!Array.isArray(data?.models)) throw new AssistantError('INVALID_RESPONSE', 'Ollama returned an invalid model list.', { provider: this.id });
    return data.models
      .filter((model) => model.capabilities?.includes('completion'))
      .map((model) => providerModel(this.id, {
        id: model.name || model.model,
        label: model.name || model.model,
        supportsTools: model.capabilities?.includes('tools'),
        details: model
      }));
  }

  async complete({ model, messages, tools = [], stream = false, signal, onEvent = () => {}, extra = {} }) {
    const payload = { model, messages: ollamaMessages(messages), stream, ...extra };
    const definitions = ollamaTools(tools);
    if (definitions.length > 0) payload.tools = definitions;
    if (!stream) {
      const data = await requestJson(this.id, `${this.baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
      });
      return parseOllamaMessage(data);
    }
    const response = await request(this.id, `${this.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
    });
    let final = null;
    let content = '';
    const calls = [];
    for await (const event of parseNdjson(response.body)) {
      final = event;
      const delta = event?.message?.content;
      if (typeof delta === 'string' && delta) {
        content += delta;
        onEvent({ type: 'text-delta', text: delta });
      }
      if (Array.isArray(event?.message?.tool_calls)) calls.push(...event.message.tool_calls);
    }
    const parsed = parseOllamaMessage({ ...(final || {}), message: { ...(final?.message || {}), content, tool_calls: calls } });
    return parsed;
  }
}

module.exports = { OllamaProvider, ollamaMessages, ollamaTools, parseOllamaMessage };
