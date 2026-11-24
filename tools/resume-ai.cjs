'use strict';

const prompt = '你是简历编辑。按用户要求改写所提供的简历片段。保留其语言、Markdown 结构和真实事实。不得编造经历、技术、数字或成果。仅输出替换原文的内容，不要附解释或包裹代码块。';

function parseHttpUrl(value, proxy) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) return null;
    if (proxy ? url.pathname !== '/' : url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

module.exports = async function handleAssistant(req, res, port, sendJson, pathname = '/api/rewrite') {
  const listModels = pathname === '/api/models';
  const origin = 'http://' + req.headers.host;
  if (!['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(origin) || req.headers.origin !== origin) {
    return sendJson(res, 403, {error: '请从本地编辑器生成建议。'});
  }
  if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return sendJson(res, 400, {error: '请通过编辑器提交修改要求。'});
  }
  let payload;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200000) return sendJson(res, 413, {error: '文字过长，请缩小改写范围。'});
      chunks.push(chunk);
    }
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return sendJson(res, 400, {error: '请求格式有误。'});
  }
  const {provider, text, instruction, key, model} = payload || {};
  const valid = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
  if (!listModels && (!valid(text, 32000) || !valid(instruction, 2000))) {
    return sendJson(res, 400, {error: '请提交 1 至 32000 字的原文，以及 1 至 2000 字的修改要求。'});
  }
  const local = provider === 'ollama';
  const openai = provider === 'openai';
  if ((listModels && !openai) || !['ollama', 'deepseek', 'openai'].includes(provider) ||
      (!local && !valid(key, 512)) || (!listModels && (local || openai) && !valid(model, 128))) {
    return sendJson(res, 400, {error: '请检查服务商、模型名称和 API Key。'});
  }

  let endpoint = local ? 'http://127.0.0.1:11434/v1/chat/completions' : 'https://api.deepseek.com/chat/completions';
  const protocol = openai ? payload.protocol ?? 'responses' : 'chat-completions';
  const responses = protocol === 'responses';
  let proxy;
  if (openai) {
    const base = parseHttpUrl(payload.baseUrl || 'https://api.openai.com/v1', false);
    if (!base || !['responses', 'chat-completions'].includes(protocol)) {
      return sendJson(res, 400, {error: '请检查 OpenAI API 地址和协议。'});
    }
    const suffix = responses ? '/responses' : '/chat/completions';
    base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/(responses|chat\/completions|models)$/, '') +
      (listModels ? '/models' : suffix);
    endpoint = base.href;
    if (payload.httpProxy) {
      proxy = parseHttpUrl(payload.httpProxy, true);
      if (!proxy) return sendJson(res, 400, {error: '请输入有效的 HTTP 或 HTTPS 代理地址。'});
    }
  }

  const input = JSON.stringify({修改要求: instruction, 简历原文: text});
  const body = responses ? {model, instructions: prompt, input, store: false} : {
    model: provider === 'deepseek' ? 'deepseek-flash' : model, stream: false,
    messages: [{role: 'system', content: prompt}, {role: 'user', content: input}]
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  res.once('close', () => controller.abort());
  let dispatcher;
  try {
    if (proxy) {
      const {ProxyAgent} = require('undici');
      dispatcher = new ProxyAgent(proxy.href);
    }
    const response = await fetch(endpoint, {
      method: listModels ? 'GET' : 'POST', redirect: 'error', signal: controller.signal, dispatcher,
      headers: {'Content-Type': 'application/json', ...(local ? {} : {Authorization: 'Bearer ' + key})},
      body: listModels ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const errors = {401: '密钥无效，请检查 API Key。', 402: '模型服务余额不足。', 429: '请求过于频繁，请稍后再试。', 404: listModels ? '此 API 地址未提供模型列表，可手动填写模型 ID。' : '找不到模型，请检查模型名称。'};
      await response.body?.cancel();
      return sendJson(res, 502, {error: errors[response.status] || '模型服务暂时不可用，请稍后再试。'});
    }
    const data = await response.json();
    if (listModels) {
      const items = data?.data ?? data?.models;
      if (!Array.isArray(items)) return sendJson(res, 502, {error: '模型列表格式无法识别，可手动填写模型 ID。'});
      const ids = items.map(item => typeof item === 'string' ? item : item?.id ?? item?.name)
        .filter(id => valid(id, 128)).map(id => id.trim());
      return sendJson(res, 200, {models: [...new Set(ids)].sort()});
    }
    const choice = data.choices?.[0];
    if (data.status === 'incomplete' || choice?.finish_reason === 'length') return sendJson(res, 502, {error: '建议超过模型输出长度，请选择较短的片段。'});
    const suggestion = responses ? (data.output_text || data.output?.filter(item => item.type === 'message')
      .flatMap(item => item.content || []).filter(part => part.type === 'output_text')
      .map(part => part.text).join('\n')) : choice?.message?.content;
    if (!valid(suggestion, 64000)) return sendJson(res, 502, {error: '模型没有返回可用的建议，请重试。'});
    sendJson(res, 200, {suggestion: suggestion.trim()});
  } catch {
    if (openai && !controller.signal.aborted) {
      if (!res.destroyed) sendJson(res, 502, {error: proxy ?
        '通过代理连接 OpenAI 失败，请检查代理地址、认证信息和 API 地址。' :
        '连接 OpenAI 失败，请检查 API 地址和网络，或填写代理地址。'});
      return;
    }
    if (!res.destroyed) sendJson(res, 502, {error: controller.signal.aborted ? (listModels ? '获取模型超时，请重试。' : '生成超时，请缩短原文后重试。') :
      (local ? '连接本机 Ollama 失败，请确认 Ollama 已启动且已安装所选模型。' : '连接 DeepSeek 失败，请检查网络后重试。')});
  } finally {
    clearTimeout(timeout);
    if (dispatcher) await dispatcher.destroy();
  }
};
