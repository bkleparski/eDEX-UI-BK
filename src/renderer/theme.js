'use strict';

// Appearance layer for EBARTNET-UI.
//
// The whole HUD is painted from a handful of CSS custom properties declared in
// theme-tokens.css, and every translucent surface is composed from RGB triplets
// (`rgb(var(--cyan-rgb) / .35)`). Overriding those five variables on the root
// element therefore repaints the entire interface, so an accent is just a set of
// values — no per-component theming is needed.
//
// The terminal is deliberately separate: xterm.js renders to a canvas, so its
// colours and font are applied through terminal options rather than CSS.

const THEME_STORAGE_KEY = 'edex-ui-bk.theme.v1';

const HUD_ACCENTS = [
  {
    id: 'cyan',
    label: 'CYAN / TRON',
    swatch: '#00e5ff',
    tokens: {
      '--cyan': '#00e5ff',
      '--cyan-bright': '#8ff8ff',
      '--cyan-dim': '#087f9c',
      '--cyan-rgb': '0 229 255',
      '--cyan-bright-rgb': '143 248 255',
      '--cyan-dim-rgb': '8 127 156'
    }
  },
  {
    id: 'ice',
    label: 'ICE / STAL',
    swatch: '#8fc7e0',
    tokens: {
      '--cyan': '#8fc7e0',
      '--cyan-bright': '#d6ecf5',
      '--cyan-dim': '#4a7d94',
      '--cyan-rgb': '143 199 224',
      '--cyan-bright-rgb': '214 236 245',
      '--cyan-dim-rgb': '74 125 148'
    }
  },
  {
    id: 'mint',
    label: 'MINT / FOSFOR',
    swatch: '#46e5a0',
    tokens: {
      '--cyan': '#46e5a0',
      '--cyan-bright': '#9fe8c4',
      '--cyan-dim': '#1c7f5a',
      '--cyan-rgb': '70 229 160',
      '--cyan-bright-rgb': '159 232 196',
      '--cyan-dim-rgb': '28 127 90'
    }
  },
  {
    id: 'amber',
    label: 'AMBER / BURSZTYN',
    swatch: '#ff9f1c',
    tokens: {
      '--cyan': '#ffb03c',
      '--cyan-bright': '#ffd79a',
      '--cyan-dim': '#a86a10',
      '--cyan-rgb': '255 176 60',
      '--cyan-bright-rgb': '255 215 154',
      '--cyan-dim-rgb': '168 106 16'
    }
  },
  {
    id: 'violet',
    label: 'VIOLET / GRID',
    swatch: '#d580ff',
    tokens: {
      '--cyan': '#d580ff',
      '--cyan-bright': '#eab8ff',
      '--cyan-dim': '#7a3f9c',
      '--cyan-rgb': '213 128 255',
      '--cyan-bright-rgb': '234 184 255',
      '--cyan-dim-rgb': '122 63 156'
    }
  }
];

const TERMINAL_COLORS = [
  { id: 'cyan', label: 'OBECNY CYAN', foreground: '#00e5ff', cursor: '#8ff8ff' },
  { id: 'steel', label: 'STALOWY BŁĘKIT', foreground: '#a8c4d4', cursor: '#7fd6e8' },
  { id: 'ice', label: 'LODOWA BIEL', foreground: '#cfe9f0', cursor: '#8ff8ff' },
  { id: 'mint', label: 'MIĘTA', foreground: '#9fe8c4', cursor: '#6fe0a8' },
  { id: 'amber', label: 'BURSZTYN', foreground: '#f0c674', cursor: '#ffd79a' }
];

// Every stack keeps the Nerd Font as a fallback so prompt glyphs never turn into
// replacement boxes when a face without them is selected.
const NERD_FALLBACK = '"Monaspace Neon NF", "SF Mono", Menlo, monospace';

