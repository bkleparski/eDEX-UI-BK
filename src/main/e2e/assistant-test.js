'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

function runAssistantVisualTest(window) {

    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const assistantGeometry = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            let submitted = false;
            let resized = false;
            let panelReadyAt = 0;
            let resizeSettledAt = 0;
            let resizeEvidence = null;
            const inspect = () => {
              const toggle = document.getElementById('assistantToggle');
              if (toggle.getAttribute('aria-expanded') !== 'true') {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                  code: 'Digit3', key: '3', metaKey: true, bubbles: true, cancelable: true
                }));
              }
              const panel = document.getElementById('assistantPanel');
              const model = document.getElementById('hudModel');
              const terminalScreen = document.querySelector('.terminal-instance:not([hidden]) .xterm-screen');
              if (!panel.hidden && !model.disabled && model.value && terminalScreen && panelReadyAt === 0) {
                panelReadyAt = Date.now();
              }
              if (!resized && panelReadyAt > 0 && Date.now() - panelReadyAt > 500) {
                const handle = document.getElementById('assistantResizer');
                const handleRect = handle.getBoundingClientRect();
                const initialPanelWidth = panel.getBoundingClientRect().width;
                const initialTerminalPanelWidth = document.querySelector('.terminal-panel').getBoundingClientRect().width;
                const initialTerminalScreenWidth = terminalScreen.getBoundingClientRect().width;
                const fallbackStoredAbsent = localStorage.getItem('edex.assistant.width.v1') === null;
                const pointerId = 41;
                const startX = handleRect.left + (handleRect.width / 2);
                handle.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1,
                  clientX: startX, clientY: handleRect.top + 40
                }));
                handle.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', buttons: 1,
                  clientX: startX - 120, clientY: handleRect.top + 40
                }));
                handle.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0,
                  clientX: startX - 120, clientY: handleRect.top + 40
                }));
                const dragWidth = panel.getBoundingClientRect().width;
                handle.focus();
                handle.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true
                }));
                resizeEvidence = {
                  initialPanelWidth,
                  initialTerminalPanelWidth,
                  initialTerminalScreenWidth,
                  fallbackStoredAbsent,
                  shortcutVisible: [...document.querySelectorAll('.shortcut-legend span')]
                    .some((item) => item.textContent.replace(/\\s+/g, ' ').trim() === '⌘3 AI'
                      && getComputedStyle(item).display !== 'none'),
                  dragWidth,
                  keyboardWidth: panel.getBoundingClientRect().width,
                  keyboardFocus: document.activeElement === handle
                };
                resized = true;
                resizeSettledAt = Date.now();
              }
              if (resized && !submitted && Date.now() - resizeSettledAt > 350) {
                const handle = document.getElementById('assistantResizer');
                resizeEvidence.finalPanelWidth = panel.getBoundingClientRect().width;
                resizeEvidence.finalTerminalScreenWidth = terminalScreen.getBoundingClientRect().width;
                resizeEvidence.keyboardFocusAfterFit = document.activeElement === handle;
                resizeEvidence.storedWidth = Number(localStorage.getItem('edex.assistant.width.v1'));
                resizeEvidence.ariaNow = Number(handle.getAttribute('aria-valuenow'));
                resizeEvidence.ariaMin = Number(handle.getAttribute('aria-valuemin'));
                resizeEvidence.ariaMax = Number(handle.getAttribute('aria-valuemax'));
                document.getElementById('assistantPrompt').value = 'Reply with exactly HUD_OK.';
                document.getElementById('assistantForm').requestSubmit();
                submitted = true;
              }
              const assistantBody = document.querySelector('.chat-message[data-role="assistant"] .chat-message__body');
              if (submitted && document.getElementById('assistantCancel').hidden && assistantBody?.textContent.trim()) {
                const panelRect = panel.getBoundingClientRect();
                const terminalRect = document.querySelector('.terminal-panel').getBoundingClientRect();
                resolve({
                  panel: { left: panelRect.left, top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom, width: panelRect.width },
                  terminalWidth: terminalRect.width,
                  provider: document.getElementById('hudProvider').value,
                  model: model.value,
                  responseLength: assistantBody.textContent.trim().length,
                  resize: resizeEvidence,
                  viewport: { width: innerWidth, height: innerHeight }
                });
              } else if (Date.now() - started > 90_000) reject(new Error('Assistant HUD inference did not complete'));
              else setTimeout(inspect, 200);
            };
            inspect();
          })`);
          await window.webContents.executeJavaScript("document.getElementById('assistantResizer').focus()");
          await new Promise((resolve) => setTimeout(resolve, 300));
          const assistantScreenshot = await window.webContents.capturePage();
          const assistantScreenshotPath = path.join(os.tmpdir(), 'edex-ui-bk-assistant-hud.png');
          fs.writeFileSync(assistantScreenshotPath, assistantScreenshot.toPNG());

          const cancellationStatus = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const prompt = document.getElementById('assistantPrompt');
            prompt.value = 'Generate a numbered list with one thousand detailed items.';
            document.getElementById('assistantForm').requestSubmit();
            const started = Date.now();
            let cancelled = false;
            const inspect = () => {
              const cancel = document.getElementById('assistantCancel');
              if (!cancelled && !cancel.hidden) {
                cancel.click();
                cancelled = true;
              }
              const status = document.getElementById('assistantStatus');
              if (cancelled && cancel.hidden) resolve({ state: status.dataset.state, text: status.textContent });
              else if (Date.now() - started > 15_000) reject(new Error('Assistant cancellation did not settle'));
              else setTimeout(inspect, 100);
            };
            inspect();
          })`);

          const settingsGeometry = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            document.getElementById('settingsToggle').click();
            const started = Date.now();
            const inspect = () => {
              const dialog = document.getElementById('settingsDialog');
              const localProvider = document.getElementById('localProvider');
              if (!dialog.hidden && localProvider.value === 'ollama') {
                localProvider.value = 'lmstudio';
                localProvider.dispatchEvent(new Event('change', { bubbles: true }));
              }
              const localModel = document.getElementById('localModel');
              if (!dialog.hidden && localProvider.value === 'lmstudio' && !localModel.disabled && localModel.value) {
                const rect = dialog.querySelector('.settings-panel').getBoundingClientRect();
                resolve({
                  left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                  width: rect.width, height: rect.height,
                  model: localModel.value,
                  secretsHidden: ['braveApiKey', 'openRouterApiKey', 'openCodeGoApiKey']
                    .every((id) => document.getElementById(id).value === ''),
                  viewport: { width: innerWidth, height: innerHeight }
                });
              } else if (Date.now() - started > 15_000) reject(new Error('Assistant settings models did not load'));
              else setTimeout(inspect, 200);
            };
            inspect();
          })`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const settingsScreenshot = await window.webContents.capturePage();
          const settingsScreenshotPath = path.join(os.tmpdir(), 'edex-ui-bk-assistant-settings.png');
          fs.writeFileSync(settingsScreenshotPath, settingsScreenshot.toPNG());

          const reloadComplete = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
          window.webContents.reload();
          await reloadComplete;
          const restoredWidth = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const pressAI = () => document.dispatchEvent(new KeyboardEvent('keydown', {
              code: 'Digit3', key: '3', metaKey: true, bubbles: true, cancelable: true
            }));
            const started = Date.now();
            let cycled = false;
            const inspect = () => {
              const panel = document.getElementById('assistantPanel');
              const stored = Number(localStorage.getItem('edex.assistant.width.v1'));
              if (panel.hidden && !cycled) pressAI();
              if (!panel.hidden && panel.getBoundingClientRect().width > 0 && !cycled) {
                pressAI();
                if (!panel.hidden) return reject(new Error('Command 3 did not close assistant'));
                pressAI();
                cycled = true;
              }
              if (cycled && !panel.hidden && panel.getBoundingClientRect().width > 0) {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                  panelWidth: panel.getBoundingClientRect().width,
                  storedWidth: stored,
                  ariaNow: Number(document.getElementById('assistantResizer').getAttribute('aria-valuenow')),
                  toggleCount: Number(document.body.dataset.assistantToggleCount),
                  panelOpen: document.body.dataset.assistantPanelOpen
                })));
              } else if (Date.now() - started > 10_000) reject(new Error('Assistant width did not restore'));
              else setTimeout(inspect, 100);
            };
            inspect();
          })`);

          const nativeResizeBefore = await window.webContents.executeJavaScript(`(() => {
            const handle = document.getElementById('assistantResizer');
            const rect = handle.getBoundingClientRect();
            const y = rect.top + Math.min(80, rect.height / 2);
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(y),
              width: document.getElementById('assistantPanel').getBoundingClientRect().width,
              hit: document.elementFromPoint(rect.left + rect.width / 2, y)?.id || ''
            };
          })()`);
          await window.webContents.sendInputEvent({ type: 'mouseDown', x: nativeResizeBefore.x, y: nativeResizeBefore.y, button: 'left', clickCount: 1 });
          await window.webContents.sendInputEvent({ type: 'mouseMove', x: nativeResizeBefore.x - 48, y: nativeResizeBefore.y, movementX: -48, movementY: 0 });
          await window.webContents.sendInputEvent({ type: 'mouseUp', x: nativeResizeBefore.x - 48, y: nativeResizeBefore.y, button: 'left', clickCount: 1 });
          await new Promise((resolve) => setTimeout(resolve, 180));
          const nativeResizeAfter = await window.webContents.executeJavaScript(`(() => ({
            width: document.getElementById('assistantPanel').getBoundingClientRect().width,
            stored: Number(localStorage.getItem('edex.assistant.width.v1')),
            resizing: document.body.classList.contains('assistant-resizing')
          }))()`);
          const systemLayoutBefore = await window.webContents.executeJavaScript(`(() => ({
            systemVisible: getComputedStyle(document.querySelector('.system-group')).display !== 'none',
            telemetry: document.getElementById('telemetryPanel').getBoundingClientRect().width,
            terminal: document.querySelector('.terminal-panel').getBoundingClientRect().width,
            assistant: document.getElementById('assistantPanel').getBoundingClientRect().width,
            columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns
          }))()`);
          await window.webContents.executeJavaScript("document.getElementById('systemGroupToggle').click()");
          await new Promise((resolve) => setTimeout(resolve, 180));
          const systemLayoutAfter = await window.webContents.executeJavaScript(`(() => ({
            systemVisible: getComputedStyle(document.querySelector('.system-group')).display !== 'none',
            telemetry: document.getElementById('telemetryPanel').getBoundingClientRect().width,
            terminal: document.querySelector('.terminal-panel').getBoundingClientRect().width,
            assistant: document.getElementById('assistantPanel').getBoundingClientRect().width,
            columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns
          }))()`);

          const minimumAssistantTestTerminalWidth = assistantGeometry.viewport.width <= 1180 ? 300 : 400;
          if (assistantGeometry.panel.width < 300 || assistantGeometry.terminalWidth < minimumAssistantTestTerminalWidth
            || assistantGeometry.panel.left < 0 || assistantGeometry.panel.right > assistantGeometry.viewport.width
            || !assistantGeometry.model || assistantGeometry.provider !== 'ollama' || assistantGeometry.responseLength < 1) {
            throw new Error('Assistant HUD geometry or dynamic Ollama model is invalid');
          }
          const resize = assistantGeometry.resize;
          if (!resize.fallbackStoredAbsent || !resize.shortcutVisible
            || Math.abs(resize.initialPanelWidth - resize.initialTerminalPanelWidth) > 2
            || resize.dragWidth <= resize.initialPanelWidth + 80
            || Math.abs(resize.keyboardWidth - (resize.dragWidth - 16)) > 2
            || Math.abs(resize.finalPanelWidth - resize.keyboardWidth) > 2
            || resize.finalTerminalScreenWidth >= resize.initialTerminalScreenWidth - 60
            || !resize.keyboardFocus || !resize.keyboardFocusAfterFit
            || resize.storedWidth !== Math.round(resize.finalPanelWidth)
            || resize.ariaNow !== Math.round(resize.finalPanelWidth)
            || resize.ariaNow < resize.ariaMin || resize.ariaNow > resize.ariaMax) {
            throw new Error(`Assistant splitter drag, keyboard control, ARIA state or xterm fit is invalid: ${JSON.stringify(resize)}`);
          }
          if (Math.abs(restoredWidth.panelWidth - resize.finalPanelWidth) > 2
            || restoredWidth.storedWidth !== resize.storedWidth
            || restoredWidth.ariaNow !== resize.ariaNow
            || restoredWidth.toggleCount !== 3 || restoredWidth.panelOpen !== 'true') {
            throw new Error('Assistant width did not persist across renderer reload');
          }
          if (nativeResizeBefore.hit !== 'assistantResizer'
            || nativeResizeAfter.width <= nativeResizeBefore.width + 10
            || nativeResizeAfter.stored !== Math.round(nativeResizeAfter.width)
            || nativeResizeAfter.resizing) {
            throw new Error(`Native mouse hit-test or resize failed: ${JSON.stringify({ nativeResizeBefore, nativeResizeAfter })}`);
          }
          if (Math.abs(systemLayoutAfter.assistant - systemLayoutBefore.assistant) > 2
            || systemLayoutAfter.systemVisible || systemLayoutAfter.telemetry !== 0
            || systemLayoutAfter.terminal <= systemLayoutBefore.terminal + 250) {
            throw new Error(`SYS toggle did not collapse the telemetry column: ${JSON.stringify({ systemLayoutBefore, systemLayoutAfter })}`);
          }
          await window.webContents.executeJavaScript("document.getElementById('filesGroupToggle').click()");
          await new Promise((resolve) => setTimeout(resolve, 180));
          const telemetryHiddenLayout = await window.webContents.executeJavaScript(`(() => {
            const workspace = document.querySelector('.workspace');
            const columns = getComputedStyle(workspace).gridTemplateColumns.trim().split(/\\s+/);
            return {
              telemetryVisible: getComputedStyle(document.getElementById('telemetryPanel')).display !== 'none',
              assistantHidden: document.getElementById('assistantPanel').hidden,
              filesHidden: document.getElementById('filesPanel').hidden,
              terminal: document.querySelector('.terminal-panel').getBoundingClientRect().width,
              files: document.getElementById('filesPanel').getBoundingClientRect().width,
              columns
            };
          })()`);
          if (telemetryHiddenLayout.telemetryVisible || telemetryHiddenLayout.columns.length !== 2
            || !telemetryHiddenLayout.assistantHidden || telemetryHiddenLayout.filesHidden
            || telemetryHiddenLayout.terminal < minimumAssistantTestTerminalWidth
            || telemetryHiddenLayout.files < 300) {
            throw new Error(`FILES toggle did not close AI and take over the split: ${JSON.stringify(telemetryHiddenLayout)}`);
          }
          await window.webContents.executeJavaScript("document.getElementById('filesGroupToggle').click()");
          await window.webContents.executeJavaScript("document.getElementById('systemGroupToggle').click()");
          if (cancellationStatus.state !== 'error' || cancellationStatus.text !== 'ABORTED') {
            throw new Error(`Assistant cancellation returned ${cancellationStatus.text || 'no status'}`);
          }
          if (settingsGeometry.left < 0 || settingsGeometry.top < 0
            || settingsGeometry.right > settingsGeometry.viewport.width || settingsGeometry.bottom > settingsGeometry.viewport.height
            || !settingsGeometry.model || !settingsGeometry.secretsHidden) {
            throw new Error('Settings geometry, dynamic LM Studio model or secret boundary is invalid');
          }
          console.log(`Assistant HUD visual test passed: ${assistantGeometry.model}; LM Studio ${settingsGeometry.model}.`);
          console.log(`Assistant HUD screenshot: ${assistantScreenshotPath}`);
          console.log(`Assistant settings screenshot: ${settingsScreenshotPath}`);
          process.exitCode = 0;
        } catch (error) {
          console.error(`Assistant HUD visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 2_000);
    });
}

module.exports = { runAssistantVisualTest };
