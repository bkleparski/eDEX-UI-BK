'use strict';

// Small glue between ConfigStore and ProviderRegistry: register the two
// cloud providers with whatever API key the store currently holds, and
// normalize/gate errors the same way for every caller. No Electron
// dependency — shared by src/main.js's registerAssistantIpc and
// src/server/index.js's HANDLERS.

const { PROVIDER_IDS } = require('./contracts');
const { OpenCodeGoProvider } = require('./opencode-go-provider');
const { OpenRouterProvider } = require('./openrouter-provider');

function configureCloudProviders(configStore, providerRegistry) {
  const config = configStore.get();
  providerRegistry.register(new OpenRouterProvider({ apiKey: config.secrets.openRouterApiKey }));
  providerRegistry.register(new OpenCodeGoProvider({ apiKey: config.secrets.openCodeGoApiKey }));
  return config;
}

function requireConfiguredCloudProvider(provider, config) {
  if (provider === PROVIDER_IDS.OPENROUTER && !config.secrets.openRouterApiKey) {
    throw new Error('OpenRouter API key is not configured.');
  }
  if (provider === PROVIDER_IDS.OPENCODE_GO && !config.secrets.openCodeGoApiKey) {
    throw new Error('OpenCode Go API key is not configured.');
  }
}

function assistantErrorPayload(error) {
  return {
    type: 'error',
    code: error?.code || 'ASSISTANT_ERROR',
    message: typeof error?.message === 'string' ? error.message : 'Assistant request failed.',
    provider: error?.provider || null,
    status: error?.status || null,
    retryAfter: error?.retryAfter || null
  };
}

module.exports = { configureCloudProviders, requireConfiguredCloudProvider, assistantErrorPayload };
