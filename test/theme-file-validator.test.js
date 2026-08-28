'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateThemeFile, isRgbTriplet } = require('../src/main/theme-file-validator');

const VALID_ACCENT = { cyan: [210, 20, 20], cyanBright: [255, 130, 110], cyanDim: [110, 10, 10] };

test('isRgbTriplet requires exactly three integers in [0, 255]', () => {
  assert.equal(isRgbTriplet([0, 0, 0]), true);
  assert.equal(isRgbTriplet([255, 255, 255]), true);
  assert.equal(isRgbTriplet([256, 0, 0]), false);
  assert.equal(isRgbTriplet([-1, 0, 0]), false);
  assert.equal(isRgbTriplet([1.5, 0, 0]), false);
  assert.equal(isRgbTriplet([0, 0]), false);
  assert.equal(isRgbTriplet([0, 0, 0, 0]), false);
  assert.equal(isRgbTriplet('0 0 0'), false);
  assert.equal(isRgbTriplet(null), false);
});

test('validateThemeFile accepts a full theme and normalizes it to CSS token shape', () => {
  const result = validateThemeFile({
    name: 'RINZLER',
    accent: VALID_ACCENT,
    terminalColor: { foreground: [255, 90, 70], cursor: [255, 170, 140] }
  });
  assert.deepEqual(result, {
    name: 'RINZLER',
    tokens: {
      '--cyan': 'rgb(210, 20, 20)',
      '--cyan-bright': 'rgb(255, 130, 110)',
      '--cyan-dim': 'rgb(110, 10, 10)',
      '--cyan-rgb': '210 20 20',
      '--cyan-bright-rgb': '255 130 110',
      '--cyan-dim-rgb': '110 10 10'
    },
    terminalColor: { foreground: 'rgb(255, 90, 70)', cursor: 'rgb(255, 170, 140)' }
  });
});

test('validateThemeFile falls back to the accent colours when terminalColor is omitted', () => {
  const result = validateThemeFile({ name: 'RINZLER', accent: VALID_ACCENT });
  assert.deepEqual(result.terminalColor, { foreground: 'rgb(210, 20, 20)', cursor: 'rgb(255, 130, 110)' });
});

test('validateThemeFile trims and truncates an overlong name to 32 characters', () => {
  const result = validateThemeFile({ name: `  ${'A'.repeat(40)}  `, accent: VALID_ACCENT });
  assert.equal(result.name, 'A'.repeat(32));
});

test('validateThemeFile rejects non-object input', () => {
  assert.equal(validateThemeFile(null), null);
  assert.equal(validateThemeFile(undefined), null);
  assert.equal(validateThemeFile('theme'), null);
  assert.equal(validateThemeFile([{ name: 'X', accent: VALID_ACCENT }]), null);
});

test('validateThemeFile rejects a missing, non-string, or unsafe name', () => {
  assert.equal(validateThemeFile({ accent: VALID_ACCENT }), null);
  assert.equal(validateThemeFile({ name: 42, accent: VALID_ACCENT }), null);
  assert.equal(validateThemeFile({ name: '', accent: VALID_ACCENT }), null);
  assert.equal(validateThemeFile({ name: '<script>', accent: VALID_ACCENT }), null);
  assert.equal(validateThemeFile({ name: '   ', accent: VALID_ACCENT }), null);
});

test('validateThemeFile rejects a missing or malformed accent block', () => {
  assert.equal(validateThemeFile({ name: 'X' }), null);
  assert.equal(validateThemeFile({ name: 'X', accent: null }), null);
  assert.equal(validateThemeFile({ name: 'X', accent: { cyan: [1, 2, 3] } }), null);
  assert.equal(validateThemeFile({
    name: 'X', accent: { ...VALID_ACCENT, cyan: [999, 0, 0] }
  }), null);
});

test('validateThemeFile rejects a malformed terminalColor block without touching a valid accent', () => {
  assert.equal(validateThemeFile({ name: 'X', accent: VALID_ACCENT, terminalColor: {} }), null);
  assert.equal(validateThemeFile({
    name: 'X', accent: VALID_ACCENT, terminalColor: { foreground: [1, 2, 3] }
  }), null);
  assert.equal(validateThemeFile({
    name: 'X', accent: VALID_ACCENT, terminalColor: { foreground: [1, 2, 300], cursor: [1, 2, 3] }
  }), null);
});
