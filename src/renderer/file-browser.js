'use strict';

/* exported
  applySelectionClasses, beginFileRename, browseDirectory, browsedDirectory, cacheImagePreview,
  cachedImagePreview, clearFileSelection, closeFileFilter, commitFileRename,
  copyPathsToClipboard, createFileIcon, currentDirectoryPath, fileBrowserBusy, fileBrowserMode,
  fileBrowserRequestId, fileClipboard, fileContextPaths, fileFilterQuery, fileIconPaths,
  fileOperationInFlight, fileRefreshInFlight, fileRefreshTimer, fileRenameTarget,
  fileSelection, fileSelectionAnchor, fileSortAscending, fileSortKey, fileTypeMarker,
  formatFileModified, formatFileSize, getFileBrowserMode, handleFileBrowserKeydown,
  handleRowSelection, hideFileContextMenu, hideFileRename, hideImagePreview, imagePreviewCache,
  imagePreviewCacheChars, imagePreviewCacheLimit, imagePreviewCacheMaxChars,
  imagePreviewCacheTtlMs, imagePreviewCursorX, imagePreviewCursorY, imagePreviewDwellMs,
  imagePreviewExtensions, imagePreviewHoverStartedAt, imagePreviewPath,
  imagePreviewRequestToken, imagePreviewTimer, initializeFileBrowser, isPreviewableImage,
  lastFileBrowserResult, matchesFileFilter, openFileEntry, openFileFilter,
  positionImagePreview, presentImagePreview, reconcileImagePreviewRow, refreshFileBrowser,
  renderCurrentFileBrowserResult, renderFileBrowser, resumeLiveFileBrowser,
  runFileContextAction, runFileOperation, scheduleImagePreview, selectableEntries,
  setFileOperationStatus, setFileSelection, showFileContextMenu, showHiddenFiles,
  showImagePreviewImage, showImagePreviewMessage, sortFileEntries, startFileBrowserPolling,
  stopFileBrowserPolling, stopFileBrowserWatching, toggleDotfiles, toggleFileFilter,
  transferSelection, trashSelection, updateDotfilesState, updateFileBrowserMode,
  updateFileStatusBar, updateSortIndicators
*/

const imagePreviewExtensions = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
const imagePreviewDwellMs = 200;
const imagePreviewCacheLimit = 24;
const imagePreviewCacheTtlMs = 60_000;
const imagePreviewCacheMaxChars = 48 * 1024 * 1024;
let fileRefreshTimer = null;
let fileRefreshInFlight = false;
// Set from the `watching` flag on each files:list response — main.js keeps
// an fs.watch on the resolved directory when it can, and pushes
// files:changed on activity. True means polling is just a slow safety net
// (fs.watch on macOS doesn't always report metadata-only changes); false
// means fs.watch isn't covering this directory and polling is the only
// signal, so it runs fast instead.
let fileWatchingActive = false;
const FILE_POLL_INTERVAL_WATCHING_MS = 10_000;
const FILE_POLL_INTERVAL_FALLBACK_MS = 1_500;
let fileBrowserMode = 'live';
let browsedDirectory = null;
let showHiddenFiles = false;
let fileBrowserRequestId = 0;
let lastFileBrowserResult = null;
const fileSelection = new Set();
let fileSelectionAnchor = null;
let fileSortKey = 'name';
let fileSortAscending = true;
let fileFilterQuery = '';
let fileClipboard = null;
let fileContextPaths = [];
let fileRenameTarget = null;
let fileOperationInFlight = false;
let imagePreviewTimer = null;
let imagePreviewRequestToken = 0;
let imagePreviewHoverStartedAt = 0;
let imagePreviewPath = null;
let imagePreviewCursorX = 0;
let imagePreviewCursorY = 0;
const imagePreviewCache = new Map();
let imagePreviewCacheChars = 0;

function fileTypeMarker(type) {
  if (type === 'directory') return '[D]';
  if (type === 'link') return '[L]';
  if (type === 'file') return '[F]';
  return '[?]';
}

const fileIconPaths = {
  parent: ['M3 7.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M12 17v-5m0 0-2.2 2.2M12 12l2.2 2.2'],
  directory: ['M3 7.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'],
  file: ['M6 3.5h8l4 4v13H6z', 'M14 3.5v4h4'],
  link: [
    'M10.5 13.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1',
    'M13.5 10.5a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1'
  ],
  other: ['M6 3.5h8l4 4v13H6z']
};

