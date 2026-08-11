'use strict';

const { normalizeMessages, normalizeTools, providerModel } = require('./contracts');
const { AssistantError } = require('./errors');
const { parseSse, request, requestJson } = require('./http');

function openAiTools(tools) {
  return normalizeTools(tools).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

function openAiMessages(messages) {
  return normalizeMessages(messages).map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, name: message.toolName, content: message.content };
    }
    const result = { role: message.role, content: message.content };
    if (message.toolCalls?.length) {
      result.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }));
    }
    return result;
  });
}

function parseArguments(value, provider) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments are not an object.');
    return parsed;
  } catch (error) {
    throw new AssistantError('INVALID_TOOL_CALL', `${provider} returned invalid tool arguments.`, { provider, cause: error });
  }
}

function parseChatMessage(provider, data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new AssistantError('INVALID_RESPONSE', `${provider} returned no assistant message.`, { provider });
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map((call, index) => ({
      id: call.id || `tool-call-${index + 1}`,
      name: call.function?.name,
      arguments: parseArguments(call.function?.arguments, provider)
    })) : [],
    finishReason: choice.finish_reason || null,
    usage: data.usage || null,
    providerMessageId: data.id || null
  };
}

class OpenAICompatibleClient {
  constructor({ provider, baseUrl, apiKey = null, fetchImpl = globalThis.fetch, defaultHeaders = {}, timeoutMs = 60_000 }) {
    this.provider = provider;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.defaultHeaders = { ...defaultHeaders };
    this.timeoutMs = timeoutMs;
  }

  headers() {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...this.defaultHeaders };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels({ signal } = {}) {
    const data = await requestJson(this.provider, `${this.baseUrl}/models`, {
      headers: this.headers(), signal, timeoutMs: 15_000, fetchImpl: this.fetchImpl
    });
    if (!Array.isArray(data?.data)) throw new AssistantError('INVALID_RESPONSE', `${this.provider} returned an invalid model list.`, { provider: this.provider });
    return data.data.map((model) => providerModel(this.provider, {
      id: model.id,
      label: model.name || model.id,
      supportsTools: Array.isArray(model.supported_parameters) ? model.supported_parameters.includes('tools') : undefined,
      details: model
    }));
  }

  async complete({ model, messages, tools = [], stream = false, signal, onEvent = () => {}, extra = {} }) {
    const payload = {
      model,
      messages: openAiMessages(messages),
      stream,
      ...extra
    };
    const definitions = openAiTools(tools);
    if (definitions.length > 0) {
      payload.tools = definitions;
      payload.tool_choice = 'auto';
    }
    if (!stream) {
      const data = await requestJson(this.provider, `${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal,
        timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
      });
      return parseChatMessage(this.provider, data);
    }

    const response = await request(this.provider, `${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal,
      timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
    });
    let content = '';
    let usage = null;
    let finishReason = null;
    const calls = new Map();
    for await (const event of parseSse(response.body)) {
      if (event?.error) throw new AssistantError('STREAM_ERROR', event.error.message || `${this.provider} stream failed.`, { provider: this.provider, details: event.error });
      if (event?.usage) usage = event.usage;
      const choice = event?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onEvent({ type: 'text-delta', text: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        const key = Number.isInteger(call.index) ? call.index : calls.size;
        const current = calls.get(key) || { id: '', name: '', arguments: '' };
        current.id += call.id || '';
        current.name += call.function?.name || '';
        current.arguments += call.function?.arguments || '';
        calls.set(key, current);
      }
    }
    const toolCalls = [...calls.values()].map((call, index) => ({
      id: call.id || `tool-call-${index + 1}`,
      name: call.name,
      arguments: parseArguments(call.arguments, this.provider)
    }));
    return { role: 'assistant', content, toolCalls, finishReason, usage, providerMessageId: null };
  }
}

module.exports = { OpenAICompatibleClient, openAiMessages, openAiTools, parseChatMessage };
