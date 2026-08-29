'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalCliBridge, sanitizeTerminalText } = require('../../src/main/assistant/local-cli-bridge');

function requestBridge(bridge, { command = '/ai', body = 'hello', provider = 'ollama', token = bridge.token } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: bridge.socketPath,
      path: command,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-eDEX-Provider': provider,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function bridgeFixture(t, run, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edex-cli-test-'));
  const calls = [];
  const assistantService = {
    async run(request, { onEvent }) {
      calls.push(request);
      await run(request, onEvent);
      onEvent({ type: 'sources', sources: [{ title: '\u001b[31mExample', url: 'https://example.test/result' }] });
      return { content: 'done' };
    }
  };
  const configStore = { get: () => ({ selection: { models: { ollama: 'gemma4:e4b', lmstudio: 'google/gemma-4-12b' } } }) };
  const bridge = new LocalCliBridge({ userDataPath: directory, assistantService, configStore, ...options });
  await bridge.start();
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { bridge, calls };
}

function requestBridgeTcp(bridge, { command = '/ai', body = 'hello', provider = 'ollama', token = bridge.token } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: bridge.port,
      path: command,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-eDEX-Provider': provider,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('terminal sanitizer removes ANSI, OSC and control bytes', () => {
  assert.equal(sanitizeTerminalText('\u001b[31mRED\u001b[0m\u001b]0;title\u0007\u0000OK\r'), 'REDOK\n');
});

test('CLI bridge rejects requests without its per-process token', async (t) => {
  const { bridge, calls } = await bridgeFixture(t, async () => {});
  const response = await requestBridge(bridge, { token: 'invalid' });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('CLI bridge routes search --lms locally and sanitizes streamed output', async (t) => {
  const { bridge, calls } = await bridgeFixture(t, async (_request, onEvent) => {
    onEvent({ type: 'text-delta', text: '\u001b[32mANSWER\u001b[0m' });
  });
  const response = await requestBridge(bridge, { command: '/search', provider: 'lmstudio', body: 'current query' });
  assert.equal(response.status, 200);
  assert.equal(calls[0].provider, 'lmstudio');
  assert.equal(calls[0].model, 'google/gemma-4-12b');
  assert.equal(calls[0].mode, 'search');
  assert.equal(calls[0].surface, 'terminal');
  assert.equal(response.body.includes('\u001b'), false);
  assert.equal(response.body.includes('ANSWER'), true);
  assert.equal(response.body.includes('https://example.test/result'), true);
});

test('CLI bridge keeps concurrent terminal requests independent', async (t) => {
  const { bridge, calls } = await bridgeFixture(t, async (request, onEvent) => {
    await new Promise((resolve) => setTimeout(resolve, request.provider === 'ollama' ? 8 : 2));
    onEvent({ type: 'text-delta', text: request.provider });
  });
  const [ollama, lmstudio] = await Promise.all([
    requestBridge(bridge, { body: 'one' }),
    requestBridge(bridge, { body: 'two', provider: 'lmstudio' })
  ]);
  assert.equal(ollama.body.startsWith('ollama'), true);
  assert.equal(lmstudio.body.startsWith('lmstudio'), true);
  assert.deepEqual(new Set(calls.map((call) => call.provider)), new Set(['ollama', 'lmstudio']));
});

test('on win32 the bridge listens on loopback TCP instead of a unix socket', async (t) => {
  const { bridge } = await bridgeFixture(t, async (_request, onEvent) => {
    onEvent({ type: 'text-delta', text: 'pong' });
  }, { platform: 'win32' });
  assert.equal(typeof bridge.port, 'number');
  assert.ok(bridge.port > 0);
  const response = await requestBridgeTcp(bridge);
  assert.equal(response.status, 200);
  assert.equal(response.body.startsWith('pong'), true);
});

test('win32 environment() exposes EDEX_AI_PORT and a ; PATH, never EDEX_AI_SOCKET', async (t) => {
  const { bridge } = await bridgeFixture(t, async () => {}, { platform: 'win32' });
  const env = bridge.environment('C:\\edex\\bin');
  assert.equal(env.EDEX_AI_PORT, String(bridge.port));
  assert.equal('EDEX_AI_SOCKET' in env, false);
  assert.ok(env.PATH.startsWith(`C:\\edex\\bin${path.delimiter}`));
});

test('non-win32 environment() keeps EDEX_AI_SOCKET and never exposes EDEX_AI_PORT', async (t) => {
  const { bridge } = await bridgeFixture(t, async () => {});
  const env = bridge.environment('/edex/bin');
  assert.equal(env.EDEX_AI_SOCKET, bridge.socketPath);
  assert.equal('EDEX_AI_PORT' in env, false);
});

test('win32 loopback bridge still enforces its per-process token', async (t) => {
  const { bridge, calls } = await bridgeFixture(t, async () => {}, { platform: 'win32' });
  const response = await requestBridgeTcp(bridge, { token: 'invalid' });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});
