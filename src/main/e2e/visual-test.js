'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

function setupFixtures(context) {
  const {
    visualBrowserChild, visualBrowserRoot, visualBrowserFile, visualBrowserImage,
    visualBrowserLargeImage, IMAGE_PREVIEW_MAX_BYTES
  } = context;

    fs.mkdirSync(visualBrowserChild, { recursive: true });
    for (let index = 0; index < 90; index += 1) {
      fs.mkdirSync(path.join(visualBrowserRoot, `.hidden-${String(index).padStart(3, '0')}`), { recursive: true });
    }
    ['Desktop', 'Documents', 'Downloads', 'Pictures'].forEach((directoryName) => {
      fs.mkdirSync(path.join(visualBrowserRoot, directoryName), { recursive: true });
    });
    fs.writeFileSync(visualBrowserFile, 'phase 11 drag fixture\n');
    fs.writeFileSync(path.join(visualBrowserChild, 'inside.txt'), 'phase 11 browsing fixture\n');
    fs.writeFileSync(visualBrowserImage, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#02080a"/>
      <path d="M0 135 L78 72 L132 108 L206 38 L320 126 V180 H0 Z" fill="#087f9c" opacity=".64"/>
      <path d="M0 145 L78 82 L132 118 L206 48 L320 136" fill="none" stroke="#00e5ff" stroke-width="4"/>
      <rect x="18" y="18" width="284" height="144" fill="none" stroke="#8ff8ff" stroke-width="2"/>
      <text x="30" y="54" fill="#8ff8ff" font-family="monospace" font-size="22">EDEX PREVIEW</text>
      <text x="30" y="78" fill="#00e5ff" font-family="monospace" font-size="12">PHASE 12 / 320x180</text>
    </svg>`);
    fs.writeFileSync(visualBrowserLargeImage, '');
    fs.truncateSync(visualBrowserLargeImage, IMAGE_PREVIEW_MAX_BYTES + 1);
}

function runVisualTest(window, context) {
  const {
    visualBrowserRoot, visualBrowserChild, visualBrowserFile, visualBrowserImage,
    visualBrowserLargeImage, visualTestWidth, visualTestHeight,
    minimumVisualTerminalWidthWithFilesPanel, minimumVisualFileListHeight, forceOfflineTest
  } = context;

    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        window.webContents.executeJavaScript(`(() => {
          const press = (code, shiftKey = false) => document.dispatchEvent(new KeyboardEvent('keydown', {
            code,
            metaKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true
          }));
          const dispatchTestFileDrag = (shouldDrop) => {
            const target = document.querySelector('.terminal-surface');
            const transfer = new DataTransfer();
            transfer.setData('application/x-edex-ui-bk-test-paths', JSON.stringify([
              '/tmp/eDEX drag one.txt',
              "/tmp/O'Brien [v2].log"
            ]));
            const dispatch = (type) => target.dispatchEvent(new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            dispatch('dragenter');
            dispatch('dragover');
            if (shouldDrop) dispatch('drop');
          };
          const dispatchPanelFileDrag = (row) => {
            const target = document.querySelector('.terminal-surface');
            const transfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            const dispatch = (type, dispatchTarget = target) => dispatchTarget.dispatchEvent(new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            dispatch('dragenter');
            dispatch('dragover');
            dispatch('drop');
            dispatch('dragend', row);
          };
          const openRow = (row) => {
            if (!row) return;
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          };
          const dispatchPreviewPointer = (row, type = 'pointerover') => {
            const rect = row.getBoundingClientRect();
            row.dispatchEvent(new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: rect.right - 8,
              clientY: rect.top + (rect.height / 2),
              relatedTarget: null
            }));
          };
          const dispatchPreviewDragCycle = (row) => {
            const transfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            row.dispatchEvent(new DragEvent('dragend', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
          };
          const dispatchTTYContextMenu = (tab, clientX = null, clientY = null) => {
            const rect = tab.getBoundingClientRect();
            const event = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: clientX ?? rect.right - 2,
              clientY: clientY ?? rect.bottom - 2
            });
            const accepted = tab.dispatchEvent(event);
            document.body.dataset.ttyNativeMenuPrevented = String(!accepted && event.defaultPrevented);
          };
          const dismissTTYMenuWithEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true
          }));
          const submitTTYRename = (name) => {
            const input = document.getElementById('ttyRenameInput');
            input.value = name;
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              bubbles: true,
              cancelable: true
            }));
          };
          press('KeyT');
          press('Digit1');
          setTimeout(() => press('Digit2'), 200);
          setTimeout(() => press('Digit2'), 400);
          setTimeout(() => press('Digit2'), 600);
          setTimeout(() => press('Digit1'), 3_000);
          if (document.body.classList.contains('scanlines-on')) press('KeyL', true);
          press('KeyL', true);
          press('KeyL', true);
          if (document.body.dataset.soundEnabled === 'true') press('KeyS', true);
          press('KeyS', true);
          press('KeyS', true);
          const waitFor = (condition, action, attempt = 0) => {
            if (condition()) action();
            else if (attempt < 40) setTimeout(() => waitFor(condition, action, attempt + 1), 250);
          };
          waitFor(
            () => document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-02'
              && document.getElementById('shellStatusText').textContent === 'LINK ONLINE'
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.type === 'directory'),
            () => {
              const backgroundTab = document.querySelector('.tty-tab[data-session-id="tty-01"]');
              dispatchTTYContextMenu(backgroundTab, window.innerWidth - 2, window.innerHeight - 2);
              waitFor(
                () => document.body.dataset.ttyContextMenuOpen === 'true'
                  && document.body.dataset.ttyContextSessionId === 'tty-01',
                () => {
                  const menuRect = document.getElementById('ttyContextMenu').getBoundingClientRect();
                  document.body.dataset.ttyContextViewportSafe = String(
                    menuRect.left >= 0 && menuRect.top >= 0
                      && menuRect.right <= window.innerWidth && menuRect.bottom <= window.innerHeight
                  );
                  dismissTTYMenuWithEscape();
                  waitFor(
                    () => document.body.dataset.ttyContextMenuOpen === 'false',
                    () => {
                      document.body.dataset.ttyContextEscapeClosed = 'true';
                      dispatchTTYContextMenu(backgroundTab);
                      document.querySelector('#ttyContextMenu [data-action="rename"]').click();
                      waitFor(
                        () => document.body.dataset.ttyRenameOpen === 'true',
                        () => {
                          document.getElementById('ttyRenameInput').value = 'CANCELLED NAME';
                          dismissTTYMenuWithEscape();
                          waitFor(
                            () => document.body.dataset.ttyRenameOpen === 'false'
                              && backgroundTab.dataset.manualName === '',
                            () => {
                              document.body.dataset.ttyRenameEscapeCancelled = 'true';
                              dispatchTTYContextMenu(backgroundTab);
                              document.querySelector('#ttyContextMenu [data-action="rename"]').click();
                              waitFor(
                                () => document.body.dataset.ttyRenameOpen === 'true',
                                () => {
                                  submitTTYRename('OPS CONTROL');
                                  waitFor(
                                    () => backgroundTab.dataset.manualName === 'OPS CONTROL'
                                      && document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-02',
                                    () => {
                                      setTimeout(() => {
                                        if (backgroundTab.dataset.manualName === 'OPS CONTROL'
                                          && backgroundTab.querySelector('.tty-context').textContent === 'OPS CONTROL') {
                                          document.body.dataset.ttyManualNamePersisted = 'true';
                                        }
                                        dispatchTTYContextMenu(backgroundTab);
                                        waitFor(
                                          () => !document.querySelector('#ttyContextMenu [data-action="auto-name"]').hidden,
                                          () => {
                                            document.querySelector('#ttyContextMenu [data-action="auto-name"]').click();
                                            waitFor(
                                              () => Number(document.body.dataset.ttyAutoNameResetCount || 0) === 1
                                                && backgroundTab.dataset.manualName === '',
                                              () => {
                                                dispatchTTYContextMenu(backgroundTab);
                                                document.querySelector('.terminal-surface').dispatchEvent(new PointerEvent('pointerdown', {
                                                  bubbles: true,
                                                  cancelable: true
                                                }));
                                                waitFor(
                                                  () => document.body.dataset.ttyContextMenuOpen === 'false',
                                                  () => {
                                                    document.body.dataset.ttyContextOutsideClosed = 'true';
                                                    dispatchTTYContextMenu(backgroundTab);
                                                    document.querySelector('#ttyContextMenu [data-action="rename"]').click();
                                                    waitFor(
                                                      () => document.body.dataset.ttyRenameOpen === 'true',
                                                      () => {
                                                        submitTTYRename('PINNED OPERATIONS ALPHA EXTRA');
                                                        waitFor(
                                                          () => backgroundTab.dataset.manualName === 'PINNED OPERATIONS ALPHA',
                                                          () => {
                                                            dispatchTTYContextMenu(backgroundTab);
                                                            waitFor(
                                                              () => !document.querySelector('#ttyContextMenu [data-action="auto-name"]').hidden,
                                                              () => document.querySelector('#ttyContextMenu [data-action="close"]').click()
                                                            );
                                                          }
                                                        );
                                                      }
                                                    );
                                                  }
                                                );
                                              }
                                            );
                                          }
                                        );
                                      }, 1_250);
                                    }
                                  );
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
          waitFor(
            () => Number(document.body.dataset.terminalExitCount || 0) >= 1
              && document.querySelectorAll('#ttyTabs .tty-tab').length === 1
              && document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-02',
            () => {
              document.body.dataset.ttyBackgroundClosePreservedActive = 'true';
              const directory = [...document.querySelectorAll('#fileList .file-row')]
                .find((row) => row.dataset.type === 'directory');
              openRow(directory);
              window.terminalApi.write('tty-02', '/usr/bin/top -l 2 -s 1 >/dev/null\\r');
              waitFor(
                () => document.body.dataset.ttyTopObserved === 'true'
                  && document.body.dataset.fileBrowserMode === 'browsing',
                () => {
                  dispatchTTYContextMenu(document.querySelector('.tty-tab[data-session-id="tty-02"]'));
                  document.querySelector('#ttyContextMenu [data-action="close"]').click();
                }
              );
            }
          );
          waitFor(
            () => document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-03'
              && document.getElementById('shellStatusText').textContent === 'LINK ONLINE'
              && Number(document.body.dataset.terminalRespawnCount || 0) === 1
              && document.body.dataset.fileBrowserMode === 'live',
            () => {
              document.body.dataset.ttySoleCloseRespawned = 'true';
              window.terminalApi.write('tty-03', ${JSON.stringify(`cd '${visualBrowserRoot.replace(/'/g, `'\\''`)}'\r`)});
              setTimeout(() => {
                window.terminalApi.write('tty-03', "printf '__EDEX_DROP_OK__<%s><%s>\\\\n' ");
                dispatchTestFileDrag(true);
                setTimeout(() => window.terminalApi.write('tty-03', '\\r'), 100);
              }, 750);
            }
          );
          waitFor(
            () => document.body.dataset.fileBrowserMode === 'live'
              && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserRoot)}
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.path === ${JSON.stringify(visualBrowserChild)})
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Desktop')
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Documents')
              && ![...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name.startsWith('.hidden-'))
              && document.getElementById('fileBrowserCount').textContent === '6 ITEMS',
            () => {
              document.body.dataset.dotfilesLiveFiltered = 'true';
              const child = [...document.querySelectorAll('#fileList .file-row')]
                .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserChild)});
              openRow(child);
              waitFor(
                () => document.body.dataset.fileBrowserMode === 'browsing'
                  && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserChild)},
                () => {
                  document.body.dataset.fileBrowserDescended = 'true';
                  openRow(document.querySelector('#fileList .file-row--parent'));
                  waitFor(
                    () => document.body.dataset.fileBrowserMode === 'browsing'
                      && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserRoot)},
                    () => {
                      document.body.dataset.fileBrowserAscended = 'true';
                      press('Period', true);
                      waitFor(
                        () => document.body.dataset.dotfilesVisible === 'true'
                          && document.getElementById('dotfilesToggle').textContent === 'DOTS SHOWN'
                          && document.getElementById('fileBrowserCount').textContent === '96+ ITEMS'
                          && [...document.querySelectorAll('#fileList .file-row')]
                            .some((row) => row.dataset.name.startsWith('.hidden-')),
                        () => {
                          document.body.dataset.dotfilesShownObserved = 'true';
                          press('Period', true);
                          waitFor(
                            () => document.body.dataset.dotfilesVisible === 'false'
                              && document.getElementById('dotfilesToggle').textContent === 'DOTS HIDDEN'
                              && document.getElementById('fileBrowserCount').textContent === '6 ITEMS'
                              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Desktop')
                              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Documents')
                              && ![...document.querySelectorAll('#fileList .file-row')]
                                .some((row) => row.dataset.name.startsWith('.hidden-')),
                            () => {
                              document.body.dataset.dotfilesHiddenRestored = 'true';
                              const file = [...document.querySelectorAll('#fileList .file-row')]
                                .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserFile)});
                              window.terminalApi.write('tty-03', "printf '__EDEX_PANEL_DROP_OK__<%s>\\\\n' ");
                              dispatchPanelFileDrag(file);
                              setTimeout(() => window.terminalApi.write('tty-03', '\\r'), 100);
                              waitFor(
                                () => document.body.dataset.panelDropShellVerified === 'true',
                                () => {
                                  document.getElementById('fileBrowserMode').click();
                                  waitFor(
                                    () => document.body.dataset.fileBrowserMode === 'live',
                                    () => {
                                      document.body.dataset.fileBrowserLiveResumed = 'true';
                                      setTimeout(() => {
                                        const liveChild = [...document.querySelectorAll('#fileList .file-row')]
                                          .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserChild)});
                                        openRow(liveChild);
                                        waitFor(
                                          () => document.body.dataset.fileBrowserMode === 'browsing'
                                            && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserChild)}
                                            && [...document.querySelectorAll('#fileList .file-row')]
                                              .some((row) => row.dataset.path === ${JSON.stringify(visualBrowserImage)}),
                                          () => {
                                            const largeRow = [...document.querySelectorAll('#fileList .file-row')]
                                              .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserLargeImage)});
                                            dispatchPreviewPointer(largeRow);
                                            waitFor(
                                              () => document.getElementById('fileImagePreview').dataset.state === 'message'
                                                && document.getElementById('fileImagePreviewMessage').textContent === 'FILE TOO LARGE',
                                              () => {
                                                document.body.dataset.imagePreviewTooLargeObserved = 'true';
                                                dispatchPreviewPointer(largeRow, 'pointerout');
                                                const previewRow = [...document.querySelectorAll('#fileList .file-row')]
                                                  .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserImage)});
                                                dispatchPreviewPointer(previewRow);
                                                waitFor(
                                                  () => document.body.dataset.imagePreviewVisible === 'true'
                                                    && document.getElementById('fileImagePreview').dataset.state === 'image',
                                                  () => {
                                                    document.body.dataset.imagePreviewFirstObserved = 'true';
                                                    dispatchPreviewDragCycle(previewRow);
                                                    waitFor(
                                                      () => document.body.dataset.imagePreviewHiddenByDrag === 'true'
                                                        && document.body.dataset.imagePreviewVisible === 'false',
                                                      () => {
                                                        const cachedRow = [...document.querySelectorAll('#fileList .file-row')]
                                                          .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserImage)});
                                                        dispatchPreviewPointer(cachedRow);
                                                        waitFor(
                                                          () => document.body.dataset.imagePreviewVisible === 'true',
                                                          () => {
                                                            const preview = document.getElementById('fileImagePreview');
                                                            const image = document.getElementById('fileImagePreviewImage');
                                                            const previewRect = preview.getBoundingClientRect();
                                                            const imageRect = image.getBoundingClientRect();
                                                            document.body.dataset.imagePreviewFinalGeometry = JSON.stringify({
                                                              state: preview.dataset.state,
                                                              hidden: preview.hidden,
                                                              left: previewRect.left,
                                                              top: previewRect.top,
                                                              right: previewRect.right,
                                                              bottom: previewRect.bottom,
                                                              width: previewRect.width,
                                                              height: previewRect.height,
                                                              imageWidth: imageRect.width,
                                                              imageHeight: imageRect.height,
                                                              viewportWidth: window.innerWidth,
                                                              viewportHeight: window.innerHeight
                                                            });
                                                            document.body.dataset.imagePreviewFinalObserved = 'true';
                                                            dispatchPreviewPointer(cachedRow, 'pointerout');
                                                            openRow(document.querySelector('#fileList .file-row--parent'));
                                                            waitFor(
                                                              () => document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserRoot)}
                                                                && [...document.querySelectorAll('#fileList .file-row')]
                                                                  .some((row) => row.dataset.name === 'Documents'),
                                                              () => {
                                                                const documentsRow = [...document.querySelectorAll('#fileList .file-row')]
                                                                  .find((row) => row.dataset.name === 'Documents');
                                                                documentsRow.scrollIntoView({ block: 'end' });
                                                                document.body.dataset.dotfilesScreenshotReady = 'true';
                                                                const activeTab = document.querySelector('#ttyTabs .tty-tab.is-active');
                                                                dispatchTTYContextMenu(activeTab);
                                                                waitFor(
                                                                  () => document.body.dataset.ttyContextMenuOpen === 'true'
                                                                    && document.body.dataset.ttyContextSessionId === 'tty-03',
                                                                  () => {
                                                                    document.body.dataset.ttyFinalMenuReady = 'true';
                                                                  }
                                                                );
                                                              }
                                                            );
                                                          }
                                                        );
                                                      }
                                                    );
                                                  }
                                                );
                                              }
                                            );
                                          }
                                        );
                                      }, 300);
                                    }
                                  );
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
          setTimeout(() => dispatchTestFileDrag(false), 10_500);
        })()`).catch((error) => console.error(`Visual shortcut setup failed: ${error.message}`));
      }, 2_000);

      setTimeout(async () => {
        try {
          const diagnostics = await window.webContents.executeJavaScript(`({
            fonts: {
              terminal: document.fonts.check('14px "Monaspace Neon NF"'),
              headings: document.fonts.check('600 14px Orbitron'),
              labels: document.fonts.check('500 11px "Chakra Petch"')
            },
            bootComplete: document.body.classList.contains('boot-complete'),
            windowMode: {
              fullscreen: ${window.isFullScreen()},
              fullscreenable: ${window.isFullScreenable()},
              resizable: ${window.isResizable()},
              bounds: ${JSON.stringify(window.getBounds())}
            },
            scanlinesEnabled: document.body.classList.contains('scanlines-on'),
            shellStatus: document.getElementById('shellStatusText').textContent,
            hostname: document.getElementById('hudHostname').textContent,
            date: document.getElementById('hudDate').textContent,
            clock: document.getElementById('hudClock').textContent.trim(),
            uptime: document.getElementById('uptimeValue').textContent,
            batteryPresent: document.body.dataset.batteryPresent === 'true',
            batteryHidden: document.getElementById('powerStatus').hidden,
            batteryValue: document.getElementById('batteryValue').textContent,
            batteryLabel: document.getElementById('powerLabel').textContent,
            terminalSessionCount: document.querySelectorAll('#ttyTabs .tty-tab').length,
            activeTerminal: document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId || null,
            activeTerminalLabel: document.querySelector('#ttyTabs .tty-tab.is-active')?.textContent.trim() || null,
            terminalTopObserved: document.body.dataset.ttyTopObserved === 'true',
            terminalExitCount: Number(document.body.dataset.terminalExitCount || 0),
            terminalRespawnCount: Number(document.body.dataset.terminalRespawnCount || 0),
            terminalOfflineMarker: document.querySelector('.terminal-instance:not([hidden])')?.textContent.includes('SHELL OFFLINE') || false,
            ttyContextMenuOpen: document.body.dataset.ttyContextMenuOpen === 'true',
            ttyContextSessionId: document.body.dataset.ttyContextSessionId || null,
            ttyNativeMenuPrevented: document.body.dataset.ttyNativeMenuPrevented === 'true',
            ttyContextViewportSafe: document.body.dataset.ttyContextViewportSafe === 'true',
            ttyContextEscapeClosed: document.body.dataset.ttyContextEscapeClosed === 'true',
            ttyContextOutsideClosed: document.body.dataset.ttyContextOutsideClosed === 'true',
            ttyRenameEscapeCancelled: document.body.dataset.ttyRenameEscapeCancelled === 'true',
            ttyManualNamePersisted: document.body.dataset.ttyManualNamePersisted === 'true',
            ttyRenameCount: Number(document.body.dataset.ttyRenameCount || 0),
            ttyAutoNameResetCount: Number(document.body.dataset.ttyAutoNameResetCount || 0),
            ttyContextCloseCount: Number(document.body.dataset.ttyContextCloseCount || 0),
            ttyBackgroundClosePreservedActive: document.body.dataset.ttyBackgroundClosePreservedActive === 'true',
            ttySoleCloseRespawned: document.body.dataset.ttySoleCloseRespawned === 'true',
            ttyFinalMenuReady: document.body.dataset.ttyFinalMenuReady === 'true',
            ttyContextMenuGeometry: (() => {
              const menu = document.getElementById('ttyContextMenu');
              const rect = menu.getBoundingClientRect();
              return {
                hidden: menu.hidden,
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                actions: [...menu.querySelectorAll('[data-action]')]
                  .filter((item) => getComputedStyle(item).display !== 'none')
                  .map((item) => item.textContent.trim())
              };
            })(),
            dropPathApiSupported: document.body.dataset.dropPathApiSupported === 'true',
            dropTargetObserved: document.body.dataset.dropTargetObserved === 'true',
            dropIndicatorCleared: document.body.dataset.dropIndicatorCleared === 'true',
            dropIndicatorVisible: document.querySelector('.terminal-panel').classList.contains('is-file-drop-target'),
            dropPathCount: Number(document.body.dataset.dropPathCount || 0),
            dropSessionId: document.body.dataset.dropSessionId || null,
            dropQuotedPayload: document.body.dataset.dropQuotedPayload || '',
            dropShellVerified: document.body.dataset.dropShellVerified === 'true',
            panelDropPathCount: Number(document.body.dataset.panelDropPathCount || 0),
            panelDropSessionId: document.body.dataset.panelDropSessionId || null,
            panelDropQuotedPayload: document.body.dataset.panelDropQuotedPayload || '',
            panelDropShellVerified: document.body.dataset.panelDropShellVerified === 'true',
            systemGroupOn: !document.body.classList.contains('system-group-hidden'),
            filesGroupOn: !document.getElementById('filesPanel').hidden,
            systemToggleCount: Number(document.body.dataset.systemToggleCount || 0),
            filesToggleCount: Number(document.body.dataset.filesToggleCount || 0),
            dataVisibilityStates: document.body.dataset.dataVisibilityStates || '',
            dataVisibilityGeometry: JSON.parse(document.body.dataset.dataVisibilityGeometry || '{}'),
            scanlinesToggleCount: Number(document.body.dataset.scanlinesToggleCount || 0),
            soundEnabled: document.body.dataset.soundEnabled === 'true',
            soundToggleCount: Number(document.body.dataset.soundToggleCount || 0),
            fileBrowserReady: document.body.dataset.fileBrowserReady === 'true',
            fileBrowserCwd: document.getElementById('fileBrowserCwd').textContent,
            fileBrowserCwdPath: document.getElementById('fileBrowserCwd').title,
            fileCount: document.querySelectorAll('#fileList .file-row').length,
            fileBrowserMode: document.body.dataset.fileBrowserMode,
            fileBrowserDescended: document.body.dataset.fileBrowserDescended === 'true',
            fileBrowserAscended: document.body.dataset.fileBrowserAscended === 'true',
            fileBrowserLiveResumed: document.body.dataset.fileBrowserLiveResumed === 'true',
            fileBrowserTabResumeObserved: document.body.dataset.fileBrowserTabResumeObserved === 'true',
            fileBrowserDragStarted: document.body.dataset.fileBrowserDragStarted === 'true',
            fileBrowserParentFirst: document.querySelector('#fileList .file-row:first-child')?.classList.contains('file-row--parent') || false,
            dotfilesVisible: document.body.dataset.dotfilesVisible === 'true',
            dotfilesToggleCount: Number(document.body.dataset.dotfilesToggleCount || 0),
            dotfilesLiveFiltered: document.body.dataset.dotfilesLiveFiltered === 'true',
            dotfilesShownObserved: document.body.dataset.dotfilesShownObserved === 'true',
            dotfilesHiddenRestored: document.body.dataset.dotfilesHiddenRestored === 'true',
            dotfilesScreenshotReady: document.body.dataset.dotfilesScreenshotReady === 'true',
            dotfilesChip: document.getElementById('dotfilesToggle').textContent,
            imagePreviewVisible: document.body.dataset.imagePreviewVisible === 'true',
            imagePreviewFinalObserved: document.body.dataset.imagePreviewFinalObserved === 'true',
            imagePreviewFirstObserved: document.body.dataset.imagePreviewFirstObserved === 'true',
            imagePreviewTooLargeObserved: document.body.dataset.imagePreviewTooLargeObserved === 'true',
            imagePreviewHiddenByDrag: document.body.dataset.imagePreviewHiddenByDrag === 'true',
            imagePreviewCacheHit: document.body.dataset.imagePreviewCacheHit === 'true',
            imagePreviewRequestCount: Number(document.body.dataset.imagePreviewRequestCount || 0),
            imagePreviewDwellMs: Number(document.body.dataset.imagePreviewDwellMs || 0),
            imagePreviewNaturalWidth: Number(document.body.dataset.imagePreviewNaturalWidth || 0),
            imagePreviewNaturalHeight: Number(document.body.dataset.imagePreviewNaturalHeight || 0),
            imagePreviewGeometry: (() => {
              const captured = document.body.dataset.imagePreviewFinalGeometry;
              if (captured) return JSON.parse(captured);
              const preview = document.getElementById('fileImagePreview');
              const image = document.getElementById('fileImagePreviewImage');
              const previewRect = preview.getBoundingClientRect();
              const imageRect = image.getBoundingClientRect();
              return {
                state: preview.dataset.state,
                hidden: preview.hidden,
                left: previewRect.left,
                top: previewRect.top,
                right: previewRect.right,
                bottom: previewRect.bottom,
                width: previewRect.width,
                height: previewRect.height,
                imageWidth: imageRect.width,
                imageHeight: imageRect.height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight
              };
            })(),
            fileHeadingGeometry: (() => {
              const header = document.querySelector('.file-section-heading').getBoundingClientRect();
              const title = document.getElementById('filesSectionTitle').getBoundingClientRect();
              const mode = document.getElementById('fileBrowserMode').getBoundingClientRect();
              const dots = document.getElementById('dotfilesToggle').getBoundingClientRect();
              const session = document.getElementById('fileBrowserSession').getBoundingClientRect();
              const count = document.getElementById('fileBrowserCount').getBoundingClientRect();
              return {
                header: { left: header.left, top: header.top, right: header.right, bottom: header.bottom },
                title: { left: title.left, top: title.top, right: title.right, bottom: title.bottom, height: title.height },
                items: [mode, dots, session, count].map((rect) => ({
                  left: rect.left,
                  top: rect.top,
                  right: rect.right,
                  bottom: rect.bottom
                }))
              };
            })(),
            shortcutCount: document.querySelectorAll('.shortcut-legend kbd').length,
            monitoringReady: document.body.dataset.monitoringReady === 'true',
            monitoringSamples: Number(document.body.dataset.monitoringSamples || 0),
            monitoringStatus: document.getElementById('monitoringStatusText').textContent,
            cpuValue: document.getElementById('cpuValue').textContent,
            memoryValue: document.getElementById('memoryValue').textContent,
            networkDown: document.getElementById('networkDown').textContent,
            networkState: document.body.dataset.networkState,
            networkLan: document.getElementById('networkLan').textContent,
            networkPublic: document.getElementById('networkPublic').textContent,
            networkPing: document.getElementById('networkPing').textContent,
            diskValue: document.getElementById('diskValue').textContent,
            diskUsed: document.getElementById('diskUsed').textContent,
            diskAvailable: document.getElementById('diskAvailable').textContent,
            diskWarning: document.getElementById('diskSection').classList.contains('is-warning'),
            processCount: document.querySelectorAll('#processList .process-row').length,
            cspLocked: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("connect-src 'none'"),
            cspImageDataOnly: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("img-src 'self' data:"),
            gridColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
            telemetryGeometry: (() => {
              const panel = document.getElementById('telemetryPanel').getBoundingClientRect();
              const column = document.querySelector('.telemetry-column');
              const diskDetails = document.querySelector('#diskSection .metric-pairs').getBoundingClientRect();
              const networkHeading = document.querySelector('.network-section .section-heading').getBoundingClientRect();
              return {
                width: panel.width,
                height: panel.height,
                columnClientHeight: column.clientHeight,
                columnScrollHeight: column.scrollHeight,
                diskDetailsClearance: networkHeading.top - diskDetails.bottom
              };
            })(),
            filesPanelGeometry: (() => {
              const filesPanel = document.getElementById('filesPanel');
              const panel = filesPanel.getBoundingClientRect();
              const list = document.getElementById('fileList');
              return {
                hidden: filesPanel.hidden,
                width: panel.width,
                fileListClientHeight: list.clientHeight,
                fileListScrollHeight: list.scrollHeight
              };
            })(),
            terminalGeometry: (() => {
              const screen = document.querySelector('.terminal-tab-view:not([hidden]) .terminal-instance.is-active-pane .xterm-screen').getBoundingClientRect();
              return { width: screen.width, height: screen.height };
            })()
          })`);
          diagnostics.packaged = app.isPackaged;
          // The TTY context menu is a diagnostic artefact, not something the
          // README should advertise — dismiss it before the frame is captured.
          await window.webContents.executeJavaScript(`(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve, 300));
          })()`);
          const screenshot = await window.webContents.capturePage();
          console.log(`Visual diagnostics: ${JSON.stringify(diagnostics)}`);
          if (!diagnostics.monitoringReady || diagnostics.monitoringSamples < 2) {
            throw new Error('Monitoring did not provide at least two samples');
          }
          if (diagnostics.windowMode.fullscreen || !diagnostics.windowMode.fullscreenable
            || !diagnostics.windowMode.resizable || diagnostics.windowMode.bounds.width !== visualTestWidth
            || diagnostics.windowMode.bounds.height !== visualTestHeight) {
            throw new Error('Window did not start with the requested resizable macOS dimensions');
          }
          if (diagnostics.terminalSessionCount !== 1 || diagnostics.activeTerminal !== 'tty-03'
            || !diagnostics.activeTerminalLabel.includes('03') || !diagnostics.activeTerminalLabel.includes('tmp')
            || !diagnostics.terminalTopObserved
            || diagnostics.terminalExitCount !== 2 || diagnostics.terminalRespawnCount !== 1
            || diagnostics.terminalOfflineMarker || diagnostics.shellStatus !== 'LINK ONLINE') {
            throw new Error('PTY exit lifecycle did not close tabs and respawn the final session');
          }
          const ttyMenu = diagnostics.ttyContextMenuGeometry;
          if (!diagnostics.ttyContextMenuOpen || diagnostics.ttyContextSessionId !== 'tty-03'
            || !diagnostics.ttyNativeMenuPrevented || !diagnostics.ttyContextViewportSafe
            || !diagnostics.ttyContextEscapeClosed || !diagnostics.ttyContextOutsideClosed
            || !diagnostics.ttyRenameEscapeCancelled || !diagnostics.ttyManualNamePersisted
            || diagnostics.ttyRenameCount !== 2 || diagnostics.ttyAutoNameResetCount !== 1
            || diagnostics.ttyContextCloseCount !== 2 || !diagnostics.ttyBackgroundClosePreservedActive
            || !diagnostics.ttySoleCloseRespawned || !diagnostics.ttyFinalMenuReady
            || ttyMenu.hidden || ttyMenu.actions.join(',') !== 'RENAME,CLOSE'
            || ttyMenu.left < 0 || ttyMenu.top < 0
            || ttyMenu.right > ttyMenu.viewportWidth || ttyMenu.bottom > ttyMenu.viewportHeight) {
            throw new Error('TTY context menu, rename/auto-name, dismissal or close lifecycle failed');
          }
          const expectedDropPayload = "'/tmp/eDEX drag one.txt' '/tmp/O'\\''Brien [v2].log' ";
          if (!diagnostics.dropPathApiSupported || !diagnostics.dropTargetObserved
            || !diagnostics.dropIndicatorCleared || !diagnostics.dropIndicatorVisible
            || diagnostics.dropPathCount !== 2 || diagnostics.dropSessionId !== diagnostics.activeTerminal
            || diagnostics.dropQuotedPayload !== expectedDropPayload || !diagnostics.dropShellVerified) {
            throw new Error('File drag/drop path insertion, shell quoting or active-session routing failed');
          }
          const expectedPanelDropPayload = `'${visualBrowserFile.replace(/'/g, `'\\''`)}' `;
          if (!diagnostics.panelDropShellVerified || diagnostics.panelDropPathCount !== 1
            || diagnostics.panelDropSessionId !== diagnostics.activeTerminal
            || diagnostics.panelDropQuotedPayload !== expectedPanelDropPayload
            || !diagnostics.fileBrowserDragStarted) {
            throw new Error('FILE SYSTEM drag/drop did not use the shared shell-quoting and active-session route');
          }
          if (!diagnostics.systemGroupOn || !diagnostics.filesGroupOn || diagnostics.shortcutCount !== 6
            || diagnostics.systemToggleCount !== 2 || diagnostics.filesToggleCount !== 3
            || diagnostics.scanlinesToggleCount < 3 || diagnostics.scanlinesEnabled
            || diagnostics.soundToggleCount < 3 || diagnostics.soundEnabled) {
            throw new Error('HUD shortcut test did not restore the expected state');
          }
          const visibility = diagnostics.dataVisibilityGeometry;
          const expectedVisibilityStates = ['system-visible', 'system-hidden'];
          if (expectedVisibilityStates.some((state) => !diagnostics.dataVisibilityStates.split(',').includes(state))
            || !visibility['system-visible']?.panelVisible || !visibility['system-visible']?.systemVisible
            || visibility['system-hidden']?.panelVisible || visibility['system-hidden']?.systemVisible
            || visibility['system-hidden']?.terminalWidth < visibility['system-visible']?.terminalWidth + 250
            || visibility['system-hidden']?.terminalScreenWidth < visibility['system-visible']?.terminalScreenWidth + 250
            || visibility['system-visible']?.visibleProcessCount < 3) {
            throw new Error('SYSTEM panel visibility toggle or terminal refit is invalid');
          }
          if (!diagnostics.fileBrowserReady || diagnostics.fileBrowserMode !== 'browsing'
            || diagnostics.fileBrowserCwdPath !== visualBrowserRoot
            || diagnostics.fileCount < 1 || !diagnostics.fileBrowserParentFirst
            || !diagnostics.fileBrowserDescended || !diagnostics.fileBrowserAscended
            || !diagnostics.fileBrowserLiveResumed || !diagnostics.fileBrowserTabResumeObserved) {
            throw new Error('FILE SYSTEM LIVE/BROWSING navigation or parent-row behavior failed');
          }
          if (diagnostics.dotfilesVisible || diagnostics.dotfilesToggleCount !== 2
            || !diagnostics.dotfilesLiveFiltered || !diagnostics.dotfilesShownObserved
            || !diagnostics.dotfilesHiddenRestored || !diagnostics.dotfilesScreenshotReady
            || diagnostics.dotfilesChip !== 'DOTS HIDDEN') {
            throw new Error('Dotfile filtering, visible count or Cmd+Shift+. toggle failed');
          }
          const fileHeading = diagnostics.fileHeadingGeometry;
          const fileHeadingItems = [fileHeading.title, ...fileHeading.items];
          if (fileHeading.title.height > 12 || fileHeadingItems.some((item) => (
            item.left < fileHeading.header.left || item.right > fileHeading.header.right
              || item.top < fileHeading.header.top || item.bottom > fileHeading.header.bottom
          ))) {
            throw new Error('FILE SYSTEM heading wrapped or clipped its status metadata');
          }
          const preview = diagnostics.imagePreviewGeometry;
          if (diagnostics.imagePreviewVisible || !diagnostics.imagePreviewFinalObserved || !diagnostics.imagePreviewFirstObserved
            || !diagnostics.imagePreviewTooLargeObserved || !diagnostics.imagePreviewHiddenByDrag
            || !diagnostics.imagePreviewCacheHit || diagnostics.imagePreviewRequestCount !== 2
            || diagnostics.imagePreviewDwellMs < 180
            || diagnostics.imagePreviewNaturalWidth !== 320 || diagnostics.imagePreviewNaturalHeight !== 180
            || preview.hidden || preview.state !== 'image'
            || preview.imageWidth < 150 || preview.imageWidth > 240 || preview.imageHeight < 80 || preview.imageHeight > 220
            || preview.width > 258 || preview.height > 260
            || preview.left < 0 || preview.top < 0
            || preview.right > preview.viewportWidth || preview.bottom > preview.viewportHeight) {
            throw new Error('Image hover preview debounce, cache, drag hiding, dimensions or viewport clamping failed');
          }
          if (!diagnostics.cspLocked || !diagnostics.cspImageDataOnly
            || diagnostics.diskValue === '--' || diagnostics.diskUsed === '--'
            || diagnostics.diskAvailable === '--') {
            throw new Error('Disk instrument or strict renderer CSP is not ready');
          }
          if (forceOfflineTest) {
            if (diagnostics.networkState !== 'offline' || diagnostics.networkLan !== '—'
              || diagnostics.networkPublic !== '—' || diagnostics.networkPing !== '—') {
              throw new Error('Offline network degradation did not produce safe placeholders');
            }
          } else if (diagnostics.networkState !== 'online'
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(diagnostics.networkLan)
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(diagnostics.networkPublic)
            || !/^\d+ms$/.test(diagnostics.networkPing)) {
            throw new Error('LAN/public IPv4, state or ping monitoring is not ready');
          }
          if (diagnostics.batteryPresent === diagnostics.batteryHidden
            || (diagnostics.batteryPresent && !/^\d+%$/.test(diagnostics.batteryValue))) {
            throw new Error('Battery visibility does not match machine capabilities');
          }
          if (diagnostics.telemetryGeometry.width < 300 || diagnostics.telemetryGeometry.width > 340
            || diagnostics.telemetryGeometry.columnScrollHeight > diagnostics.telemetryGeometry.columnClientHeight + 2
            || diagnostics.telemetryGeometry.diskDetailsClearance < 6
            || diagnostics.filesPanelGeometry.hidden
            || diagnostics.filesPanelGeometry.fileListClientHeight < minimumVisualFileListHeight
            || diagnostics.terminalGeometry.width < minimumVisualTerminalWidthWithFilesPanel || diagnostics.terminalGeometry.height < 100) {
            throw new Error('Two-column layout has invalid geometry or scroll ownership');
          }
          const screenshotPath = path.join(
            os.tmpdir(),
            `edex-ui-bk-phase14-${visualTestWidth}x${visualTestHeight}${app.isPackaged ? '-packaged' : forceOfflineTest ? '-offline' : ''}.png`
          );
          fs.writeFileSync(screenshotPath, screenshot.toPNG());
          console.log(`Visual test screenshot: ${screenshotPath}`);

          // Crop of the WYGLĄD section alone: the theme controls document well
          // on their own, and no provider list means no offline error banner.
          const themeRect = await window.webContents.executeJavaScript(`(async () => {
            document.getElementById('settingsToggle').click();
            await new Promise((resolve) => setTimeout(resolve, 700));
            const section = document.querySelector('#settingsDialog .theme-section');
            if (!section) return null;
            const rect = section.getBoundingClientRect();
            return {
              x: Math.round(rect.left) - 12,
              y: Math.round(rect.top) - 12,
              width: Math.round(rect.width) + 24,
              height: Math.round(rect.height) + 24
            };
          })()`);
          if (themeRect) {
            const themeShotPath = path.join(os.tmpdir(), 'edex-ui-bk-theme-section.png');
            fs.writeFileSync(themeShotPath, (await window.webContents.capturePage(themeRect)).toPNG());
            console.log(`Theme section screenshot: ${themeShotPath}`);
          }
          process.exitCode = 0;
        } catch (error) {
          console.error(`Visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 17_500);
    });
}

module.exports = { setupFixtures, runVisualTest };
