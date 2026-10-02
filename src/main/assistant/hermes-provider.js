'use strict';

const { PROVIDER_IDS, requireString } = require('./contracts');
const { OpenAICompatibleClient } = require('./openai-compatible-client');
const { requestJson } = require('./http');

class HermesProvider {
  constructor({ hermesUrl = '', apiKey, fetchImpl = globalThis.fetch } = {}) {
    this.id = PROVIDER_IDS.HERMES;
    this.agent = true;
    this.hermesUrl = hermesUrl.replace(/\/+$/, '');
    this.client = new OpenAICompatibleClient({
      provider: this.id, baseUrl: `${this.hermesUrl}/v1`, apiKey, fetchImpl, timeoutMs: 120_000
    });
  }

  listModels(options) {
    return this.client.listModels(options);
  }

  async testConnection({ signal } = {}) {
    await requestJson(this.id, `${this.hermesUrl}/health`, {
      headers: this.client.headers(), signal, timeoutMs: 15_000, fetchImpl: this.client.fetchImpl
    });
    return { ok: true };
  }

  complete({ model, messages, sessionId, stream, signal, onEvent }) {
    requireString(sessionId, 'Hermes session ID', { max: 125 });
    if (/[\r\n\x00]/.test(sessionId)) throw new TypeError('Invalid Hermes session ID.');
    return this.client.complete({
      model, messages, stream, signal, onEvent, headers: { 'X-Hermes-Session-Id': sessionId }
    });
  }
}

module.exports = { HermesProvider };
