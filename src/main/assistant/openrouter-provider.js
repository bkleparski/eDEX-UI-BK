'use strict';

const { PROVIDER_IDS } = require('./contracts');
const { OpenAICompatibleClient } = require('./openai-compatible-client');
const { requestJson } = require('./http');

class OpenRouterProvider {
  constructor({ apiKey, baseUrl = 'https://openrouter.ai/api/v1', fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
    this.id = PROVIDER_IDS.OPENROUTER;
    this.client = new OpenAICompatibleClient({
      provider: this.id,
      baseUrl,
      apiKey,
      fetchImpl,
      timeoutMs,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/BartekKleparski/eDEX-UI-BK',
        'X-Title': 'EBARTNET-UI'
      }
    });
  }

  listModels(options) {
    return this.client.listModels(options);
  }

  async testConnection({ signal } = {}) {
    const data = await requestJson(this.id, `${this.client.baseUrl}/key`, {
      headers: this.client.headers(), signal, timeoutMs: 15_000, fetchImpl: this.client.fetchImpl
    });
    return { ok: true, label: data?.data?.label || null, limit: data?.data?.limit ?? null };
  }

  complete(options) {
    const extra = {
      ...options.extra,
      provider: { data_collection: 'deny', ...(options.extra?.provider || {}) }
    };
    return this.client.complete({ ...options, extra });
  }
}

module.exports = { OpenRouterProvider };
