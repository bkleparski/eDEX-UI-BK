'use strict';

/* exported primaryModifier, secondaryPlatformModifier, applyPlatformShortcutGlyphs */

// Loaded first (see index.html) so every other renderer script can call
// primaryModifier() instead of hardcoding event.metaKey. The whole HUD was
// designed macOS-only — every shortcut in the codebase checks event.metaKey
// (⌘) directly. Linux (and eventually Windows) use Ctrl as the primary
// modifier instead, so this is the one place that decision lives.
//
// Platform comes from window.edexCapabilities.platform, set by both
// src/preload.js (Electron: the real process.platform) and
// src/renderer/web-preload.js (the web server has no way to know the
// *browser's* OS from process.platform, so it reads navigator.platform
// instead — same values, different source).

function platformName() {
  return (typeof window !== 'undefined' && window.edexCapabilities?.platform) || 'other';
}

function isDarwinPlatform() {
  return platformName() === 'darwin';
}

// The modifier a shortcut is anchored to: ⌘ on macOS, Ctrl everywhere else.
function primaryModifier(event) {
  return isDarwinPlatform() ? event.metaKey === true : event.ctrlKey === true;
}

// The *other* platform modifier. Several shortcuts exclude it deliberately
// (e.g. plain ⌘F must not also fire on ⌃⌘F, which means something else) —
// rewriting those checks for Linux means excluding Meta/Super instead of
// Ctrl, not dropping the exclusion, since Ctrl there is the primary one.
function secondaryPlatformModifier(event) {
  return isDarwinPlatform() ? event.ctrlKey === true : event.metaKey === true;
}

// Markup across index.html was written with macOS glyphs (⌘⌥⇧) baked in as
// literal text — ⇧⌘ and ⌘⇧ both occur (footer legend vs. title attributes
// disagree on order), so both are matched before the single-glyph passes.
//
// `compact` swaps ⌘ for a single '^' instead of spelling out "Ctrl+" — same
// character count as the macOS glyph it replaces (⌘1 -> ^1, ⇧⌘L -> ^⇧L), so
// the footer's shortcut legend (the only place this is used) keeps the
// exact width it already has on macOS instead of blowing out the fixed-
// height HUD row with "Ctrl+Shift+L"-length text. Found on a real Windows
// VM: the legend column is a `grid-template-columns: ... auto ...` track
// that grows to fit whatever it's given, no wrap, no shrink — spelled-out
// combos pushed the status-chip toggles clean off the row. Tooltips
// ([title] below) keep the full spelled-out word — that's meant to be read
// on hover, not squeezed into a fixed-width row.
function modifierComboText(text, compact = false) {
  if (isDarwinPlatform()) return text;
  if (compact) {
    return text.replace(/⇧⌘|⌘⇧/g, '^⇧').replace(/⌘/g, '^');
  }
  return text
    .replace(/⇧⌘|⌘⇧/g, 'Ctrl+Shift+')
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+');
}

// The on-screen keyboard's Cmd key is a single physical key, not a combo —
// "Ctrl+" (trailing plus, meant for chaining into a letter) doesn't apply.
function superKeyGlyph() {
  const platform = platformName();
  if (platform === 'darwin') return '⌘';
  if (platform === 'win32') return 'Win';
  return 'Super';
}

// Called once at boot (see renderer.js). A no-op on macOS — the markup
// already matches. Elsewhere it rewrites every <kbd> shortcut hint, every
// title="...(⌘X)" tooltip, and the on-screen keyboard's Cmd key label in
// place, so nothing needs a second, parallel copy of the HUD text.
function applyPlatformShortcutGlyphs(root = document) {
  if (isDarwinPlatform()) return;
  root.querySelectorAll('kbd').forEach((node) => {
    // Every <kbd> in the markup lives in the footer's shortcut legend —
    // compact form only, see modifierComboText's comment above.
    node.textContent = modifierComboText(node.textContent, true);
  });
  root.querySelectorAll('[title]').forEach((node) => {
    const title = node.getAttribute('title');
    const next = modifierComboText(title);
    if (next !== title) node.setAttribute('title', next);
  });
  root.querySelectorAll('.kb-key--mod[data-code="MetaLeft"], .kb-key--mod[data-code="MetaRight"]')
    .forEach((node) => {
      node.textContent = superKeyGlyph();
    });
}

// Wraps a dropped/dragged path for insertion at the shell prompt (see
// renderer.js's insertDroppedPaths). POSIX shells (zsh/bash/sh) close and
// reopen the single-quoted string around a literal `'` — PowerShell has no
// such escape and instead doubles the embedded quote, so win32 gets its own
// branch rather than producing a string cmd.exe/pwsh would choke on.
function quoteShellPath(filePath) {
  if (platformName() === 'win32') {
    return `'${filePath.replace(/'/g, "''")}'`;
  }
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

// Pure, DOM-free functions only — see test/renderer/platform-utils.test.js.
// applyPlatformShortcutGlyphs needs a real `document` and isn't exported here.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    platformName,
    isDarwinPlatform,
    primaryModifier,
    secondaryPlatformModifier,
    modifierComboText,
    superKeyGlyph,
    quoteShellPath
  };
}
