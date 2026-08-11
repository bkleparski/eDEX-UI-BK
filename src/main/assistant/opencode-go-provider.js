'use strict';

const { PROVIDER_IDS, normalizeMessages, normalizeTools, providerModel } = require('./contracts');
const { AssistantError } = require('./errors');
const { parseSse, request, requestJson } = require('./http');
const { OpenAICompatibleClient } = require('./openai-compatible-client');

const PROTOCOLS = Object.freeze({
  'grok-4.5': 'chat',
  'glm-5.2': 'chat',
  'glm-5.1': 'chat',
  'kimi-k3': 'chat',
  'kimi-k2.7-code': 'chat',
  'kimi-k2.6': 'chat',
  'deepseek-v4-pro': 'chat',
  'deepseek-v4-flash': 'chat',
  'mimo-v2.5': 'chat',
  'mimo-v2.5-pro': 'chat',
  hy3: 'chat',
  'gpt-5.6-luna': 'responses',
  'minimax-m3': 'messages',
  'minimax-m2.7': 'messages',
  'minimax-m2.5': 'messages',
  'qwen3.8-max': 'messages',
  'qwen3.7-max': 'messages',
  'qwen3.7-plus': 'messages',
  'qwen3.6-plus': 'messages'
});

function bareModelId(model) {
  return String(model).replace(/^opencode-go\//, '');
}

function protocolForModel(model) {
  return PROTOCOLS[bareModelId(model)] || null;
}

function responseTools(tools) {
  return normalizeTools(tools).map((tool) => ({
    type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema
  }));
}

function responseInput(messages) {
  const input = [];
  for (const message of normalizeMessages(messages)) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    input.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls || []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return input;
}

function parseResponsesResult(data) {
  const content = [];
  const toolCalls = [];
  for (const item of data?.output || []) {
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if (block.type === 'output_text' && typeof block.text === 'string') content.push(block.text);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        name: item.name,
        arguments: parseJsonArguments(item.arguments, PROVIDER_IDS.OPENCODE_GO)
      });
    }
  }
  return {
    role: 'assistant', content: content.join(''), toolCalls,
    finishReason: data?.status || null, usage: data?.usage || null, providerMessageId: data?.id || null
  };
}

function anthropicPayload(messages, tools) {
  const normalized = normalizeMessages(messages);
  const system = normalized.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const output = [];
  for (const message of normalized.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      output.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] });
      continue;
    }
    const content = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls || []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    output.push({ role: message.role, content });
  }
  const payload = { messages: output };
  if (system) payload.system = system;
  const definitions = normalizeTools(tools).map((tool) => ({
    name: tool.name, description: tool.description, input_schema: tool.inputSchema
  }));
  if (definitions.length) payload.tools = definitions;
  return payload;
}

function parseJsonArguments(value, provider) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new AssistantError('INVALID_TOOL_CALL', `${provider} returned invalid tool arguments.`, { provider, cause: error });
  }
}

function parseAnthropicResult(data) {
  const text = [];
  const toolCalls = [];
  for (const block of data?.content || []) {
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} });
  }
  return {
    role: 'assistant', content: text.join(''), toolCalls,
    finishReason: data?.stop_reason || null, usage: data?.usage || null, providerMessageId: data?.id || null
  };
}

class OpenCodeGoProvider {
  constructor({ apiKey, baseUrl = 'https://opencode.ai/zen/go/v1', fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
    this.id = PROVIDER_IDS.OPENCODE_GO;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.chatClient = new OpenAICompatibleClient({ provider: this.id, baseUrl: this.baseUrl, apiKey, fetchImpl, timeoutMs });
  }

  headers() {
    return this.chatClient.headers();
  }

  async listModels({ signal } = {}) {
    const data = await requestJson(this.id, `${this.baseUrl}/models`, {
      headers: this.headers(), signal, timeoutMs: 15_000, fetchImpl: this.fetchImpl
    });
    if (!Array.isArray(data?.data)) throw new AssistantError('INVALID_RESPONSE', 'OpenCode Go returned an invalid model list.', { provider: this.id });
    return data.data.map((model) => {
      const protocol = protocolForModel(model.id);
      return providerModel(this.id, {
        id: model.id, label: model.name || model.id, protocol,
        supportsTools: protocol !== null, available: protocol !== null,
        details: { ...model, unsupportedReason: protocol ? null : 'protocol-unknown' }
      });
    });
  }

  testConnection(options) {
    return this.listModels(options).then((models) => ({ ok: true, catalogOnly: true, modelCount: models.length }));
  }

  complete(options) {
    const protocol = protocolForModel(options.model);
    if (protocol === 'chat') return this.chatClient.complete(options);
    if (protocol === 'responses') return this.completeResponses(options);
    if (protocol === 'messages') return this.completeAnthropic(options);
    throw new AssistantError('UNSUPPORTED_MODEL_PROTOCOL', `No OpenCode Go protocol is registered for ${options.model}.`, { provider: this.id });
  }

  async completeResponses({ model, messages, tools = [], stream = false, signal, onEvent = () => {}, extra = {} }) {
    const payload = { model, input: responseInput(messages), stream, ...extra };
    const definitions = responseTools(tools);
    if (definitions.length) payload.tools = definitions;
    if (!stream) {
      const data = await requestJson(this.id, `${this.baseUrl}/responses`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal,
        timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
      });
      return parseResponsesResult(data);
    }
    const response = await request(this.id, `${this.baseUrl}/responses`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal,
      timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
    });
    let completed = null;
    let content = '';
    for await (const event of parseSse(response.body)) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        content += event.delta;
        onEvent({ type: 'text-delta', text: event.delta });
      }
      if (event.type === 'response.completed') completed = event.response;
      if (event.type === 'response.failed') throw new AssistantError('STREAM_ERROR', event.response?.error?.message || 'OpenCode Go response failed.', { provider: this.id });
    }
    const result = parseResponsesResult(completed || { output: [] });
    if (!result.content && content) result.content = content;
    return result;
  }

  async completeAnthropic({ model, messages, tools = [], stream = false, signal, onEvent = () => {}, extra = {} }) {
    const payload = { model, max_tokens: 4096, stream, ...anthropicPayload(messages, tools), ...extra };
    if (!stream) {
      const data = await requestJson(this.id, `${this.baseUrl}/messages`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal,
        timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
      });
      return parseAnthropicResult(data);
    }
    const response = await request(this.id, `${this.baseUrl}/messages`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal,
      timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl
    });
    let content = '';
    let finishReason = null;
    let usage = null;
    const calls = new Map();
    for await (const event of parseSse(response.body)) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' });
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        content += event.delta.text || '';
        if (event.delta.text) onEvent({ type: 'text-delta', text: event.delta.text });
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const call = calls.get(event.index);
        if (call) call.arguments += event.delta.partial_json || '';
      } else if (event.type === 'message_delta') {
        finishReason = event.delta?.stop_reason || finishReason;
        usage = event.usage || usage;
      } else if (event.type === 'error') {
        throw new AssistantError('STREAM_ERROR', event.error?.message || 'OpenCode Go message failed.', { provider: this.id });
      }
    }
    return {
      role: 'assistant', content,
      toolCalls: [...calls.values()].map((call) => ({ ...call, arguments: parseJsonArguments(call.arguments, this.id) })),
      finishReason, usage, providerMessageId: null
    };
  }
}

module.exports = {
  OpenCodeGoProvider,
  PROTOCOLS,
  anthropicPayload,
  bareModelId,
  parseAnthropicResult,
  parseResponsesResult,
  protocolForModel,
  responseInput,
  responseTools
};
