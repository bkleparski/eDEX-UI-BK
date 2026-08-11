'use strict';

const { PROVIDER_IDS } = require('./contracts');
const { AssistantError } = require('./errors');
const { LMStudioProvider } = require('./lmstudio-provider');
const { OllamaProvider } = require('./ollama-provider');

class ProviderRegistry {
  constructor(providers = [new OllamaProvider(), new LMStudioProvider()]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  register(provider) {
    if (!provider?.id || typeof provider.complete !== 'function' || typeof provider.listModels !== 'function') {
      throw new TypeError('Invalid assistant provider.');
    }
    this.providers.set(provider.id, provider);
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new AssistantError('PROVIDER_UNAVAILABLE', `Provider ${id} is not available.`, { provider: id });
    return provider;
  }

  async listModels(id, options) {
    return this.get(id).listModels(options);
  }

  isLocal(id) {
    return id === PROVIDER_IDS.OLLAMA || id === PROVIDER_IDS.LM_STUDIO;
  }
}

module.exports = { ProviderRegistry };
