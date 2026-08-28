'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// src/renderer/*.js are plain global-scope <script> tags (no bundler, no ES
// modules) — see src/renderer/index.html. Six of them (theme.js,
// telemetry-ui.js, terminal-panes.js, file-browser.js, panel-resizer.js,
// renderer.js) declare top-level functions/consts that other renderer
// scripts call as bare globals; the other three (assistant-ui.js,
// filesystem-ui.js, theme-ui.js) wrap everything in an IIFE and only ever
// *consume* those globals.
//
// This is the full cross-file surface. Each "owner" file below gets this
// list MINUS its own names — for sourceType:'script', a file's top-level
// declarations live in the same scope as configured globals, so including a
// file's own names in its own globals would collide (no-redeclare) and
// reassigning a `let` would look like writing a read-only global
// (no-global-assign). The three IIFE-only consumer files get the full list
// unfiltered, since they never declare any of these names themselves.
const rendererSharedGlobals = {
  DEFAULT_THEME: 'readonly',
  FONT_SIZES: 'readonly',
  HUD_ACCENTS: 'readonly',
  NERD_FALLBACK: 'readonly',
  PASTE_PREVIEW_LINES: 'readonly',
  PROCESS_LIST_LIMIT: 'readonly',
  SCROLLBACK_SIZES: 'readonly',
  TERMINAL_COLORS: 'readonly',
  TERMINAL_FONTS: 'readonly',
  THEME_STORAGE_KEY: 'readonly',
  accentById: 'readonly',
  activeSessionId: 'readonly',
  activeTabId: 'readonly',
  applyHudTokens: 'readonly',
  applySelectionClasses: 'readonly',
  applyTerminalAppearance: 'readonly',
  applyTheme: 'readonly',
  audioContext: 'readonly',
  beginFileRename: 'readonly',
  beginSplitterDrag: 'readonly',
  beginTTYRename: 'readonly',
  bootActive: 'readonly',
  bootTimer: 'readonly',
  browseDirectory: 'readonly',
  browsedDirectory: 'readonly',
  cacheImagePreview: 'readonly',
  cachedImagePreview: 'readonly',
  clearFileDropTarget: 'readonly',
  clearFileSelection: 'readonly',
  closeActivePane: 'readonly',
  closeFileFilter: 'readonly',
  closeTTYSession: 'readonly',
  closeTerminalSearch: 'readonly',
  commitFileRename: 'readonly',
  commitTTYRename: 'readonly',
  confirmPasteWarning: 'readonly',
  copyPathsToClipboard: 'readonly',
  createFileIcon: 'readonly',
  createPaneChip: 'readonly',
  createPanelResizer: 'readonly',
  createSplitter: 'readonly',
  createTerminalSession: 'readonly',
  createTerminalTab: 'readonly',
  currentDirectoryPath: 'readonly',
  currentTheme: 'readonly',
  dropTestMarker: 'readonly',
  dropTestMime: 'readonly',
  dropTestOutput: 'readonly',
  droppedFilePaths: 'readonly',
  ensureAudioContext: 'readonly',
  enterPaneZoom: 'readonly',
  exitPaneZoom: 'readonly',
  fileBrowserBusy: 'readonly',
  fileBrowserMode: 'readonly',
  fileBrowserRequestId: 'readonly',
  fileClipboard: 'readonly',
  fileContextPaths: 'readonly',
  fileDragDepth: 'readonly',
  fileFilterQuery: 'readonly',
  fileIconPaths: 'readonly',
  fileOperationInFlight: 'readonly',
  fileRefreshInFlight: 'readonly',
  fileRefreshTimer: 'readonly',
  fileRenameTarget: 'readonly',
  fileSelection: 'readonly',
  fileSelectionAnchor: 'readonly',
  fileSortAscending: 'readonly',
  fileSortKey: 'readonly',
  fileTypeMarker: 'readonly',
  finishBoot: 'readonly',
  fitActiveTerminal: 'readonly',
  fitSession: 'readonly',
  focusPaneInDirection: 'readonly',
  focusTerminal: 'readonly',
  formatCapacity: 'readonly',
  formatFileModified: 'readonly',
  formatFileSize: 'readonly',
  formatPercent: 'readonly',
  formatProcessValue: 'readonly',
  formatRate: 'readonly',
  formatUptime: 'readonly',
  getFileBrowserMode: 'readonly',
  getTerminalSearchSessionId: 'readonly',
  getTtyContextSessionId: 'readonly',
  getTtyRenameSessionId: 'readonly',
  getZoomedSessionId: 'readonly',
  handleBootClick: 'readonly',
  handleBootInput: 'readonly',
  handleCommandCompleted: 'readonly',
  handleFileBrowserKeydown: 'readonly',
  handleRowSelection: 'readonly',
  handleTerminalExit: 'readonly',
  handleTerminalPasteCapture: 'readonly',
  hasFileDrag: 'readonly',
  hideFileContextMenu: 'readonly',
  hideFileRename: 'readonly',
  hideImagePreview: 'readonly',
  hidePasteWarning: 'readonly',
  hideTTYContextMenu: 'readonly',
  hideTTYRename: 'readonly',
  imagePreviewCache: 'readonly',
  imagePreviewCacheChars: 'readonly',
  imagePreviewCacheLimit: 'readonly',
  imagePreviewCacheMaxChars: 'readonly',
  imagePreviewCacheTtlMs: 'readonly',
  imagePreviewCursorX: 'readonly',
  imagePreviewCursorY: 'readonly',
  imagePreviewDwellMs: 'readonly',
  imagePreviewExtensions: 'readonly',
  imagePreviewHoverStartedAt: 'readonly',
  imagePreviewPath: 'readonly',
  imagePreviewRequestToken: 'readonly',
  imagePreviewTimer: 'readonly',
  initializeAudio: 'readonly',
  initializeBoot: 'readonly',
  initializeControls: 'readonly',
  initializeFileBrowser: 'readonly',
  initializeFileDrop: 'readonly',
  initializeMonitoring: 'readonly',
  initializePasteWarning: 'readonly',
  initializeProcessSort: 'readonly',
  initializeTTYContextMenu: 'readonly',
  initializeTerminal: 'readonly',
  initializeTerminalSearch: 'readonly',
  insertDroppedPaths: 'readonly',
  internalFilePathMime: 'readonly',
  isPreviewableImage: 'readonly',
  isSmokeTest: 'readonly',
  isTypingInForeignInput: 'readonly',
  isVisualTest: 'readonly',
  lastFileBrowserResult: 'readonly',
  lastProcesses: 'readonly',
  listeners: 'readonly',
  loadWebglAddon: 'readonly',
  matchesFileFilter: 'readonly',
  maxTerminalSessions: 'readonly',
  nextSessionNumber: 'readonly',
  nextTabNumber: 'readonly',
  normalizeTheme: 'readonly',
  numeric: 'readonly',
  openFileEntry: 'readonly',
  openFileFilter: 'readonly',
  openTerminalSearch: 'readonly',
  paneLabel: 'readonly',
  paneResizeObserver: 'readonly',
  paneZoomPath: 'readonly',
  panelDropTestMarker: 'readonly',
  pasteWarningSessionId: 'readonly',
  pasteWarningText: 'readonly',
  playCommandCompleteSound: 'readonly',
  playInputSound: 'readonly',
  positionImagePreview: 'readonly',
  positionTTYOverlay: 'readonly',
  positionTerminalSearchBar: 'readonly',
  presentImagePreview: 'readonly',
  processSortKey: 'readonly',
  pushHistory: 'readonly',
  quoteShellPath: 'readonly',
  readSetting: 'readonly',
  readStoredTheme: 'readonly',
  reconcileImagePreviewRow: 'readonly',
  recordSystemVisibilityState: 'readonly',
  refreshFileBrowser: 'readonly',
  removeBootListeners: 'readonly',
  removePaneContainer: 'readonly',
  removeTerminalTab: 'readonly',
  renderCoreLoads: 'readonly',
  renderCurrentFileBrowserResult: 'readonly',
  renderFileBrowser: 'readonly',
  renderMonitoring: 'readonly',
  renderPaneChips: 'readonly',
  renderProcesses: 'readonly',
  renderTabLabel: 'readonly',
  renderTerminalTabLabel: 'readonly',
  rendererShuttingDown: 'readonly',
  resetTTYName: 'readonly',
  resumeLiveFileBrowser: 'readonly',
  runFileContextAction: 'readonly',
  runFileOperation: 'readonly',
  runTerminalSearch: 'readonly',
  saveTheme: 'readonly',
  scheduleImagePreview: 'readonly',
  selectableEntries: 'readonly',
  setFileDropTarget: 'readonly',
  setFileOperationStatus: 'readonly',
  setFileSelection: 'readonly',
  setMeter: 'readonly',
  setProcessSortKey: 'readonly',
  setStackedMeter: 'readonly',
  setSystemGroupVisible: 'readonly',
  setWarningState: 'readonly',
  showFileContextMenu: 'readonly',
  showHiddenFiles: 'readonly',
  showImagePreviewImage: 'readonly',
  showImagePreviewMessage: 'readonly',
  showPasteWarning: 'readonly',
  showTTYContextMenu: 'readonly',
  smokeCompleted: 'readonly',
  smokeMarker: 'readonly',
  smokeOutput: 'readonly',
  sortFileEntries: 'readonly',
  sortProcesses: 'readonly',
  soundEnabled: 'readonly',
  sparklinePoints: 'readonly',
  splitActivePane: 'readonly',
  splitPaneContainer: 'readonly',
  startFileBrowserPolling: 'readonly',
  stopFileBrowserPolling: 'readonly',
  storageKeys: 'readonly',
  switchTerminalSession: 'readonly',
  switchTerminalTab: 'readonly',
  tabSessions: 'readonly',
  telemetryHistory: 'readonly',
  terminalAppearance: 'readonly',
  terminalColorById: 'readonly',
  terminalFitFrame: 'readonly',
  terminalFocusRequested: 'readonly',
  terminalFontById: 'readonly',
  terminalSearchDecorations: 'readonly',
  terminalSearchOptions: 'readonly',
  terminalSearchSessionId: 'readonly',
  terminalSessions: 'readonly',
  terminalTabs: 'readonly',
  terminalTheme: 'readonly',
  testMode: 'readonly',
  themedTerminalPalette: 'readonly',
  toggleActivePaneZoom: 'readonly',
  toggleDotfiles: 'readonly',
  toggleFileFilter: 'readonly',
  toggleScanlines: 'readonly',
  toggleSound: 'readonly',
  toggleSystemGroup: 'readonly',
  transferSelection: 'readonly',
  trashSelection: 'readonly',
  ttyContextSessionId: 'readonly',
  ttyRenameSessionId: 'readonly',
  updateClock: 'readonly',
  updateDotfilesState: 'readonly',
  updateFileBrowserMode: 'readonly',
  updateFileStatusBar: 'readonly',
  updateScanlines: 'readonly',
  updateShellStatus: 'readonly',
  updateSortIndicators: 'readonly',
  updateSound: 'readonly',
  updateTerminalMetadata: 'readonly',
  updateTerminalSearchCount: 'readonly',
  visibleSessions: 'readonly',
  writeSetting: 'readonly',
  zoomedSessionId: 'readonly'
};

