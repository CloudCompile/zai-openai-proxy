# chat.z.ai 逆向工程报告

## 1. 目标概述

**目标站点**: https://chat.z.ai  
**所属公司**: 智谱 AI (Zhipu AI)  
**目标**: 逆向网页端免登录请求流程，构建 OpenAI 兼容格式的 API 代理服务  

## 2. 站点架构分析

### 2.1 前端技术栈

| 组件 | 技术 |
|------|------|
| 框架 | SvelteKit (Open WebUI 定制版) |
| 构建 | Vite，产物部署至 CDN `z-cdn.chatglm.cn` |
| 版本标识 | `prod-fe-1.0.252` |
| JS 混淆 | js-obfuscator + RC4 字符串解码器 |

### 2.2 后端 API 结构

```
https://chat.z.ai/
├── /api/v1/auths/          # Guest 认证（GET 自动创建访客账号）
├── /api/config             # 站点配置（含 completion_version）
├── /api/models             # 模型列表
└── /api/v2/chat/completions # 聊天补全（v2，需签名）
```

### 2.3 认证机制

- `GET /api/v1/auths/` 无需任何参数，自动创建 Guest 账号并返回 JWT token
- Token 权限: `{"chat": {"temporary": true}}`
- Token 存储于 `localStorage`，过期后自动续期

## 3. 签名算法逆向

### 3.1 请求签名要求

V2 接口 (`/api/v2/chat/completions`) 强制要求:
- URL 参数: `signature_timestamp`、`requestId`、`user_id` 及浏览器指纹参数
- Header: `X-Signature` (HMAC-SHA256 签名)

### 3.2 签名函数定位

通过分析 ~5.5MB 的前端 JS bundle，定位到核心签名模块:

**文件**: `CAm9rDEa.js` (~124KB)  
**导出**:
- `b0` (别名 `yM`): 参数生成函数 → 返回 `{sortedPayload, urlParams, timestamp}`
- `b1` (别名 `MM`): 签名计算函数 → 返回 `{signature, timestamp}`

### 3.3 签名算法结构

```
yM() → {
  o = {timestamp, requestId, user_id}  // 核心参数
  l = {浏览器指纹: version, platform, user_agent, screen_*, ...}  // 指纹参数
  sortedPayload = Object.entries(o).sort().join(",")
  urlParams = new URLSearchParams({...o, ...l}).toString()
}

MM(sortedPayload, prompt, timestamp) → {
  prompt_b64 = btoa(encode(prompt))
  data = sortedPayload + "|" + prompt_b64 + "|" + timestamp
  window = floor(timestamp / (5 * 60 * 1000))
  key = HMAC-SHA256(SECRET_KEY, str(window))
  signature = HMAC-SHA256(key, data).hex()
}
```

### 3.4 混淆对抗

**混淆手段**:
- **RC4 字符串解码器**: `K()` 函数使用 RC4 算法解码所有字符串常量
- **自修改代码**: `K()` 首次调用后替换自身为解码结果，后续调用行为不同
- **状态化执行**: 字符串数组 `Se[]` 的索引在运行时被旋转

**关键发现**:
- HMAC 密钥在源码中看似 `"dXt$"`，但实际经过 `K()` 解码后为不同值
- 尝试在 Node.js 中提取 `K()` 函数独立运行失败 — 因为解码器依赖运行时状态
- 6 种 HMAC 参数组合暴力测试均无法匹配浏览器内真实签名

### 3.5 最终方案: 浏览器签名预言机

由于混淆无法完全脱离浏览器环境，采用 **Puppeteer 浏览器预言机** 方案:

1. 启动 headless Chrome，加载 `chat.z.ai`
2. 在浏览器上下文中 `import()` 签名模块
3. 将 `b0`/`b1` 挂载到 `window` 对象
4. 每次请求时通过 `page.evaluate()` 调用真实签名函数

**优势**: 100% 签名兼容，无需破解混淆  
**代价**: 需要运行 Chrome 实例（~100MB 内存）

## 4. SSE 流格式转换

### 4.1 Z.ai 原始格式

```json
data: {"type":"chat:completion","data":{"phase":"thinking","delta_content":"思考内容..."}}
data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"回答内容..."}}
data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"<details>...</details>\n完整内容"}}
data: {"type":"chat:completion","data":{"phase":"other","usage":{...},"done":true}}
```

### 4.2 转换为 OpenAI 格式

