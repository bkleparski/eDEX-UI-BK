'use strict';

const { app } = require('electron');

function scheduleSmokeTimeout() {
  return setTimeout(() => {
    console.error('PTY smoke test timed out.');
    process.exitCode = 1;
    app.quit();
  }, 15_000);
}

module.exports = { scheduleSmokeTimeout };
