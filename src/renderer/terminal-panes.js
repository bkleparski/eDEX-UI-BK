'use strict';

let terminalSearchSessionId = null;
let zoomedSessionId = null;
let ttyContextSessionId = null;
let ttyRenameSessionId = null;

// Minimal read accessors for renderer.js core (switchTerminalSession /
// handleTerminalExit need to know these without owning them).
function getTerminalSearchSessionId() {
  return terminalSearchSessionId;
}

function getZoomedSessionId() {
  return zoomedSessionId;
}

function getTtyContextSessionId() {
  return ttyContextSessionId;
}

function getTtyRenameSessionId() {
  return ttyRenameSessionId;
}

// The layout tree lives in the DOM: a `.terminal-split` always holds exactly
// two children (pane or nested split) separated by one `.terminal-splitter`,
// so closing a pane collapses by hoisting the surviving sibling.
function createSplitter(direction) {
  const splitter = document.createElement('div');
  splitter.className = 'terminal-splitter';
  splitter.dataset.direction = direction;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', direction === 'row' ? 'vertical' : 'horizontal');
  splitter.addEventListener('pointerdown', beginSplitterDrag);
  return splitter;
}

function beginSplitterDrag(event) {
  const splitter = event.currentTarget;
  const split = splitter.parentElement;
  const before = splitter.previousElementSibling;
  const after = splitter.nextElementSibling;
  if (!split || !before || !after) return;
  const horizontal = split.dataset.direction === 'row';
  const rect = split.getBoundingClientRect();
  const total = horizontal ? rect.width : rect.height;
  if (total <= 0) return;
  event.preventDefault();
  splitter.setPointerCapture(event.pointerId);
  splitter.dataset.dragging = 'true';
  const minRatio = 0.12;

  const onMove = (moveEvent) => {
    const offset = horizontal ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
    const ratio = Math.min(1 - minRatio, Math.max(minRatio, offset / total));
    before.style.flex = `${ratio} 1 0`;
    after.style.flex = `${1 - ratio} 1 0`;
  };
  const onEnd = () => {
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onEnd);
    splitter.removeEventListener('pointercancel', onEnd);
    delete splitter.dataset.dragging;
    document.body.dataset.paneResizeCount = String((Number(document.body.dataset.paneResizeCount) || 0) + 1);
    fitActiveTerminal();
  };
  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onEnd);
  splitter.addEventListener('pointercancel', onEnd);
}

// Replace `container` in place with a split holding it and the new pane.
function splitPaneContainer(container, newContainer, direction) {
  const parent = container.parentElement;
  if (!parent) return;
  const split = document.createElement('div');
  split.className = 'terminal-split';
  split.dataset.direction = direction;
  split.style.flex = container.style.flex || '1 1 0';
  parent.insertBefore(split, container);
  container.style.flex = '1 1 0';
  newContainer.style.flex = '1 1 0';
  split.append(container, createSplitter(direction), newContainer);
}

function removePaneContainer(container) {
  const parent = container.parentElement;
  container.remove();
  if (!parent || !parent.classList.contains('terminal-split')) return;
  parent.querySelectorAll(':scope > .terminal-splitter').forEach((splitter) => splitter.remove());
  const survivor = parent.firstElementChild;
  if (!survivor) {
    parent.remove();
    return;
  }
  survivor.style.flex = parent.style.flex || '1 1 0';
  parent.replaceWith(survivor);
}

// Search highlights are painted in the theme's accent, matching the HUD
// chrome rather than the terminal's own (independently chosen) text color —
// decorations need plain #RRGGBB, so read the resolved custom properties.
function terminalSearchDecorations() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const dim = token('--cyan-dim', '#087f9c');
  const cyan = token('--cyan', '#00e5ff');
  const bright = token('--cyan-bright', '#8ff8ff');
  return {
    matchBackground: dim,
    matchBorder: cyan,
    matchOverviewRuler: cyan,
    activeMatchBackground: cyan,
    activeMatchBorder: bright,
    activeMatchColorOverviewRuler: bright
  };
}

function terminalSearchOptions(extra = {}) {
  return { decorations: terminalSearchDecorations(), ...extra };
}