| Z.ai 字段 | OpenAI 字段 |
|-----------|------------|
| `phase: "thinking"` + `delta_content` | `delta.reasoning_content` |
| `phase: "answer"` + `delta_content` | `delta.content` |
| `phase: "answer"` + `edit_content` | `delta.content`（去除 `<details>` 标签后） |
| `phase: "other"` + `usage` | `usage` 对象 |
| `done: true` | `finish_reason: "stop"` + `data: [DONE]` |

### 4.3 特殊处理

- **`edit_content` 桥接**: thinking → answer 过渡时，`edit_content` 包含 `<details>` HTML 包裹的思考内容 + 回答内容，需提取 `</details>\n` 之后的部分
- **非流式 reasoning 清理**: 去除 `<details>` 标签和 `> ` 引用前缀

## 5. 代理服务实现

### 5.1 功能列表

| 功能 | 参数 | 说明 |
|------|------|------|
| 聊天补全 | `POST /v1/chat/completions` | OpenAI 兼容 |
| 模型列表 | `GET /v1/models` | 动态获取 |
| 流式输出 | `stream: true` | SSE 格式 |
| 思维链 | `enable_thinking: true` | `reasoning_content` 字段 |
| 联网搜索 | `web_search: true` | Z.ai 内置搜索 |
| 工具调用 | `tools: [...]` | OpenAI function calling 格式 |
| 会话续期 | 自动 | 401 时自动刷新 Guest token |
| CORS | 全开 | `Access-Control-Allow-Origin: *` |

### 5.2 技术架构

```
Client (curl/SDK)                   zai-proxy.js                    chat.z.ai
     │                                   │                              │
     │  POST /v1/chat/completions        │                              │
     │ ─────────────────────────────────> │                              │
     │                                   │  page.evaluate(yM(), MM())   │
     │                                   │  ──────────────────────>      │
     │                                   │  <── signature ──────────    │
     │                                   │                              │
     │                                   │  POST /api/v2/chat/completions
     │                                   │ ────────────────────────────> │
     │                                   │ <──── Z.ai SSE stream ────── │
     │                                   │                              │
     │  <── OpenAI SSE stream ────────── │                              │
     │                                   │                              │
```

## 6. 逆向过程时间线

| 阶段 | 内容 | 结果 |
|------|------|------|
| 1. 信息收集 | 抓取 HTML、分析 API 路由 | 识别 Open WebUI 框架 + 4 个关键 API |
| 2. 认证分析 | 测试 Guest 端点 | 发现无参数自动创建访客 JWT |
| 3. 端点探测 | 测试 v1/v2 接口 | 确认 v2 需签名，v1 已弃用 |
| 4. JS 分析 | 下载 ~5.5MB bundle 搜索签名逻辑 | 定位 `CAm9rDEa.js` 签名模块 |
| 5. 算法提取 | 分析 HMAC-SHA256 双层签名 | 识别 `yM(b0)` 和 `MM(b1)` 函数 |
| 6. 脱壳尝试 | Python/Node.js 独立实现签名 | 失败 — RC4 混淆无法脱离浏览器 |
| 7. 预言机方案 | Puppeteer 浏览器内调用签名 | 成功 — 签名 100% 有效 |
| 8. 格式转换 | Z.ai SSE → OpenAI SSE | 完成流式/非流式双模式 |
| 9. 功能增强 | 添加搜索、工具调用支持 | 完整 OpenAI 兼容代理 |

## 7. 关键技术发现

1. **Z.ai 基于 Open WebUI**: 前端是 SvelteKit 版 Open WebUI 的深度定制，后端接口与开源版差异较大
2. **双版本 API 共存**: v1 (无签名) 和 v2 (需签名) 并存，`config.completion_version` 控制版本
3. **5 分钟时间窗口**: 签名密钥每 5 分钟轮换一次 (`floor(ts / 300000)`)
4. **浏览器指纹绑定**: URL 参数包含 20+ 浏览器指纹字段（screen_*、viewport_*、timezone 等）
5. **js-sha256 库**: 签名使用 emn178 的 js-sha256 库的 HMAC 功能

## 8. 文件清单

| 文件 | 说明 |
|------|------|
| `zai-proxy.js` | 主代理服务（355 行） |
| `package.json` | Node.js 依赖 |
| `README.md` | 使用文档 |
| `REPORT.md` | 本报告 |
