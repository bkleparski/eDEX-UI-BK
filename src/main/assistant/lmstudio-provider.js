'use strict';

const { PROVIDER_IDS } = require('./contracts');
const { OpenAICompatibleClient } = require('./openai-compatible-client');

const EMBEDDING_MODEL_PATTERN = /(?:^|[\/_-])(?:embed|embedding)(?:$|[\/_-])/i;

class LMStudioProvider {
  constructor({ baseUrl = 'http://127.0.0.1:1234/v1', fetchImpl = globalThis.fetch, timeoutMs = 180_000 } = {}) {
    this.id = PROVIDER_IDS.LM_STUDIO;
    this.client = new OpenAICompatibleClient({
      provider: this.id,
      baseUrl,
      fetchImpl,
      timeoutMs
    });
  }

  async listModels(options = {}) {
    const models = await this.client.listModels(options);
    return models
      .filter((model) => !EMBEDDING_MODEL_PATTERN.test(model.id))
      .map((model) => ({ ...model, supportsTools: true, toolSupportKnown: false }));
  }

  complete(options) {
    return this.client.complete(options);
  }
}

module.exports = { EMBEDDING_MODEL_PATTERN, LMStudioProvider };
