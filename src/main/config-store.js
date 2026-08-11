'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_IDS } = require('./assistant/contracts');

const CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = 'config.json';
const PROVIDERS = new Set(Object.values(PROVIDER_IDS));
const LOCAL_PROVIDERS = new Set([PROVIDER_IDS.OLLAMA, PROVIDER_IDS.LM_STUDIO]);
const SECRET_KEYS = Object.freeze(['braveApiKey', 'openRouterApiKey', 'openCodeGoApiKey']);

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    secrets: {
      braveApiKey: '',
      openRouterApiKey: '',
      openCodeGoApiKey: ''
    },
    selection: {
      localProvider: PROVIDER_IDS.OLLAMA,
      hudProvider: PROVIDER_IDS.OLLAMA,
      models: {
        [PROVIDER_IDS.OLLAMA]: 'gemma4:e4b',
        [PROVIDER_IDS.LM_STUDIO]: '',
        [PROVIDER_IDS.OPENROUTER]: '',
        [PROVIDER_IDS.OPENCODE_GO]: ''
      }
    }
  };
}

function cleanString(value, max = 512) {
  return typeof value === 'string' && value.length <= max ? value.trim() : '';
}

function normalizeConfig(input) {
  const defaults = defaultConfig();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;
  if (input.version !== undefined && input.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported config version: ${input.version}`);
  }
  const config = structuredClone(defaults);
  for (const key of SECRET_KEYS) config.secrets[key] = cleanString(input.secrets?.[key], 4_096);
  const localProvider = input.selection?.localProvider;
  if (LOCAL_PROVIDERS.has(localProvider)) config.selection.localProvider = localProvider;
  const hudProvider = input.selection?.hudProvider;
  if (PROVIDERS.has(hudProvider)) config.selection.hudProvider = hudProvider;
  for (const provider of PROVIDERS) {
    config.selection.models[provider] = cleanString(input.selection?.models?.[provider], 240)
      || defaults.selection.models[provider];
  }
  return config;
}

function publicConfig(config) {
  return {
    version: config.version,
    selection: structuredClone(config.selection),
    credentials: {
      braveConfigured: Boolean(config.secrets.braveApiKey),
      openRouterConfigured: Boolean(config.secrets.openRouterApiKey),
      openCodeGoConfigured: Boolean(config.secrets.openCodeGoApiKey)
    }
  };
}

class ConfigStore {
  constructor(userDataPath, { fsImpl = fs } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
      throw new TypeError('ConfigStore requires an absolute userData path.');
    }
    this.fs = fsImpl;
    this.directory = userDataPath;
    this.filePath = path.join(userDataPath, CONFIG_FILE_NAME);
    this.config = null;
  }

  load() {
    if (this.config) return structuredClone(this.config);
    try {
      const raw = this.fs.readFileSync(this.filePath, 'utf8');
      this.config = normalizeConfig(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`Cannot load ${CONFIG_FILE_NAME}: ${error.message}`, { cause: error });
      this.config = defaultConfig();
    }
    return structuredClone(this.config);
  }

  get() {
    return this.load();
  }

  getPublic() {
    return publicConfig(this.load());
  }

  update(patch = {}) {
    const next = this.load();
    if (patch.selection && typeof patch.selection === 'object') {
      if (patch.selection.localProvider !== undefined) {
        if (!LOCAL_PROVIDERS.has(patch.selection.localProvider)) throw new TypeError('Invalid local provider.');
        next.selection.localProvider = patch.selection.localProvider;
      }
      if (patch.selection.hudProvider !== undefined) {
        if (!PROVIDERS.has(patch.selection.hudProvider)) throw new TypeError('Invalid HUD provider.');
        next.selection.hudProvider = patch.selection.hudProvider;
      }
      if (patch.selection.models && typeof patch.selection.models === 'object') {
        for (const [provider, model] of Object.entries(patch.selection.models)) {
          if (!PROVIDERS.has(provider)) throw new TypeError('Invalid model provider.');
          if (typeof model !== 'string' || model.length > 240) throw new TypeError('Invalid model ID.');
          next.selection.models[provider] = model.trim();
        }
      }
    }
    if (patch.secrets && typeof patch.secrets === 'object') {
      for (const [key, value] of Object.entries(patch.secrets)) {
        if (!SECRET_KEYS.includes(key)) throw new TypeError('Invalid secret setting.');
        if (typeof value !== 'string' || value.length > 4_096) throw new TypeError('Invalid secret value.');
        next.secrets[key] = value.trim();
      }
    }
    this.config = normalizeConfig(next);
    this.save();
    return this.getPublic();
  }

  save() {
    if (!this.config) this.config = defaultConfig();
    this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      this.fs.writeFileSync(temporaryPath, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.fs.renameSync(temporaryPath, this.filePath);
      this.fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        this.fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }
}

module.exports = {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  ConfigStore,
  LOCAL_PROVIDERS,
  SECRET_KEYS,
  defaultConfig,
  normalizeConfig,
  publicConfig
};
