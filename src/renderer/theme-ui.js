'use strict';

// Controls for the WYGLĄD section of the SETTINGS dialog. Every change applies
// immediately and is persisted, so the dialog acts as its own live preview.

(() => {
  const themeApi = window.themeApi;
  if (!themeApi) return;

  const elements = Object.fromEntries([
    'themeAccents', 'themeTerminalColors', 'themeFont', 'themeFontSize',
    'themePreview', 'themePreviewText', 'themeNote', 'themeReset'
  ].map((id) => [id, document.getElementById(id)]));

  if (!elements.themeAccents) return;

  const PREVIEW_LINES = [
    'bartek at MacBook-Pro in ~/Projekty',
    '$ npm run test:files',
    'File manager test passed: 12/12 OK',
    '0O1lI {}[]()<> ąćęłńóśżź'
  ].join('\n');

  function swatchButton({ id, label, color, group }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-swatch';
    button.dataset.themeValue = id;
    button.dataset.themeGroup = group;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.title = label;
    button.setAttribute('aria-label', label);
    const dot = document.createElement('span');
    dot.className = 'theme-swatch__dot';
    dot.style.background = color;
    button.append(dot);
    return button;
  }

  for (const accent of themeApi.accents) {
    elements.themeAccents.append(swatchButton({
      id: accent.id, label: accent.label, color: accent.swatch, group: 'accent'
    }));
  }

  for (const color of themeApi.terminalColors) {
    elements.themeTerminalColors.append(swatchButton({
      id: color.id, label: color.label, color: color.foreground, group: 'terminalColor'
    }));
  }

  for (const font of themeApi.terminalFonts) {
    elements.themeFont.add(new Option(font.label, font.id));
  }

  for (const size of themeApi.fontSizes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-size';
    button.dataset.themeValue = String(size);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.textContent = String(size);
    elements.themeFontSize.append(button);
  }

  function syncControls() {
    const theme = themeApi.get();
    const appearance = themeApi.appearance();

    for (const button of elements.themeAccents.querySelectorAll('.theme-swatch')) {
      button.setAttribute('aria-checked', String(button.dataset.themeValue === theme.accent));
    }
    for (const button of elements.themeTerminalColors.querySelectorAll('.theme-swatch')) {
      button.setAttribute('aria-checked', String(button.dataset.themeValue === theme.terminalColor));
    }
    for (const button of elements.themeFontSize.querySelectorAll('.theme-size')) {
      button.setAttribute('aria-checked', String(Number(button.dataset.themeValue) === theme.terminalFontSize));
    }
    elements.themeFont.value = theme.terminalFont;

    elements.themePreviewText.textContent = PREVIEW_LINES;
    elements.themePreviewText.style.color = appearance.foreground;
    elements.themePreviewText.style.fontFamily = appearance.fontFamily;
    elements.themePreviewText.style.fontSize = `${appearance.fontSize}px`;

    const font = themeApi.terminalFonts.find((item) => item.id === theme.terminalFont);
    elements.themeNote.textContent = font ? font.note : '';
  }

  function handleGroupClick(container, key, cast = (value) => value) {
    container.addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-value]');
      if (!button) return;
      themeApi.set({ [key]: cast(button.dataset.themeValue) });
      syncControls();
    });
  }

  handleGroupClick(elements.themeAccents, 'accent');
  handleGroupClick(elements.themeTerminalColors, 'terminalColor');
  handleGroupClick(elements.themeFontSize, 'terminalFontSize', Number);

  elements.themeFont.addEventListener('change', () => {
    themeApi.set({ terminalFont: elements.themeFont.value });
    syncControls();
  });

  elements.themeReset.addEventListener('click', () => {
    themeApi.reset();
    syncControls();
  });

  // Keep the controls truthful when the theme is changed from anywhere else.
  themeApi.onChange(() => syncControls());

  syncControls();
})();