function createFileIcon(entry) {
  const key = entry.parent ? 'parent' : fileIconPaths[entry.type] ? entry.type : 'other';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'file-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const definition of fileIconPaths[key]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

function formatFileSize(bytes) {
  const value = numeric(bytes);
  if (value === null) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function formatFileModified(modifiedMs) {
  const value = numeric(modifiedMs);
  if (value === null) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const datePart = date.toLocaleDateString('pl-PL', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
  const timePart = date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

function isPreviewableImage(entry) {
  return entry?.type === 'file' && imagePreviewExtensions.test(entry.fullPath || '');
}

function cachedImagePreview(filePath) {
  const cached = imagePreviewCache.get(filePath);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    imagePreviewCache.delete(filePath);
    imagePreviewCacheChars -= cached.chars;
    return null;
  }
  imagePreviewCache.delete(filePath);
  imagePreviewCache.set(filePath, cached);
  return cached.response;
}

function cacheImagePreview(filePath, response) {
  const chars = typeof response?.dataUri === 'string' ? response.dataUri.length : 128;
  if (chars > imagePreviewCacheMaxChars) return;
  const existing = imagePreviewCache.get(filePath);
  if (existing) imagePreviewCacheChars -= existing.chars;
  imagePreviewCache.set(filePath, { response, chars, expiresAt: Date.now() + imagePreviewCacheTtlMs });
  imagePreviewCacheChars += chars;
  while (imagePreviewCache.size > imagePreviewCacheLimit || imagePreviewCacheChars > imagePreviewCacheMaxChars) {
    const oldestPath = imagePreviewCache.keys().next().value;
    const oldest = imagePreviewCache.get(oldestPath);
    imagePreviewCache.delete(oldestPath);
    imagePreviewCacheChars -= oldest.chars;
  }
}

function positionImagePreview() {
  const preview = document.getElementById('fileImagePreview');
  if (preview.hidden) return;
  const margin = 8;
  const offset = 16;
  const rect = preview.getBoundingClientRect();
  let left = imagePreviewCursorX + offset;
  let top = imagePreviewCursorY + offset;
  if (left + rect.width > window.innerWidth - margin) left = imagePreviewCursorX - rect.width - offset;
  if (top + rect.height > window.innerHeight - margin) top = imagePreviewCursorY - rect.height - offset;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - rect.width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - rect.height - margin));
  preview.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function hideImagePreview(reason = 'leave') {
  const preview = document.getElementById('fileImagePreview');
  const image = document.getElementById('fileImagePreviewImage');
  const wasActive = imagePreviewPath !== null || !preview.hidden;
  clearTimeout(imagePreviewTimer);
  imagePreviewTimer = null;
  imagePreviewRequestToken += 1;
  imagePreviewPath = null;
  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  preview.dataset.state = 'hidden';
  document.body.dataset.imagePreviewVisible = 'false';
  if (reason === 'drag' && wasActive) document.body.dataset.imagePreviewHiddenByDrag = 'true';
}

function showImagePreviewMessage(message, fileName, requestToken) {
  if (requestToken !== imagePreviewRequestToken || !imagePreviewPath) return;
  const preview = document.getElementById('fileImagePreview');
  const image = document.getElementById('fileImagePreviewImage');
  const messageNode = document.getElementById('fileImagePreviewMessage');
  image.hidden = true;
  messageNode.hidden = false;
  messageNode.textContent = message;
  document.getElementById('fileImagePreviewLabel').textContent = fileName;
  preview.dataset.state = 'message';
  preview.hidden = false;
  preview.setAttribute('aria-hidden', 'false');
  document.body.dataset.imagePreviewVisible = 'true';
  requestAnimationFrame(positionImagePreview);
}

function showImagePreviewImage(response, fileName, requestToken) {
  if (requestToken !== imagePreviewRequestToken || !imagePreviewPath
    || typeof response.dataUri !== 'string' || !response.dataUri.startsWith('data:image/')) return;
  const preview = document.getElementById('fileImagePreview');
  const image = document.getElementById('fileImagePreviewImage');
  const messageNode = document.getElementById('fileImagePreviewMessage');
  image.onload = () => {
    if (requestToken !== imagePreviewRequestToken || !imagePreviewPath) return;
    messageNode.hidden = true;
    image.hidden = false;
    document.getElementById('fileImagePreviewLabel').textContent = fileName;
    preview.dataset.state = 'image';
    preview.hidden = false;
    preview.setAttribute('aria-hidden', 'false');
    document.body.dataset.imagePreviewVisible = 'true';
    document.body.dataset.imagePreviewNaturalWidth = String(image.naturalWidth);
    document.body.dataset.imagePreviewNaturalHeight = String(image.naturalHeight);
    requestAnimationFrame(positionImagePreview);
  };
  image.onerror = () => {
    if (requestToken === imagePreviewRequestToken) hideImagePreview('decode-error');
  };
  image.src = response.dataUri;
}

function presentImagePreview(response, fileName, requestToken) {
  if (response?.status === 'ok') {
    showImagePreviewImage(response, fileName, requestToken);
  } else if (response?.status === 'too-large') {
    showImagePreviewMessage('FILE TOO LARGE', fileName, requestToken);
  } else if (requestToken === imagePreviewRequestToken) {
    hideImagePreview('unavailable');
  }
}

function scheduleImagePreview(row, clientX, clientY) {
  const filePath = row?.dataset.path;
  if (!filePath || row.dataset.previewable !== 'true') return;
  clearTimeout(imagePreviewTimer);
  imagePreviewRequestToken += 1;
  const requestToken = imagePreviewRequestToken;
  imagePreviewPath = filePath;
  imagePreviewCursorX = clientX;
  imagePreviewCursorY = clientY;
  imagePreviewHoverStartedAt = Date.now();
  imagePreviewTimer = setTimeout(async () => {
    imagePreviewTimer = null;
    if (requestToken !== imagePreviewRequestToken || imagePreviewPath !== filePath) return;
    document.body.dataset.imagePreviewDwellMs = String(Date.now() - imagePreviewHoverStartedAt);
    const cached = cachedImagePreview(filePath);
    if (cached) {
      document.body.dataset.imagePreviewCacheHit = 'true';
      presentImagePreview(cached, row.dataset.name, requestToken);
      return;
    }
    document.body.dataset.imagePreviewRequestCount = String(
      (Number(document.body.dataset.imagePreviewRequestCount) || 0) + 1
    );
    try {
      const response = await window.filesApi.preview(filePath);
      if (response?.status === 'ok' || response?.status === 'too-large') cacheImagePreview(filePath, response);
      presentImagePreview(response, row.dataset.name, requestToken);
    } catch {
      if (requestToken === imagePreviewRequestToken) hideImagePreview('ipc-error');
    }
  }, imagePreviewDwellMs);
}

function reconcileImagePreviewRow(list) {
  if (!imagePreviewPath) return;
  const replacement = [...list.querySelectorAll('.file-row[data-previewable="true"]')]
    .find((row) => row.dataset.path === imagePreviewPath);
  if (!replacement) {
    hideImagePreview('listing-changed');
    return;
  }
  const rect = replacement.getBoundingClientRect();
  if (imagePreviewCursorX < rect.left || imagePreviewCursorX > rect.right
    || imagePreviewCursorY < rect.top || imagePreviewCursorY > rect.bottom) {
    hideImagePreview('pointer-left');
    return;
  }
}

// Minimal read accessor for renderer.js core (switchTerminalSession needs to
// know this without owning it).
function getFileBrowserMode() {
  return fileBrowserMode;
}

function updateFileBrowserMode(mode) {
  fileBrowserMode = mode === 'browsing' ? 'browsing' : 'live';
  const browsing = fileBrowserMode === 'browsing';
  const chip = document.getElementById('fileBrowserMode');
  chip.textContent = browsing ? 'BROWSING' : 'LIVE';
  chip.classList.toggle('is-on', browsing);
  chip.dataset.mode = fileBrowserMode;
  chip.disabled = !browsing;
  chip.setAttribute('aria-pressed', String(browsing));
  chip.title = browsing ? 'RESUME LIVE TRACKING' : 'LIVE CWD TRACKING';
  document.body.dataset.fileBrowserMode = fileBrowserMode;
}

function updateDotfilesState() {
  const toggle = document.getElementById('dotfilesToggle');
  toggle.textContent = showHiddenFiles ? 'DOTS SHOWN' : 'DOTS HIDDEN';
  toggle.classList.toggle('is-on', showHiddenFiles);
  toggle.setAttribute('aria-pressed', String(showHiddenFiles));
  toggle.setAttribute('aria-label', showHiddenFiles ? 'Ukryj ukryte pliki' : 'Pokaz ukryte pliki');
  toggle.title = showHiddenFiles ? 'HIDE DOTFILES (⌘⇧.)' : 'SHOW DOTFILES (⌘⇧.)';
  document.body.dataset.dotfilesVisible = String(showHiddenFiles);
}

function toggleDotfiles() {
  showHiddenFiles = !showHiddenFiles;
  document.body.dataset.dotfilesToggleCount = String(
    (Number(document.body.dataset.dotfilesToggleCount) || 0) + 1
  );
  fileBrowserRequestId += 1;
  fileRefreshInFlight = false;
  updateDotfilesState();
  refreshFileBrowser();
  focusTerminal();
}

function fileBrowserBusy() {
  return fileOperationInFlight
    || !document.getElementById('fileContextMenu').hidden
    || !document.getElementById('fileRenamePopover').hidden;
}

function currentDirectoryPath() {
  return lastFileBrowserResult?.status === 'ok' ? lastFileBrowserResult.cwd : null;
}

function selectableEntries() {
  const entries = Array.isArray(lastFileBrowserResult?.entries) ? lastFileBrowserResult.entries : [];
  return sortFileEntries(entries.filter(matchesFileFilter));
}

function matchesFileFilter(entry) {
  if (!fileFilterQuery) return true;
  return entry.name.toLowerCase().includes(fileFilterQuery);
}

function sortFileEntries(entries) {
  const direction = fileSortAscending ? 1 : -1;
  return [...entries].sort((left, right) => {
    // Folders stay grouped above files regardless of the active sort column.
    const leftDirectory = left.type === 'directory' ? 0 : 1;
    const rightDirectory = right.type === 'directory' ? 0 : 1;
    if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory;
    if (fileSortKey === 'size') {
      return ((left.sizeBytes ?? -1) - (right.sizeBytes ?? -1)) * direction
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    if (fileSortKey === 'modified') {
      return ((left.modifiedMs ?? 0) - (right.modifiedMs ?? 0)) * direction
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) * direction;
  });
}

function updateSortIndicators() {
  for (const button of document.querySelectorAll('.file-sort-btn')) {
    const active = button.dataset.sortKey === fileSortKey;
    button.classList.toggle('is-active', active);
    button.dataset.direction = active ? (fileSortAscending ? 'asc' : 'desc') : '';
  }
}

function updateFileStatusBar() {
  const selected = [...fileSelection];
  const entries = Array.isArray(lastFileBrowserResult?.entries) ? lastFileBrowserResult.entries : [];
  const chosen = entries.filter((entry) => selected.includes(entry.fullPath));
  const totalBytes = chosen.reduce((sum, entry) => sum + (numeric(entry.sizeBytes) ?? 0), 0);
  const label = document.getElementById('fileStatusSelection');
  if (chosen.length === 0) {
    label.textContent = 'NIC NIE ZAZNACZONO';
  } else if (chosen.length === 1) {
    label.textContent = `${chosen[0].name} · ${chosen[0].type === 'directory' ? 'KATALOG' : formatFileSize(chosen[0].sizeBytes)}`;
  } else {
    label.textContent = `${chosen.length} ZAZNACZONE · ${formatFileSize(totalBytes)}`;
  }
  const clipboard = document.getElementById('fileStatusClipboard');
  clipboard.textContent = fileClipboard
    ? `SCHOWEK: ${fileClipboard.paths.length} · ${fileClipboard.mode === 'copy' ? 'KOPIUJ' : 'PRZENIEŚ'}`
    : '';
  document.body.dataset.fileSelectionCount = String(chosen.length);
}

function applySelectionClasses() {
  for (const row of document.querySelectorAll('#fileList .file-row')) {
    row.classList.toggle('is-selected', fileSelection.has(row.dataset.path));
  }
  updateFileStatusBar();
}

function setFileSelection(paths) {
  fileSelection.clear();
  for (const item of paths) fileSelection.add(item);
  applySelectionClasses();
}

function clearFileSelection() {
  fileSelection.clear();
  fileSelectionAnchor = null;
  applySelectionClasses();
}

function handleRowSelection(row, event) {
  const visible = selectableEntries().map((entry) => entry.fullPath);
  const filePath = row.dataset.path;
  if (event.shiftKey && fileSelectionAnchor && visible.includes(fileSelectionAnchor)) {
    const from = visible.indexOf(fileSelectionAnchor);
    const to = visible.indexOf(filePath);
    const [start, end] = from < to ? [from, to] : [to, from];
    setFileSelection(visible.slice(start, end + 1));
    return;
  }
  if (event.metaKey) {
    if (fileSelection.has(filePath)) fileSelection.delete(filePath);
    else fileSelection.add(filePath);
    fileSelectionAnchor = filePath;
    applySelectionClasses();
    return;
  }
  fileSelectionAnchor = filePath;
  setFileSelection([filePath]);
}

function setFileOperationStatus(message) {
  document.getElementById('fileStatusSelection').textContent = message;
}

async function runFileOperation(label, task) {
  if (fileOperationInFlight) return null;
  fileOperationInFlight = true;
  setFileOperationStatus(label);
  try {
    return await task();
  } catch (error) {
    const text = typeof error?.message === 'string' ? error.message : 'OPERACJA NIE POWIODLA SIE';
    setFileOperationStatus(text.replace(/^Error invoking remote method '[^']+':\s*/i, '').slice(0, 120));
    document.body.dataset.fileOperationError = 'true';
    return null;
  } finally {
    fileOperationInFlight = false;
    fileBrowserRequestId += 1;
    fileRefreshInFlight = false;
    await refreshFileBrowser(fileBrowserMode === 'browsing' ? browsedDirectory : null);
    updateFileStatusBar();
  }
}

function openFileEntry(filePath, type) {
  if (!filePath) return;
  if (type === 'directory') {
    clearFileSelection();
    browseDirectory(filePath);
    return;
  }
  runFileOperation('OTWIERANIE…', async () => {
    await window.filesApi.open(filePath);
    document.body.dataset.fileOpenCount = String((Number(document.body.dataset.fileOpenCount) || 0) + 1);
  });
}

function hideFileContextMenu() {
  const menu = document.getElementById('fileContextMenu');
  menu.hidden = true;
  menu.setAttribute('aria-hidden', 'true');
  fileContextPaths = [];
  document.body.dataset.fileContextMenuOpen = 'false';
}

function showFileContextMenu(clientX, clientY) {
  const menu = document.getElementById('fileContextMenu');
  fileContextPaths = [...fileSelection];
  if (fileContextPaths.length === 0) return;
  const multiple = fileContextPaths.length > 1;
  const suffix = multiple ? ` (${fileContextPaths.length})` : '';
  const labels = {
    open: multiple ? `OTWÓRZ${suffix}` : 'OTWÓRZ',
    rename: 'ZMIEŃ NAZWĘ',
    insert: `DODAJ ŚCIEŻKĘ DO TERMINALA${suffix}`,
    'copy-path': `KOPIUJ ŚCIEŻKĘ${suffix}`,
    copy: `KOPIUJ${suffix}`,
    move: `PRZENIEŚ…${suffix}`,
    reveal: 'POKAŻ W FINDERZE',
    trash: `USUŃ DO KOSZA${suffix}`
  };
  for (const item of menu.querySelectorAll('[data-file-action]')) {
    const action = item.dataset.fileAction;
    item.textContent = labels[action] || item.textContent;
    // Renaming and revealing only make sense for exactly one entry.
    item.hidden = multiple && (action === 'rename' || action === 'reveal');
  }
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
  document.body.dataset.fileContextMenuOpen = 'true';
  positionTTYOverlay(menu, clientX, clientY);
}

function hideFileRename() {
  const popover = document.getElementById('fileRenamePopover');
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  fileRenameTarget = null;
  document.body.dataset.fileRenameOpen = 'false';
}

function beginFileRename(filePath, { create = false } = {}) {
  const row = [...document.querySelectorAll('#fileList .file-row')].find((item) => item.dataset.path === filePath);
  const popover = document.getElementById('fileRenamePopover');
  const input = document.getElementById('fileRenameInput');
  fileRenameTarget = create ? { mode: 'create', parent: filePath } : { mode: 'rename', path: filePath };
  document.getElementById('fileRenameLabel').textContent = create ? 'NAZWA NOWEGO FOLDERU' : 'NOWA NAZWA';
  input.value = create ? '' : (row?.dataset.name || '');
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  document.body.dataset.fileRenameOpen = 'true';
  const anchor = row?.getBoundingClientRect();
  positionTTYOverlay(popover, anchor ? anchor.left : window.innerWidth / 2, anchor ? anchor.bottom : window.innerHeight / 2);
  input.focus();
  input.select();
}

function commitFileRename() {
  const input = document.getElementById('fileRenameInput');
  const name = input.value.trim();
  const target = fileRenameTarget;
  if (!target || !name) {
    hideFileRename();
    return;
  }
  hideFileRename();
  if (target.mode === 'create') {
    runFileOperation('TWORZENIE FOLDERU…', () => window.filesApi.makeDirectory(target.parent, name));
    return;
  }
  runFileOperation('ZMIANA NAZWY…', async () => {
    const result = await window.filesApi.rename(target.path, name);
    if (result?.target) setFileSelection([result.target]);
    document.body.dataset.fileRenameCount = String((Number(document.body.dataset.fileRenameCount) || 0) + 1);
    return result;
  });
}

function copyPathsToClipboard(paths) {
  const payload = paths.join('\n');
  navigator.clipboard?.writeText(payload).catch(() => {});
  setFileOperationStatus(`SKOPIOWANO ${paths.length === 1 ? 'ŚCIEŻKĘ' : `${paths.length} ŚCIEŻEK`}`);
}

function transferSelection(paths, mode) {
  runFileOperation(mode === 'copy' ? 'KOPIOWANIE…' : 'PRZENOSZENIE…', async () => {
    const choice = await window.filesApi.chooseDirectory(currentDirectoryPath());
    if (choice?.status !== 'ok') return null;
    const result = await window.filesApi.transfer(paths, choice.directory, mode);
    document.body.dataset.fileTransferCount = String((Number(document.body.dataset.fileTransferCount) || 0) + 1);
    return result;
  });
}

async function trashSelection(paths) {
  const hasDirectory = [...document.querySelectorAll('#fileList .file-row')]
    .some((row) => paths.includes(row.dataset.path) && row.dataset.type === 'directory');
  if (hasDirectory || paths.length > 1) {
    const confirmation = await window.filesApi.confirm({
      message: paths.length > 1
        ? `Przenieść ${paths.length} elementów do Kosza?`
        : 'Przenieść katalog do Kosza?',
      detail: paths.slice(0, 8).map((item) => item.split('/').pop()).join('\n'),
      confirmLabel: 'Do Kosza'
    });
    if (!confirmation?.confirmed) return;
  }
  runFileOperation('USUWANIE…', async () => {
    const result = await window.filesApi.trash(paths);
    clearFileSelection();
    document.body.dataset.fileTrashCount = String((Number(document.body.dataset.fileTrashCount) || 0) + 1);
    return result;
  });
}

function runFileContextAction(action) {
  const paths = [...fileContextPaths];
  hideFileContextMenu();
  if (paths.length === 0) return;
  const row = [...document.querySelectorAll('#fileList .file-row')].find((item) => item.dataset.path === paths[0]);
  if (action === 'open') {
    if (paths.length === 1) openFileEntry(paths[0], row?.dataset.type);
    else paths.forEach((item) => window.filesApi.open(item).catch(() => {}));
  } else if (action === 'rename') {
    beginFileRename(paths[0]);
  } else if (action === 'insert') {
    insertDroppedPaths(paths, 'browser');
  } else if (action === 'copy-path') {
    copyPathsToClipboard(paths);
  } else if (action === 'copy') {
    fileClipboard = { mode: 'copy', paths };
    updateFileStatusBar();
  } else if (action === 'move') {
    transferSelection(paths, 'move');
  } else if (action === 'reveal') {
    window.filesApi.reveal(paths[0]).catch(() => {});
  } else if (action === 'trash') {
    trashSelection(paths);
  }
}

function stopFileBrowserPolling() {
  if (fileRefreshTimer !== null) clearTimeout(fileRefreshTimer);
  fileRefreshTimer = null;
}

// A recursive setTimeout (rather than setInterval) so the cadence can adapt
// on the fly: fast (fallback) while fs.watch isn't covering the current
// directory, slow (safety net) once it is — each tick just re-reads
// fileWatchingActive, no need to tear down/recreate a timer to switch.
function scheduleNextFileBrowserPoll() {
  const intervalMs = fileWatchingActive ? FILE_POLL_INTERVAL_WATCHING_MS : FILE_POLL_INTERVAL_FALLBACK_MS;
  fileRefreshTimer = setTimeout(async () => {
    await refreshFileBrowser();
    scheduleNextFileBrowserPoll();
  }, intervalMs);
}

function startFileBrowserPolling() {
  stopFileBrowserPolling();
  scheduleNextFileBrowserPoll();
}

// Tears down the main-process fs.watch for this window. Called wherever the
// FILES panel actually closes (filesystem-ui.js) and on unload — window
// close is also covered independently, main-side, by main.js's own
// webContents 'destroyed' cleanup, so nothing is left watching either way.
function stopFileBrowserWatching() {
  fileWatchingActive = false;
  window.filesApi.stopWatching();
}

function resumeLiveFileBrowser({ refresh = true } = {}) {
  browsedDirectory = null;
  fileBrowserRequestId += 1;
  fileRefreshInFlight = false;
  updateFileBrowserMode('live');
  startFileBrowserPolling();
  if (refresh) refreshFileBrowser();
}

function renderCurrentFileBrowserResult() {
  renderFileBrowser(lastFileBrowserResult);
}

function renderFileBrowser(result) {
  lastFileBrowserResult = result;
  const list = document.getElementById('fileList');
  const viewMode = document.body.dataset.fileViewMode || 'compact';
  list.classList.toggle('file-list--detailed', viewMode === 'detailed');
  list.classList.toggle('file-list--tiles', viewMode === 'tiles');
  document.getElementById('fileListColumns').hidden = viewMode !== 'detailed';
  list.replaceChildren();
  const ready = result?.status === 'ok';
  document.body.dataset.fileBrowserReady = String(ready);
  document.getElementById('fileBrowserError').hidden = ready;
  document.getElementById('fileBrowserSession').textContent = activeSessionId
    ? activeSessionId.replace('tty-', 'TTY ')
    : 'TTY --';
  document.getElementById('fileBrowserCount').textContent = ready
    ? `${result.totalCount}${result.truncated ? '+' : ''} ITEMS`
    : '-- ITEMS';
  const cwd = ready && result.cwd ? result.cwd : 'N/A';
  const cwdNode = document.getElementById('fileBrowserCwd');
  cwdNode.textContent = `CWD ${cwd}`;
  cwdNode.title = ready && result.cwd ? result.cwd : '';

  if (!ready) {
    hideImagePreview('listing-unavailable');
    clearFileSelection();
    return;
  }
  const visibleEntries = selectableEntries();
  updateSortIndicators();
  const filterCount = document.getElementById('fileFilterCount');
  filterCount.textContent = fileFilterQuery
    ? `${visibleEntries.length}/${result.entries?.length ?? 0}`
    : '';

  // Drop selected paths that no longer exist so the status bar cannot lie.
  const availablePaths = new Set((result.entries || []).map((entry) => entry.fullPath));
  for (const selected of [...fileSelection]) {
    if (!availablePaths.has(selected)) fileSelection.delete(selected);
  }

  const entries = [...visibleEntries];
  if (result.parentPath && !fileFilterQuery) {
    entries.unshift({ name: '..', fullPath: result.parentPath, type: 'directory', parent: true });
  }

  if (entries.length === 0) {
    hideImagePreview('listing-empty');
    const empty = document.createElement('li');
    empty.className = 'file-empty hud-label';
    empty.textContent = fileFilterQuery ? 'BRAK DOPASOWAN' : 'DIRECTORY EMPTY';
    list.append(empty);
    updateFileStatusBar();
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('li');
    row.className = `file-row file-row--${entry.type}`;
    if (entry.parent) row.classList.add('file-row--parent');
    row.draggable = true;
    row.dataset.path = entry.fullPath;
    row.dataset.type = entry.type;
    row.dataset.name = entry.name;
    if (isPreviewableImage(entry)) {
      row.classList.add('file-row--image');
      row.dataset.previewable = 'true';
    }
    row.title = entry.fullPath;
    const marker = document.createElement('span');
    marker.className = 'file-marker';
    marker.textContent = fileTypeMarker(entry.type);
    const icon = createFileIcon(entry);
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.parent ? '..' : `${entry.name}${entry.type === 'directory' ? '/' : ''}`;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry.parent ? '' : entry.type === 'directory' ? '--' : formatFileSize(entry.sizeBytes);
    const modified = document.createElement('span');
    modified.className = 'file-modified';
    modified.textContent = entry.parent ? '' : formatFileModified(entry.modifiedMs);
    row.append(marker, icon, name, size, modified);
    list.append(row);
  });
  applySelectionClasses();
  reconcileImagePreviewRow(list);
}

async function refreshFileBrowser(directoryPath = null) {
  if (document.getElementById('filesPanel').hidden || fileRefreshInFlight) return;
  // A live refresh would rebuild the list under an open menu or rename field.
  if (fileBrowserBusy() && directoryPath === null) return;
  const requestedSessionId = activeSessionId;
  const requestedMode = fileBrowserMode;
  const requestedDirectory = requestedMode === 'browsing' ? (directoryPath || browsedDirectory) : null;
  if (!requestedSessionId) {
    renderFileBrowser(null);
    return;
  }

  const requestId = ++fileBrowserRequestId;
  fileRefreshInFlight = true;
  try {
    const result = await window.filesApi.list(requestedSessionId, requestedDirectory, showHiddenFiles);
    fileWatchingActive = result?.watching === true;
    if (requestId !== fileBrowserRequestId || requestedSessionId !== activeSessionId
      || requestedMode !== fileBrowserMode) return;
    if (requestedMode === 'browsing' && result?.status === 'ok') browsedDirectory = result.cwd;
    renderFileBrowser(result);
  } catch {
    fileWatchingActive = false;
    if (requestId === fileBrowserRequestId && requestedSessionId === activeSessionId) renderFileBrowser(null);
  } finally {
    if (requestId === fileBrowserRequestId) fileRefreshInFlight = false;
  }
}

function browseDirectory(directoryPath) {
  if (typeof directoryPath !== 'string' || directoryPath.length === 0) return;
  browsedDirectory = directoryPath;
  fileBrowserRequestId += 1;
  fileRefreshInFlight = false;
  stopFileBrowserPolling();
  updateFileBrowserMode('browsing');
  refreshFileBrowser(directoryPath);
}

function initializeFileBrowser() {
  const list = document.getElementById('fileList');
  const modeChip = document.getElementById('fileBrowserMode');
  const dotfilesToggle = document.getElementById('dotfilesToggle');

  // Finder semantics: a single click selects, a double click opens or enters.
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.file-row');
    if (!row) {
      clearFileSelection();
      return;
    }
    if (row.classList.contains('file-row--parent')) {
      clearFileSelection();
      return;
    }
    handleRowSelection(row, event);
  });

  list.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.file-row');
    if (!row) return;
    openFileEntry(row.dataset.path, row.dataset.type);
  });

  list.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.file-row');
    event.preventDefault();
    if (!row || row.classList.contains('file-row--parent')) return;
    if (!fileSelection.has(row.dataset.path)) {
      fileSelectionAnchor = row.dataset.path;
      setFileSelection([row.dataset.path]);
    }
    showFileContextMenu(event.clientX, event.clientY);
  });

  list.addEventListener('pointerover', (event) => {
    const row = event.target.closest('.file-row[data-previewable="true"]');
    if (!row || row.contains(event.relatedTarget)) return;
    scheduleImagePreview(row, event.clientX, event.clientY);
  });

  list.addEventListener('pointermove', (event) => {
    const row = event.target.closest('.file-row[data-previewable="true"]');
    if (!row || row.dataset.path !== imagePreviewPath) return;
    imagePreviewCursorX = event.clientX;
    imagePreviewCursorY = event.clientY;
    positionImagePreview();
  });

  list.addEventListener('pointerout', (event) => {
    const row = event.target.closest('.file-row[data-previewable="true"]');
    if (!row || row.contains(event.relatedTarget) || row.dataset.path !== imagePreviewPath) return;
    hideImagePreview('leave');
  });

  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.file-row');
    if (!row || !event.dataTransfer) return;
    hideImagePreview('drag');
    // Dragging a selected row carries the whole selection into the terminal.
    const dragged = fileSelection.has(row.dataset.path) && fileSelection.size > 1
      ? [...fileSelection]
      : [row.dataset.path];
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', dragged.join('\n'));
    event.dataTransfer.setData(internalFilePathMime, dragged.join('\n'));
    for (const item of document.querySelectorAll('#fileList .file-row')) {
      if (dragged.includes(item.dataset.path)) item.classList.add('is-dragging');
    }
    document.body.classList.add('file-browser-dragging');
    document.body.dataset.fileBrowserDragStarted = 'true';
  });

  list.addEventListener('dragend', (_event) => {
    for (const item of document.querySelectorAll('#fileList .file-row.is-dragging')) {
      item.classList.remove('is-dragging');
    }
    document.body.classList.remove('file-browser-dragging');
  });

  modeChip.addEventListener('click', () => {
    if (fileBrowserMode === 'browsing') resumeLiveFileBrowser();
  });
  dotfilesToggle.addEventListener('click', toggleDotfiles);

  for (const button of document.querySelectorAll('.file-sort-btn')) {
    button.addEventListener('click', () => {
      const key = button.dataset.sortKey;
      if (fileSortKey === key) fileSortAscending = !fileSortAscending;
      else {
        fileSortKey = key;
        // Sizes and dates read best largest/newest first.
        fileSortAscending = key === 'name';
      }
      renderCurrentFileBrowserResult();
    });
  }

  for (const item of document.getElementById('fileContextMenu').querySelectorAll('[data-file-action]')) {
    item.addEventListener('click', () => runFileContextAction(item.dataset.fileAction));
  }

  document.getElementById('fileNewFolder').addEventListener('click', () => {
    const parent = currentDirectoryPath();
    if (parent) beginFileRename(parent, { create: true });
  });

  document.getElementById('fileFilterToggle').addEventListener('click', toggleFileFilter);

  const filterInput = document.getElementById('fileFilterInput');
  filterInput.addEventListener('input', () => {
    fileFilterQuery = filterInput.value.trim().toLowerCase();
    renderCurrentFileBrowserResult();
  });
  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFileFilter();
    }
  });

  const renameInput = document.getElementById('fileRenameInput');
  renameInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commitFileRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideFileRename();
      focusTerminal();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    const menu = document.getElementById('fileContextMenu');
    if (!menu.hidden && !menu.contains(event.target)) hideFileContextMenu();
    const popover = document.getElementById('fileRenamePopover');
    if (!popover.hidden && !popover.contains(event.target)) hideFileRename();
  }, true);

  list.addEventListener('scroll', () => hideImagePreview('scroll'), { passive: true });
  window.addEventListener('resize', positionImagePreview);
  window.addEventListener('blur', () => hideImagePreview('blur'));

  // Pushed by main.js's fs.watch on the resolved directory (debounced there)
  // — just triggers an immediate refresh; refreshFileBrowser's own guards
  // (hidden panel, in-flight, busy) decide whether that actually does
  // anything.
  window.filesApi.onChanged(() => refreshFileBrowser());

  updateFileBrowserMode('live');
  updateDotfilesState();
  updateSortIndicators();
  updateFileStatusBar();
  startFileBrowserPolling();
  window.addEventListener('beforeunload', () => {
    stopFileBrowserPolling();
    stopFileBrowserWatching();
  }, { once: true });
}

