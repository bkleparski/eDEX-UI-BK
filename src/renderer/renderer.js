'use strict';

const storageKeys = Object.freeze({
  skipBoot: 'edex-ui-bk.skipBoot',
  scanlines: 'edex-ui-bk.scanlines'
});

const terminalTheme = Object.freeze({
  background: '#02080a',
  foreground: '#00e5ff',
  cursor: '#8ff8ff',
  cursorAccent: '#02080a',
  selectionBackground: 'rgba(0, 229, 255, 0.25)',
  black: '#02080a',
  red: '#ff5f56',
  green: '#00e5a0',
  yellow: '#ff9f1c',
  blue: '#00b8d9',
  magenta: '#d580ff',
  cyan: '#00e5ff',
  white: '#d8f9ff',
  brightBlack: '#087f9c',
  brightRed: '#ff8a80',
  brightGreen: '#8ff8ff',
  brightYellow: '#ffc46b',
  brightBlue: '#8ff8ff',
  brightMagenta: '#eab8ff',
  brightCyan: '#8ff8ff',
  brightWhite: '#ffffff'
});

const testMode = new URLSearchParams(window.location.search).get('test');
const isSmokeTest = testMode === 'smoke';
const isVisualTest = testMode === 'visual';
const smokeMarker = '__EDEX_PTY_ARM64_OK__';
let terminal;
let fitAddon;
let bootTimer;
let bootActive = false;
let smokeOutput = '';
let smokeCompleted = false;

function readSetting(key) {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeSetting(key, enabled) {
  try {
    window.localStorage.setItem(key, enabled ? '1' : '0');
  } catch {
    // The interface remains functional if storage is unavailable.
  }
}

function focusTerminal() {
  if (terminal) {
    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });
  }
}

function removeBootListeners() {
  document.removeEventListener('keydown', handleBootInput, true);
  document.getElementById('bootOverlay').removeEventListener('click', handleBootClick);
}

function finishBoot() {
  if (!bootActive) return;
  bootActive = false;
  clearTimeout(bootTimer);
  removeBootListeners();
  document.body.classList.remove('booting');
  document.body.classList.add('boot-complete');
  document.getElementById('bootOverlay').hidden = true;
  focusTerminal();
}

function handleBootInput(event) {
  if (!bootActive) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishBoot();
}

function handleBootClick(event) {
  if (event.target.closest('#skipBootAlways')) {
    writeSetting(storageKeys.skipBoot, true);
  }
  finishBoot();
}

function initializeBoot() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (isSmokeTest || reduceMotion || readSetting(storageKeys.skipBoot)) {
    document.body.classList.remove('booting');
    document.body.classList.add('boot-complete');
    document.getElementById('bootOverlay').hidden = true;
    return;
  }

  bootActive = true;
  document.addEventListener('keydown', handleBootInput, true);
  document.getElementById('bootOverlay').addEventListener('click', handleBootClick);
  bootTimer = setTimeout(finishBoot, 1_450);
}

function updateScanlines(enabled) {
  document.body.classList.toggle('scanlines-on', enabled);
  document.getElementById('scanlinesState').textContent = enabled ? 'ON' : 'OFF';
  document.getElementById('scanlinesToggle').setAttribute('aria-pressed', String(enabled));
  writeSetting(storageKeys.scanlines, enabled);
}

function toggleScanlines() {
  updateScanlines(!document.body.classList.contains('scanlines-on'));
  focusTerminal();
}

function initializeControls() {
  updateScanlines(readSetting(storageKeys.scanlines));
  document.getElementById('scanlinesToggle').addEventListener('click', toggleScanlines);
  document.addEventListener('keydown', (event) => {
    if (!bootActive && event.metaKey && event.shiftKey && event.code === 'KeyL') {
      event.preventDefault();
      toggleScanlines();
    }
  });
}

async function initializeTerminal() {
  await document.fonts.ready;

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: '"Monaspace Neon NF", "SF Mono", Menlo, monospace',
    fontSize: 14,
    fontWeight: '400',
    letterSpacing: 0.2,
    lineHeight: 1.16,
    scrollback: 10_000,
    theme: terminalTheme
  });

  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.getElementById('terminal'));
  fitAddon.fit();

  window.terminalApi.onData((data) => {
    terminal.write(data);

    if (isSmokeTest && !smokeCompleted) {
      smokeOutput += data;
      if (smokeOutput.includes(smokeMarker)) {
        smokeCompleted = true;
        window.terminalApi.reportSmokeResult(true);
      }
    }
  });

  window.terminalApi.onExit(({ exitCode }) => {
    terminal.write(`\r\n[SHELL OFFLINE: ${exitCode}]\r\n`);
    document.getElementById('shellStatus').dataset.state = 'offline';
    document.getElementById('shellStatusText').textContent = 'LINK OFFLINE';
    if (isSmokeTest && !smokeCompleted) {
      smokeCompleted = true;
      window.terminalApi.reportSmokeResult(false);
    }
  });

  terminal.onData((data) => window.terminalApi.write(data));
  terminal.onResize(({ cols, rows }) => window.terminalApi.resize(cols, rows));

  const resizeObserver = new ResizeObserver(() => fitAddon.fit());
  resizeObserver.observe(document.querySelector('.terminal-surface'));

  try {
    await window.terminalApi.start({ cols: terminal.cols, rows: terminal.rows });
    document.getElementById('shellStatus').dataset.state = 'online';
    document.getElementById('shellStatusText').textContent = 'LINK ONLINE';
    focusTerminal();
    if (isSmokeTest) {
      window.terminalApi.write(`printf '${smokeMarker}\\n'\r`);
    } else if (isVisualTest) {
      window.terminalApi.write("printf '\\033[36mPTY LINK VERIFIED / ZSH READY\\033[0m\\n'\r");
    }
  } catch (error) {
    terminal.write(`\r\n[ZSH START FAILED: ${error.message}]\r\n`);
    document.getElementById('shellStatus').dataset.state = 'offline';
    document.getElementById('shellStatusText').textContent = 'LINK FAILED';
    if (isSmokeTest) window.terminalApi.reportSmokeResult(false);
  }
}

initializeBoot();
initializeControls();
initializeTerminal().catch((error) => {
  document.getElementById('shellStatus').dataset.state = 'offline';
  document.getElementById('shellStatusText').textContent = 'LINK FAILED';
  console.error('Terminal initialization failed:', error);
  if (isSmokeTest && !smokeCompleted) {
    smokeCompleted = true;
    window.terminalApi.reportSmokeResult(false);
  }
});
