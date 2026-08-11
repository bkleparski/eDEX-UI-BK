'use strict';

const PROVIDER_IDS = Object.freeze({
  OLLAMA: 'ollama',
  LM_STUDIO: 'lmstudio',
  OPENROUTER: 'openrouter',
  OPENCODE_GO: 'opencode-go'
});

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MAX_PROMPT_CHARS = 32_000;
const MAX_TOOL_RESULT_CHARS = 48_000;

function requireString(value, field, { max = MAX_PROMPT_CHARS, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || value.length > max) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value;
}

function normalizeToolCall(call, index = 0) {
  const name = requireString(call?.name, 'tool call name', { max: 64 });
  const args = call?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('Invalid tool call arguments.');
  }
  return {
    id: typeof call.id === 'string' && call.id ? call.id : `tool-call-${index + 1}`,
    name,
    arguments: { ...args }
  };
}

function normalizeMessage(message, index = 0) {
  const role = message?.role;
  if (!MESSAGE_ROLES.has(role)) throw new TypeError('Invalid message role.');
  const normalized = {
    role,
    content: requireString(message.content ?? '', 'message content', {
      max: role === 'tool' ? MAX_TOOL_RESULT_CHARS : MAX_PROMPT_CHARS,
      allowEmpty: role === 'assistant'
    })
  };
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    normalized.toolCalls = message.toolCalls.map(normalizeToolCall);
  }
  if (role === 'tool') {
    normalized.toolCallId = requireString(message.toolCallId, 'tool call ID', { max: 160 });
    normalized.toolName = requireString(message.toolName, 'tool name', { max: 64 });
  }
  if (typeof message.providerMessageId === 'string') normalized.providerMessageId = message.providerMessageId;
  normalized.index = index;
  return normalized;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 80) {
    throw new TypeError('Invalid messages collection.');
  }
  return messages.map(normalizeMessage).map(({ index: _index, ...message }) => message);
}

function normalizeToolDefinition(tool) {
  const name = requireString(tool?.name, 'tool name', { max: 64 });
  const description = requireString(tool?.description, 'tool description', { max: 1_024 });
  const inputSchema = tool?.inputSchema;
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new TypeError('Invalid tool input schema.');
  }
  return { name, description, inputSchema: structuredClone(inputSchema) };
}

function normalizeTools(tools = []) {
  if (!Array.isArray(tools) || tools.length > 8) throw new TypeError('Invalid tools collection.');
  return tools.map(normalizeToolDefinition);
}

function providerModel(provider, model) {
  return {
    provider,
    id: requireString(model?.id, 'model ID', { max: 240 }),
    label: typeof model.label === 'string' && model.label.trim() ? model.label : model.id,
    protocol: model.protocol || null,
    supportsTools: model.supportsTools === true,
    toolSupportKnown: typeof model.supportsTools === 'boolean',
    available: model.available !== false,
    details: model.details && typeof model.details === 'object' ? structuredClone(model.details) : {}
  };
}

module.exports = {
  MAX_PROMPT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  PROVIDER_IDS,
  normalizeMessages,
  normalizeToolCall,
  normalizeTools,
  providerModel,
  requireString
};