function toggleFileFilter() {
  const bar = document.getElementById('fileFilterBar');
  if (bar.hidden) openFileFilter(); else closeFileFilter();
}

function openFileFilter() {
  const bar = document.getElementById('fileFilterBar');
  bar.hidden = false;
  document.getElementById('fileFilterToggle').setAttribute('aria-pressed', 'true');
  document.getElementById('fileFilterInput').focus();
}

function closeFileFilter() {
  const bar = document.getElementById('fileFilterBar');
  bar.hidden = true;
  document.getElementById('fileFilterToggle').setAttribute('aria-pressed', 'false');
  document.getElementById('fileFilterInput').value = '';
  fileFilterQuery = '';
  renderCurrentFileBrowserResult();
  focusTerminal();
}

// Keyboard control for the file panel. Only active while the panel is open and the
// terminal does not own the keystroke (the shell keeps priority for plain typing).
function handleFileBrowserKeydown(event) {
  const panel = document.getElementById('filesPanel');
  if (panel.hidden || bootActive) return;
  if (!document.getElementById('fileRenamePopover').hidden) return;
  const filterFocused = document.activeElement === document.getElementById('fileFilterInput');

  // ⌘F is shared with terminal search (initializeControls): only claim it here
  // when focus is actually inside FILES — otherwise fall through unhandled so
  // the terminal search shortcut gets it, matching iTerm2-style expectations.
  if (event.metaKey && !event.altKey && !event.ctrlKey && event.code === 'KeyF') {
    if (!panel.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    openFileFilter();
    return;
  }
  if (event.metaKey && event.shiftKey && event.code === 'KeyN') {
    event.preventDefault();
    event.stopPropagation();
    const parent = currentDirectoryPath();
    if (parent) beginFileRename(parent, { create: true });
    return;
  }
  if (event.key === 'Escape' && !document.getElementById('fileContextMenu').hidden) {
    event.preventDefault();
    hideFileContextMenu();
    return;
  }
  if (filterFocused) return;

  const paths = [...fileSelection];
  if (event.metaKey && !event.shiftKey && event.code === 'KeyA') {
    event.preventDefault();
    event.stopPropagation();
    setFileSelection(selectableEntries().map((entry) => entry.fullPath));
    return;
  }
  if (event.metaKey && event.altKey && event.code === 'KeyC' && paths.length) {
    event.preventDefault();
    copyPathsToClipboard(paths);
    return;
  }
  if (event.metaKey && !event.altKey && event.code === 'KeyC' && paths.length) {
    event.preventDefault();
    fileClipboard = { mode: 'copy', paths };
    updateFileStatusBar();
    return;
  }
  if (event.metaKey && event.code === 'KeyV' && fileClipboard) {
    event.preventDefault();
    const destination = currentDirectoryPath();
    const payload = fileClipboard;
    if (!destination) return;
    runFileOperation('WKLEJANIE…', () => window.filesApi.transfer(payload.paths, destination, payload.mode));
    return;
  }
  // ⌥⌘↑ belongs to pane navigation, so the plain ⌘↑ shortcut must not swallow it.
  if (event.metaKey && !event.altKey && event.code === 'ArrowUp') {
    event.preventDefault();
    const parentPath = lastFileBrowserResult?.parentPath;
    if (parentPath) {
      clearFileSelection();
      browseDirectory(parentPath);
    }
    return;
  }
  if (paths.length === 0) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    clearFileSelection();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const row = [...document.querySelectorAll('#fileList .file-row')].find((item) => item.dataset.path === paths[0]);
    openFileEntry(paths[0], row?.dataset.type);
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    trashSelection(paths);
  }
}

// Node-only export for unit tests (test/renderer/file-browser.test.js). This
// file stays a plain global-scope <script> in the browser — `module` is
// undefined there, so this block never runs and browser behavior is
// unchanged. Only the pure, DOM-free functions are exported. sortFileEntries
// and matchesFileFilter close over module-level sort/filter state that the
// browser UI mutates through click handlers (fileSortKey, fileSortAscending,
// fileFilterQuery); the two __set*ForTest helpers let tests drive that state
// without touching the DOM — they have no browser call site.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fileTypeMarker,
    isPreviewableImage,
    matchesFileFilter,
    sortFileEntries,
    __setFileFilterQueryForTest(query) {
      fileFilterQuery = query;
    },
    __setFileSortStateForTest(key, ascending) {
      fileSortKey = key;
      fileSortAscending = ascending;
    }
  };
}
