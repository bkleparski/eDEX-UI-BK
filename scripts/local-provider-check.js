'use strict';

const assert = require('node:assert/strict');
const { LMStudioProvider } = require('../src/main/assistant/lmstudio-provider');
const { OllamaProvider } = require('../src/main/assistant/ollama-provider');

const diagnosticTool = {
  name: 'echo_token',
  description: 'Return a diagnostic token.',
  inputSchema: {
    type: 'object',
    properties: { token: { type: 'string' } },
    required: ['token'],
    additionalProperties: false
  }
};

async function testProvider(provider, requestedModel) {
  const models = await provider.listModels();
  assert(models.length > 0, `${provider.id} returned no chat models.`);
  const model = requestedModel || models[0].id;
  assert(models.some((item) => item.id === model), `${provider.id} model ${model} is unavailable.`);
  const response = await provider.complete({
    model,
    messages: [{ role: 'user', content: 'You must call echo_token once with token EDEX_TEST.' }],
    tools: [diagnosticTool],
    stream: false,
    extra: provider.id === 'ollama' ? { options: { num_predict: 256 } } : { max_tokens: 256 }
  });
  assert.equal(response.toolCalls.length, 1, `${provider.id} did not return exactly one tool call.`);
  assert.equal(response.toolCalls[0].name, 'echo_token');
  assert.equal(response.toolCalls[0].arguments.token, 'EDEX_TEST');
  process.stdout.write(`${provider.id}: ${model} tool-call verified\n`);
}

async function main() {
  await testProvider(new OllamaProvider(), process.env.EDEX_TEST_OLLAMA_MODEL || 'gemma4:e4b');
  await testProvider(new LMStudioProvider(), process.env.EDEX_TEST_LMS_MODEL);
}

main().catch((error) => {
  process.stderr.write(`Local provider test failed: ${error.message}\n`);
  process.exitCode = 1;
});
