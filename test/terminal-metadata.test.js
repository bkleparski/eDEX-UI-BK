'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  defaultShell, shellDisplayName, shellSpawnArgs, win32ShellArgs, processIdentity, terminalWorkingDirectory,
  collectTerminalMetadata, sanitizeReportedCwd, reportTerminalCwd
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

test('win32ShellArgs injects the OSC 7 prompt wrapper for pwsh.exe and powershell.exe', () => {
  const scriptDir = makeTempDir();
  const scriptPath = path.join(scriptDir, 'osc7-prompt.ps1');
  const scriptSource = "function global:prompt { 'PS> ' }";
  fs.writeFileSync(scriptPath, scriptSource, 'utf8');

  // Forward slashes, not backslashes — path.basename on this (POSIX) test
  // runner only splits on '/'. On real Windows, `path` is win32-flavored and
  // splits on '\' too; see the module-level comment in
  // test/terminal-metadata.test.js about this being a POSIX-runner limit.
  for (const shell of ['C:/Tools/pwsh.exe', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'C:/x/POWERSHELL.EXE']) {
    const args = win32ShellArgs(shell, scriptPath);
    assert.deepEqual(args.slice(0, 2), ['-NoExit', '-EncodedCommand']);
    assert.equal(Buffer.from(args[2], 'base64').toString('utf16le'), scriptSource);
  }
});

test('win32ShellArgs returns no extra args for cmd.exe or when the script is missing', () => {
  const scriptDir = makeTempDir();
  const realScript = path.join(scriptDir, 'osc7-prompt.ps1');
  fs.writeFileSync(realScript, 'function global:prompt { "" }', 'utf8');

  assert.deepEqual(win32ShellArgs('C:\\Windows\\System32\\cmd.exe', realScript), []);
  assert.deepEqual(win32ShellArgs('C:\\Tools\\pwsh.exe', null), []);
  assert.deepEqual(win32ShellArgs('C:\\Tools\\pwsh.exe', path.join(scriptDir, 'missing.ps1')), []);
});

test('sanitizeReportedCwd rejects non-strings, empty strings, oversized input and control characters', () => {
  assert.equal(sanitizeReportedCwd('C:\\Users\\bartek'), 'C:\\Users\\bartek');
  assert.equal(sanitizeReportedCwd(''), null);
  assert.equal(sanitizeReportedCwd(null), null);
  assert.equal(sanitizeReportedCwd(42), null);
  assert.equal(sanitizeReportedCwd('a'.repeat(5000)), null);
  assert.equal(sanitizeReportedCwd('C:\\evil\x1b]0;pwned\x07'), null);
});

