'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listTerminalFiles } = require('../src/main/files-operations');

// listTerminalFiles no longer derives cwd itself (that used to mean an
// independent terminalWorkingDirectory() call that was always null on
// win32, blind to whatever OSC 7 had already reported into the session's
// tracked state — see terminal-metadata.js). It now trusts whatever the
// caller already has tracked and falls back to the home directory only
// when that's genuinely unknown.
test('listTerminalFiles lists the tracked cwd when one is provided', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edex-files-test-'));
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'hi');
  const result = await listTerminalFiles({ pid: 1 }, 'tty-01', false, dir);
  assert.equal(result.status, 'ok');
  assert.equal(result.cwd, dir);
  assert.ok(result.entries.some((entry) => entry.name === 'marker.txt'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listTerminalFiles falls back to the home directory when no cwd is tracked yet', async () => {
  // The exact win32 case: OSC 7 hasn't reported anything yet (panel opened
  // before the first prompt, or a cmd.exe session that never will).
  const result = await listTerminalFiles({ pid: 1 }, 'tty-01', false, null);
  assert.equal(result.status, 'ok');
  assert.equal(result.cwd, os.homedir());
});

test('listTerminalFiles ignores a non-string trackedCwd and falls back to the home directory', async () => {
  const result = await listTerminalFiles({ pid: 1 }, 'tty-01', false, undefined);
  assert.equal(result.status, 'ok');
  assert.equal(result.cwd, os.homedir());
});
