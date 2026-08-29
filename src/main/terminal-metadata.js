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
const IS_LINUX = process.platform === 'linux';

// The Electron main process spawns this directly on Electron 43 (that's
// been the shell on every Mac since Catalina, so darwin never needs to look
// further); the web server (src/server/index.js) uses this same function
// because its Docker image (node:22-slim) doesn't ship zsh at all — without
// a fallback, node-pty's spawn would just fail outright with ENOENT. Linux
// desktop builds hit exactly the same gap.
function defaultShell() {
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
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

async function terminalWorkingDirectory(terminal) {
  if (!terminal || !Number.isInteger(terminal.pid)) {
    throw new Error('Terminal process unavailable');
  }
  if (IS_LINUX) {
    try {
      return await terminalWorkingDirectoryViaProcfs(terminal);
    } catch {
      // Fall through to lsof below — covers a container without /proc
      // mounted, or a lsof-less image where this just fails either way.
    }
  }
  return terminalWorkingDirectoryViaLsof(terminal);
}

function processIdentity(processTitle) {
  const command = safeLabel(processTitle, 'zsh', 180);
  const executable = command.trim().split(/\s+/)[0];
  const name = path.basename(executable).replace(/^-/, '').toLowerCase() || 'zsh';
  return { command, name, idle: /^(?:zsh|bash|sh|login)$/.test(name) };
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

async function collectTerminalMetadata(terminal, state, now) {
  const processInfo = processIdentity(terminal.process);
  if (processInfo.idle && (!state.cwd || now - state.cwdCheckedAt >= 1_000)) {
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
    label: processInfo.idle ? compactWorkingDirectory(state.cwd) : processInfo.name,
    completedCommand
  };
}

module.exports = {
  SLOW_COMMAND_THRESHOLD_MS,
  defaultShell,
  terminalWorkingDirectory,
  processIdentity,
  compactWorkingDirectory,
  detectCompletedCommand,
  collectTerminalMetadata
};