test('reportTerminalCwd marks the state as osc7-sourced and stamps cwdCheckedAt', () => {
  const state = { cwd: null, cwdSource: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
  const ok = reportTerminalCwd(state, 'C:\\Users\\bartek\\project', 9999);
  assert.equal(ok, true);
  assert.equal(state.cwd, 'C:\\Users\\bartek\\project');
  assert.equal(state.cwdSource, 'osc7');
  assert.equal(state.cwdCheckedAt, 9999);
});

test('reportTerminalCwd leaves the state untouched for garbage input or a missing state', () => {
  const state = { cwd: '/old', cwdSource: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
  assert.equal(reportTerminalCwd(state, ''), false);
  assert.equal(state.cwd, '/old');
  assert.equal(state.cwdSource, null);
  assert.equal(reportTerminalCwd(null, '/somewhere'), false);
});

test('collectTerminalMetadata stops polling lsof/procfs once a session has an osc7-sourced cwd', async () => {
  // An invalid pid makes terminalWorkingDirectory reject immediately, before
  // any platform-specific lookup — but cwdCheckedAt still gets stamped the
  // moment the lookup branch is *entered*, so it doubles as a "was this
  // attempted at all" probe independent of whether the lookup itself works.
  const terminal = { pid: undefined, process: 'zsh' };

  const osc7State = { cwd: '/reported/by/osc7', cwdSource: 'osc7', cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
  await collectTerminalMetadata(terminal, osc7State, 12345);
  assert.equal(osc7State.cwdCheckedAt, 0, 'lookup must not run once osc7 has reported');
  assert.equal(osc7State.cwd, '/reported/by/osc7');

  const lookupState = { cwd: '/reported/by/osc7', cwdSource: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
  await collectTerminalMetadata(terminal, lookupState, 12345);
  assert.equal(lookupState.cwdCheckedAt, 12345, 'lookup runs as normal without an osc7 report');
});

test('shellDisplayName uppercases the shell basename and strips .exe case-insensitively', () => {
  assert.equal(shellDisplayName('C:/Tools/pwsh.exe'), 'PWSH');
  assert.equal(shellDisplayName('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'), 'POWERSHELL');
  assert.equal(shellDisplayName('C:/Windows/System32/CMD.EXE'), 'CMD');
  assert.equal(shellDisplayName('/bin/zsh'), 'ZSH');
  assert.equal(shellDisplayName('/bin/bash'), 'BASH');
  assert.equal(shellDisplayName(''), 'SHELL');
  assert.equal(shellDisplayName(null), 'SHELL');
});

test('processIdentity on win32 ignores terminal.process entirely and derives identity from the known shell path', () => {
  // Found on real Windows hardware: node-pty's Windows backend has no live
  // process introspection — its `.process` getter just echoes back the
  // `name` pty-spawn option ('xterm-256color') regardless of what's
  // actually running. Any processTitle here must be ignored on win32.
  const poisoned = 'xterm-256color';
  assert.deepEqual(
    processIdentity(poisoned, { platform: 'win32', shellPath: 'C:/Tools/pwsh.exe' }),
    { command: 'pwsh', name: 'pwsh', idle: true }
  );
  assert.deepEqual(
    processIdentity(poisoned, { platform: 'win32', shellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/POWERSHELL.EXE' }),
    { command: 'powershell', name: 'powershell', idle: true }
  );
});

test('processIdentity on win32 falls back to a generic name if the shell path is somehow missing', () => {
  assert.deepEqual(
    processIdentity('xterm-256color', { platform: 'win32', shellPath: null }),
    { command: 'shell', name: 'shell', idle: true }
  );
});

test('processIdentity off win32 is unaffected by the shellPath option (still reads processTitle)', () => {
  assert.deepEqual(
    processIdentity('vim notes.txt', { platform: 'darwin', shellPath: 'C:/Tools/pwsh.exe' }),
    { command: 'vim notes.txt', name: 'vim', idle: false }
  );
});

test('collectTerminalMetadata on win32 never shows the pty terminfo name ("xterm-256color") as the label', async () => {
  // The exact regression from real hardware: idle was always false because
  // processIdentity trusted the poisoned terminal.process value, so the
  // label fell to processInfo.name = 'xterm-256color' even though OSC 7
  // had already reported a perfectly good cwd.
  const terminal = { pid: 4242, process: 'xterm-256color' };
  const state = {
    cwd: 'C:\\Users\\bartek\\project', cwdSource: 'osc7', cwdCheckedAt: 0,
    commandStartedAt: null, commandName: null, shellPath: 'C:/Tools/pwsh.exe'
  };
  const result = await collectTerminalMetadata(terminal, state, 1000, 'win32');
  assert.equal(result.idle, true);
  assert.notEqual(result.label, 'xterm-256color');
  assert.notEqual(result.processName, 'xterm-256color');
  assert.equal(result.processName, 'pwsh');
});

test('collectTerminalMetadata on win32 falls back to the shell name, not the terminfo name, when cwd is still unknown', async () => {
  const terminal = { pid: 4242, process: 'xterm-256color' };
  const state = {
    cwd: null, cwdSource: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null,
    shellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  };
  const result = await collectTerminalMetadata(terminal, state, 1000, 'win32');
  assert.equal(result.label, 'powershell');
  assert.notEqual(result.label, 'xterm-256color');
});
