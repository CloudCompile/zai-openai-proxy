# zai-openai-proxy

Reverse-engineered [chat.z.ai](https://chat.z.ai) (Zhipu AI) proxy that exposes an **OpenAI-compatible API**.

No API key needed — uses guest sessions automatically.

## Features

- **OpenAI-compatible** — drop-in replacement for `/v1/chat/completions` and `/v1/models`
- **Streaming & non-streaming** — full SSE support
- **Thinking/Reasoning** — `reasoning_content` field in responses (like DeepSeek R1)
- **Web Search** — toggle with `web_search: true`
- **Tool Calling** — pass OpenAI-format `tools` array
- **Auto session refresh** — guest token auto-renewal on 401

## How It Works

The proxy uses headless Chrome (via Puppeteer) to:

1. Load `chat.z.ai` and obtain a guest session token
2. Import the frontend's obfuscated signature module directly in the browser context
3. Use the browser as a "signature oracle" — calling the real `yM()` and `MM()` functions to generate valid request signatures
4. Forward requests to Z.ai's `/api/v2/chat/completions` endpoint
5. Convert Z.ai's custom SSE format to standard OpenAI format

This approach bypasses the need to fully reverse-engineer the obfuscated HMAC-SHA256 signature algorithm (which uses RC4-based string decoding and self-modifying functions).

## Quick Start

### Prerequisites

- Node.js >= 18
- Chrome/Chromium installed

### Install

```bash
git clone https://github.com/xaoLiu1222/zai-openai-proxy.git
cd zai-openai-proxy
npm install

# Install Chrome if needed
npx puppeteer browsers install chrome
```

### Run

```bash
# Set Chrome path (auto-detected if installed via puppeteer)
export CHROME_PATH=/path/to/chrome

node zai-proxy.js
```

Output:
```
=======================================================
  chat.z.ai -> OpenAI API Proxy
=======================================================
  Base URL : http://localhost:9876/v1
  Models   : glm-5, glm-4-flash, ...
  Endpoints:
    GET  /v1/models
    POST /v1/chat/completions
  Extra params:
    web_search: true     - enable web search
    tools: [...]          - OpenAI function calling
    enable_thinking: bool - thinking/reasoning (default: true)
=======================================================
```

## Usage Examples

### Basic Chat

```bash
curl http://localhost:9876/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### With Web Search

```bash
curl http://localhost:9876/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5",
    "messages": [{"role": "user", "content": "What happened today?"}],
    "stream": true,
    "web_search": true
  }'
```

### With Tool Calling

```bash
curl http://localhost:9876/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5",
    "messages": [{"role": "user", "content": "What is the weather in Beijing?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
      }
    }]
  }'
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9876/v1", api_key="unused")
response = client.chat.completions.create(
    model="glm-5",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/usr/bin/google-chrome` | Path to Chrome/Chromium binary |
| `PORT` | `9876` | Proxy server port |
| `ZAI_CDN_CHUNK` | `https://z-cdn.chatglm.cn/…/CAm9rDEa.js` | Full URL to the Z.ai signature chunk — update when Z.ai ships a new frontend version |

## Available Models

Models are fetched dynamically from Z.ai. Common ones include:

- `glm-5` — Latest GLM model with deep thinking
- `glm-4-flash` — Fast inference model
- `glm-4-plus` — Enhanced GLM-4
- And more (check `/v1/models`)

## Deploy to Vercel

You can run this proxy on Vercel's **free Hobby plan** — no Pro plan needed. The Vercel functions load the Z.ai signature module directly in Node.js (no headless browser), so cold starts take ~1–3 seconds, well within the free-tier 10-second function timeout.

### What you need

| Requirement | Notes |
|---|---|
| Vercel account | [vercel.com](https://vercel.com) — **free Hobby plan works** |
| Node.js ≥ 18 | Required locally to run the Vercel CLI |

### Step 1 — Deploy

```bash
# Install Vercel CLI if you don't have it
npm i -g vercel

# Clone and enter the repo
git clone https://github.com/CloudCompile/zai-openai-proxy.git
cd zai-openai-proxy
npm install

# Deploy (follow the prompts — link to your project)
vercel --prod
```

That's it. No environment variables are required to get started.

### Step 2 — Use your deployment

Replace `https://your-project.vercel.app` with your actual Vercel URL:

```bash
# List models
curl https://your-project.vercel.app/v1/models

# Chat completion
curl https://your-project.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

**OpenAI SDK (Python):**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-project.vercel.app/v1",
    api_key="unused",
)
response = client.chat.completions.create(
    model="glm-5",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### How it works (no browser needed)

On a cold start the function does two things in parallel (~1–3 s total):

1. **`GET https://chat.z.ai/api/v1/auths/`** — auto-creates an anonymous guest JWT
2. **Fetches the Z.ai signature chunk** (~124 KB) from the CDN and imports it via Node.js 18's native `import('data:text/javascript;base64,...')` — the module's RC4-obfuscated HMAC signing logic runs as-is with mocked browser fingerprint globals

Both the module and the token are cached at module scope, so **warm requests skip the cold start entirely** and respond in 2–5 s.

### Optional environment variable

| Variable | Default | Description |
|---|---|---|
| `ZAI_CDN_CHUNK` | `https://z-cdn.chatglm.cn/…/CAm9rDEa.js` | Full URL to the Z.ai signature chunk — set this if Z.ai ships a new frontend version and the default URL stops working |

---

## Limitations

- Guest sessions have rate limits imposed by Z.ai
- The CDN chunk hash (`CAm9rDEa.js`) may change on Z.ai frontend updates (update `ZAI_CDN_CHUNK` if needed)

## License

MIT
