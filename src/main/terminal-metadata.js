'use strict';

// Per-pane terminal metadata: foreground process, cwd, slow-command
// notifications. Pure Node (execFile + os/path), no Electron dependency —
// shared by the Electron main process and the standalone web server.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeLabel } = require('./format-utils');

const SLOW_COMMAND_THRESHOLD_MS = 15_000;

// A bare directory scan of PATH, no child process — used to find pwsh.exe
// (PowerShell 7 doesn't install to a fixed path; it's wherever winget/MSI
// put it, but always on PATH once installed).
function findExecutableInPath(exeName) {
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// PowerShell 7 (pwsh.exe) first if it's installed — it's the modern,
// actively-developed shell Microsoft ships going forward — then the
// Windows PowerShell that's on every Windows install at a fixed path, then
// cmd.exe as the one thing guaranteed to exist.
function defaultShellWin32() {
  const pwsh = findExecutableInPath('pwsh.exe');
  if (pwsh) return pwsh;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const windowsPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(windowsPowerShell)) return windowsPowerShell;
  return path.join(systemRoot, 'System32', 'cmd.exe');
}

// The Electron main process spawns this directly on Electron 43 (that's
// been the shell on every Mac since Catalina, so darwin never needs to look
// further); the web server (src/server/index.js) uses this same function
// because its Docker image (node:22-slim) doesn't ship zsh at all — without
// a fallback, node-pty's spawn would just fail outright with ENOENT. Linux
// desktop builds hit exactly the same gap. `platform` is an override for
// unit tests only — production callers always take the process.platform default.
function defaultShell(platform = process.platform) {
  if (platform === 'win32') return defaultShellWin32();
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}

// `-l` (login shell) is a POSIX shell flag. pwsh.exe/powershell.exe treat an
// unrecognized leading argument as a script path and fail to start; cmd.exe
// would try to run it as a command. So Windows gets no extra args at all —
// see win32ShellArgs below for what PowerShell actually gets instead.
function shellSpawnArgs(platform = process.platform) {
  return platform === 'win32' ? [] : ['-l'];
}

// For the "INTERACTIVE <SHELL>" heading (see main.js's terminal:start
// response) — a plain uppercased basename, .exe stripped case-insensitively.
function shellDisplayName(shellPath) {
  const base = path.basename(String(shellPath || '')).replace(/\.exe$/i, '');
  return base ? base.toUpperCase() : 'SHELL';
}

function isPowerShellExecutable(shellPath) {
  const base = path.basename(String(shellPath || '')).toLowerCase();
  return base === 'pwsh.exe' || base === 'powershell.exe';
}

// Injects the OSC 7 cwd-reporting prompt wrapper (see
// resources/shell-integration/osc7-prompt.ps1) without ever touching the
// user's own $PROFILE. `-EncodedCommand` runs arbitrary script text as if
// typed at the prompt — unlike `-File` or a dot-sourced path, it isn't
// gated by the machine's script execution policy, which a locked-down
// corporate Windows box may well have set to something that blocks
// unsigned .ps1 files outright. Profiles still load first as normal
// (nothing here passes -NoProfile), so the script wraps whatever `prompt`
// the user already has, not PowerShell's bare default.
function win32ShellArgs(shellPath, osc7ScriptPath) {
  if (!isPowerShellExecutable(shellPath) || !osc7ScriptPath) return [];
  let scriptSource;
  try {
    scriptSource = fs.readFileSync(osc7ScriptPath, 'utf8');
  } catch {
    return []; // Script missing — degrade to no cwd tracking, don't break the spawn.
  }
  const encodedCommand = Buffer.from(scriptSource, 'utf16le').toString('base64');
  return ['-NoExit', '-EncodedCommand', encodedCommand];
}

function terminalWorkingDirectoryViaLsof(terminal) {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/lsof', ['-a', '-p', String(terminal.pid), '-d', 'cwd', '-Fn'], {
      timeout: 1_000,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const cwdLine = stdout.split('\n').find((line) => line.startsWith('n'));
      if (!cwdLine?.slice(1)) {
        reject(new Error('Terminal working directory unavailable'));
        return;
      }
      resolve(cwdLine.slice(1));
    });
  });
}

// /proc/PID/cwd is a symlink to the process's current directory — a single
// syscall via readlink, no child process, no parsing. Linux only (there's no
// /proc on macOS); lsof covers everything else (macOS, and Linux hosts/images
// where /proc isn't mounted for some reason — rare, but readlink failing
// there just falls through to it below).
async function terminalWorkingDirectoryViaProcfs(terminal) {
  return fs.promises.readlink(`/proc/${terminal.pid}/cwd`);
}

async function terminalWorkingDirectory(terminal, platform = process.platform) {
  if (!terminal || !Number.isInteger(terminal.pid)) {
    throw new Error('Terminal process unavailable');
  }
  if (platform === 'win32') {
    // ConPTY exposes no cwd today — no /proc, and no lsof equivalent. Degrade
    // to null rather than shelling out to something that doesn't exist;
    // collectTerminalMetadata below falls back to the process name for the
    // panel label. An OSC 7 cwd-reporting spike is tracked separately (W2).
    return null;
  }
  if (platform === 'linux') {
    try {
      return await terminalWorkingDirectoryViaProcfs(terminal);
    } catch {
      // Fall through to lsof below — covers a container without /proc
      // mounted, or a lsof-less image where this just fails either way.
    }
  }
  return terminalWorkingDirectoryViaLsof(terminal);
}

