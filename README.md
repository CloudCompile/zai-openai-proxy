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

## Available Models

Models are fetched dynamically from Z.ai. Common ones include:

- `glm-5` — Latest GLM model with deep thinking
- `glm-4-flash` — Fast inference model
- `glm-4-plus` — Enhanced GLM-4
- And more (check `/v1/models`)

## Limitations

- Guest sessions have rate limits imposed by Z.ai
- Requires a running Chrome instance (headless)
- The CDN chunk hash (`CAm9rDEa.js`) may change on frontend updates

## License

MIT
