const puppeteer = require('puppeteer-core');
const http = require('http');
const crypto = require('crypto');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
// Full URL to the signature chunk — set ZAI_CDN_CHUNK env var to override when Z.ai upgrades its frontend
const CDN_CHUNK = process.env.ZAI_CDN_CHUNK ||
  'https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.0.252/_app/immutable/chunks/CAm9rDEa.js';
const ZAI_BASE = 'https://chat.z.ai';
const PORT = process.env.PORT || 9876;

let browser, page;

async function init() {
  console.log('[*] Launching browser...');
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  page = await browser.newPage();
  await page.goto(ZAI_BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('[+] Page loaded');
  await page.evaluate(async (chunkUrl) => {
    window.__zaiMod = await import(chunkUrl);
    window.__zaiYM = window.__zaiMod.b0;
    window.__zaiMM = window.__zaiMod.b1;
  }, CDN_CHUNK);
  console.log('[+] Signature module loaded');
}

async function refreshSession() {
  console.log('[*] Refreshing guest session...');
  await page.evaluate(() => localStorage.removeItem('token'));
  await page.reload({ waitUntil: 'networkidle2' });
  await page.evaluate(async (chunkUrl) => {
    window.__zaiMod = await import(chunkUrl);
    window.__zaiYM = window.__zaiMod.b0;
    window.__zaiMM = window.__zaiMod.b1;
  }, CDN_CHUNK);
  console.log('[+] Session refreshed');
}

async function getModels() {
  return await page.evaluate(async (base) => {
    const token = localStorage.getItem('token') || '';
    const res = await fetch(base + '/api/models', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    const models = await res.json();
    return Array.isArray(models) ? models.map(m => m.id) : (models.data || []).map(m => m.id);
  }, ZAI_BASE);
}

async function generateSignedRequest(model, messages, stream, opts = {}) {
  const { enableThinking = true, webSearch = false, tools, toolChoice } = opts;
  return await page.evaluate((base, model, messages, stream, enableThinking, webSearch, tools, toolChoice) => {
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
      features: { image_generation: false, web_search: webSearch, auto_web_search: webSearch, preview_mode: true, flags: [], enable_thinking: enableThinking },
      variables: {},
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    return {
      url: base + '/api/v2/chat/completions?' + urlParams + '&signature_timestamp=' + sigTs,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN',
        'X-FE-Version': 'prod-fe-1.0.252',
        'X-Signature': signature,
        'Origin': base,
        'Referer': base + '/',
      },
      body: JSON.stringify(body),
    };
  }, ZAI_BASE, model, messages, stream, enableThinking, webSearch, tools, toolChoice);
}

function makeChunk(id, model, content, reasoningContent, finishReason, toolCalls) {
  const chunk = {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: finishReason || null,
    }],
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
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

async function handleChat(req, res) {
  try {
    const body = await parseBody(req);
    const model = body.model || 'glm-5';
    const messages = body.messages || [];
    const wantStream = body.stream ?? false;
    const enableThinking = body.enable_thinking ?? true;
    const webSearch = body.web_search ?? false;
    const tools = body.tools || null;
    const toolChoice = body.tool_choice || null;
    const chatId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

    console.log(`[>] ${model} | ${messages.length} msgs | stream=${wantStream} | search=${webSearch} | tools=${tools ? tools.length : 0}`);

    const signed = await generateSignedRequest(model, messages, true, { enableThinking, webSearch, tools, toolChoice });
    const resp = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[-] ${resp.status}: ${err.substring(0, 200)}`);
      if (resp.status === 401) await refreshSession();
      res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: err, type: 'upstream_error', code: resp.status } }));
      return;
    }

    let fullContent = '';
    let fullReasoning = '';
    let usage = null;
    let toolCallsAccum = [];

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        const d = parsed.type === 'chat:completion' ? parsed.data : parsed;
        if (!d || typeof d === 'string') continue;

        if (d.done) {
          const fr = toolCallsAccum.length > 0 ? 'tool_calls' : 'stop';
          if (wantStream) {
            if (usage) {
              const usageChunk = makeChunk(chatId, model, undefined, undefined, fr);
              usageChunk.usage = usage;
              res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify(makeChunk(chatId, model, undefined, undefined, fr))}\n\n`);
            }
            res.write('data: [DONE]\n\n');
          }
          continue;
        }

        if (d.phase === 'thinking' && d.delta_content) {
          fullReasoning += d.delta_content;
          if (wantStream) {
            res.write(`data: ${JSON.stringify(makeChunk(chatId, model, undefined, d.delta_content, null))}\n\n`);
          }
        } else if (d.phase === 'answer') {
          if (d.delta_content) {
            fullContent += d.delta_content;
            if (wantStream) {
              res.write(`data: ${JSON.stringify(makeChunk(chatId, model, d.delta_content, undefined, null))}\n\n`);
            }
          } else if (d.edit_content) {
            let text = d.edit_content;
            const marker = '</details>\n';
            const idx = text.indexOf(marker);
            if (idx !== -1) text = text.substring(idx + marker.length);
            if (text) {
              fullContent += text;
              if (wantStream) {
                res.write(`data: ${JSON.stringify(makeChunk(chatId, model, text, undefined, null))}\n\n`);
              }
            }
          }
        } else if (d.phase === 'other') {
          if (d.usage) {
            usage = {
              prompt_tokens: d.usage.prompt_tokens || 0,
              completion_tokens: d.usage.completion_tokens || 0,
              total_tokens: d.usage.total_tokens || 0,
            };
          }
          if (d.edit_content) {
            fullContent += d.edit_content;
            if (wantStream) {
              res.write(`data: ${JSON.stringify(makeChunk(chatId, model, d.edit_content, undefined, null))}\n\n`);
            }
          }
        }

        if (d.tool_calls) {
          const tc = Array.isArray(d.tool_calls) ? d.tool_calls : [d.tool_calls];
          for (const call of tc) {
            const oaiCall = {
              index: call.index ?? toolCallsAccum.length,
              id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
              type: 'function',
              function: { name: call.function?.name || '', arguments: call.function?.arguments || '' },
            };
            toolCallsAccum.push(oaiCall);
            if (wantStream) {
              res.write(`data: ${JSON.stringify(makeChunk(chatId, model, undefined, undefined, null, [oaiCall]))}\n\n`);
            }
          }
        }

        if (d.phase === 'search' || d.type === 'web_search') {
          const searchInfo = d.results || d.sources || d.citations;
          if (searchInfo && wantStream) {
            const citation = Array.isArray(searchInfo)
              ? '\n\n---\n' + searchInfo.map((s, i) => `[${i + 1}] [${s.title || s.name || ''}](${s.url || s.link || ''})`).join('\n')
              : '';
            if (citation) {
              fullContent += citation;
              res.write(`data: ${JSON.stringify(makeChunk(chatId, model, citation, undefined, null))}\n\n`);
            }
          }
        }
      }
    }

    if (wantStream) {
      res.end();
    } else {
      let cleanReasoning = fullReasoning
        .replace(/<details[^>]*>\n?/g, '')
        .replace(/<\/details>\n?/g, '')
        .replace(/^> /gm, '')
        .trim();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(makeCompletion(chatId, model, fullContent, cleanReasoning || undefined, usage, toolCallsAccum.length > 0 ? toolCallsAccum : undefined)));
    }

    console.log(`[+] Done: ${fullContent.length} chars content, ${fullReasoning.length} chars reasoning, ${toolCallsAccum.length} tool_calls`);
  } catch (e) {
    console.error('[-] Error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }
}

async function handleModels(req, res) {
  const ids = await getModels();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    object: 'list',
    data: ids.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'zhipu' })),
  }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }
  const path = req.url.split('?')[0];
  if (path === '/v1/models' || path === '/models') return handleModels(req, res);
  if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') return handleChat(req, res);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use /v1/chat/completions' }));
});

(async () => {
  await init();
  const ids = await getModels();
  server.listen(PORT, () => {
    console.log(`\n${'='.repeat(55)}`);
    console.log('  chat.z.ai -> OpenAI API Proxy');
    console.log('='.repeat(55));
    console.log(`  Base URL : http://localhost:${PORT}/v1`);
    console.log(`  Models   : ${ids.slice(0, 5).join(', ')}`);
    console.log('  Endpoints:');
    console.log('    GET  /v1/models');
    console.log('    POST /v1/chat/completions');
    console.log('  Extra params:');
    console.log('    web_search: true     - enable web search');
    console.log('    tools: [...]          - OpenAI function calling');
    console.log('    enable_thinking: bool - thinking/reasoning (default: true)');
    console.log('='.repeat(55) + '\n');
  });
})();
