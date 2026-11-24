'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const MD = require('../assets/resume-md.js');
const findBrowser = require('./find-browser.cjs');
const maxBytes = 32 * 1024 * 1024;

module.exports = async function downloadPdf(req, res, port, sendJson) {
  const origin = 'http://' + req.headers.host;
  if (!['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(origin) || req.headers.origin !== origin) {
    return sendJson(res, 403, {error: '请从本地简历编辑器下载 PDF。'});
  }
  if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return sendJson(res, 400, {error: '请通过编辑器提交简历。'});
  }

  let doc;
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) return sendJson(res, 413, {error: '简历超过 32 MB，请压缩图片后重试。'});
      chunks.push(chunk);
    }
    doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return sendJson(res, 400, {error: '无法读取简历，请重新下载。'});
  }
  if (typeof doc?.markdown !== 'string' || typeof doc.title !== 'string' || !Array.isArray(doc.images) ||
      !doc.images.every(img => typeof img === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img))) {
    return sendJson(res, 400, {error: '简历或图片格式有误。'});
  }

  let browser;
  try {
    const { chromium } = require('playwright-core');
    const executablePath = findBrowser(null, chromium.executablePath());
    if (!executablePath) return sendJson(res, 503, {error: '缺少 PDF 渲染器，请在项目目录运行 npx playwright-core install chromium。'});
    const css = await fs.readFile(path.join(__dirname, '../assets/resume.css'), 'utf8');
    const html = MD.toDocumentHTML(doc.markdown, {css, title: doc.title});
    browser = await chromium.launch({executablePath, headless: true});
    res.once('close', () => browser.close().catch(() => {}));
    if (res.destroyed) return;
    const page = await browser.newPage({offline: true, javaScriptEnabled: false});
    await page.route('**/*', route => route.abort());
    await page.setContent(html);
    // Only the pixels the editor supplied are needed for non-embedded images.
    await page.evaluate(async images => {
      const external = [...document.images].filter(img => !img.getAttribute('src').startsWith('data:'));
      if (external.length !== images.length) throw Error('image count');
      external.forEach((img, index) => { img.src = images[index]; });
      await Promise.all([...document.images].map(img => img.decode()));
      await document.fonts.ready;
    }, doc.images);
    const pdf = await page.pdf({format: 'A4', preferCSSPageSize: true, printBackground: true, timeout: 45000});
    res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename=resume.pdf; filename*=UTF-8''" +
      encodeURIComponent(doc.title + '.pdf').replace(/'/g, '%27'), 'Content-Length': pdf.length, 'Cache-Control': 'no-store'});
    res.end(pdf);
  } catch (err) {
    if (!res.destroyed) sendJson(res, 500, {error: err.code === 'MODULE_NOT_FOUND' ?
      '缺少 PDF 依赖，请在项目目录运行 npm ci。' : '生成 PDF 失败，请检查照片能否显示，或使用「打印简历」。'});
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
