'use strict';

const crypto = require('crypto');

// Full URL to the signature chunk — update ZAI_CDN_CHUNK env var when Z.ai upgrades its frontend
const CDN_CHUNK = process.env.ZAI_CDN_CHUNK ||
  'https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.0.252/_app/immutable/chunks/CAm9rDEa.js';
const ZAI_BASE = 'https://chat.z.ai';

// Module-level cache — persists across warm Vercel invocations
let _sigModule = null;   // { b0, b1 } from the signature chunk
let _guestToken = undefined; // JWT from /api/v1/auths/ (undefined = not yet fetched; '' = fetched but empty)
let _initPromise = null; // deduplicate concurrent cold-start inits
let _sigLoadPromise = null; // deduplicate concurrent signature-module loads

/**
 * Set up browser-like globals required by the Z.ai signature module.
 * The module reads screen dimensions, navigator fields, and timezone to build
 * the browser fingerprint included in urlParams. Fixed fake values are fine —
 * the server uses them as part of the signed payload but does not validate
 * that they match a "real" browser profile.
 */
function setupBrowserGlobals() {
  if (!globalThis.window) globalThis.window = globalThis;

  if (!globalThis.navigator) {
    globalThis.navigator = {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en'],
      hardwareConcurrency: 8,
      maxTouchPoints: 0,
      vendor: 'Google Inc.',
      cookieEnabled: true,
      connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
    };
  }

  if (!globalThis.screen) {
    globalThis.screen = {
      width: 1920, height: 1080,
      availWidth: 1920, availHeight: 1040,
      colorDepth: 24, pixelDepth: 24,
    };
  }

  if (!globalThis.innerWidth) {
    globalThis.innerWidth = 1920;
    globalThis.innerHeight = 1040;
  }

  if (!globalThis.devicePixelRatio) globalThis.devicePixelRatio = 1;

  if (!globalThis.document) {
    globalThis.document = {
      documentElement: { clientWidth: 1920, clientHeight: 1040 },
      referrer: '',
    };
  }

  if (!globalThis.location) {
    globalThis.location = { href: ZAI_BASE + '/', origin: ZAI_BASE, hostname: 'chat.z.ai' };
  }

  // Ensure btoa/atob are reachable as window.btoa / window.atob (available natively in Node.js 16+)
  if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  }
}

/**
 * Load the Z.ai signature module into Node.js without a browser.
 *
 * Strategy: fetch the ESM chunk as text, then import it via a data: URL
 * (stable in Node.js 18+, no flags required). Browser globals are mocked
 * before the import so the module's fingerprint-collection code has values
 * to read. The RC4-obfuscated HMAC key lives entirely inside the module and
 * is decoded at module-load time — it does not depend on browser entropy.
 */
async function loadSigModule() {
  if (_sigModule) return _sigModule;
  // Deduplicate concurrent loads
  if (_sigLoadPromise) return _sigLoadPromise;

  _sigLoadPromise = (async () => {
    console.log('[*] Fetching signature module...');
    setupBrowserGlobals();

    const res = await fetch(CDN_CHUNK, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': ZAI_BASE + '/',
        'Origin': ZAI_BASE,
      },
    });
    if (!res.ok) throw new Error(`Failed to fetch signature chunk: ${res.status}`);

    const code = await res.text();

    // Node.js 18+ supports data: URL imports natively (no --experimental flags needed)
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    const mod = await import(dataUrl);

    if (typeof mod.b0 !== 'function' || typeof mod.b1 !== 'function') {
      throw new Error(
        'Signature module loaded but b0/b1 exports not found — ' +
        'the CDN chunk hash may have changed. Set ZAI_CDN_CHUNK env var to the new chunk URL.'
      );
    }

    _sigModule = { b0: mod.b0, b1: mod.b1 };
    _sigLoadPromise = null;
    console.log('[+] Signature module ready');
    return _sigModule;
  })();

  // Reset on failure so the next request can retry
  _sigLoadPromise.catch(() => { _sigLoadPromise = null; });
  return _sigLoadPromise;
}

/**
 * Obtain a guest JWT from Z.ai. GET /api/v1/auths/ requires no parameters;
 * the server auto-creates an anonymous account on each call.
 */
async function fetchGuestToken() {
  console.log('[*] Fetching guest token...');
  try {
    const res = await fetch(`${ZAI_BASE}/api/v1/auths/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: ZAI_BASE + '/',
        Origin: ZAI_BASE,
      },
    });
    if (res.ok) {
      const data = await res.json();
      const token = data.token || data.access_token || '';
      if (token) { console.log('[+] Guest token obtained'); return token; }
    }
    console.warn(`[!] Guest token endpoint returned ${res.status} — falling back to empty token`);
  } catch (e) {
    console.warn('[!] Guest token fetch failed:', e.message, '— using empty token');
  }
  return '';
}

/** Ensure the signature module and guest token are ready (called on every request). */
async function ensureInit() {
  if (_sigModule && _guestToken !== null) return;
  // Deduplicate: if a cold start is already in progress, wait for it
  if (_initPromise) return _initPromise;
  _initPromise = Promise.all([loadSigModule(), fetchGuestToken()])
    .then(([mod, tok]) => { _sigModule = mod; _guestToken = tok; _initPromise = null; });
  return _initPromise;
}

async function refreshToken() {
  console.log('[*] Refreshing guest token...');
  _guestToken = await fetchGuestToken();
}

async function getModels() {
  await ensureInit();
  const res = await fetch(`${ZAI_BASE}/api/models`, {
    headers: { Authorization: 'Bearer ' + _guestToken, Accept: 'application/json' },
  });
  const models = await res.json();
  return Array.isArray(models) ? models.map(m => m.id) : (models.data || []).map(m => m.id);
}

async function generateSignedRequest(model, messages, opts = {}) {
  await ensureInit();

  const { enableThinking = true, webSearch = false, tools, toolChoice } = opts;
  const { b0: yM, b1: mM } = _sigModule;

  const { sortedPayload, urlParams, timestamp } = yM();
  const prompt = messages[messages.length - 1]?.content || '';
  const { signature, timestamp: sigTs } = mM(sortedPayload, prompt, timestamp);

  const msgId = crypto.randomUUID();
  const body = {
    model, messages, stream: true,
    signature_prompt: prompt,
    chat_id: crypto.randomUUID(),
    id: msgId,
    session_id: crypto.randomUUID(),
    current_user_message_id: msgId,
    current_user_message_parent_id: null,
    params: {}, extra: {},
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
    url: `${ZAI_BASE}/api/v2/chat/completions?${urlParams}&signature_timestamp=${sigTs}`,
    headers: {
      Authorization: 'Bearer ' + _guestToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
      'X-FE-Version': 'prod-fe-1.0.252',
      'X-Signature': signature,
      Origin: ZAI_BASE,
      Referer: ZAI_BASE + '/',
    },
    body: JSON.stringify(body),
  };
}

function makeChunk(id, model, content, reasoningContent, finishReason, toolCalls) {
  const chunk = {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
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
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
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
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

module.exports = {
  ensureInit,
  refreshToken,
  getModels,
  generateSignedRequest,
  makeChunk,
  makeCompletion,
  parseBody,
};
