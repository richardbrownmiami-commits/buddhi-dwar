# Buddhi Dwar

AI Gateway proxy on Cloudflare Workers. Routes OpenAI-compatible requests to free-tier and paid LLM providers with automatic failover, rate-limit tracking, usage analytics, and an admin dashboard.

**Live**: `https://buddhi-dwar.richard-brown-miami.workers.dev`

## Features

- **Unified API** -- Single OpenAI-compatible endpoint for all providers
- **Multi-provider** -- Groq, Google Gemini, Mistral, OpenRouter, DeepSeek, Together AI + custom providers
- **Auto failover** -- Circuit breaker per key, dead key eviction, model fallback arrays
- **Load balancing** -- Round-robin, lowest-latency, or least-loaded strategy per provider
- **Streaming** -- SSE passthrough with 60s timeout
- **Model fallback array** -- Try models in order: `"model": ["gpt-4o", "claude-3", "gemini-pro"]`
- **Usage tracking** -- Per-key daily limits, real rate-limit headers, provider-level caps
- **Admin dashboard** -- Server-side auth, key management, health checks, analytics CSV export
- **Webhook alerts** -- Discord/Slack notifications for auth failures and evictions
- **Dynamic providers** -- Add OpenAI-compatible or Google-style providers at runtime via UI

## Quick Start

### 1. Add API Keys

Go to `/admin` -> **API Keys** tab. Add keys for your providers:

| Provider | Key URL | Free tier |
|----------|---------|-----------|
| Groq | https://console.groq.com/keys | 14400 req/day |
| Google | https://aistudio.google.com/apikey | 1500 req/day |
| Mistral | https://console.mistral.ai/api-keys | 5000 req/day |
| OpenRouter | https://openrouter.ai/keys | 500 req/day |
| DeepSeek | https://platform.deepseek.com | 5000 req/day |
| Together AI | https://api.together.xyz | 5000 req/day |

### 2. Create a Gateway Key

Go to **Gateway Keys** tab -> click **Generate Key**. Use this as your Bearer token.

### 3. Make Requests

```bash
curl -X POST https://buddhi-dwar.richard-brown-miami.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hello"}]}'
```

JavaScript:
```js
const resp = await fetch("https://buddhi-dwar.../v1/chat/completions", {
  method: "POST",
  headers: { "Authorization": "Bearer YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] })
});
```

Python:
```python
import requests
resp = requests.post("https://buddhi-dwar.../v1/chat/completions",
  headers={"Authorization": "Bearer YOUR_KEY"},
  json={"model": "mistral-small-latest", "messages": [{"role": "user", "content": "hello"}]})
print(resp.json())
```

### Model Fallback Array

Specify multiple models in priority order:
```json
{"model": ["gemini-2.0-flash", "llama-3.3-70b-versatile", "mistral-small-latest"], "messages": [...]}
```
Tries Gemini first, falls back to Llama, then Mistral if earlier models fail.

## Admin Dashboard

Access at `/admin`. Default password: `2200` (change via `ADMIN_PASSWORD` env var).

| Tab | Purpose |
|-----|---------|
| Overview | Key stats, 7-day trends, provider usage bars |
| API Keys | Add/test/copy/delete provider keys |
| Gateway Keys | Generate per-app Bearer tokens |
| Strategy | Set round-robin / lowest-latency / least-loaded per provider |
| Analytics | 30-day request logs with CSV export |
| Usage | Daily limits vs usage with live rate-limit headers |
| Settings | Custom providers, per-provider rate limits |
| Health Check | Ping all keys, view circuit-breaker state |
| Setup | Code examples, webhook config, env vars |

## Architecture

```
Client -> Gateway Key -> Buddhi Dwar (Cloudflare Worker) -> Provider API
                    v                          ^
               Rate limit check         Key selection + health
                    v                          ^
               Model matching           Circuit breaker + eviction
                    v                          ^
               Provider loop            Usage + analytics logging
```

- **KV storage**: Provider keys, health state, usage counters, analytics, rate-limit data
- **No external DB**: Everything in Cloudflare KV with TTL-based cleanup
- **Cron**: 6-hourly eviction of expired/dead keys
- **Auth**: Gateway keys (Bearer) for clients; cookie-based session for admin

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ADMIN_PASSWORD` | Admin login password (default: `2200`) |
| `WEBHOOK_URL` | Discord/Slack webhook for failure alerts |
| `BF` | KV namespace binding |

## Deployment

Cloudflare Connect Git auto-deploys from `main` branch.

```bash
# Manual deploy (requires wrangler)
npx wrangler deploy src/index.ts
```

## License

MIT
