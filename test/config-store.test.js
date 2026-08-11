'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ConfigStore, defaultConfig } = require('../src/main/config-store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edex-config-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('ConfigStore returns defaults without writing until update', (t) => {
  const directory = temporaryDirectory(t);
  const store = new ConfigStore(directory);
  assert.deepEqual(store.get(), defaultConfig());
  assert.equal(fs.existsSync(path.join(directory, 'config.json')), false);
});

test('ConfigStore writes secrets atomically with owner-only permissions and never exposes values', (t) => {
  const directory = temporaryDirectory(t);
  const store = new ConfigStore(directory);
  const visible = store.update({
    secrets: { braveApiKey: 'brave-secret', openRouterApiKey: 'router-secret', openCodeGoApiKey: 'go-secret' },
    selection: { localProvider: 'lmstudio', hudProvider: 'openrouter', models: { lmstudio: 'google/gemma-4-12b' } }
  });
  assert.deepEqual(visible.credentials, {
    braveConfigured: true,
    openRouterConfigured: true,
    openCodeGoConfigured: true
  });
  assert.equal(JSON.stringify(visible).includes('secret'), false);
  const filePath = path.join(directory, 'config.json');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(directory).some((name) => name.includes('.tmp-')), false);
  const reloaded = new ConfigStore(directory).get();
  assert.equal(reloaded.secrets.braveApiKey, 'brave-secret');
  assert.equal(reloaded.selection.models.lmstudio, 'google/gemma-4-12b');
});

test('ConfigStore rejects unknown providers and schema versions', (t) => {
  const directory = temporaryDirectory(t);
  const store = new ConfigStore(directory);
  assert.throws(() => store.update({ selection: { hudProvider: 'remote-anything' } }), /Invalid HUD provider/);
  fs.writeFileSync(path.join(directory, 'config.json'), '{"version":99}\n');
  assert.throws(() => new ConfigStore(directory).get(), /Unsupported config version/);
});