function positionTerminalSearchBar() {
  const session = terminalSessions.get(terminalSearchSessionId);
  const bar = document.getElementById('terminalSearchBar');
  if (!session || !session.container.isConnected) return;
  const rect = session.container.getBoundingClientRect();
  bar.style.left = `${Math.round(rect.left)}px`;
  bar.style.top = `${Math.round(rect.top)}px`;
  bar.style.width = `${Math.round(rect.width)}px`;
}

function updateTerminalSearchCount(resultIndex, resultCount) {
  const bar = document.getElementById('terminalSearchBar');
  const hasQuery = document.getElementById('terminalSearchInput').value.length > 0;
  document.getElementById('terminalSearchCount').textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '0/0';
  bar.classList.toggle('is-empty', hasQuery && resultCount === 0);
}

function runTerminalSearch(direction = 'next', extra = {}) {
  const session = terminalSessions.get(terminalSearchSessionId);
  const input = document.getElementById('terminalSearchInput');
  if (!session) return;
  const term = input.value;
  if (!term) {
    session.searchAddon.clearDecorations();
    updateTerminalSearchCount(-1, 0);
    return;
  }
  const method = direction === 'prev' ? 'findPrevious' : 'findNext';
  session.searchAddon[method](term, terminalSearchOptions(extra));
}

// One shared bar bound to whichever pane was active when it opened — switching
// panes closes it (see switchTerminalSession/handleTerminalExit) rather than
// tracking per-pane state, which keeps this simple like iTerm2's own find bar.
function openTerminalSearch() {
  const session = terminalSessions.get(activeSessionId);
  if (!session) return;
  terminalSearchSessionId = activeSessionId;
  const bar = document.getElementById('terminalSearchBar');
  bar.hidden = false;
  bar.setAttribute('aria-hidden', 'false');
  positionTerminalSearchBar();
  const input = document.getElementById('terminalSearchInput');
  input.focus();
  input.select();
  if (input.value) runTerminalSearch('next', { incremental: true });
}

function closeTerminalSearch({ refocusTerminal = true } = {}) {
  const bar = document.getElementById('terminalSearchBar');
  if (bar.hidden) return;
  bar.hidden = true;
  bar.setAttribute('aria-hidden', 'true');
  bar.classList.remove('is-empty');
  terminalSessions.get(terminalSearchSessionId)?.searchAddon.clearDecorations();
  terminalSearchSessionId = null;
  if (refocusTerminal) focusTerminal();
}

function initializeTerminalSearch() {
  const input = document.getElementById('terminalSearchInput');
  input.addEventListener('input', () => runTerminalSearch('next', { incremental: true }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runTerminalSearch(event.shiftKey ? 'prev' : 'next');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeTerminalSearch();
    }
  });
  document.getElementById('terminalSearchNext').addEventListener('click', () => runTerminalSearch('next'));
  document.getElementById('terminalSearchPrev').addEventListener('click', () => runTerminalSearch('prev'));
  document.getElementById('terminalSearchClose').addEventListener('click', () => closeTerminalSearch());
  window.themeApi?.onChange(() => {
    if (!document.getElementById('terminalSearchBar').hidden) runTerminalSearch('next', { incremental: true });
  });
}

const PASTE_PREVIEW_LINES = 5;
let pasteWarningSessionId = null;
let pasteWarningText = '';

function showPasteWarning(session, text) {
  pasteWarningSessionId = session.id;
  pasteWarningText = text;
  const lines = text.split(/\r\n|\r|\n/);
  const preview = lines.slice(0, PASTE_PREVIEW_LINES).join('\n');
  const remaining = lines.length - PASTE_PREVIEW_LINES;
  const previewElement = document.getElementById('pasteWarningPreview');
  previewElement.textContent = remaining > 0 ? `${preview}\n… (+${remaining} więcej)` : preview;
  document.getElementById('pasteWarningLabel').textContent = `WKLEJANIE WIELOLINIOWE — ${lines.length} LINII`;
  const popover = document.getElementById('pasteWarningPopover');
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  // Default focus sits on CANCEL — a warning dialog shouldn't make the risky
  // action the one muscle memory (Enter/Space on the focused control) picks.
  document.getElementById('pasteWarningCancel').focus();
}

function hidePasteWarning() {
  const popover = document.getElementById('pasteWarningPopover');
  if (popover.hidden) return;
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  pasteWarningSessionId = null;
  pasteWarningText = '';
  focusTerminal();
}

