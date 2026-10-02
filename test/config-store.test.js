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
    openCodeGoConfigured: true,
    hermesConfigured: false
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

test('Hermes URL/key settings migrate old configs and never expose the key', (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ version: 1,
    secrets: { openRouterApiKey: 'existing' }, selection: { hudProvider: 'openrouter' } }));
  const store = new ConfigStore(directory);
  assert.equal(store.get().endpoints.hermesUrl, '');
  assert.equal(store.get().selection.models.hermes, 'hermes-agent');
  assert.equal(store.getPublic().credentials.hermesConfigured, false);
  const visible = store.update({ secrets: { hermesApiKey: 'hidden-hermes-key' },
    endpoints: { hermesUrl: ' https://hermes:8642/// ' }, selection: { hudProvider: 'hermes' } });
  assert.equal(visible.endpoints.hermesUrl, 'https://hermes:8642');
  assert.equal(visible.credentials.hermesConfigured, true);
  assert.equal(JSON.stringify(visible).includes('hidden-hermes-key'), false);
  assert.equal(new ConfigStore(directory).get().secrets.hermesApiKey, 'hidden-hermes-key');
  assert.equal(store.get().secrets.openRouterApiKey, 'existing');
  assert.equal(store.update({ secrets: { hermesApiKey: '' } }).credentials.hermesConfigured, false);
  assert.equal(store.update({ endpoints: { hermesUrl: '' } }).endpoints.hermesUrl, '');
});

test('Hermes URL validation rejects credentials, invalid protocols, malformed and excessive URLs', (t) => {
  const store = new ConfigStore(temporaryDirectory(t));
  for (const url of ['ftp://hermes', 'file:///tmp/a', 'http://user:password@hermes', 'http://user@hermes',
    'not a URL', 'http://', 'https://hermes/' + 'x'.repeat(300), 'http://hermes?token=secret', 'http://hermes#fragment', 123]) {
    assert.throws(() => store.update({ endpoints: { hermesUrl: url } }), /Invalid Hermes URL/);
    assert.equal(store.get().endpoints.hermesUrl, '');
  }
  assert.equal(store.update({ endpoints: { hermesUrl: 'http://100.64.0.1:8642/' } }).endpoints.hermesUrl, 'http://100.64.0.1:8642');
});

test('an invalid stored Hermes URL does not break loading the rest of the config', () => {
  const { normalizeConfig } = require('../src/main/config-store');
  const config = normalizeConfig({ secrets: { openRouterApiKey: 'kept' }, endpoints: { hermesUrl: 'ftp://nope' } });
  assert.equal(config.endpoints.hermesUrl, '');
  assert.equal(config.secrets.openRouterApiKey, 'kept');
});
