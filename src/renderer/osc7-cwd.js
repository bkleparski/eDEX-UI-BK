'use strict';

/* exported parseOsc7Cwd */

// OSC 7 (ESC ]7;<uri> BEL) is a de-facto standard prompt hook that reports
// the shell's current directory as a file:// URI — used here for Windows,
// where there's no /proc or lsof to poll for it (see W1/W2 notes in
// src/main/terminal-metadata.js), but it works the same way for any shell
// with the right prompt integration, POSIX included. Registered against
// xterm's OSC parser in renderer.js's terminal setup.
//
// Pure, DOM-free — see test/renderer/osc7-cwd.test.js.

const MAX_URI_LENGTH = 4096;
// eslint-disable-next-line no-control-regex -- deliberately matching control bytes to reject them
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

function currentPlatform() {
  return (typeof window !== 'undefined' && window.edexCapabilities?.platform) || 'other';
}

// `platform` defaults to the real one and is an override for unit tests
// only. Found the hard way, mid-W2, by actually running the app: this
// machine's own zsh already has OSC 7 shell integration (iTerm2/omz-style)
// that reports file://<this-mac's-hostname>/path for perfectly ordinary
// local paths — not "localhost", the box's real hostname. Treating any
// non-localhost host as a Windows UNC share (file://server/share) would
// have silently mangled every plain macOS/Linux path into a fake \\host\...
// string. UNC only makes sense as a *destination format* on win32, so it's
// gated on that; elsewhere a differing host is left alone (most likely an
// SSH session reporting the remote box's name) and the path is still shown.
function parseOsc7Cwd(uri, platform = currentPlatform()) {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_LENGTH) return null;

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null; // malformed percent-encoding (e.g. a lone "%")
  }
  if (pathname.length === 0 || CONTROL_CHARS_PATTERN.test(pathname)) return null;

  const host = parsed.hostname;
  if (host && host !== 'localhost' && platform === 'win32') {
    // UNC network path: file://server/share/dir -> \\server\share\dir
    const withoutLeadingSlash = pathname.replace(/^\/+/, '');
    return withoutLeadingSlash ? `\\\\${host}\\${withoutLeadingSlash.replace(/\//g, '\\')}` : null;
  }

  // Local Windows path: file:///C:/Users/bartek -> C:\Users\bartek
  if (/^\/[a-zA-Z]:\//.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }

  // Local path (POSIX, or a non-win32 host we don't try to disambiguate —
  // see the comment above): file:///Users/bartek -> /Users/bartek
  return pathname;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseOsc7Cwd };
}