function processIdentity(processTitle, { platform = process.platform, shellPath = null } = {}) {
  if (platform === 'win32') {
    // node-pty's Windows backend has no live process introspection: its
    // `.process` getter just echoes back the `name` pty-spawn option —
    // 'xterm-256color', the terminfo name passed at spawn time, see
    // main.js — regardless of what's actually running. `processTitle` is
    // useless here, so fall back to the shell resolved at spawn time and
    // treat the session as always idle: there's no busy/idle signal on
    // Windows either way, so the only cost is losing slow-command
    // notifications there, not cwd tracking (OSC 7 reports that
    // independently of this idle gate).
    const base = path.basename(String(shellPath || '')).replace(/\.exe$/i, '').toLowerCase();
    const name = base || 'shell';
    return { command: name, name, idle: true };
  }
  const command = safeLabel(processTitle, 'zsh', 180);
  const executable = command.trim().split(/\s+/)[0];
  // Windows process titles carry the .exe suffix (and in whatever case the
  // OS feels like reporting it) — already lowercased above, so a plain
  // suffix strip covers PowerShell.EXE, POWERSHELL.EXE, etc. alike.
  const baseName = path.basename(executable).replace(/^-/, '').toLowerCase();
  const name = baseName.replace(/\.exe$/, '') || 'zsh';
  return { command, name, idle: /^(?:zsh|bash|sh|login|pwsh|powershell|cmd)$/.test(name) };
}

function compactWorkingDirectory(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '~';
  const home = os.homedir();
  const displayPath = cwd === home ? '~' : cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
  if (displayPath.length <= 20) return displayPath;
  const segments = displayPath.split(path.sep).filter(Boolean);
  return segments.slice(-2).join(path.sep) || displayPath;
}

// A foreground (non-idle) run that lasts long enough to matter, ending back
// at the shell prompt, is worth a notification — but only once it actually
// ends, so a still-running command never fires early and a killed pane never
// fires at all (it just disappears without the idle transition).
function detectCompletedCommand(state, processInfo, now) {
  if (!processInfo.idle) {
    if (state.commandStartedAt === null) state.commandStartedAt = now;
    state.commandName = processInfo.name;
    return null;
  }
  if (state.commandStartedAt === null) return null;
  const durationMs = now - state.commandStartedAt;
  const name = state.commandName;
  state.commandStartedAt = null;
  state.commandName = null;
  return durationMs >= SLOW_COMMAND_THRESHOLD_MS ? { name, durationMs } : null;
}

// A shell prompt hook (OSC 7) pushes its cwd straight into state.cwd from
// the IPC handler in main.js/server — see reportTerminalCwd below. Once
// that has happened for a session, it's strictly better than lsof/procfs
// (it's exact, and it's the *only* source at all on win32), so the periodic
// lookup below stops running entirely rather than racing it.
const MAX_REPORTED_CWD_LENGTH = 4_096;
const REPORTED_CWD_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function sanitizeReportedCwd(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REPORTED_CWD_LENGTH) return null;
  if (REPORTED_CWD_CONTROL_CHARS.test(value)) return null;
  return value;
}

// Shared by the IPC handler in main.js and the WS handler in server/index.js
// so both re-validate the renderer's decoded OSC 7 payload the same way
// rather than trusting it — the renderer isn't a fully untrusted process,
// but the *text it decoded* originated in terminal output, which a remote
// shell (an ssh session, say) can fill with whatever it wants.
function reportTerminalCwd(state, value, now = Date.now()) {
  const cwd = sanitizeReportedCwd(value);
  if (!cwd || !state) return false;
  state.cwd = cwd;
  state.cwdSource = 'osc7';
  state.cwdCheckedAt = now;
  return true;
}

async function collectTerminalMetadata(terminal, state, now, platform = process.platform) {
  const processInfo = processIdentity(terminal.process, { platform, shellPath: state.shellPath });
  if (processInfo.idle && state.cwdSource !== 'osc7' && (!state.cwd || now - state.cwdCheckedAt >= 1_000)) {
    state.cwdCheckedAt = now;
    try {
      state.cwd = await terminalWorkingDirectory(terminal);
    } catch {
      // Preserve the last known directory if lsof is temporarily unavailable.
    }
  }
  const completedCommand = detectCompletedCommand(state, processInfo, now);

  return {
    processName: processInfo.name,
    command: processInfo.command,
    idle: processInfo.idle,
    cwd: state.cwd || null,
    // Idle with a known cwd shows the compacted path; idle with no cwd
    // (win32 today — see terminalWorkingDirectory above) falls back to the
    // process name, same as the non-idle case, instead of a misleading '~'.
    label: processInfo.idle && typeof state.cwd === 'string' && state.cwd
      ? compactWorkingDirectory(state.cwd)
      : processInfo.name,
    completedCommand
  };
}

module.exports = {
  SLOW_COMMAND_THRESHOLD_MS,
  defaultShell,
  shellDisplayName,
  shellSpawnArgs,
  win32ShellArgs,
  terminalWorkingDirectory,
  processIdentity,
  compactWorkingDirectory,
  detectCompletedCommand,
  collectTerminalMetadata,
  sanitizeReportedCwd,
  reportTerminalCwd
};
