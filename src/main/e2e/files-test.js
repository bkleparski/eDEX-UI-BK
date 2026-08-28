'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function setupFixtures(context) {
  const { filesTestRoot } = context;
  fs.rmSync(filesTestRoot, { recursive: true, force: true });
  fs.mkdirSync(filesTestRoot, { recursive: true });
  fs.writeFileSync(path.join(filesTestRoot, 'alpha.txt'), 'alpha fixture\n');
  fs.writeFileSync(path.join(filesTestRoot, 'beta.txt'), 'beta fixture\n');
  fs.writeFileSync(path.join(filesTestRoot, 'gamma.log'), 'gamma fixture\n');
  fs.mkdirSync(path.join(filesTestRoot, 'nested'), { recursive: true });
}

function runFilesTest(window, context) {
  const { filesTestRoot } = context;

    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const report = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            const root = ${JSON.stringify(filesTestRoot)};
            const rows = () => [...document.querySelectorAll('#fileList .file-row')];
            const rowFor = (name) => rows().find((row) => row.dataset.name === name);
            const click = (row, init = {}) => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
            const evidence = {};
            const step = async () => {
              document.getElementById('filesGroupToggle').click();
              await new Promise((r) => setTimeout(r, 400));
              window.__edexBrowse(root);
              await new Promise((r) => setTimeout(r, 700));
              if (!rowFor('alpha.txt')) throw new Error('fixture not listed');

              // 1. single click selects instead of navigating
              click(rowFor('alpha.txt'));
              evidence.singleSelect = document.body.dataset.fileSelectionCount === '1';
              evidence.stillInRoot = document.getElementById('fileBrowserCwd').title === root;

              // 2. cmd+click extends the selection
              click(rowFor('beta.txt'), { metaKey: true });
              evidence.metaSelect = document.body.dataset.fileSelectionCount === '2';

              // 3. context menu opens for the selection
              rowFor('beta.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
              evidence.menuOpen = document.body.dataset.fileContextMenuOpen === 'true';
              evidence.menuHidesRename = document.querySelector('#fileContextMenu [data-file-action="rename"]').hidden;
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
              evidence.menuClosed = document.body.dataset.fileContextMenuOpen === 'false';

              // 4. rename through the popover
              click(rowFor('alpha.txt'));
              rowFor('alpha.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
              document.querySelector('#fileContextMenu [data-file-action="rename"]').click();
              const input = document.getElementById('fileRenameInput');
              input.value = 'renamed.txt';
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 900));
              evidence.renamed = Boolean(rowFor('renamed.txt')) && !rowFor('alpha.txt');

              // 5. new folder
              window.__edexNewFolder('created-dir');
              await new Promise((r) => setTimeout(r, 900));
              evidence.folderCreated = Boolean(rowFor('created-dir'));

              // 6. sorting toggles direction
              document.querySelector('.file-sort-btn[data-sort-key="name"]').click();
              document.querySelector('.file-sort-btn[data-sort-key="name"]').click();
              evidence.sortActive = document.querySelector('.file-sort-btn[data-sort-key="name"]').classList.contains('is-active');

              // 7. filter narrows the listing
              document.getElementById('fileFilterToggle').click();
              const filter = document.getElementById('fileFilterInput');
              filter.value = 'beta';
              filter.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 200));
              evidence.filtered = rows().length === 1 && Boolean(rowFor('beta.txt'));
              filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 200));
              evidence.filterCleared = rows().length > 1;

              // 8. trash removes the selection
              click(rowFor('beta.txt'));
              await window.filesApi.trash([root + '/beta.txt']);
              window.__edexBrowse(root);
              await new Promise((r) => setTimeout(r, 900));
              evidence.trashed = !rowFor('beta.txt');

              // 9. motyw: akcent przemalowuje tokeny HUD, kroj/rozmiar ida do xterm
              const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
              window.themeApi.set({ accent: 'amber', terminalColor: 'mint', terminalFont: 'jetbrains', terminalFontSize: 14 });
              await new Promise((r) => setTimeout(r, 250));
              evidence.accentToken = cssVar('--cyan-rgb') === '255 176 60';
              evidence.accentOnBody = document.body.dataset.themeAccent === 'amber';
              const opts = window.__edexTerminalOptions();
              evidence.xtermFont = String(opts.fontFamily).includes('JetBrains Mono');
              evidence.xtermSize = opts.fontSize === 14;
              evidence.xtermColor = String(opts.foreground).toLowerCase() === '#9fe8c4';
              evidence.themePersisted = JSON.parse(localStorage.getItem('edex-ui-bk.theme.v1')).accent === 'amber';
              window.themeApi.reset();
              await new Promise((r) => setTimeout(r, 200));
              evidence.themeReset = cssVar('--cyan-rgb') === '0 229 255';

              if (Date.now() - started > 25_000) throw new Error('files test timed out');
              resolve(evidence);
            };
            step().catch(reject);
          })`);
          console.log(`File manager diagnostics: ${JSON.stringify(report)}`);
          const failures = Object.entries(report).filter(([, value]) => value !== true).map(([key]) => key);
          if (failures.length) throw new Error(`failed checks: ${failures.join(', ')}`);
          console.log('File manager test passed: selection, context menu, rename, mkdir, sort, filter and trash all work.');
          process.exitCode = 0;
        } catch (error) {
          console.error(`File manager test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 3_500);
    });
}

module.exports = { setupFixtures, runFilesTest };
