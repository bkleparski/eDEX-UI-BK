'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

const isSmokeTest = process.env.EDEX_SMOKE_TEST === '1';
const isVisualTest = process.env.EDEX_VISUAL_TEST === '1';
const isAutomatedTest = isSmokeTest || isVisualTest;
const terminals = new Map();
let smokeTimeout;

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url;
  if (typeof senderUrl !== 'string') return false;

  const parsedUrl = new URL(senderUrl);
  const expectedPath = path.join(__dirname, 'renderer', 'index.html');
  return parsedUrl.protocol === 'file:' && decodeURIComponent(parsedUrl.pathname) === expectedPath;
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) {
    throw new Error('Rejected IPC request from an untrusted renderer.');
  }
}

function disposeTerminal(webContentsId) {
  const terminal = terminals.get(webContentsId);
  if (!terminal) return;

  terminals.delete(webContentsId);
  try {
    terminal.kill();
  } catch {
    // The shell may already have exited.
  }
}

function registerTerminalIpc() {
  ipcMain.handle('terminal:start', (event, dimensions = {}) => {
    requireTrustedSender(event);

    if (terminals.has(event.sender.id)) {
      return { started: true };
    }

    const cols = Number.isInteger(dimensions.cols) ? Math.min(Math.max(dimensions.cols, 2), 500) : 80;
    const rows = Number.isInteger(dimensions.rows) ? Math.min(Math.max(dimensions.rows, 1), 300) : 24;
    const shell = '/bin/zsh';
    const terminal = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        SHELL: shell,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });

    terminals.set(event.sender.id, terminal);

    terminal.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('terminal:data', data);
      }
    });

    terminal.onExit(({ exitCode, signal }) => {
      terminals.delete(event.sender.id);
      if (!event.sender.isDestroyed()) {
        event.sender.send('terminal:exit', { exitCode, signal });
      }
    });

    event.sender.once('destroyed', () => disposeTerminal(event.sender.id));
    return { started: true, pid: terminal.pid, shell };
  });

  ipcMain.on('terminal:write', (event, data) => {
    if (!isTrustedSender(event) || typeof data !== 'string' || data.length > 64 * 1024) return;
    terminals.get(event.sender.id)?.write(data);
  });

  ipcMain.on('terminal:resize', (event, dimensions) => {
    if (!isTrustedSender(event) || !dimensions || !Number.isInteger(dimensions.cols) || !Number.isInteger(dimensions.rows)) return;
    const cols = Math.min(Math.max(dimensions.cols, 2), 500);
    const rows = Math.min(Math.max(dimensions.rows, 1), 300);
    terminals.get(event.sender.id)?.resize(cols, rows);
  });

  ipcMain.on('terminal:smoke-result', (event, result) => {
    if (!isSmokeTest) return;
    requireTrustedSender(event);
    clearTimeout(smokeTimeout);
    process.exitCode = result?.ok === true ? 0 : 1;
    if (result?.ok === true) {
      console.log('PTY smoke test passed: xterm renderer received output from /bin/zsh through node-pty.');
    } else {
      console.error('PTY smoke test failed.');
    }
    app.quit();
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    frame: false,
    fullscreen: !isAutomatedTest,
    show: !isAutomatedTest,
    backgroundColor: '#02080a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    isAutomatedTest ? { query: { test: isSmokeTest ? 'smoke' : 'visual' } } : undefined
  );

  if (isSmokeTest) {
    smokeTimeout = setTimeout(() => {
      console.error('PTY smoke test timed out.');
      process.exitCode = 1;
      app.quit();
    }, 15_000);
  }

  if (isVisualTest) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const diagnostics = await window.webContents.executeJavaScript(`({
            fonts: {
              terminal: document.fonts.check('14px "Monaspace Neon NF"'),
              headings: document.fonts.check('600 14px Orbitron'),
              labels: document.fonts.check('500 11px "Chakra Petch"')
            },
            bootComplete: document.body.classList.contains('boot-complete'),
            scanlinesEnabled: document.body.classList.contains('scanlines-on'),
            shellStatus: document.getElementById('shellStatusText').textContent,
            gridColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
            terminalGeometry: (() => {
              const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
              return { width: screen.width, height: screen.height };
            })()
          })`);
          const screenshot = await window.webContents.capturePage();
          const screenshotPath = path.join(os.tmpdir(), 'edex-ui-bk-phase1.png');
          fs.writeFileSync(screenshotPath, screenshot.toPNG());
          console.log(`Visual diagnostics: ${JSON.stringify(diagnostics)}`);
          console.log(`Visual test screenshot: ${screenshotPath}`);
          process.exitCode = 0;
        } catch (error) {
          console.error(`Visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 3_000);
    });
  }
}

app.whenReady().then(() => {
  registerTerminalIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  clearTimeout(smokeTimeout);
  for (const webContentsId of terminals.keys()) {
    disposeTerminal(webContentsId);
  }
});
