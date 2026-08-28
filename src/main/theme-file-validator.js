'use strict';

// Pure validation/normalization for a parsed theme JSON file (see
// themes/example-theme.json for the format). Never throws — a malformed file
// should be skipped with a warning, not take down theme loading for every
// other file. Kept dependency-free (no fs, no Electron) so it can be unit
// tested directly against plain objects.

const MAX_NAME_LENGTH = 32;
// Letters (incl. accented, any script), digits, spaces and a few punctuation
// marks that show up in real preset names ("BURSZTYN", "RINZLER v2"). Length
// is enforced separately (after truncation, see validateThemeFile) rather
// than baked into the pattern — a `{1,32}` quantifier here would reject an
// overlong-but-otherwise-safe name outright instead of letting it truncate.
const SAFE_NAME_PATTERN = /^[\p{L}\p{N} .,'_-]+$/u;
const CUSTOM_THEME_ID_PREFIX = 'CUSTOM:';

function isRgbTriplet(value) {
  return Array.isArray(value) && value.length === 3
    && value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255);
}

// Comma syntax, not the `rgb(r g b)` space syntax used for --cyan-rgb etc. —
// this is the color itself, not a triplet meant to be recombined with an
// alpha slash, and comma syntax is the safest bet for xterm.js's canvas
// fillStyle parsing on top of every browser's CSS parser.
function rgbColor(triplet) {
  return `rgb(${triplet[0]}, ${triplet[1]}, ${triplet[2]})`;
}

function rgbTriplet(triplet) {
  return `${triplet[0]} ${triplet[1]} ${triplet[2]}`;
}

// Returns { name, tokens, terminalColor } or null for anything malformed.
// `tokens` mirrors the shape HUD_ACCENTS entries already carry in theme.js
// (theme-tokens.css custom property name -> value), so the renderer can
// apply a custom theme the exact same way it applies a built-in one.
function validateThemeFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.name !== 'string') return null;
  const name = data.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name || !SAFE_NAME_PATTERN.test(name)) return null;

  const accent = data.accent;
  if (!accent || typeof accent !== 'object' || Array.isArray(accent)) return null;
  if (!isRgbTriplet(accent.cyan) || !isRgbTriplet(accent.cyanBright) || !isRgbTriplet(accent.cyanDim)) return null;

  let terminalColor = null;
  if (data.terminalColor !== undefined) {
    const source = data.terminalColor;
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || !isRgbTriplet(source.foreground) || !isRgbTriplet(source.cursor)) {
      return null;
    }
    terminalColor = { foreground: rgbColor(source.foreground), cursor: rgbColor(source.cursor) };
  }

  return {
    name,
    tokens: {
      '--cyan': rgbColor(accent.cyan),
      '--cyan-bright': rgbColor(accent.cyanBright),
      '--cyan-dim': rgbColor(accent.cyanDim),
      '--cyan-rgb': rgbTriplet(accent.cyan),
      '--cyan-bright-rgb': rgbTriplet(accent.cyanBright),
      '--cyan-dim-rgb': rgbTriplet(accent.cyanDim)
    },
    // No explicit terminalColor in the file — the accent itself reads fine
    // as a terminal palette, so fall back to it instead of forcing every
    // custom theme author to specify two colour pairs for one look.
    terminalColor: terminalColor || { foreground: rgbColor(accent.cyan), cursor: rgbColor(accent.cyanBright) }
  };
}

module.exports = {
  CUSTOM_THEME_ID_PREFIX,
  MAX_NAME_LENGTH,
  SAFE_NAME_PATTERN,
  isRgbTriplet,
  validateThemeFile
};
