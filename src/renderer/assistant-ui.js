'use strict';

(() => {
  if (!window.assistantApi || !window.settingsApi) return;

  const assistantTestMode = new URLSearchParams(window.location.search).get('test') === 'assistant';
  const PROVIDERS = ['ollama', 'lmstudio', 'openrouter', 'opencode-go'];
  const CLOUD_PROVIDERS = new Set(['openrouter', 'opencode-go']);
  const ASSISTANT_WIDTH_KEY = 'edex.assistant.width.v1';
  const ASSISTANT_DEFAULT_WIDTH = 390;
  const ASSISTANT_MIN_WIDTH = 300;
  const TERMINAL_MIN_WIDTH = 430;
  if (assistantTestMode) {
    try {
      if (window.sessionStorage.getItem('edex.assistant.width-test-reset') !== '1') {
        window.localStorage.removeItem(ASSISTANT_WIDTH_KEY);
        window.sessionStorage.setItem('edex.assistant.width-test-reset', '1');
      }
    } catch {
      // The visual test will report unavailable storage through its assertions.
    }
  }
  const providerLabels = {
    ollama: 'OLLAMA',
    lmstudio: 'LM STUDIO',
    openrouter: 'OPENROUTER',
    'opencode-go': 'OPENCODE GO'
  };
  const elements = Object.fromEntries([
    'assistantToggle', 'settingsToggle', 'assistantPanel', 'assistantClose', 'hudProvider', 'hudModel',
    'newConversation', 'assistantStatus', 'assistantMessages', 'assistantEmpty', 'assistantForm',
    'assistantPrompt', 'assistantSearchMode', 'assistantCancel', 'assistantSubmit', 'settingsDialog',
    'settingsClose', 'settingsSave', 'settingsStatus', 'localProvider', 'localModel', 'braveApiKey',
    'openRouterApiKey', 'openCodeGoApiKey', 'openRouterModel', 'openCodeGoModel', 'braveState',
    'openRouterState', 'openCodeGoState', 'assistantResizer'
  ].map((id) => [id, document.getElementById(id)]));

  const state = {
    config: null,
    models: new Map(),
    conversationId: newId('thread'),
    activeRequestId: null,
    assistantMessage: null,
    sourceList: null,
    settingsReturnFocus: null
  };

  const assistantResizer = createPanelResizer({
    storageKey: ASSISTANT_WIDTH_KEY,
    defaultWidth: ASSISTANT_DEFAULT_WIDTH,
    minWidth: ASSISTANT_MIN_WIDTH,
    terminalMinWidth: TERMINAL_MIN_WIDTH,
    cssVariable: '--assistant-panel-width',
    resizingBodyClass: 'assistant-resizing',
    datasetWidthKey: 'assistantPanelWidth',
    panel: elements.assistantPanel,
    resizer: elements.assistantResizer,
    workspace: document.querySelector('.workspace')
  });

  function newId(prefix) {
    const suffix = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${suffix}`;
  }

  function setStatus(element, text, status = 'ready') {
    element.textContent = text;
    element.dataset.state = status;
  }

  function errorText(error) {
    const message = typeof error?.message === 'string' ? error.message : 'REQUEST FAILED';
    return message.replace(/^Error invoking remote method '[^']+':\s*/i, '').slice(0, 240);
  }

  function credentialAvailable(provider) {
    if (!state.config) return false;
    if (provider === 'openrouter') return state.config.credentials.openRouterConfigured;
    if (provider === 'opencode-go') return state.config.credentials.openCodeGoConfigured;
    return true;
  }

  function setCredentialState(element, configured) {
    element.textContent = configured ? 'CONFIGURED / VALUE HIDDEN' : 'NOT CONFIGURED';
    element.classList.toggle('is-configured', configured);
  }

  function fillSelect(select, models, selectedId, emptyLabel = 'NO MODELS DETECTED') {
    select.replaceChildren();
    const available = models.filter((model) => model.available !== false);
    if (available.length === 0) {
      const option = new Option(emptyLabel, '');
      option.disabled = true;
      option.selected = true;
      select.add(option);
      select.disabled = true;
      return '';
    }
    select.disabled = false;
    for (const model of models) {
      const protocol = model.protocol ? ` / ${String(model.protocol).toUpperCase()}` : '';
      const option = new Option(`${model.label}${protocol}`, model.id);
      option.disabled = model.available === false;
      select.add(option);
    }
    const wanted = models.some((model) => model.id === selectedId && model.available !== false)
      ? selectedId
      : available[0].id;
    select.value = wanted;
    return wanted;
  }

  async function loadModels(provider, { select, selectedId, status = elements.settingsStatus } = {}) {
    if (!credentialAvailable(provider)) {
      fillSelect(select, [], '', 'API KEY REQUIRED');
      return [];
    }
    select.disabled = true;
    setStatus(status, `SCANNING ${providerLabels[provider]}`);
    try {
      const models = await window.assistantApi.listModels(provider);
      state.models.set(provider, models);
      fillSelect(select, models, selectedId);
      setStatus(status, `${models.filter((model) => model.available !== false).length} MODELS READY`);
      return models;
    } catch (error) {
      state.models.delete(provider);
      fillSelect(select, [], '', 'PROVIDER OFFLINE');
      setStatus(status, errorText(error), 'error');
      return [];
    }
  }

  function activeLocalModelSelect() {
    return state.config?.selection.models[elements.localProvider.value] || '';
  }

  async function refreshLocalModels() {
    const provider = elements.localProvider.value;
    return loadModels(provider, { select: elements.localModel, selectedId: activeLocalModelSelect() });
  }

  async function refreshHudModels({ persistFallback = true } = {}) {
    const provider = elements.hudProvider.value;
    const selected = state.config?.selection.models[provider] || '';
    const models = await loadModels(provider, {
      select: elements.hudModel,
      selectedId: selected,
      status: elements.assistantStatus
    });
    if (models.length && persistFallback && elements.hudModel.value !== selected) {
      state.config = await window.settingsApi.update({ selection: { models: { [provider]: elements.hudModel.value } } });
    }
  }

  function resetConversation({ clear = true } = {}) {
    if (state.activeRequestId) window.assistantApi.cancel(state.activeRequestId);
    window.assistantApi.reset(state.conversationId);
    state.conversationId = newId('thread');
    state.activeRequestId = null;
    state.assistantMessage = null;
    state.sourceList = null;
    if (clear) {
      elements.assistantMessages.replaceChildren(elements.assistantEmpty);
      elements.assistantEmpty.hidden = false;
    }
    setBusy(false);
    setStatus(elements.assistantStatus, 'NEW THREAD READY');
  }

  function openAssistant() {
    assistantResizer.applyPreferredWidth();
    elements.assistantPanel.hidden = false;
    elements.assistantToggle.setAttribute('aria-expanded', 'true');
    document.body.dataset.assistantPanelOpen = 'true';
    document.body.dataset.assistantToggleCount = String((Number(document.body.dataset.assistantToggleCount) || 0) + 1);
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      elements.assistantPrompt.focus();
    });
  }

  function closeAssistant() {
    elements.assistantPanel.hidden = true;
    elements.assistantToggle.setAttribute('aria-expanded', 'false');
    document.body.dataset.assistantPanelOpen = 'false';
    document.body.dataset.assistantToggleCount = String((Number(document.body.dataset.assistantToggleCount) || 0) + 1);
    window.dispatchEvent(new Event('resize'));
  }

  function openSettings() {
    state.settingsReturnFocus = document.activeElement;
    elements.settingsDialog.hidden = false;
    elements.settingsDialog.setAttribute('aria-hidden', 'false');
    elements.settingsToggle.setAttribute('aria-expanded', 'true');
    elements.localProvider.focus();
  }

  function closeSettings() {
    elements.settingsDialog.hidden = true;
    elements.settingsDialog.setAttribute('aria-hidden', 'true');
    elements.settingsToggle.setAttribute('aria-expanded', 'false');
    state.settingsReturnFocus?.focus?.();
  }

  async function loadSettings() {
    try {
      state.config = await window.settingsApi.get();
      elements.localProvider.value = state.config.selection.localProvider;
      elements.hudProvider.value = state.config.selection.hudProvider;
      setCredentialState(elements.braveState, state.config.credentials.braveConfigured);
      setCredentialState(elements.openRouterState, state.config.credentials.openRouterConfigured);
      setCredentialState(elements.openCodeGoState, state.config.credentials.openCodeGoConfigured);
      await Promise.all([
        refreshLocalModels(),
        state.config.credentials.openRouterConfigured
          ? loadModels('openrouter', { select: elements.openRouterModel, selectedId: state.config.selection.models.openrouter })
          : Promise.resolve(fillSelect(elements.openRouterModel, [], '', 'API KEY REQUIRED')),
        state.config.credentials.openCodeGoConfigured
          ? loadModels('opencode-go', { select: elements.openCodeGoModel, selectedId: state.config.selection.models['opencode-go'] })
          : Promise.resolve(fillSelect(elements.openCodeGoModel, [], '', 'API KEY REQUIRED')),
        refreshHudModels({ persistFallback: false })
      ]);
      setStatus(elements.settingsStatus, 'CONFIG LOADED');
    } catch (error) {
      setStatus(elements.settingsStatus, errorText(error), 'error');
      setStatus(elements.assistantStatus, 'CONFIG UNAVAILABLE', 'error');
    }
  }

  function secretPatch() {
    const secrets = {};
    if (elements.braveApiKey.value) secrets.braveApiKey = elements.braveApiKey.value;
    if (elements.openRouterApiKey.value) secrets.openRouterApiKey = elements.openRouterApiKey.value;
    if (elements.openCodeGoApiKey.value) secrets.openCodeGoApiKey = elements.openCodeGoApiKey.value;
    return secrets;
  }

  async function saveSettings() {
    elements.settingsSave.disabled = true;
    setStatus(elements.settingsStatus, 'WRITING CONFIG');
    try {
      const models = { ...state.config.selection.models };
      if (elements.localModel.value) models[elements.localProvider.value] = elements.localModel.value;
      if (elements.openRouterModel.value) models.openrouter = elements.openRouterModel.value;
      if (elements.openCodeGoModel.value) models['opencode-go'] = elements.openCodeGoModel.value;
      const secrets = secretPatch();
      state.config = await window.settingsApi.update({
        selection: { localProvider: elements.localProvider.value, models },
        ...(Object.keys(secrets).length ? { secrets } : {})
      });
      elements.braveApiKey.value = '';
      elements.openRouterApiKey.value = '';
      elements.openCodeGoApiKey.value = '';
      setCredentialState(elements.braveState, state.config.credentials.braveConfigured);
      setCredentialState(elements.openRouterState, state.config.credentials.openRouterConfigured);
      setCredentialState(elements.openCodeGoState, state.config.credentials.openCodeGoConfigured);
      setStatus(elements.settingsStatus, 'CONFIG SAVED');
      await refreshHudModels();
    } catch (error) {
      setStatus(elements.settingsStatus, errorText(error), 'error');
    } finally {
      elements.settingsSave.disabled = false;
    }
  }

  async function persistTypedCredential(provider) {
    const input = provider === 'openrouter' ? elements.openRouterApiKey : elements.openCodeGoApiKey;
    if (!input.value) return;
    const key = provider === 'openrouter' ? 'openRouterApiKey' : 'openCodeGoApiKey';
    state.config = await window.settingsApi.update({ secrets: { [key]: input.value } });
    input.value = '';
    setCredentialState(provider === 'openrouter' ? elements.openRouterState : elements.openCodeGoState, true);
  }

  async function refreshSettingsProvider(provider) {
    try {
      if (CLOUD_PROVIDERS.has(provider)) await persistTypedCredential(provider);
      if (provider === 'local') {
        await refreshLocalModels();
      } else {
        const select = provider === 'openrouter' ? elements.openRouterModel : elements.openCodeGoModel;
        await loadModels(provider, { select, selectedId: state.config.selection.models[provider] });
      }
    } catch (error) {
      setStatus(elements.settingsStatus, errorText(error), 'error');
    }
  }

  async function testProvider(provider) {
    setStatus(elements.settingsStatus, `TESTING ${providerLabels[provider]}`);
    try {
      await persistTypedCredential(provider);
      const result = await window.assistantApi.testProvider(provider);
      const message = result.catalogOnly
        ? `CATALOG READY / ${result.modelCount} MODELS / KEY NOT BILLING VALIDATED`
        : `LINK VERIFIED / ${result.modelCount ?? 'KEY'} READY`;
      setStatus(elements.settingsStatus, message);
    } catch (error) {
      setStatus(elements.settingsStatus, errorText(error), 'error');
    }
  }

  function addMessage(role, content = '') {
    elements.assistantEmpty.hidden = true;
    if (elements.assistantEmpty.parentElement) elements.assistantEmpty.remove();
    const item = document.createElement('li');
    item.className = 'chat-message';
    item.dataset.role = role;
    const meta = document.createElement('div');
    meta.className = 'chat-message__meta';
    const label = document.createElement('span');
    label.textContent = role === 'user' ? 'OPERATOR' : providerLabels[elements.hudProvider.value];
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    meta.append(label, time);
    const body = document.createElement('p');
    body.className = 'chat-message__body';
    body.textContent = content;
    item.append(meta, body);
    elements.assistantMessages.append(item);
    elements.assistantMessages.scrollTop = elements.assistantMessages.scrollHeight;
    return { item, body };
  }

  function renderSources(sources) {
    if (!state.assistantMessage || !Array.isArray(sources)) return;
    if (!state.sourceList) {
      state.sourceList = document.createElement('div');
      state.sourceList.className = 'chat-sources';
      state.assistantMessage.item.append(state.sourceList);
    }
    const known = new Set([...state.sourceList.children].map((button) => button.dataset.url));
    for (const source of sources) {
      if (!source?.url || known.has(source.url)) continue;
      known.add(source.url);
      const button = document.createElement('button');
      button.className = 'chat-source';
      button.type = 'button';
      button.dataset.url = source.url;
      button.textContent = `SOURCE / ${source.title || source.url}`;
      button.title = source.url;
      button.addEventListener('click', () => window.assistantApi.openSource(source.url).catch(() => {}));
      state.sourceList.append(button);
    }
  }

  function setBusy(busy) {
    elements.assistantSubmit.disabled = busy;
    elements.assistantPrompt.disabled = busy;
    elements.hudProvider.disabled = busy;
    elements.hudModel.disabled = busy;
    elements.assistantCancel.hidden = !busy;
  }

  async function submitPrompt(event) {
    event.preventDefault();
    const prompt = elements.assistantPrompt.value.trim();
    if (!prompt || state.activeRequestId || !elements.hudModel.value) return;
    const requestId = newId('hud');
    state.activeRequestId = requestId;
    state.sourceList = null;
    addMessage('user', prompt);
    state.assistantMessage = addMessage('assistant', '');
    elements.assistantPrompt.value = '';
    setBusy(true);
    setStatus(elements.assistantStatus, 'INFERENCE ACTIVE');
    try {
      await window.assistantApi.start({
        requestId,
        conversationId: state.conversationId,
        prompt,
        mode: elements.assistantSearchMode.checked ? 'search' : 'chat'
      });
    } catch (error) {
      if (state.activeRequestId === requestId && !state.assistantMessage.body.textContent) {
        state.assistantMessage.body.textContent = errorText(error);
      }
    } finally {
      if (state.activeRequestId === requestId) {
        state.activeRequestId = null;
        setBusy(false);
      }
    }
  }

  function handleAssistantEvent(event) {
    if (!event || event.requestId !== state.activeRequestId || !state.assistantMessage) return;
    if (event.type === 'text-delta') {
      state.assistantMessage.body.textContent += event.text || '';
      elements.assistantMessages.scrollTop = elements.assistantMessages.scrollHeight;
    } else if (event.type === 'tool-start') {
      setStatus(elements.assistantStatus, `SEARCH / ${event.query || 'WEB'}`);
    } else if (event.type === 'sources') {
      renderSources(event.sources);
    } else if (event.type === 'done') {
      if (!state.assistantMessage.body.textContent && event.content) state.assistantMessage.body.textContent = event.content;
      renderSources(event.sources);
      setStatus(elements.assistantStatus, 'RESPONSE COMPLETE');
    } else if (event.type === 'error') {
      if (!state.assistantMessage.body.textContent) state.assistantMessage.body.textContent = event.message || 'REQUEST FAILED';
      setStatus(elements.assistantStatus, event.code || 'REQUEST FAILED', 'error');
    }
  }

  elements.assistantToggle.addEventListener('click', () => {
    if (elements.assistantPanel.hidden) openAssistant(); else closeAssistant();
  });
  elements.assistantClose.addEventListener('click', closeAssistant);
  elements.settingsToggle.addEventListener('click', openSettings);
  elements.settingsClose.addEventListener('click', closeSettings);
  elements.settingsDialog.addEventListener('click', (event) => {
    if (event.target === elements.settingsDialog) closeSettings();
  });
  elements.localProvider.addEventListener('change', refreshLocalModels);
  elements.settingsSave.addEventListener('click', saveSettings);
  elements.newConversation.addEventListener('click', () => resetConversation());
  elements.assistantForm.addEventListener('submit', submitPrompt);
  elements.assistantCancel.addEventListener('click', () => {
    if (state.activeRequestId) window.assistantApi.cancel(state.activeRequestId);
    setStatus(elements.assistantStatus, 'CANCELLING');
  });
  elements.hudProvider.addEventListener('change', async () => {
    resetConversation();
    state.config = await window.settingsApi.update({ selection: { hudProvider: elements.hudProvider.value } });
    await refreshHudModels();
  });
  elements.hudModel.addEventListener('change', async () => {
    resetConversation();
    const provider = elements.hudProvider.value;
    state.config = await window.settingsApi.update({ selection: { models: { [provider]: elements.hudModel.value } } });
  });
  for (const button of document.querySelectorAll('[data-refresh-provider]')) {
    button.addEventListener('click', () => refreshSettingsProvider(button.dataset.refreshProvider));
  }
  for (const button of document.querySelectorAll('[data-test-provider]')) {
    button.addEventListener('click', () => testProvider(button.dataset.testProvider));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.settingsDialog.hidden) {
      event.preventDefault();
      closeSettings();
    }
  });

  window.assistantApi.onEvent(handleAssistantEvent);
  assistantResizer.initialize();
  loadSettings();
})();