function confirmPasteWarning() {
  const session = terminalSessions.get(pasteWarningSessionId);
  const text = pasteWarningText;
  hidePasteWarning();
  session?.terminal.paste(text);
}

// Only the terminal's own hidden textarea goes through this gate — anything
// else (search box, file filter, rename inputs) keeps its native paste.
// Capture on document so this runs before xterm's own paste listener on the
// textarea itself (same-element listeners can't be reordered, only outrun).
function handleTerminalPasteCapture(event) {
  const target = event.target;
  if (!target?.classList?.contains('xterm-helper-textarea')) return;
  const session = [...terminalSessions.values()].find((candidate) => candidate.terminal.textarea === target);
  if (!session) return;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();
  const lineCount = text.split(/\r\n|\r|\n/).length;
  if (lineCount > 1) showPasteWarning(session, text);
  else session.terminal.paste(text);
}

function initializePasteWarning() {
  document.addEventListener('paste', handleTerminalPasteCapture, true);
  document.getElementById('pasteWarningConfirm').addEventListener('click', confirmPasteWarning);
  document.getElementById('pasteWarningCancel').addEventListener('click', hidePasteWarning);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.getElementById('pasteWarningPopover').hidden) return;
    event.preventDefault();
    event.stopPropagation();
    hidePasteWarning();
  }, true);
}

// Geometric navigation beats tree walking here: it does the right thing for
// any nesting depth, the same way ⌥⌘arrows behave in iTerm2.
function focusPaneInDirection(direction) {
  const current = terminalSessions.get(activeSessionId);
  if (!current) return;
  const source = current.container.getBoundingClientRect();
  const sourceX = source.left + source.width / 2;
  const sourceY = source.top + source.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const session of visibleSessions()) {
    if (session === current) continue;
    const rect = session.container.getBoundingClientRect();
    const deltaX = rect.left + rect.width / 2 - sourceX;
    const deltaY = rect.top + rect.height / 2 - sourceY;
    const along = direction === 'left' ? -deltaX
      : direction === 'right' ? deltaX
        : direction === 'up' ? -deltaY : deltaY;
    if (along <= 1) continue;
    const across = direction === 'left' || direction === 'right' ? Math.abs(deltaY) : Math.abs(deltaX);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = session;
    }
  }
  if (!best) return;
  switchTerminalSession(best.id);
  document.body.dataset.paneNavigationCount = String((Number(document.body.dataset.paneNavigationCount) || 0) + 1);
}

// The split tree in the DOM stays exactly as-is — zoom only marks the
// ancestor chain from the target pane up to its tab-view with a class, and
// CSS (`.terminal-split.is-zoom-path > *:not(.is-zoom-path)`) hides every
// sibling off that path. The zoomed pane is always the sole *visible* flex
// child at each level, so it fills the tab-view without any layout math.
function paneZoomPath(container, tabView) {
  const path = [];
  for (let node = container; node && node !== tabView; node = node.parentElement) path.push(node);
  return path;
}

function toggleActivePaneZoom() {
  if (zoomedSessionId) exitPaneZoom();
  else enterPaneZoom(activeSessionId);
}

function enterPaneZoom(sessionId) {
  const session = terminalSessions.get(sessionId);
  const tab = session && terminalTabs.get(session.tabId);
  if (!session || !tab) return;
  zoomedSessionId = sessionId;
  for (const element of paneZoomPath(session.container, tab.view)) element.classList.add('is-zoom-path');
  tab.view.classList.add('is-zoomed');
  renderTabLabel(tab.id);
  fitActiveTerminal();
}

function exitPaneZoom() {
  if (!zoomedSessionId) return;
  const session = terminalSessions.get(zoomedSessionId);
  const tab = session && terminalTabs.get(session.tabId);
  zoomedSessionId = null;
  // The session (or its tab) may already be gone by the time this runs, e.g.
  // when called from handleTerminalExit — the path elements went with it.
  if (session && tab) {
    for (const element of paneZoomPath(session.container, tab.view)) element.classList.remove('is-zoom-path');
    tab.view.classList.remove('is-zoomed');
    renderTabLabel(tab.id);
  }
  fitActiveTerminal();
}

