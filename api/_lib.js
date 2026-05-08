'use strict';

const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

// Full URL to the signature chunk — update ZAI_CDN_CHUNK env var when Z.ai upgrades its frontend
const CDN_CHUNK = process.env.ZAI_CDN_CHUNK ||
  'https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.0.252/_app/immutable/chunks/CAm9rDEa.js';
const ZAI_BASE = 'https://chat.z.ai';

// Module-level cache — persists across warm Vercel function invocations
let _browser = null;
let _page = null;

async function loadSignatureModule(page) {
  await page.evaluate(async (chunkUrl) => {
    window.__zaiMod = await import(chunkUrl);
    window.__zaiYM = window.__zaiMod.b0;
    window.__zaiMM = window.__zaiMod.b1;
  }, CDN_CHUNK);
}

async function getPage() {
  // Reuse cached page on warm invocations
  if (_page && _browser) {
    try {
      await _page.evaluate(() => true);
      return _page;
    } catch {
      _browser = null;
      _page = null;
    }
  }

  console.log('[*] Launching browser...');
  const executablePath = await chromium.executablePath(process.env.CHROMIUM_PACK);
  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
  _page = await _browser.newPage();
  await _page.goto(ZAI_BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await loadSignatureModule(_page);
  console.log('[+] Browser ready');
  return _page;
}

async function refreshSession(page) {
  console.log('[*] Refreshing guest session...');
  await page.evaluate(() => localStorage.removeItem('token'));
  await page.reload({ waitUntil: 'networkidle2' });
  await loadSignatureModule(page);
  console.log('[+] Session refreshed');
}

async function getModels(page) {
  return await page.evaluate(async (base) => {
    const token = localStorage.getItem('token') || '';
    const res = await fetch(base + '/api/models', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    const models = await res.json();
    return Array.isArray(models) ? models.map(m => m.id) : (models.data || []).map(m => m.id);
  }, ZAI_BASE);
}

async function generateSignedRequest(page, model, messages, opts = {}) {
  const { enableThinking = true, webSearch = false, tools, toolChoice } = opts;
  return await page.evaluate((base, model, messages, enableThinking, webSearch, tools, toolChoice) => {
    const token = localStorage.getItem('token') || '';
    const { sortedPayload, urlParams, timestamp } = window.__zaiYM();
    const prompt = messages[messages.length - 1]?.content || '';
    const { signature, timestamp: sigTs } = window.__zaiMM(sortedPayload, prompt, timestamp);
    const msgId = crypto.randomUUID();
    const body = {
      model, messages, stream: true,
      signature_prompt: prompt,
      chat_id: crypto.randomUUID(),
      id: msgId,
      session_id: crypto.randomUUID(),
      current_user_message_id: msgId,
      current_user_message_parent_id: null,
      params: {},
      extra: {},
      features: {
        image_generation: false,
        web_search: webSearch,
        auto_web_search: webSearch,
        preview_mode: true,
        flags: [],
        enable_thinking: enableThinking,
      },
      variables: {},
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    return {
      url: base + '/api/v2/chat/completions?' + urlParams + '&signature_timestamp=' + sigTs,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
        'X-FE-Version': 'prod-fe-1.0.252',
        'X-Signature': signature,
        Origin: base,
        Referer: base + '/',
      },
      body: JSON.stringify(body),
    };
  }, ZAI_BASE, model, messages, enableThinking, webSearch, tools, toolChoice);
}

function makeChunk(id, model, content, reasoningContent, finishReason, toolCalls) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason || null }],
  };
  if (content !== undefined) chunk.choices[0].delta.content = content;
  if (reasoningContent !== undefined) chunk.choices[0].delta.reasoning_content = reasoningContent;
  if (toolCalls !== undefined) chunk.choices[0].delta.tool_calls = toolCalls;
  return chunk;
}

function makeCompletion(id, model, content, reasoningContent, usage, toolCalls) {
  const msg = { role: 'assistant', content };
  if (reasoningContent) msg.reasoning_content = reasoningContent;
  if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}

module.exports = {
  getPage,
  refreshSession,
  getModels,
  generateSignedRequest,
  makeChunk,
  makeCompletion,
  parseBody,
};
