/* 只把用户预览的文字交给模型，应用时从同一份快照替换。 */
window.bindResumeAssistant = function (api) {
  const el = id => document.getElementById(id);
  const dialog = el('aiDialog');
  const form = el('aiForm');
  const scope = el('aiScope');
  const provider = el('aiProvider');
  const source = el('aiSource');
  const result = el('aiResult');
  const status = el('aiStatus');
  let snapshot;
  let ranges;
  let pending;
  let modelRequest;
  const choices = el('aiModelChoices');
  const modelStatus = el('aiModelStatus');
  const modelButton = el('aiFetchModels');

  const fields = {
    provider: ['aiProvider'],
    deepseek: ['aiKey'],
    openai: ['aiOpenAIKey', 'aiBaseUrl', 'aiProxy', 'aiProtocol', 'aiOpenAIModel'],
    ollama: ['aiModel']
  };

  function saveSettings(group) {
    const settings = {};
    for (const id of fields[group]) settings[id] = el(id).value;
    if (group === 'openai' && choices.options.length > 2) {
      settings.models = Array.from(choices.options).slice(2).map(option => option.value);
      settings.manual = choices.selectedIndex === 1;
      settings.selected = choices.value;
    }
    const saved = api.writeSettings(group, settings);
    el('aiCacheNote').textContent = saved ? cacheNote : '浏览器存储不可用，本次设置仅在当前页面有效。';
  }

  const cacheNote = el('aiCacheNote').textContent;
  for (const [group, ids] of Object.entries(fields)) {
    const saved = api.readSettings(group);
    for (const id of ids) {
      const input = el(id);
      const value = saved?.[id];
      if (typeof value === 'string' && (input.tagName !== 'SELECT' ||
          Array.from(input.options).some(option => option.value === value))) input.value = value;
    }
    if (group === 'openai' && Array.isArray(saved?.models) && saved.models.length &&
        saved.models.every(id => typeof id === 'string' && id.length > 0)) {
      showModels(saved.models, saved.selected, saved.manual);
    }
  }

  function showModels(models, selected, manual) {
    choices.replaceChildren(new Option('请选择模型', ''), new Option('手动输入模型 ID', ''),
      ...models.map(id => new Option(id, id)));
    choices.options[0].disabled = true;
    choices.selectedIndex = manual ? 1 : models.includes(selected) ? models.indexOf(selected) + 2 : 0;
    el('aiModelChoicesRow').hidden = !models.length;
    el('aiManualModelRow').hidden = !!models.length && !manual;
  }

  function openAIConnection() {
    return {provider: 'openai', key: el('aiOpenAIKey').value.trim(),
      baseUrl: el('aiBaseUrl').value.trim(), httpProxy: el('aiProxy').value.trim()};
  }

  function selectedModel() {
    return el('aiManualModelRow').hidden ? choices.value : el('aiOpenAIModel').value.trim();
  }

  function clearModelList() {
    modelRequest?.abort();
    modelRequest = null;
    choices.replaceChildren();
    el('aiModelChoicesRow').hidden = true;
    el('aiManualModelRow').hidden = false;
    modelButton.disabled = false;
    modelStatus.textContent = '';
  }

  modelButton.addEventListener('click', async () => {
    const connection = openAIConnection();
    if (!connection.key) { modelStatus.textContent = '请先填写 OpenAI API Key。'; return; }
    const request = new AbortController();
    modelRequest = request;
    modelButton.disabled = true;
    modelStatus.textContent = '正在获取模型…';
    try {
      const response = await fetch('/api/models', {
        method: 'POST', signal: request.signal, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(connection)
      });
      const data = await response.json().catch(() => ({}));
      if (modelRequest !== request) return;
      if (!response.ok || !Array.isArray(data.models)) throw new Error(data.error || '获取失败，请确认本地服务已更新并重启。');
      const previous = selectedModel();
      showModels(data.models, previous, false);
      saveSettings('openai');
      if (selectedModel() !== previous) resetSuggestion();
      modelStatus.textContent = data.models.length ? '已获取 ' + data.models.length + ' 个模型' : '未返回模型，可手动填写模型 ID。';
    } catch (err) {
      if (modelRequest === request) modelStatus.textContent = err.message;
    } finally {
      if (modelRequest === request) { modelRequest = null; modelButton.disabled = false; }
    }
  });
  choices.addEventListener('change', () => {
    el('aiManualModelRow').hidden = choices.selectedIndex !== 1;
    if (choices.value) el('aiOpenAIModel').value = choices.value;
    saveSettings('openai');
    resetSuggestion();
  });
  for (const id of ['aiOpenAIKey', 'aiBaseUrl', 'aiProxy']) el(id).addEventListener('input', clearModelList);
  el('aiProtocol').addEventListener('change', resetSuggestion);

  function collectRanges(text, selection) {
    const parsed = window.ResumeForm.walk(text);
    const starts = [0];
    const normalizedStarts = [0];
    for (const match of text.matchAll(/\r\n|[\n\r]/g)) {
      const prev = starts.length - 1;
      normalizedStarts.push(normalizedStarts[prev] + match.index - starts[prev] + 1);
      starts.push(match.index + match[0].length);
    }
    function originalOffset(pos) {
      let line = normalizedStarts.findIndex(start => start > pos);
      line = (line === -1 ? starts.length : line) - 1;
      return starts[line] + pos - normalizedStarts[line];
    }
    const options = [];
    function add(label, start, end) {
      const raw = text.slice(start, end);
      if (!raw.trim() || /data:image\//i.test(raw)) return;
      options.push({label, start: start + raw.length - raw.trimStart().length, end: start + raw.trimEnd().length});
    }
    if (selection && selection[0] >= parsed.prefix.length && selection[1] > selection[0]) {
      add('Markdown 选区', originalOffset(selection[0]), originalOffset(selection[1]));
    }
    for (const section of parsed.sections) {
      const start = starts[parsed.prefixLines + section.start + 1] ?? text.length;
      const end = starts[parsed.prefixLines + section.end] ?? text.length;
      add(section.title, start, end);
    }
    return options;
  }

  function resetSuggestion() {
    pending?.abort();
    pending = null;
    result.value = '';
    el('aiResultRow').hidden = true;
    el('aiApply').hidden = true;
    el('aiGenerate').textContent = '生成建议';
    el('aiGenerate').disabled = !ranges?.length;
    status.textContent = ranges?.length ? '' : '请先添加有正文的章节，或在 Markdown 中选中要修改的文字。';
  }

  function showScope() {
    resetSuggestion();
    const range = ranges[scope.selectedIndex];
    source.value = range ? snapshot.markdown.slice(range.start, range.end) : '';
  }

  el('btnAssistant').addEventListener('click', () => {
    if (location.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(location.hostname)) {
      el('aiForm').hidden = true;
      el('aiLocalHelp').hidden = false;
      dialog.showModal();
      return;
    }
    snapshot = api.getDocument();
    ranges = collectRanges(snapshot.markdown, api.getSelection());
    scope.replaceChildren(...ranges.map((r, i) => new Option(r.label, String(i))));
    showScope();
    dialog.showModal();
  });
  scope.addEventListener('change', showScope);
  function syncProvider() {
    modelRequest?.abort();
    modelRequest = null;
    modelButton.disabled = false;
    modelStatus.textContent = '';
    const openai = provider.value === 'openai';
    el('aiOpenAI').hidden = !openai;
    el('aiOpenAI').disabled = !openai;
    el('aiKeyRow').hidden = provider.value !== 'deepseek';
    el('aiModelRow').hidden = provider.value !== 'ollama';
    resetSuggestion();
  }
  syncProvider();
  provider.addEventListener('change', syncProvider);
  // Register after the model-list invalidation listeners so changed credentials
  // and their model list are always stored as one consistent configuration.
  for (const [group, ids] of Object.entries(fields)) {
    for (const id of ids) {
      const field = el(id);
      field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => saveSettings(group));
    }
  }
  form.addEventListener('input', e => {
    if (e.target !== result && e.target.tagName !== 'SELECT') resetSuggestion();
  });
  el('aiClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    modelRequest?.abort();
    modelRequest = null;
    modelButton.disabled = false;
    modelStatus.textContent = '';
    resetSuggestion();
  });
  dialog.addEventListener('keydown', e => e.stopPropagation());

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (pending || !ranges.length) return;
    resetSuggestion();
    const instruction = el('aiInstruction').value.trim();
    const openai = provider.value === 'openai';
    const local = provider.value === 'ollama';
    const key = el(openai ? 'aiOpenAIKey' : 'aiKey').value.trim();
    const model = openai ? selectedModel() : el('aiModel').value.trim();
    if (!instruction || (!local && !key) || ((openai || local) && !model)) {
      status.textContent = '请填写修改要求及所选服务的连接信息。';
      return;
    }
    const request = new AbortController();
    pending = request;
    el('aiGenerate').disabled = true;
    status.textContent = '正在生成修改建议…';
    try {
      const response = await fetch('/api/rewrite', {
        method: 'POST', signal: request.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({provider: provider.value, text: source.value, instruction,
          ...(local ? {model} : {key}),
          ...(openai ? {...openAIConnection(), model, protocol: el('aiProtocol').value} : {})})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.suggestion) throw new Error(data.error || '请确认已使用项目自带的本地服务。');
      if (pending !== request) return;
      result.value = data.suggestion;
      el('aiResultRow').hidden = false;
      el('aiApply').hidden = false;
      el('aiGenerate').textContent = '重新生成';
      status.textContent = '请核对经历和数字，确认后应用。';
      result.focus();
    } catch (err) {
      if (pending === request) status.textContent = err instanceof TypeError ? '连接本地服务失败，请检查服务后重试。' : err.message;
    } finally {
      if (pending === request) {
        pending = null;
        el('aiGenerate').disabled = false;
      }
    }
  });

  el('aiApply').addEventListener('click', () => {
    const current = api.getDocument();
    if (current.name !== snapshot.name || current.markdown !== snapshot.markdown) {
      resetSuggestion();
      el('aiGenerate').disabled = true;
      status.textContent = '原文已更新，请关闭并重新打开助手。';
      return;
    }
    const replacement = result.value.trim();
    if (!replacement) { status.textContent = '请先填写修改建议。'; return; }
    const range = ranges[scope.selectedIndex];
    const old = current.markdown.slice(range.start, range.end);
    const updated = old.includes('\r\n') ? replacement.replace(/\n/g, '\r\n') : replacement;
    api.apply(current.markdown.slice(0, range.start) + updated + current.markdown.slice(range.end), true);
    dialog.close();
    api.notice('已应用修改，可点击「撤销」恢复。');
  });
};
