'use strict';

/* exported parseOsc52Clipboard */

// OSC 52 (ESC ]52;<targets>;<base64> BEL) is how a program running *inside*
// the terminal — including one on the far end of an SSH hop, or two — asks
// the terminal emulator itself to put text on the local clipboard. It is the
// only clipboard path that survives nesting: the remote vim has no idea what
// machine the pixels end up on, it just emits the escape and whoever draws
// the screen does the copying. Terminal.app does not implement it at all,
// which is why a yank inside a nested ssh session used to vanish.
//
// Two things are deliberately *not* supported here:
//
//   * the read form (ESC ]52;c;? BEL), where the remote side asks the
//     terminal to send the clipboard's current contents back down the pty.
//     That turns any compromised or merely nosy remote host into a clipboard
//     exfiltration channel, so it is refused outright — same default as
//     xterm, iTerm2 and Ghostty.
//   * control characters in the payload. A clipboard entry carrying raw
//     escape sequences detonates when pasted into some *other* terminal that
//     lacks bracketed paste; tabs and newlines are kept (a yank is usually
//     multi-line), everything else in C0/C1 is dropped.
//
// Pure, DOM-free — see test/renderer/osc52-clipboard.test.js.

// 1 MiB of decoded text. Comfortably past any realistic yank, far short of
// letting a stuck loop on the remote side pin the main process.
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_TEXT_BYTES / 3) * 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex -- deliberately matching control bytes to strip them
const STRIPPED_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function decodeBase64Utf8(encoded) {
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null; // not valid UTF-8 — most likely not text we should be pasting
  }
}

// Returns null for anything malformed, `{ kind: 'read' }` for the refused
// query form, and `{ kind: 'write', targets, text, bytes }` otherwise. The
// caller decides what to do with each — this module never touches a clipboard.
function parseOsc52Clipboard(data) {
  if (typeof data !== 'string' || data.length === 0) return null;

  const separator = data.indexOf(';');
  if (separator === -1) return null;
  const targets = data.slice(0, separator);
  const payload = data.slice(separator + 1);

  // Selection targets: c(lipboard), p(rimary), s(elect), q, 0-7. An empty
  // field means "c;s" per the spec. Anything else is not OSC 52.
  if (!/^[cpqs0-7]*$/.test(targets)) return null;

  if (payload === '?') return { kind: 'read', targets };

  // Some senders drop the '=' padding; xterm accepts that, so do we.
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  if (padded.length > MAX_BASE64_LENGTH || !BASE64_PATTERN.test(padded)) return null;

  const decoded = decodeBase64Utf8(padded);
  if (decoded === null) return null;

  const text = decoded.replace(STRIPPED_CONTROL_CHARS, '');
  if (text.length === 0) return null;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_TEXT_BYTES) return null;

  return { kind: 'write', targets, text, bytes };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseOsc52Clipboard, MAX_TEXT_BYTES };
}
