'use strict';

const crypto = require('crypto');
const {
  getPage,
  refreshSession,
  generateSignedRequest,
  makeChunk,
  makeCompletion,
  parseBody,
} = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    const page = await getPage();
    const signed = await generateSignedRequest(page, model, messages, { enableThinking, webSearch, tools, toolChoice });
    const upstream = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error(`[-] ${upstream.status}: ${err.substring(0, 200)}`);
      if (upstream.status === 401) await refreshSession(page);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(upstream.status).end(
        JSON.stringify({ error: { message: err, type: 'upstream_error', code: upstream.status } })
      );
    }

    let fullContent = '';
    let fullReasoning = '';
    let usage = null;
    let toolCallsAccum = [];

    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200);
      res.write(
        `data: ${JSON.stringify({
          id: chatId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        })}\n\n`
      );
    }

    const reader = upstream.body.getReader();
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
      const cleanReasoning = fullReasoning
        .replace(/<details[^>]*>\n?/g, '')
        .replace(/<\/details>\n?/g, '')
        .replace(/^> /gm, '')
        .trim();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).end(
        JSON.stringify(makeCompletion(chatId, model, fullContent, cleanReasoning || undefined, usage, toolCallsAccum.length > 0 ? toolCallsAccum : undefined))
      );
    }

    console.log(`[+] Done: ${fullContent.length} chars, ${fullReasoning.length} reasoning, ${toolCallsAccum.length} tool_calls`);
  } catch (e) {
    console.error('[-] Error:', e.message);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).end(JSON.stringify({ error: { message: e.message } }));
    }
  }
};
