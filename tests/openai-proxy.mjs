// Run offline. A local HTTP CONNECT proxy records the route independently of the model fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import handleRewrite from '../tools/resume-ai.cjs';

test('OpenAI rewrite uses the configured protocol, credentials and proxy', async t => {
  async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return 'http://127.0.0.1:' + server.address().port;
  }
  const calls = [];
  const target = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({url: req.url, method: req.method, headers: req.headers, body: body && JSON.parse(body)});
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({data: [{id: 'sample-b'}, {id: 'sample-a'}, {id: 'sample-b'}]}));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/responses') ? {
      output: [{type: 'message', content: [{type: 'output_text', text: '测试建议'}]}]
    } : {choices: [{message: {content: '测试建议'}}]}));
  }));

  const tunnels = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    tunnels.push({authority: req.url, headers: req.headers});
    const socket = net.connect(new URL(target).port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      client.pipe(socket).pipe(client);
    });
    client.on('close', () => socket.destroy());
    socket.on('error', () => client.destroy());
    client.on('error', () => socket.destroy());
  });
  const proxyUrl = new URL(await listen(proxy));
  proxyUrl.username = 'tester';
  proxyUrl.password = 'pass';
  const app = http.createServer((req, res) => handleRewrite(req, res, app.address().port, (r, status, data) => {
    r.writeHead(status, {'content-type': 'application/json'});
    r.end(JSON.stringify(data));
  }, req.url));
  const origin = await listen(app);
  for (const httpProxy of ['', proxyUrl.href]) {
    const before = tunnels.length;
    const response = await fetch(origin + '/api/models', {
      method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({provider: 'openai', baseUrl: target + '/v1/responses/', key: 'query-key', httpProxy})
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {models: ['sample-a', 'sample-b']});
    const call = calls.at(-1);
    assert.equal(call.method, 'GET');
    assert.equal(call.url, '/v1/models');
    assert.equal(call.body, '');
    assert.equal(call.headers.authorization, 'Bearer query-key');
    assert.equal(tunnels.length, before + (httpProxy ? 1 : 0));
  }
  const rewrite = config => fetch(origin + '/api/rewrite', {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({provider: 'openai', model: 'example-model', key: 'test-only',
      baseUrl: target + '/v1', text: '测试原文', instruction: '精简', ...config})
  });

  for (const protocol of ['responses', 'chat-completions']) {
    const before = tunnels.length;
    const response = await rewrite({protocol, httpProxy: proxyUrl.href, baseUrl: target + '/v1/chat/completions/'});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {suggestion: '测试建议'});
    assert.equal(tunnels.length, before + 1);
    assert.equal(tunnels.at(-1).authority, new URL(target).host);
    assert.equal(tunnels.at(-1).headers['proxy-authorization'], 'Basic ' + Buffer.from('tester:pass').toString('base64'));
    assert.equal(tunnels.at(-1).headers.authorization, undefined);
    const call = calls.at(-1);
    assert.equal(call.headers.authorization, 'Bearer test-only');
    assert.equal(call.headers['proxy-authorization'], undefined);
    assert.equal(call.body.model, 'example-model');
    assert.equal(call.url, '/v1/' + (protocol === 'responses' ? 'responses' : 'chat/completions'));
    assert.match(protocol === 'responses' ? call.body.input : call.body.messages[1].content, /测试原文/);
  }
  const before = tunnels.length;
  assert.equal((await rewrite({httpProxy: ''})).status, 200);
  assert.equal(tunnels.length, before);
  assert.equal((await rewrite({httpProxy: 'invalid'})).status, 400);
  const count = calls.length;
  // A proxy can refuse the CONNECT request. Never retry directly in that case.
  const refusing = http.createServer();
  refusing.on('connect', (_req, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
  assert.equal((await rewrite({httpProxy: await listen(refusing)})).status, 502);
  assert.equal(calls.length, count);
});
