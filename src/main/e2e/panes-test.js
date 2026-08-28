'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

function runPanesTest(window) {

    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // Captured while the three-pane layout is still on screen — the run
          // tears it down again a step later.
          const screenshotPath = (async () => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const ready = await window.webContents.executeJavaScript(
                "document.body.dataset.paneScreenshotReady === 'true'"
              );
              if (ready) {
                const target = path.join(os.tmpdir(), 'edex-ui-bk-split-panes.png');
                fs.writeFileSync(target, (await window.webContents.capturePage()).toPNG());
                return target;
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return null;
          })();

          const report = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const press = (code, modifiers = {}) => document.dispatchEvent(new KeyboardEvent('keydown', {
              code, metaKey: true, bubbles: true, cancelable: true, ...modifiers
            }));
            const view = () => document.querySelector('.terminal-tab-view:not([hidden])');
            const panes = () => [...view().querySelectorAll('.terminal-instance')];
            const tabs = () => [...document.querySelectorAll('#ttyTabs .tty-tab')];
            const activePane = () => document.body.dataset.activePaneId;
            const evidence = {};
            const step = async () => {
              evidence.startsWithOnePane = panes().length === 1 && tabs().length === 1;

              // 1. cmd+D splits the pane side by side inside the same tab
              press('KeyD');
              await wait(900);
              evidence.splitAddsPane = panes().length === 2 && tabs().length === 1;
              evidence.splitIsHorizontal = view().querySelector('.terminal-split')?.dataset.direction === 'row';
              evidence.splitHasSplitter = view().querySelectorAll('.terminal-splitter').length === 1;
              evidence.newPaneFocused = activePane() === panes()[1].dataset.sessionId;
              evidence.tabCountsPanes = tabs()[0].dataset.paneCount === '2';

              // 2. shift+cmd+D stacks the focused pane, nesting a second split
              press('KeyD', { shiftKey: true });
              await wait(900);
              evidence.stackAddsPane = panes().length === 3;
              evidence.nestedSplitIsVertical = Boolean(
                view().querySelector('.terminal-split[data-direction="row"] .terminal-split[data-direction="column"]')
              );

              // 2b. shift+cmd+enter zooms the focused (nested) pane — the split
              // tree must stay put, only visibility/fit changes — then zooms
              // back out again.
              const zoomedId = activePane();
              const siblings = () => panes().filter((pane) => pane.dataset.sessionId !== zoomedId);
              press('Enter', { shiftKey: true });
              await wait(300);
              evidence.zoomMarksTabView = view().classList.contains('is-zoomed');
              evidence.zoomHidesSiblings = siblings().every((pane) => pane.getBoundingClientRect().width === 0);
              const zoomedRect = document.querySelector(
                '.terminal-instance[data-session-id="' + zoomedId + '"]'
              ).getBoundingClientRect();
              evidence.zoomFillsTabView = Math.abs(zoomedRect.width - view().getBoundingClientRect().width) < 2;
              evidence.zoomChipMarked = Boolean(
                document.querySelector('.tty-pane-chip[data-session-id="' + zoomedId + '"]')?.classList.contains('is-zoomed')
              );
              press('Enter', { shiftKey: true });
              await wait(300);
              evidence.zoomExitClearsClass = !view().classList.contains('is-zoomed');
              evidence.zoomExitRestoresSiblings = siblings().every((pane) => pane.getBoundingClientRect().width > 0);
              evidence.zoomExitRefits = panes().every((pane) => {
                const screen = pane.querySelector('.xterm-screen');
                const paneRect = pane.getBoundingClientRect();
                return screen && Math.abs(screen.getBoundingClientRect().width - paneRect.width) < 20;
              });

              // Geometric nav is meaningless against zero-size hidden panes,
              // so ⌥⌘→ must drop the zoom before it walks the grid.
              press('Enter', { shiftKey: true });
              await wait(300);
              press('ArrowRight', { altKey: true });
              await wait(300);
              evidence.zoomExitsOnArrowNav = !view().classList.contains('is-zoomed');

              // 3. alt+cmd+arrows walk the pane grid
              const leftPaneId = panes()[0].dataset.sessionId;
              press('ArrowLeft', { altKey: true });
              await wait(200);
              evidence.navigatesLeft = activePane() === leftPaneId;
              press('ArrowRight', { altKey: true });
              await wait(200);
              evidence.navigatesBack = activePane() !== leftPaneId;

              // 4. dragging a splitter re-weights the pair
              const splitter = view().querySelector('.terminal-splitter[data-direction="row"]');
              const split = splitter.parentElement;
              const rect = split.getBoundingClientRect();
              const before = splitter.previousElementSibling;
              splitter.setPointerCapture = () => {};
              splitter.releasePointerCapture = () => {};
              splitter.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, pointerId: 1,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
              }));
              splitter.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, pointerId: 1,
                clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height / 2
              }));
              splitter.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
              await wait(200);
              evidence.splitterResizes = Math.abs(Number.parseFloat(before.style.flex) - 0.3) < 0.06;
              evidence.splitterCounted = document.body.dataset.paneResizeCount === '1';

              document.body.dataset.paneScreenshotReady = 'true';
              await wait(400);

              // 5. every pane owns a chip in the bar, and its context menu
              //    closes that pane alone — not the whole tab
              const chips = () => [...document.querySelectorAll('.tty-tab-group .tty-pane-chip')];
              evidence.chipPerPane = chips().length === 3;
              evidence.chipsCarryNames = chips().every(
                (chip) => chip.querySelector('.tty-pane-name').textContent.trim().length > 0
              );
              evidence.tabKeepsOnlyNumber = document.querySelector('#ttyTabs .tty-tab .tty-context').hidden;
              const victim = chips().find((chip) => !chip.classList.contains('is-active'));
              const victimId = victim.dataset.sessionId;
              victim.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: 300, clientY: 140
              }));
              evidence.chipMenuTargetsItsPane = document.body.dataset.ttyContextSessionId === victimId;
              document.querySelector('#ttyContextMenu [data-action="close"]').click();
              await wait(1_400);
              evidence.chipCloseRemovesOnlyThatPane = panes().length === 2
                && !panes().some((pane) => pane.dataset.sessionId === victimId)
                && tabs().length === 1;

              // 6. shift+cmd+W closes the focused pane and the tree collapses
              press('KeyW', { shiftKey: true });
              await wait(1_400);
              evidence.closeRemovesPane = panes().length === 1 && tabs().length === 1;
              evidence.treeCollapsed = view().querySelectorAll('.terminal-split').length === 0;
              evidence.chipsGoneWhenUnsplit = chips().length === 0;
              evidence.focusMovedToSibling = Boolean(terminalPaneAlive(activePane()));

              // 7. cmd+T still opens a separate tab, hiding the split view
              press('KeyT');
              await wait(900);
              evidence.newTabOpens = tabs().length === 2 && panes().length === 1;
              evidence.previousTabHidden = document.querySelectorAll('.terminal-tab-view[hidden]').length === 1;

              // 8. a background command-completion notification (the real IPC
              // payload main.js would send once a 15s+ foreground process goes
              // back to idle — simulated directly here, since actually waiting
              // 15s for a real one is not worth the wall-clock cost) badges the
              // inactive tab, never the active one, and clears on switch.
              const hiddenPaneId = document.querySelector('.terminal-tab-view[hidden] .terminal-instance').dataset.sessionId;
              const hiddenTabButton = tabs().find((btn) => btn.dataset.sessionId === hiddenPaneId);
              const activeTabButton = tabs().find((btn) => btn.classList.contains('is-active'));
              const completedCommand = { name: 'sleep', durationMs: 20_000 };

              updateTerminalMetadata([{ sessionId: hiddenPaneId, completedCommand }]);
              await wait(100);
              evidence.notifiesInactiveTab = hiddenTabButton.classList.contains('has-notification');
              evidence.commandCompletedCounted = document.body.dataset.commandCompletedCount === '1';

              updateTerminalMetadata([{ sessionId: activePane(), completedCommand }]);
              await wait(100);
              evidence.noNotifyForActiveSession = !activeTabButton.classList.contains('has-notification')
                && document.body.dataset.commandCompletedCount === '1';

              hiddenTabButton.click();
              await wait(300);
              evidence.notificationClearsOnSwitch = !hiddenTabButton.classList.contains('has-notification');

              if (Date.now() - started > 25_000) throw new Error('panes test timed out');
              resolve(evidence);
            };
            function terminalPaneAlive(id) {
              return id && document.querySelector('.terminal-instance[data-session-id="' + id + '"].is-active-pane');
            }
            step().catch(reject);
          })`);
          console.log(`Split panes diagnostics: ${JSON.stringify(report)}`);
          const failures = Object.entries(report).filter(([, value]) => value !== true).map(([key]) => key);
          if (failures.length) throw new Error(`failed checks: ${failures.join(', ')}`);
          const capturedPath = await screenshotPath;
          if (capturedPath) console.log(`Split panes screenshot: ${capturedPath}`);
          console.log('Split panes test passed: split, stack, navigate, resize, close and tabs all work.');
          process.exitCode = 0;
        } catch (error) {
          console.error(`Split panes test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 3_500);
    });
}

module.exports = { runPanesTest };
