'use strict';

// Custom theme directory: seed the example file once, list+validate the
// JSON files that live there. Pure Node (fs/path) — takes the directory as
// an argument instead of reaching for Electron's app.getPath('userData'), so
// the web server can point it at EDEX_WEB_DATA/themes while Electron keeps
// pointing it at userData/themes. See src/main.js's registerThemesIpc and
// src/server/index.js's HANDLERS for the two call sites.

const fs = require('node:fs');
const path = require('node:path');
const { CUSTOM_THEME_ID_PREFIX, validateThemeFile } = require('./theme-file-validator');

const MAX_THEME_FILES = 50;
const EXAMPLE_THEME_FILE_NAME = 'example-theme.json';
const EXAMPLE_THEME_CONTENT = {
  name: 'RINZLER',
  accent: { cyan: [210, 20, 20], cyanBright: [255, 130, 110], cyanDim: [110, 10, 10] },
  terminalColor: { foreground: [255, 90, 70], cursor: [255, 170, 140] }
};

// Runs once at startup. Only seeds the example file the very first time the
// directory itself is created — a user who deletes the example later isn't
// fighting the app recreating it on every launch.
function ensureThemesDirectory(directory) {
  if (fs.existsSync(directory)) return;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, EXAMPLE_THEME_FILE_NAME),
      `${JSON.stringify(EXAMPLE_THEME_CONTENT, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    console.error(`Could not create themes directory: ${error.message}`);
  }
}

// The theme's own `name` is free text (any script, spaces) and isn't unique,
// so the persisted id — the string that ends up in localStorage and has to
// survive a rename/retitle — comes from the filename instead.
function sanitizeThemeIdStem(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  const cleaned = stem.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return cleaned || 'theme';
}

// Re-reads the directory from disk on every call — the file set is tiny
// (MAX_THEME_FILES caps it) and local, so there's no cache to keep in sync
// and a file dropped in while the app is running is picked up on request.
// A malformed file is skipped with a warning; it never takes the app down.
function readCustomThemes(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const themes = [];
  for (const entry of entries) {
    if (themes.length >= MAX_THEME_FILES) break;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const validated = validateThemeFile(parsed);
      if (!validated) {
        console.warn(`Skipping invalid theme file: ${entry.name}`);
        continue;
      }
      themes.push({ id: `${CUSTOM_THEME_ID_PREFIX}${sanitizeThemeIdStem(entry.name)}`, ...validated });
    } catch (error) {
      console.warn(`Skipping unreadable theme file ${entry.name}: ${error.message}`);
    }
  }
  return themes;
}

module.exports = {
  MAX_THEME_FILES,
  EXAMPLE_THEME_FILE_NAME,
  EXAMPLE_THEME_CONTENT,
  ensureThemesDirectory,
  sanitizeThemeIdStem,
  readCustomThemes
};
