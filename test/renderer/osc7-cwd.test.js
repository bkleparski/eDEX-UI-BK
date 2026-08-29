'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseOsc7Cwd } = require('../../src/renderer/osc7-cwd.js');

test('parseOsc7Cwd decodes a local Windows path (file:///C:/...) to a backslash path', () => {
  assert.equal(parseOsc7Cwd('file:///C:/Users/bartek/project'), 'C:\\Users\\bartek\\project');
});

test('parseOsc7Cwd decodes a local POSIX path (file:///Users/...) unchanged', () => {
  assert.equal(parseOsc7Cwd('file:///Users/bartek/project'), '/Users/bartek/project');
  assert.equal(parseOsc7Cwd('file://localhost/Users/bartek'), '/Users/bartek');
});

test('parseOsc7Cwd decodes a UNC network path (file://host/share) to \\\\host\\share on win32', () => {
  assert.equal(parseOsc7Cwd('file://fileserver/share/dir', 'win32'), '\\\\fileserver\\share\\dir');
});

test('parseOsc7Cwd does not mangle a real hostname into fake UNC off win32 (found via real zsh OSC 7 integration)', () => {
  // This is the exact shape a Mac with iTerm2/omz shell integration already
  // emits for an ordinary local path — the host is the machine's own real
  // hostname, not "localhost". Confirmed live during manual verification:
  // treating this as UNC mangled every path on this dev machine.
  assert.equal(parseOsc7Cwd('file://macbook-pro-bartomiej.local/private/tmp/project', 'darwin'), '/private/tmp/project');
  assert.equal(parseOsc7Cwd('file://some-remote-host/home/bartek', 'linux'), '/home/bartek');
});

test('parseOsc7Cwd percent-decodes spaces and unicode in the path', () => {
  assert.equal(parseOsc7Cwd('file:///C:/Program%20Files/App'), 'C:\\Program Files\\App');
  assert.equal(parseOsc7Cwd('file:///Users/bartek/O%27Brien%20%5Bv2%5D'), "/Users/bartek/O'Brien [v2]");
});

test('parseOsc7Cwd rejects malformed input instead of throwing', () => {
  assert.equal(parseOsc7Cwd(''), null);
  assert.equal(parseOsc7Cwd(null), null);
  assert.equal(parseOsc7Cwd(undefined), null);
  assert.equal(parseOsc7Cwd('not a uri at all'), null);
  assert.equal(parseOsc7Cwd('http://example.com/not-file'), null);
  assert.equal(parseOsc7Cwd('file:///bad%escaping'), null);
  assert.equal(parseOsc7Cwd('a'.repeat(5000)), null);
});

test('parseOsc7Cwd rejects a path smuggling control characters or escape sequences', () => {
  assert.equal(parseOsc7Cwd('file:///Users/bartek/%1B%5D0%3Bpwned%07'), null);
  assert.equal(parseOsc7Cwd('file:///Users/bartek/%00null'), null);
});