async function splitActivePane(direction) {
  const session = terminalSessions.get(activeSessionId);
  if (!session) return null;
  return createTerminalSession({ tabId: session.tabId, splitFrom: session.id, direction });
}

function closeActivePane() {
  if (activeSessionId) closeTTYSession(activeSessionId);
}

function positionTTYOverlay(element, anchorX, anchorY, offset = 6) {
  const margin = 8;
  const rect = element.getBoundingClientRect();
  let left = anchorX + offset;
  let top = anchorY + offset;
  if (left + rect.width > window.innerWidth - margin) left = anchorX - rect.width - offset;
  if (top + rect.height > window.innerHeight - margin) top = anchorY - rect.height - offset;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - rect.width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - rect.height - margin));
  element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function hideTTYContextMenu() {
  const menu = document.getElementById('ttyContextMenu');
  menu.hidden = true;
  menu.setAttribute('aria-hidden', 'true');
  ttyContextSessionId = null;
  document.body.dataset.ttyContextMenuOpen = 'false';
}

function hideTTYRename() {
  const popover = document.getElementById('ttyRenamePopover');
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  ttyRenameSessionId = null;
  document.body.dataset.ttyRenameOpen = 'false';
}

function paneLabel(session) {
  return session.manualName || session.autoContext || '~';
}

// An unsplit tab carries the name itself; a split one hands the names over to
// its pane chips and keeps only the number.
function renderTabLabel(tabId) {
  const tab = terminalTabs.get(tabId);
  if (!tab) return;
  const sessions = tabSessions(tabId);
  const session = terminalSessions.get(tab.activePaneId) || sessions[0] || null;
  const split = sessions.length > 1;
  const context = session ? paneLabel(session) : '~';
  const contextElement = tab.button.querySelector('.tty-context');
  contextElement.textContent = context;
  contextElement.hidden = split;
  tab.button.dataset.context = context;
  tab.button.dataset.manualName = session?.manualName || '';
  tab.button.dataset.sessionId = session?.id || '';
  tab.button.dataset.paneCount = String(sessions.length);
  tab.button.title = session ? session.manualName || session.autoTitle || context : context;
  // Only an unsplit tab needs the marker on the tab button itself — a split
  // tab's own chip carries it instead (below).
  tab.button.classList.toggle('is-zoomed', !split && session?.id === zoomedSessionId);
  // The tab-level badge is broader than zoom's: it fires if *any* pane in the
  // tab has a pending notification, even one the user isn't currently looking
  // at within an otherwise-focused tab — the per-chip badge below pinpoints
  // which pane it actually is.
  tab.button.classList.toggle('has-notification', sessions.some((item) => item.completedCommandBadge));
  renderPaneChips(tab, sessions, split);
}

function createPaneChip(sessionId) {
  const chip = document.createElement('button');
  chip.className = 'tty-pane-chip hud-label';
  chip.type = 'button';
  chip.dataset.sessionId = sessionId;
  const branch = document.createElement('span');
  branch.className = 'tty-pane-branch';
  branch.textContent = '├';
  branch.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'tty-pane-name';
  chip.append(branch, name);
  chip.addEventListener('click', () => switchTerminalSession(sessionId));
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showTTYContextMenu(sessionId, event.clientX, event.clientY);
  });
  return chip;
}

// Chips are reused across metadata ticks — rebuilding them every second would
// drop the focus ring mid-click.
function renderPaneChips(tab, sessions, split) {
  const existing = new Map([...tab.group.querySelectorAll('.tty-pane-chip')]
    .map((chip) => [chip.dataset.sessionId, chip]));
  if (!split) {
    existing.forEach((chip) => chip.remove());
    sessions.forEach((session) => { session.chip = null; });
    return;
  }
  let previous = tab.button;
  for (const session of sessions) {
    let chip = existing.get(session.id);
    if (chip) existing.delete(session.id);
    else chip = createPaneChip(session.id);
    if (previous.nextElementSibling !== chip) previous.after(chip);
    previous = chip;
    const label = paneLabel(session);
    chip.querySelector('.tty-pane-name').textContent = label;
    chip.title = session.manualName || session.autoTitle || label;
    chip.dataset.manualName = session.manualName || '';
    chip.classList.toggle('is-active', session.id === tab.activePaneId);
    chip.classList.toggle('is-zoomed', session.id === zoomedSessionId);
    chip.classList.toggle('has-notification', session.completedCommandBadge === true);
    chip.setAttribute('aria-pressed', String(session.id === tab.activePaneId));
    session.chip = chip;
  }
  existing.forEach((chip) => chip.remove());
}

