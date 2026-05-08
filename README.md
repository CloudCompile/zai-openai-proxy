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

You can run this proxy as a serverless app on Vercel. Each request boots a headless Chromium instance (cached across warm invocations), so a **Pro plan** (60-second function timeout) is required — the free-tier 10-second limit is too short for a cold start.

### What you need

| Requirement | Notes |
|---|---|
| Vercel account | [vercel.com](https://vercel.com) — **Pro plan** needed for the 60 s timeout |
| Chromium pack URL | A public URL to an `@sparticuz/chromium` binary (see below) |

### Step 1 — Get a Chromium pack URL

The Chromium binary is too large to bundle with your deployment, so it is downloaded at cold-start from a URL you supply.

The easiest option is to grab a pre-built release directly from GitHub:

```
https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.tar
```

> **Production tip:** GitHub releases can hit rate limits under heavy traffic. Upload the `.tar` file to your own S3 bucket, Cloudflare R2, or any public CDN and use that URL instead.

### Step 2 — Deploy

```bash
# Install Vercel CLI if you don't have it
npm i -g vercel

# Clone and enter the repo
git clone https://github.com/CloudCompile/zai-openai-proxy.git
cd zai-openai-proxy
npm install

# Deploy (follow the prompts — link to your project)
vercel
```

### Step 3 — Set the environment variable

In the Vercel dashboard → your project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `CHROMIUM_PACK` | `https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.tar` |

Or set it from the CLI:

```bash
vercel env add CHROMIUM_PACK
# paste the URL when prompted, select all environments
```

Then redeploy so the variable takes effect:

```bash
vercel --prod
```

### Step 4 — Use your deployment

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

### How warm starts work

The first request to a cold function instance downloads Chromium (~50 MB) to `/tmp` and boots the browser — this takes 15–30 seconds. Subsequent requests to the **same warm instance** reuse the cached browser and respond in 2–5 seconds. Vercel keeps function instances warm for several minutes of inactivity.

### Vercel-specific environment variables

| Variable | Default | Description |
|---|---|---|
| `CHROMIUM_PACK` | *(required)* | URL to the `@sparticuz/chromium` pack `.tar` file |
| `ZAI_CDN_CHUNK` | `https://z-cdn.chatglm.cn/…/CAm9rDEa.js` | Full URL to the Z.ai signature chunk — update this if Z.ai ships a new frontend version |
| `PORT` | N/A | Not used on Vercel (Vercel manages the port) |

---

## Limitations

- Guest sessions have rate limits imposed by Z.ai
- Requires a running Chrome instance (headless)
- The CDN chunk hash (`CAm9rDEa.js`) may change on frontend updates
- Vercel deployment requires a **Pro plan** for the 60-second function timeout

## License

MIT
