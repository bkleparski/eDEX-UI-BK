'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { AssistantService } = require('../src/main/assistant/assistant-service');
const { LocalCliBridge } = require('../src/main/assistant/local-cli-bridge');
const { LMStudioProvider } = require('../src/main/assistant/lmstudio-provider');
const { OllamaProvider } = require('../src/main/assistant/ollama-provider');
const { ProviderRegistry } = require('../src/main/assistant/provider-registry');
const { ConfigStore } = require('../src/main/config-store');

const execFileAsync = promisify(execFile);

async function main() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'edex-cli-live-'));
  const ollama = new OllamaProvider();
  const lmstudio = new LMStudioProvider();
  const registry = new ProviderRegistry([ollama, lmstudio]);
  const configStore = new ConfigStore(temporaryDirectory);
  let bridge;
  try {
    const [ollamaModels, lmstudioModels] = await Promise.all([ollama.listModels(), lmstudio.listModels()]);
    const ollamaModel = ollamaModels.find((model) => model.id === 'gemma4:e4b')?.id || ollamaModels[0]?.id;
    const lmstudioModel = lmstudioModels.find((model) => model.id === 'google/gemma-4-12b')?.id || lmstudioModels[0]?.id;
    if (!ollamaModel || !lmstudioModel) throw new Error('Both local providers need at least one completion model.');
    configStore.update({ selection: { models: { ollama: ollamaModel, lmstudio: lmstudioModel } } });
    const assistantService = new AssistantService({ registry, configStore });
    bridge = new LocalCliBridge({ userDataPath: temporaryDirectory, assistantService, configStore });
    await bridge.start();
    const environment = { ...process.env, ...bridge.environment(path.join(__dirname, '..', 'resources', 'bin')) };
    for (const args of [
      ['Reply with exactly EDEX_OK and nothing else.'],
      ['--lms', 'Reply with exactly EDEX_OK and nothing else.']
    ]) {
      const { stdout } = await execFileAsync(path.join(__dirname, '..', 'resources', 'bin', 'ai'), args, {
        env: environment, timeout: 180_000, maxBuffer: 1024 * 1024
      });
      if (!stdout.includes('EDEX_OK')) throw new Error(`Unexpected local CLI response: ${stdout.slice(0, 200)}`);
    }
    console.log(`Local CLI integration passed: Ollama ${ollamaModel}; LM Studio ${lmstudioModel}.`);
  } finally {
    await bridge?.stop();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Local CLI integration failed: ${error.message}`);
  process.exitCode = 1;
});
