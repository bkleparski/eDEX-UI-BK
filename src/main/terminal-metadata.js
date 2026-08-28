'use strict';

// Per-pane terminal metadata: foreground process, cwd, slow-command
// notifications. Pure Node (execFile + os/path), no Electron dependency —
// shared by the Electron main process and the standalone web server.

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { safeLabel } = require('./format-utils');

const SLOW_COMMAND_THRESHOLD_MS = 15_000;

function terminalWorkingDirectory(terminal) {
  return new Promise((resolve, reject) => {
    if (!terminal || !Number.isInteger(terminal.pid)) {
      reject(new Error('Terminal process unavailable'));
      return;
    }

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
  terminalWorkingDirectory,
  processIdentity,
  compactWorkingDirectory,
  detectCompletedCommand,
  collectTerminalMetadata
};
