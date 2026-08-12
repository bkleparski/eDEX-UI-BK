#!/usr/bin/env node
'use strict';

// CLI launcher: `ebartnet-ui` starts the Electron app from wherever this package
// is installed, so the terminal can be opened from any working directory.

const { spawn } = require('node:child_process');
const path = require('node:path');

const appRoot = path.join(__dirname, '..');

function fail(message) {
  process.stderr.write(`ebartnet-ui: ${message}\n`);
  process.exit(1);
}

let electronBinary;
try {
  // The electron package exports the absolute path to its bundled binary.
  electronBinary = require('electron');
} catch {
  fail([
    'Electron is not installed.',
    '',
    'EBARTNET-UI ships Electron as a development dependency, so install it once:',
    `  cd ${appRoot}`,
    '  npm install',
    ''
  ].join('\n'));
}

if (typeof electronBinary !== 'string') {
  fail('Electron resolved to an unexpected value; reinstall dependencies with `npm install`.');
}

if (process.platform !== 'darwin') {
  process.stderr.write('ebartnet-ui: this build targets macOS on Apple Silicon; other platforms are untested.\n');
}

const child = spawn(electronBinary, [appRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false
});

child.on('error', (error) => fail(`failed to start Electron (${error.message}).`));
child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
