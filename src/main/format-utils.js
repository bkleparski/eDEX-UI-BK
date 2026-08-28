'use strict';

// Small formatting/validation helpers shared by the Electron main process
// (src/main.js) and the standalone web server (src/server/index.js) — neither
// depends on Electron APIs.

const CONTROL_CHARS_PATTERN = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(Math.max(number, 0), 100);
}

function safeLabel(value, fallback = 'N/A', maxLength = 36) {
  if (typeof value !== 'string') return fallback;
  const label = value.replace(CONTROL_CHARS_PATTERN, '').trim();
  return label ? label.slice(0, maxLength) : fallback;
}

function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const octets = value.trim().split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

module.exports = { finiteNumber, clampPercent, safeLabel, isIpv4 };
