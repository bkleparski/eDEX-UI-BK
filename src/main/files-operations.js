'use strict';

// File-manager backend: path validation, copy/move/rename, directory
// listing, image preview. Pure Node (fs/path only) — no Electron API — so
// the Electron main process (src/main.js) and the standalone web server
// (src/server/index.js) share this one implementation instead of drifting
// apart. See src/main.js's registerFilesIpc for the Electron-side wiring and
// src/server/index.js's HANDLERS for the web-side wiring.
//
// Every path arriving here is untrusted (renderer-originated, or in the web
// server's case, browser-originated) and is re-validated as absolute,
// null-byte-free and length-bounded before it ever reaches fs — callers must
// never pass a raw, unvalidated string into fs.* themselves.

const fs = require('node:fs');
const path = require('node:path');
const { safeLabel, finiteNumber } = require('./format-utils');
const { terminalWorkingDirectory } = require('./terminal-metadata');

const MAX_FILE_ENTRIES = 80;
const MAX_BATCH_ENTRIES = 200;
const IMAGE_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PREVIEW_CACHE_LIMIT = 24;
const IMAGE_PREVIEW_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const IMAGE_PREVIEW_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml']
]);

function validDirectoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096
    || value.includes('\0') || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

// File-manager mutations arrive from the renderer, so every path is re-validated
// here and never trusted as-is. The renderer itself never touches the disk.
function validEntryPaths(value) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > MAX_BATCH_ENTRIES) return null;
  const resolved = list.map((item) => validDirectoryPath(item));
  return resolved.every(Boolean) ? [...new Set(resolved)] : null;
}

function validEntryName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 255 || name === '.' || name === '..') return null;
  if (name.includes('\0') || name.includes('/')) return null;
  return name;
}

async function pathExists(target) {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

// Finder-style "name copy.ext" suffixing so a collision never silently overwrites.
async function uniqueDestination(directory, name) {
  const target = path.join(directory, name);
  if (!await pathExists(target)) return target;
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let index = 2; index <= 999; index += 1) {
    const candidate = path.join(directory, `${stem} ${index}${extension}`);
    if (!await pathExists(candidate)) return candidate;
  }
  throw new Error('Could not find a free name in the destination folder.');
}

async function transferEntries(sourcePaths, destinationDirectory, mode) {
  const destination = validDirectoryPath(destinationDirectory);
  if (!destination) throw new Error('Invalid destination folder.');
  const stats = await fs.promises.stat(destination).catch(() => null);
  if (!stats?.isDirectory()) throw new Error('Destination is not a folder.');

  const results = [];
  for (const source of sourcePaths) {
    const name = path.basename(source);
    try {
      if (source === destination || destination.startsWith(`${source}${path.sep}`)) {
        throw new Error('Cannot move a folder into itself.');
      }
      if (path.dirname(source) === destination && mode === 'move') {
        results.push({ path: source, status: 'skipped', reason: 'Already in destination.' });
        continue;
      }
      const target = await uniqueDestination(destination, name);
      if (mode === 'move') {
        try {
          await fs.promises.rename(source, target);
        } catch (error) {
          // EXDEV: crossing a volume boundary needs a copy followed by a delete.
          if (error.code !== 'EXDEV') throw error;
          await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false });
          await fs.promises.rm(source, { recursive: true, force: false });
        }
      } else {
        await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false });
      }
      results.push({ path: source, status: 'ok', target });
    } catch (error) {
      results.push({ path: source, status: 'error', reason: safeLabel(error.message, 'Operation failed.', 160) });
    }
  }
  return { status: results.some((item) => item.status === 'error') ? 'partial' : 'ok', results };
}

// Permanent delete for callers with no OS Trash to move things to (the web
// server — see src/server/index.js's `edexCapabilities.trash: false`). The
// Electron main process keeps using shell.trashItem directly and never calls
// this.
async function removeEntries(targetPaths) {
  const results = [];
  for (const target of targetPaths) {
    try {
      await fs.promises.rm(target, { recursive: true, force: false });
      results.push({ path: target, status: 'ok' });
    } catch (error) {
      results.push({ path: target, status: 'error', reason: safeLabel(error.message, 'Could not delete.', 160) });
    }
  }
  return { status: results.some((item) => item.status === 'error') ? 'partial' : 'ok', results };
}

// One preview cache per process — the Electron main process and the web
// server each get their own via createImagePreviewCache(), same pattern as
// monitoring.js's per-consumer session.
function createImagePreviewCache() {
  return { entries: new Map(), bytes: 0 };
}

function cachedImagePreview(cache, cacheKey) {
  const cached = cache.entries.get(cacheKey);
  if (!cached) return null;
  cache.entries.delete(cacheKey);
  cache.entries.set(cacheKey, cached);
  return cached.response;
}

