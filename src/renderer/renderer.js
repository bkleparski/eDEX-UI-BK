'use strict';

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: false,
  fontFamily: 'Menlo, Monaco, monospace',
  fontSize: 15,
  scrollback: 10_000,
  theme: {
    background: '#101418',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#3b4552'
  }
});

const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById('terminal'));
fitAddon.fit();

let smokeOutput = '';
let smokeCompleted = false;
const smokeMarker = '__EDEX_PTY_ARM64_OK__';
const isSmokeTest = new URLSearchParams(window.location.search).get('smoke') === '1';

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
  terminal.write(`\r\n[Powłoka zakończyła działanie: ${exitCode}]\r\n`);
  if (isSmokeTest && !smokeCompleted) {
    smokeCompleted = true;
    window.terminalApi.reportSmokeResult(false);
  }
});

terminal.onData((data) => window.terminalApi.write(data));
terminal.onResize(({ cols, rows }) => window.terminalApi.resize(cols, rows));

const resizeObserver = new ResizeObserver(() => fitAddon.fit());
resizeObserver.observe(document.querySelector('.terminal-shell'));

window.terminalApi.start({ cols: terminal.cols, rows: terminal.rows })
  .then(() => {
    terminal.focus();
    if (isSmokeTest) {
      window.terminalApi.write(`printf '${smokeMarker}\\n'\r`);
    }
  })
  .catch((error) => {
    terminal.write(`\r\n[Nie udało się uruchomić zsh: ${error.message}]\r\n`);
    if (isSmokeTest) {
      window.terminalApi.reportSmokeResult(false);
    }
  });
