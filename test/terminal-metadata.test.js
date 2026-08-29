'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  defaultShell, shellSpawnArgs, processIdentity, terminalWorkingDirectory, collectTerminalMetadata
} = require('../src/main/terminal-metadata');

// These tests run on whatever CI/dev machine executes `npm run test:unit`
// (currently always POSIX) — real Windows verification is W1's job for
// Bartek's PC. Passing an explicit `platform` argument exercises the win32
// branches without touching the real process.platform; note `path.join`
// here is still the POSIX-flavored module (no win32 machine to run this
// on), so the fixtures below are self-consistent joins, not literal
// Windows-formatted paths — good enough to prove the *search order*.
function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'edex-shell-test-'));
}

test('defaultShell on win32 prefers pwsh.exe when it is on PATH', () => {
  const pathDir = makeTempDir();
  const pwshPath = path.join(pathDir, 'pwsh.exe');
  fs.writeFileSync(pwshPath, '');
  withEnv({ PATH: pathDir, SystemRoot: makeTempDir() }, () => {
    assert.equal(defaultShell('win32'), pwshPath);
  });
});

test('defaultShell on win32 falls back to Windows PowerShell when pwsh.exe is not on PATH', () => {
  const systemRoot = makeTempDir();
  const powershellDir = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  fs.mkdirSync(powershellDir, { recursive: true });
  const powershellPath = path.join(powershellDir, 'powershell.exe');
  fs.writeFileSync(powershellPath, '');
  withEnv({ PATH: makeTempDir(), SystemRoot: systemRoot }, () => {
    assert.equal(defaultShell('win32'), powershellPath);
  });
});

test('defaultShell on win32 falls back to cmd.exe when neither pwsh nor Windows PowerShell exist', () => {
  const systemRoot = makeTempDir();
  withEnv({ PATH: makeTempDir(), SystemRoot: systemRoot }, () => {
    assert.equal(defaultShell('win32'), path.join(systemRoot, 'System32', 'cmd.exe'));
  });
});

test('defaultShell falls through to the POSIX zsh/bash/sh chain for every non-win32 platform value', () => {
  assert.equal(defaultShell('darwin'), defaultShell('linux'));
  assert.notEqual(defaultShell('linux'), undefined);
});

test('shellSpawnArgs drops the POSIX login flag on win32 only', () => {
  assert.deepEqual(shellSpawnArgs('win32'), []);
  assert.deepEqual(shellSpawnArgs('darwin'), ['-l']);
  assert.deepEqual(shellSpawnArgs('linux'), ['-l']);
});

test('processIdentity recognizes Windows shells as idle regardless of case or the .exe suffix', () => {
  assert.equal(processIdentity('powershell.exe').idle, true);
  assert.equal(processIdentity('PowerShell.EXE').idle, true);
  assert.equal(processIdentity('pwsh.exe').idle, true);
  assert.equal(processIdentity('PWSH').idle, true);
  assert.equal(processIdentity('cmd.exe').idle, true);
  assert.equal(processIdentity('CMD.EXE -k').idle, true);
});

test('processIdentity strips the .exe suffix from the reported name', () => {
  assert.equal(processIdentity('powershell.exe').name, 'powershell');
  assert.equal(processIdentity('PowerShell.EXE -NoLogo').name, 'powershell');
  assert.equal(processIdentity('cmd.exe').name, 'cmd');
});

test('processIdentity still treats a real foreground command as non-idle', () => {
  assert.equal(processIdentity('node build.js').idle, false);
  assert.equal(processIdentity('vim.exe notes.txt').idle, false);
});

test('terminalWorkingDirectory resolves to null on win32 instead of throwing (no /proc, no lsof)', async () => {
  const result = await terminalWorkingDirectory({ pid: 4242 }, 'win32');
  assert.equal(result, null);
});

test('collectTerminalMetadata falls back to the process name when idle but cwd is unknown (the win32 case)', async () => {
  const state = { cwd: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
  // No pid makes terminalWorkingDirectory throw "Terminal process unavailable"
  // — the same "stay null" outcome win32 reaches via its own explicit branch.
  const terminal = { pid: undefined, process: 'powershell.exe' };
  const result = await collectTerminalMetadata(terminal, state, Date.now());
  assert.equal(result.idle, true);
  assert.equal(result.cwd, null);
  assert.equal(result.label, 'powershell');
});