function withoutOwn(...ownNames) {
  const result = { ...rendererSharedGlobals };
  for (const name of ownNames) delete result[name];
  return result;
}

// UMD globals from the vendored xterm.js + addon <script> tags in index.html
// (loaded straight from node_modules, no bundler) — only renderer.js uses
// them, harmless to declare everywhere.
const rendererEnvGlobals = {
  ...globals.browser,
  Terminal: 'readonly',
  FitAddon: 'readonly',
  SearchAddon: 'readonly',
  WebLinksAddon: 'readonly',
  WebglAddon: 'readonly',
  // telemetry-ui.js and file-browser.js each end with a
  // `typeof module !== 'undefined'` guard exporting pure functions for
  // node:test (see test/renderer/*.test.js) — dead code in the browser,
  // but ESLint still parses it as this file's script scope.
  module: 'readonly'
};

const rendererRules = {
  // The codebase's convention for an intentionally-unused callback argument
  // (event handlers, IPC listeners) is a leading underscore, e.g.
  // `(_event, payload) => ...`. Keep the rest of no-unused-vars active — it
  // still catches real dead code.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**']
  },
  js.configs.recommended,
  {
    files: ['src/renderer/theme.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...withoutOwn(
          'DEFAULT_THEME', 'FONT_SIZES', 'HUD_ACCENTS', 'NERD_FALLBACK', 'SCROLLBACK_SIZES',
          'TERMINAL_COLORS', 'TERMINAL_FONTS', 'THEME_STORAGE_KEY', 'accentById', 'applyHudTokens',
          'applyTheme', 'currentTheme', 'listeners', 'normalizeTheme', 'readStoredTheme', 'saveTheme',
          'terminalAppearance', 'terminalColorById', 'terminalFontById'
        )
      }
    },
    rules: rendererRules
  },
  {
    files: ['src/renderer/telemetry-ui.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...withoutOwn(
          'PROCESS_LIST_LIMIT', 'formatCapacity', 'formatPercent', 'formatProcessValue', 'formatRate',
          'formatUptime', 'initializeMonitoring', 'initializeProcessSort', 'lastProcesses', 'numeric',
          'processSortKey', 'pushHistory', 'renderCoreLoads', 'renderMonitoring', 'renderProcesses',
          'setMeter', 'setProcessSortKey', 'setStackedMeter', 'setWarningState', 'sortProcesses',
          'sparklinePoints', 'telemetryHistory', 'updateClock'
        )
      }
    },
    rules: rendererRules
  },
  {
    files: ['src/renderer/terminal-panes.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...withoutOwn(
          'PASTE_PREVIEW_LINES', 'beginSplitterDrag', 'beginTTYRename', 'closeActivePane',
          'closeTTYSession', 'closeTerminalSearch', 'commitTTYRename', 'confirmPasteWarning',
          'createPaneChip', 'createSplitter', 'enterPaneZoom', 'exitPaneZoom', 'focusPaneInDirection',
          'getTerminalSearchSessionId', 'getTtyContextSessionId', 'getTtyRenameSessionId',
          'getZoomedSessionId', 'handleTerminalPasteCapture', 'hidePasteWarning', 'hideTTYContextMenu',
          'hideTTYRename', 'initializePasteWarning', 'initializeTTYContextMenu',
          'initializeTerminalSearch', 'openTerminalSearch', 'paneLabel', 'paneZoomPath',
          'pasteWarningSessionId', 'pasteWarningText', 'positionTTYOverlay',
          'positionTerminalSearchBar', 'removePaneContainer', 'renderPaneChips', 'renderTabLabel',
          'renderTerminalTabLabel', 'resetTTYName', 'runTerminalSearch', 'showPasteWarning',
          'showTTYContextMenu', 'splitActivePane', 'splitPaneContainer', 'terminalSearchDecorations',
          'terminalSearchOptions', 'terminalSearchSessionId', 'toggleActivePaneZoom',
          'ttyContextSessionId', 'ttyRenameSessionId', 'updateTerminalSearchCount', 'zoomedSessionId'
        )
      }
    },
    rules: rendererRules
  },
  {
    files: ['src/renderer/file-browser.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...withoutOwn(
          'applySelectionClasses', 'beginFileRename', 'browseDirectory', 'browsedDirectory',
          'cacheImagePreview', 'cachedImagePreview', 'clearFileSelection', 'closeFileFilter',
          'commitFileRename', 'copyPathsToClipboard', 'createFileIcon', 'currentDirectoryPath',
          'fileBrowserBusy', 'fileBrowserMode', 'fileBrowserRequestId', 'fileClipboard',
          'fileContextPaths', 'fileFilterQuery', 'fileIconPaths', 'fileOperationInFlight',
          'fileRefreshInFlight', 'fileRefreshTimer', 'fileRenameTarget', 'fileSelection',
          'fileSelectionAnchor', 'fileSortAscending', 'fileSortKey', 'fileTypeMarker',
          'formatFileModified', 'formatFileSize', 'getFileBrowserMode', 'handleFileBrowserKeydown',
          'handleRowSelection', 'hideFileContextMenu', 'hideFileRename', 'hideImagePreview',
          'imagePreviewCache', 'imagePreviewCacheChars', 'imagePreviewCacheLimit',
          'imagePreviewCacheMaxChars', 'imagePreviewCacheTtlMs', 'imagePreviewCursorX',
          'imagePreviewCursorY', 'imagePreviewDwellMs', 'imagePreviewExtensions',
          'imagePreviewHoverStartedAt', 'imagePreviewPath', 'imagePreviewRequestToken',
          'imagePreviewTimer', 'initializeFileBrowser', 'isPreviewableImage', 'lastFileBrowserResult',
          'matchesFileFilter', 'openFileEntry', 'openFileFilter', 'positionImagePreview',
          'presentImagePreview', 'reconcileImagePreviewRow', 'refreshFileBrowser',
          'renderCurrentFileBrowserResult', 'renderFileBrowser', 'resumeLiveFileBrowser',
          'runFileContextAction', 'runFileOperation', 'scheduleImagePreview', 'selectableEntries',
          'setFileOperationStatus', 'setFileSelection', 'showFileContextMenu', 'showHiddenFiles',
          'showImagePreviewImage', 'showImagePreviewMessage', 'sortFileEntries',
          'startFileBrowserPolling', 'stopFileBrowserPolling', 'toggleDotfiles', 'toggleFileFilter',
          'transferSelection', 'trashSelection', 'updateDotfilesState', 'updateFileBrowserMode',
          'updateFileStatusBar', 'updateSortIndicators'
        )
      }
    },
    rules: rendererRules
  },
  {
    files: ['src/renderer/panel-resizer.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...withoutOwn('createPanelResizer')
      }
    },
    rules: rendererRules
  },
  {
    files: ['src/renderer/renderer.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...withoutOwn(
          'activeSessionId', 'activeTabId', 'applyTerminalAppearance', 'audioContext', 'bootActive',
          'bootTimer', 'clearFileDropTarget', 'createTerminalSession', 'createTerminalTab',
          'dropTestMarker', 'dropTestMime', 'dropTestOutput', 'droppedFilePaths', 'ensureAudioContext',
          'fileDragDepth', 'finishBoot', 'fitActiveTerminal', 'fitSession', 'focusTerminal',
          'handleBootClick', 'handleBootInput', 'handleCommandCompleted', 'handleTerminalExit',
          'hasFileDrag', 'initializeAudio', 'initializeBoot', 'initializeControls',
          'initializeFileDrop', 'initializeTerminal', 'insertDroppedPaths', 'internalFilePathMime',
          'isSmokeTest', 'isTypingInForeignInput', 'isVisualTest', 'loadWebglAddon',
          'maxTerminalSessions', 'nextSessionNumber', 'nextTabNumber', 'paneResizeObserver',
          'panelDropTestMarker', 'playCommandCompleteSound', 'playInputSound', 'quoteShellPath',
          'readSetting', 'recordSystemVisibilityState', 'removeBootListeners', 'removeTerminalTab',
          'rendererShuttingDown', 'setFileDropTarget', 'setSystemGroupVisible', 'smokeCompleted',
          'smokeMarker', 'smokeOutput', 'soundEnabled', 'storageKeys', 'switchTerminalSession',
          'switchTerminalTab', 'tabSessions', 'terminalFitFrame', 'terminalFocusRequested',
          'terminalSessions', 'terminalTabs', 'terminalTheme', 'testMode', 'themedTerminalPalette',
          'toggleScanlines', 'toggleSound', 'toggleSystemGroup', 'updateScanlines',
          'updateShellStatus', 'updateSound', 'updateTerminalMetadata', 'visibleSessions',
          'writeSetting'
        )
      }
    },
    rules: rendererRules
  },
  {
    // assistant-ui.js, filesystem-ui.js and theme-ui.js each wrap their whole
    // body in an IIFE — they only ever *consume* the shared renderer
    // globals, never declare any of them, so no filtering needed here.
    files: ['src/renderer/assistant-ui.js', 'src/renderer/filesystem-ui.js', 'src/renderer/theme-ui.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: {
        ...rendererEnvGlobals,
        ...rendererSharedGlobals
      }
    },
    rules: rendererRules
  },
  {
    files: ['src/main.js', 'src/preload.js', 'src/main/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 'latest',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Stripping ANSI/OSC escape sequences and raw control bytes from
      // terminal output and untrusted text (safeLabel, cleanText,
      // sanitizeTerminalText) is core functionality here, not a typo — the
      // whole point of these regexes is to match \x00-\x1f/\x7f etc.
      'no-control-regex': 'off'
    }
  }
];