const TERMINAL_FONTS = [
  { id: 'neon', label: 'MONASPACE NEON', family: NERD_FALLBACK, note: 'Neo-grotesk, krój domyślny' },
  { id: 'argon', label: 'MONASPACE ARGON', family: `"Monaspace Argon", ${NERD_FALLBACK}`, note: 'Humanistyczny, łatwiejszy w czytaniu' },
  { id: 'xenon', label: 'MONASPACE XENON', family: `"Monaspace Xenon", ${NERD_FALLBACK}`, note: 'Szeryfowy slab, klimat lat 80.' },
  { id: 'krypton', label: 'MONASPACE KRYPTON', family: `"Monaspace Krypton", ${NERD_FALLBACK}`, note: 'Mechaniczny, kreślarski' },
  { id: 'jetbrains', label: 'JETBRAINS MONO', family: `"JetBrains Mono", ${NERD_FALLBACK}`, note: 'Najczęściej polecany do terminala' },
  { id: 'fira', label: 'FIRA CODE', family: `"Fira Code", ${NERD_FALLBACK}`, note: 'Klasyk, węższy i zaokrąglony' },
  { id: 'plex', label: 'IBM PLEX MONO', family: `"IBM Plex Mono", ${NERD_FALLBACK}`, note: 'Elegancki, lekko humanistyczny' }
];

const FONT_SIZES = [11, 12, 13, 14, 15, 16];

const DEFAULT_THEME = Object.freeze({
  accent: 'cyan',
  terminalColor: 'cyan',
  terminalFont: 'neon',
  terminalFontSize: 12
});

function accentById(id) {
  return HUD_ACCENTS.find((item) => item.id === id) || HUD_ACCENTS[0];
}

function terminalColorById(id) {
  return TERMINAL_COLORS.find((item) => item.id === id) || TERMINAL_COLORS[0];
}

function terminalFontById(id) {
  return TERMINAL_FONTS.find((item) => item.id === id) || TERMINAL_FONTS[0];
}

function normalizeTheme(value) {
  const source = value && typeof value === 'object' ? value : {};
  const size = Number(source.terminalFontSize);
  return {
    accent: accentById(source.accent).id,
    terminalColor: terminalColorById(source.terminalColor).id,
    terminalFont: terminalFontById(source.terminalFont).id,
    terminalFontSize: FONT_SIZES.includes(size) ? size : DEFAULT_THEME.terminalFontSize
  };
}

function readStoredTheme() {
  try {
    return normalizeTheme(JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_THEME };
  }
}

function saveTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Appearance persistence is optional when storage is unavailable.
  }
}

let currentTheme = readStoredTheme();
const listeners = new Set();

function applyHudTokens(theme) {
  const accent = accentById(theme.accent);
  for (const [token, value] of Object.entries(accent.tokens)) {
    document.documentElement.style.setProperty(token, value);
  }
  document.body.dataset.themeAccent = accent.id;
}

function terminalAppearance(theme = currentTheme) {
  const color = terminalColorById(theme.terminalColor);
  const font = terminalFontById(theme.terminalFont);
  return {
    foreground: color.foreground,
    cursor: color.cursor,
    fontFamily: font.family,
    fontSize: theme.terminalFontSize
  };
}

function applyTheme(theme, { persist = true, notify = true } = {}) {
  currentTheme = normalizeTheme(theme);
  applyHudTokens(currentTheme);
  document.body.dataset.themeTerminalFont = currentTheme.terminalFont;
  document.body.dataset.themeTerminalSize = String(currentTheme.terminalFontSize);
  if (persist) saveTheme(currentTheme);
  if (notify) {
    for (const listener of listeners) {
      try {
        listener(terminalAppearance(currentTheme), currentTheme);
      } catch (error) {
        console.error('Theme listener failed:', error);
      }
    }
  }
  return currentTheme;
}

window.themeApi = Object.freeze({
  accents: HUD_ACCENTS,
  terminalColors: TERMINAL_COLORS,
  terminalFonts: TERMINAL_FONTS,
  fontSizes: FONT_SIZES,
  defaults: DEFAULT_THEME,
  get: () => ({ ...currentTheme }),
  appearance: () => terminalAppearance(),
  set: (patch) => applyTheme({ ...currentTheme, ...patch }),
  reset: () => applyTheme({ ...DEFAULT_THEME }),
  onChange: (listener) => {
    if (typeof listener === 'function') listeners.add(listener);
    return () => listeners.delete(listener);
  }
});

// Paint the HUD before the first frame so the interface never flashes the
// default cyan when another accent is stored.
applyTheme(currentTheme, { persist: false, notify: false });