function renderTerminalTabLabel(session) {
  if (session) renderTabLabel(session.tabId);
}

function showTTYContextMenu(sessionId, clientX, clientY) {
  const session = terminalSessions.get(sessionId);
  if (!session || session.closing) return;
  hideTTYRename();
  const menu = document.getElementById('ttyContextMenu');
  const autoName = menu.querySelector('[data-action="auto-name"]');
  ttyContextSessionId = sessionId;
  autoName.hidden = !session.manualName;
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
  document.body.dataset.ttyContextMenuOpen = 'true';
  document.body.dataset.ttyContextSessionId = sessionId;
  positionTTYOverlay(menu, clientX, clientY);
  menu.querySelector('[data-action="rename"]').focus({ preventScroll: true });
}

function beginTTYRename(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session || session.closing) return;
  hideTTYContextMenu();
  ttyRenameSessionId = sessionId;
  const popover = document.getElementById('ttyRenamePopover');
  const input = document.getElementById('ttyRenameInput');
  const tabRect = (session.chip || session.tab).getBoundingClientRect();
  input.value = (session.manualName || session.autoContext || '').slice(0, 24);
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  document.body.dataset.ttyRenameOpen = 'true';
  positionTTYOverlay(popover, tabRect.left, tabRect.bottom, 5);
  input.focus({ preventScroll: true });
  input.select();
}

function commitTTYRename() {
  const session = terminalSessions.get(ttyRenameSessionId);
  if (!session) {
    hideTTYRename();
    return;
  }
  const input = document.getElementById('ttyRenameInput');
  const manualName = input.value.trim().replace(/\s+/g, ' ').slice(0, 24).trimEnd();
  session.manualName = manualName || null;
  renderTerminalTabLabel(session);
  document.body.dataset.ttyRenameCount = String((Number(document.body.dataset.ttyRenameCount) || 0) + 1);
  document.body.dataset.ttyLastRenamedSession = session.id;
  document.body.dataset.ttyLastManualName = session.manualName || '';
  hideTTYRename();
  focusTerminal();
}

function resetTTYName(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.manualName = null;
  renderTerminalTabLabel(session);
  document.body.dataset.ttyAutoNameResetCount = String(
    (Number(document.body.dataset.ttyAutoNameResetCount) || 0) + 1
  );
  hideTTYContextMenu();
  focusTerminal();
}

function closeTTYSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session || session.closing) return;
  session.closing = true;
  // Only the last pane takes its tab down with it, so keep the tab clickable
  // while siblings survive — the closing pane's own chip is what greys out.
  if (tabSessions(session.tabId).length === 1) session.tab.disabled = true;
  else if (session.chip) session.chip.disabled = true;
  document.body.dataset.ttyContextCloseCount = String(
    (Number(document.body.dataset.ttyContextCloseCount) || 0) + 1
  );
  document.body.dataset.ttyLastClosedSession = sessionId;
  hideTTYContextMenu();
  hideTTYRename();
  window.terminalApi.close(sessionId);
}

function initializeTTYContextMenu() {
  const menu = document.getElementById('ttyContextMenu');
  const input = document.getElementById('ttyRenameInput');

  menu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const sessionId = ttyContextSessionId;
    if (!action || !sessionId) return;
    if (action === 'rename') beginTTYRename(sessionId);
    else if (action === 'auto-name') resetTTYName(sessionId);
    else if (action === 'close') closeTTYSession(sessionId);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    commitTTYRename();
  });

  document.addEventListener('pointerdown', (event) => {
    if (menu.contains(event.target) || document.getElementById('ttyRenamePopover').contains(event.target)) return;
    hideTTYContextMenu();
    hideTTYRename();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || (ttyContextSessionId === null && ttyRenameSessionId === null)) return;
    event.preventDefault();
    event.stopPropagation();
    hideTTYContextMenu();
    hideTTYRename();
    focusTerminal();
  }, true);

  window.addEventListener('resize', () => {
    hideTTYContextMenu();
    hideTTYRename();
  });
}