function cacheImagePreview(cache, cacheKey, response) {
  const bytes = Buffer.byteLength(response.dataUri || '', 'utf8');
  if (bytes > IMAGE_PREVIEW_CACHE_MAX_BYTES) return;
  const existing = cache.entries.get(cacheKey);
  if (existing) cache.bytes -= existing.bytes;
  cache.entries.set(cacheKey, { response, bytes });
  cache.bytes += bytes;
  while (cache.entries.size > IMAGE_PREVIEW_CACHE_LIMIT || cache.bytes > IMAGE_PREVIEW_CACHE_MAX_BYTES) {
    const oldestKey = cache.entries.keys().next().value;
    const oldest = cache.entries.get(oldestKey);
    cache.entries.delete(oldestKey);
    cache.bytes -= oldest.bytes;
  }
}

async function readBoundedFile(fileHandle, size) {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fileHandle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

// No-resize fallback encoder — used as-is by the web server (no nativeImage
// outside Electron) and as the Electron main process's own fallback when
// nativeImage can't decode a format Chromium still renders fine from a data
// URI (e.g. some malformed-but-valid files).
function defaultImagePreviewEncode(buffer, mimeType) {
  return { dataUri: `data:${mimeType};base64,${buffer.toString('base64')}`, width: null, height: null };
}

// `encode` lets the Electron main process plug in a nativeImage-based
// downscaler (see src/main.js's imagePreviewData) without this module ever
// importing Electron; the web server just takes the default (no downscale).
async function previewImageFile(filePath, cache, encode = defaultImagePreviewEncode) {
  const normalizedPath = validDirectoryPath(filePath);
  const mimeType = normalizedPath ? IMAGE_PREVIEW_MIME_TYPES.get(path.extname(normalizedPath).toLowerCase()) : null;
  if (!normalizedPath || !mimeType) return { status: 'unsupported' };

  let fileHandle;
  try {
    fileHandle = await fs.promises.open(normalizedPath, 'r');
    const stats = await fileHandle.stat();
    if (!stats.isFile()) return { status: 'unsupported' };
    if (stats.size > IMAGE_PREVIEW_MAX_BYTES) {
      return { status: 'too-large', maxBytes: IMAGE_PREVIEW_MAX_BYTES, size: stats.size };
    }

    const cacheKey = `${normalizedPath}\0${stats.size}\0${stats.mtimeMs}`;
    const cached = cachedImagePreview(cache, cacheKey);
    if (cached) return cached;

    const buffer = await readBoundedFile(fileHandle, stats.size);
    const image = encode(buffer, mimeType);
    const response = {
      status: 'ok',
      ...image,
      path: normalizedPath,
      sourceBytes: buffer.length
    };
    cacheImagePreview(cache, cacheKey, response);
    return response;
  } catch {
    return { status: 'error' };
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function enrichFileEntries(entries) {
  return Promise.all(entries.map(async (entry) => {
    try {
      const stats = await fs.promises.lstat(entry.fullPath);
      return {
        ...entry,
        sizeBytes: entry.type === 'file' ? Math.max(finiteNumber(stats.size, 0), 0) : null,
        modifiedMs: finiteNumber(stats.mtimeMs, null)
      };
    } catch {
      return { ...entry, sizeBytes: null, modifiedMs: null };
    }
  }));
}

async function listDirectoryFiles(cwd, sessionId, showHidden = false) {
  try {
    const directoryEntries = await fs.promises.readdir(cwd, { withFileTypes: true });
    const entries = directoryEntries
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => ({
        name: safeLabel(entry.name, 'UNKNOWN', 96),
        fullPath: path.join(cwd, entry.name),
        type: entry.isDirectory() ? 'directory'
          : entry.isSymbolicLink() ? 'link'
            : entry.isFile() ? 'file' : 'other'
      }))
      .sort((left, right) => {
        const leftDirectory = left.type === 'directory' ? 0 : 1;
        const rightDirectory = right.type === 'directory' ? 0 : 1;
        return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      });

    return {
      status: 'ok',
      sessionId,
      cwd,
      parentPath: cwd === path.parse(cwd).root ? null : path.dirname(cwd),
      entries: await enrichFileEntries(entries.slice(0, MAX_FILE_ENTRIES)),
      totalCount: entries.length,
      truncated: entries.length > MAX_FILE_ENTRIES
    };
  } catch {
    return {
      status: 'error',
      sessionId,
      cwd: null,
      parentPath: null,
      entries: [],
      totalCount: 0,
      truncated: false
    };
  }
}

async function listTerminalFiles(terminal, sessionId, showHidden = false) {
  try {
    return listDirectoryFiles(await terminalWorkingDirectory(terminal), sessionId, showHidden);
  } catch {
    return {
      status: 'error',
      sessionId,
      cwd: null,
      parentPath: null,
      entries: [],
      totalCount: 0,
      truncated: false
    };
  }
}

module.exports = {
  MAX_FILE_ENTRIES,
  MAX_BATCH_ENTRIES,
  IMAGE_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MIME_TYPES,
  validDirectoryPath,
  validEntryPaths,
  validEntryName,
  pathExists,
  uniqueDestination,
  transferEntries,
  removeEntries,
  createImagePreviewCache,
  defaultImagePreviewEncode,
  previewImageFile,
  enrichFileEntries,
  listDirectoryFiles,
  listTerminalFiles
};
