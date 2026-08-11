'use strict';

const { OpenCodeGoProvider } = require('../src/main/assistant/opencode-go-provider');
const { OpenRouterProvider } = require('../src/main/assistant/openrouter-provider');

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main() {
  const openRouter = new OpenRouterProvider({ apiKey: requiredEnvironment('OPENROUTER_API_KEY') });
  const openCodeGo = new OpenCodeGoProvider({ apiKey: requiredEnvironment('OPENCODE_GO_API_KEY') });
  const failures = [];

  try {
    const openCodeModels = await openCodeGo.listModels();
    const openCodeModel = openCodeModels.find((model) => model.id === 'opencode-go/kimi-k3')
      || openCodeModels.find((model) => model.id === 'kimi-k3');
    if (!openCodeModel) throw new Error('OpenCode Go catalog does not expose kimi-k3.');
    const reply = await openCodeGo.complete({
      model: openCodeModel.id,
      messages: [{ role: 'user', content: 'Reply with exactly EDEX_OK.' }],
      extra: { max_tokens: 256 }
    });
    if (!reply.content) throw new Error('OpenCode Go returned empty content.');
    console.log(`OpenCode Go live check passed with ${openCodeModel.id}.`);
  } catch (error) {
    failures.push(`OpenCode Go ${error.code || 'ERROR'} / ${error.message}`);
  }

  try {
    const keyStatus = await openRouter.testConnection();
    const openRouterModels = await openRouter.listModels();
    const paidModels = openRouterModels
      .map((model) => ({
        model,
        price: Number(model.details?.pricing?.prompt) + Number(model.details?.pricing?.completion)
      }))
      .filter((entry) => Number.isFinite(entry.price) && entry.price > 0)
      .sort((left, right) => left.price - right.price);
    const openRouterModel = openRouterModels.find((model) => model.id === 'openai/gpt-4.1-nano')
      || paidModels[0]?.model;
    if (!openRouterModel) throw new Error('OpenRouter returned no paid smoke-test model.');
    const reply = await openRouter.complete({
      model: openRouterModel.id,
      messages: [{ role: 'user', content: 'Reply with exactly EDEX_OK.' }],
      extra: { max_tokens: 32 }
    });
    if (!reply.content) throw new Error('OpenRouter returned empty content.');
    console.log(`OpenRouter live check passed: key ${keyStatus.ok ? 'valid' : 'unknown'} with ${openRouterModel.id}.`);
  } catch (error) {
    failures.push(`OpenRouter ${error.code || 'ERROR'} / ${error.message}`);
  }

  if (failures.length) throw new Error(failures.join(' | '));
}

main().catch((error) => {
  console.error(`Cloud provider integration failed: ${error.code || 'ERROR'} / ${error.message}`);
  process.exitCode = 1;
});
