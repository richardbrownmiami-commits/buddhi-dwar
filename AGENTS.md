# Buddhi Dwar â€” Session Context

## HARD RULE: Write code in 50-line MAX chunks
Every edit must be â‰¤50 lines of changed code. Never write an entire function or file in one edit.
Break work into small, deployable pieces â€” edit, deploy, verify, repeat. If a change requires more than 50 lines, split it across multiple edit/deploy cycles.

## Project
Cloudflare Workers AI Gateway (buddhi-dwar) that proxies OpenAI-compatible requests to free-tier LLM providers (Groq, Google Gemini, Mistral, OpenRouter), plus the Saraha-brain cognitive worker that uses it as its LLM backend.

- **Worker URL**: https://buddhi-dwar.richard-brown-miami.workers.dev
- **Admin URL**: https://buddhi-dwar.richard-brown-miami.workers.dev/admin
- **GitHub repo**: richardbrownmiami-commits/buddhi-dwar
- **Default admin password**: `itsgood` (read from env `ADMIN_PASSWORD`; fallback hardcoded; set to `Daredavil` in Cloudflare dashboard)
- **Master API key**: `bf-master-kun-2026` (env var `MASTER_KEY` overrides; set to `Pinka` in Cloudflare dashboard)
- **WEBHOOK_URL**: Slack/Webhook URL for alerts. The gateway POSTs JSON to this URL when a key auth fails (401/403) or a key gets evicted (expired/inactive). Leave empty if not needed.

## Credentials (do not expose)
- GitHub token: `(set in deploy script)`
- Cloudflare API token: `(set in deploy script)` (works with `cfat_` prefix; has D1 create access)
- No git/Node.js on dev machine â€” deploy via GitHub API (PowerShell scripts)
- **ADMIN_PASSWORD** (env var) = `Daredavil`
- **MASTER_KEY** (env var) = `Pinka`
- **Saraha-Brain-Key**: `Saraha-Brain-Key` â€” gateway key on Buddhi Dwar for Saraha brain usage tracking

## Keys on file (as of session end)
- `groq`: 1 key (label: `groq_1779989567409`)
- `mistral`: 1 key (label: `ds`)
- `openrouter`: 2 keys (both label: `sd` â€” possible duplicate)
- `google`: **0 keys** â† needs API key from aistudio.google.com/apikey

## Changes Made (Session 2026-05-28)

### src/index.ts
1. **Admin password from env** â€” `_ADMIN_PW` read from `env.ADMIN_PASSWORD`, fallback `"2200"`
2. **Google type** â€” changed from `"openai"` to `"google"` in PROVIDERS
3. **Gemini format converters** â€” `oaiToGemini()` / `geminiToOai()` for request/response translation
4. **Proxy Google support** â€” `x-goog-api-key` header, `/v1beta/models/{model}:generateContent` endpoint
5. **Test-key / list-models / health-check** â€” all updated for Google-specific API
6. **Re-detect models endpoint** â€” `/admin/api/redetect-models`
7. **Analytics CSV export** â€” `?format=csv` query param
8. **Admin page cache-busting** â€” `Cache-Control: no-cache, no-store, must-revalidate`
9. **Server-side login endpoint** â€” `/admin/api/login` (POST) validates password, returns `Set-Cookie` header

### public/admin.html
1. Logs table: added Type column with color badges (error/evicted/expired)
2. New "Request Logs" tab with date picker, pagination, formatted table
3. "Models" (re-detect) button per key row
4. Analytics CSV export button
5. Setup tab: WEBHOOK_URL and ADMIN_PASSWORD sections added
6. Sidebar: added "Request Logs" nav item
7. **Login via POST to /admin/api/login** â€” server sets cookie via `Set-Cookie` header (fixes SameSite issues)

### wrangler.toml
- Added `ADMIN_PASSWORD = ''` in `[vars]`

## Changes Made (Session 2026-05-31 â€” Admin auth overhaul)

### src/index.ts
1. **`/v1/embeddings` endpoint** â€” `handleEmbeddings()` passthrough proxy. Auth, rate-limit, provider routing (skips Google-type). Calls `p.baseUrl + "/v1/embeddings"` with Bearer token. Cooldown on 429.
2. **Key rotation on 429** â€” `isKeyCooling()` / `setKeyCooling()` store KV cooldown `cooling:{provider}:{keyId}` with 60s TTL. `selectKey()` refactored to pre-filter usable+non-cooling keys, then apply strategy. Called on 429 in both `handleProxy` and `handleEmbeddings`.
3. **Anthropic `/v1/messages` endpoint** â€” `anthropicToOpenAI()` converts Anthropic format (system field, content blocks) to OpenAI messages. `openAIToAnthropic()` converts response back (finish_reasonâ†’stop_reason mapping, usage mapping). Handler clones request with converted body, calls `handleProxy()`, converts response.
4. **`const KEY_COOLDOWN_MS = 60000`** â€” cooling constant added next to `CB_COOLDOWN_MS`.
5. **Fixed ALL routes returning 500** â€” Changed `c.req` â†’ `c.req.raw` (native `Request`) in route handlers. `c.req.path` â†’ `new URL(c.req.url).pathname`. `no_bundle` removed from wrangler.toml. Wrangler pinned to `3.90.0`. Hono imported via npm package. **Root cause**: `c.req` (HonoRequest) was incompatible with wrangler's bundled output, causing 500 on any route passing `c.req` to a handler.

### public/admin.html
1. **Page descriptions** â€” `.page-desc` CSS style (blue left border, muted text). Added description box to each tab: Overview, API Keys (mentions CB + 429 cooldown), Gateway Keys, Strategy, Analytics, Usage & Limits, Settings, Health Check, Setup Guide.

### Deployment infrastructure
- Changed URL import (`https://esm.sh/hono@4.7.0`) â†’ npm import (`import { Hono } from 'hono'`) â€” avoids Workers runtime URL import rejection
- Removed `src/hono.bundle.mjs` (esm.sh local bundle file) â€” was causing `c.req` 500s
- Removed `no_bundle = true` from `wrangler.toml` â€” wrangler should bundle hono
- Pinned wrangler version to `3.90.0` in workflow â€” avoids v4 breaking changes
- Added `/diag` endpoint (later removed) â€” temporary diagnostic bypass

## Changes Made (Session 2026-05-31 â€” Admin auth + inline HTML)

### src/index.ts
1. **Default password changed** â€” `"2200"` â†’ `"itsgood"` (both fallback and hardcoded default)
2. **`LOGIN_PAGE` constant** â€” standalone login HTML page with `<form method="POST" action="/admin/api/login">`. Server-side form submission avoids JS fetch() cookie issues.
3. **`ADMIN_PAGE` constant** â€” dashboard HTML inlined as base64 string (decoded via `atob()`). Eliminates ASSETS binding edge-cache entirely. Login overlay, sessionStorage, `doLogin()`, `showLogin()`, `logout()`, `getPw()` removed from inlined JS. 401 handler shows toast instead of showing login overlay.
4. **`checkAdmin()` updated** â€” now checks both `Cookie` and `X-Admin-Auth` header.
5. **`/admin/api/login` rewritten** â€” accepts both JSON (`Content-Type: application/json`) and form-encoded bodies. Returns 302 redirect with `Set-Cookie` on success, 302 to `?error=1` on failure. Rate-limited (5 attempts/min/IP).
6. **`/admin` route rewritten** â€” no more `_ASSETS.fetch()`. Checks cookie â†’ serves `ADMIN_PAGE` if authed, `LOGIN_PAGE` (with optional error message) if not. `Cache-Control: no-cache`.
7. **`_ASSETS`, `_ADMIN_HTML_VER` removed** â€” no longer needed. `_ASSETS` variable, `_ADMIN_HTML_VER` counter, and ASSETS fetcher code all deleted.
8. **`Env` interface updated** â€” removed `ASSETS?: Fetcher` field.

### wrangler.toml
- Removed `assets = { directory = 'public', binding = 'ASSETS' }` line

### Deployment notes
- Single file deploy: only `src/index.ts` needs to be pushed (no static assets)
- No git/Node.js on dev machine â€” deploy via GitHub API

## Deployed commits
- `63d97443` â€” main feature changes (session 2026-05-28)
- `890ff1cf` â€” cache-busting headers fix
- `c5475f00` â€” server-side login endpoint with Set-Cookie
- `819261be` â€” add /v1/embeddings endpoint
- `04fbbaad` â€” add key rotation: cooling keys on 429
- `a97e4bd1` â€” add /v1/messages Anthropic endpoint
- `8300a67f` â€” add page descriptions to all admin dashboard tabs
- `7d3105ec` â€” revert to esm.sh URL with no_bundle (failed)
- `69aeb3b9` â€” add no_bundle to wrangler.toml (failed - syntax error)
- `e03fc169` â€” use c.req.raw (native Request) instead of c.req (HonoRequest) â€” **fixed the 500 bug**
- `44908fa1` â€” remove no_bundle, use npm import
- `ae1a9474` â€” pin wrangler version to 3.90.0
- `fb329642` â€” add /admin/api/keys-health endpoint
- `6789e19a` â€” show per-key health status on Keys page
- `a851ab42` â€” remove Secure flag, SameSite=Lax for login cookie
- `f7d4f89a` â€” buffer admin page (await resp.text()) to prevent truncation

## Known Issues
1. **Google Gemini not usable** â€” no API key configured (needs `gsk_...` key from aistudio.google.com)
2. **OpenRouter duplicate keys** â€” two keys with same label "sd" (possibly same key)
3. ~~**`const ADMIN_PASSWORD = "2200"`** â€” dead code~~ **Fixed** â€” removed `_ASSETS`, `_ADMIN_HTML_VER`, dead `_ASSETS` fetcher. HTML inlined via `ADMIN_PAGE` base64 constant.
4. **Cloudflare API token 401** â€” can't inspect worker status/settings directly
5. **Embeddings endpoint** â€” returns 502 for most models (only works if a provider has the embedding model)
6. **Admin page auth via `X-Admin-Auth` header** â€” only works for `/admin/api/*` routes, not for the `/admin` page itself (which uses cookies by design)

## Changes Made (Session 2026-05-31 â€” Admin fix)

### Root cause: Admin page JavaScript syntax error
- `ADMIN_PAGE_B64` (base64-encoded dashboard HTML) contained a stray closing brace `}` on line 239, followed by a duplicate API Keys `setContent()` block (lines 240-282), both outside any function.
- This caused a JS `SyntaxError: Unexpected token '}'`, preventing the ENTIRE `<script>` block from executing.
- All sidebar tabs (API Keys, Gateway Keys, Strategy, Analytics, etc.) silently failed to render because `showTab()` calls `PAGES[name].render()` which referenced undefined functions.

### Fix deployed at `d384c3e`
- Removed stray `}` (line 239) and duplicate API Keys `setContent()` block (lines 240-282) from the inlined HTML source.
- Verified all 9 `render*` functions are present in the cleaned output.
- Deployed via GitHub API push (no git/Node.js on dev machine).

### Verification
- `GET /admin` (no cookie) â†’ Login page (1812B OK)
- `POST /admin/api/login` with `password=itsgood` â†’ 302 + `Set-Cookie: bfadmin=itsgood`
- `GET /admin` with cookie â†’ Dashboard (42697B) with all render functions
- `GET /admin/api/stats` with cookie â†’ `{"requestsToday":3, ...}`
- `POST /v1/chat/completions` with master key â†’ 200 OK
- Failed login redirects to `/admin?error=1` with error message displayed
- Login page reads `?error=` query param to show/hide error div

## Saraha Brain â€” Full Phase Summary (Session 2026-06-01)

### Worker & Deploy
- **URL**: https://saraha-brain.richard-brown-miami.workers.dev
- **Repo**: `richardbrownmiami-commits/saraha-brain`
- **D1 DB**: `saraha-brain-db` (ID `4e4e5fde-2207-478a-b1ed-d55d6cc35a91`)
- **Deployment**: Cloudflare API PUT single-file (no sub-modules). METADATA includes all 6 bindings: DB (D1), BUDDHI_DWAR (service), SENTINEL (service), BRAIN_KEY (plain_text), BRAVE_API_KEY (plain_text), GITHUB_TOKEN (plain_text).
- **Service bindings**: `BUDDHI_DWAR` â†’ buddhi-dwar, `SENTINEL` â†’ saraha-sentinel (bypasses 1042 cross-worker fetch error)

### All Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Health + DB check |
| `/avatar` | GET | Animated SVG avatar with typewriter speech bubble |
| `/platform` | GET | Dashboard: emotions bars, energy gauge, recent activity, logs |
| `/monitor` | GET | Tool approval UI: pending/approve/deny for dangerous tools |
| `/think` | POST | Core cognition: classify â†’ assemble prompt â†’ LLM call â†’ tool execution â†’ emotion update â†’ store |
| `/evolve` | POST | Returns 501 (future self-improvement) |
| `/brain/emotions` | GET | Current emotion state + energy/confidence |
| `/brain/activity` | GET | Last 20 actions |
| `/brain/logs` | GET | Last 50 logs (or `?action_id=N`) |
| `/monitor/api/pending` | GET | Pending + history of tool approvals |
| `/monitor/api/approve` | POST | Approve pending tool `{id}` |
| `/monitor/api/deny` | POST | Deny pending tool `{id}` |

### Phase Status
| Phase | What | Status |
|-------|------|--------|
| **1** | Core brain: emotions (4-number system), regulator (energy/confidence), memory (store/recall), D1 tables | âœ… Done |
| **2aâ€“2c** | Sentinel created + deployed + tested (web_search/github_read safe, github_write dangerous) | âœ… Done |
| **2dâ€“2f** | Tools wired: TOOL: detection in /think, runTool â†’ Sentinel â†’ webSearch (Brave+DDG fallback) â†’ follow-up LLM | âœ… Done |
| **3** | Monitor page: pending_approvals D1 table, /monitor HTML, approve/deny endpoints, runTool stores pending on `safe: false` | âœ… Done |
| **4** | Platform dashboard: /platform HTML with emotions bars, energy gauge, activity table, log snippets, auto-refresh 10s | âœ… Done |
| **5** | CI/CD: wrangler.toml updated with all bindings, deploy workflow ready, CF_API_TOKEN as `vars.`, npm install, content-type fix | âœ… Done |
| **6** | GitHub tools: githubRead (safe, reads file content), githubWrite (dangerous â†’ needs Monitor approval) wired in runTool | âœ… Done |

### Tool Flow
1. LLM responds `TOOL:tool_name:input`
2. `/think` parses tool + input, calls `runTool(env, aid, tool, input)`
3. Sentinel classifies: safe â†’ execute | dangerous â†’ store `pending_approvals`, return "needs approval"
4. If safe: `web_search` â†’ Brave API (if key set) else DuckDuckGo fallback; `github_read` â†’ GitHub API; `github_write` â†’ GitHub API (but blocked by Sentinel as dangerous)
5. Follow-up LLM call with tool data â†’ synthesized answer
6. Emotions update: happy +1, energetic -1, energy -5 per answer

### Key Design Decisions
- **All logic inlined into index.ts** (~550 lines) â€” Cloudflare API multipart upload fails with sub-module imports
- **BRAIN_KEY as plain_text binding**, not `vars` â€” API metadata format: `{ type: "plain_text", name: "BRAIN_KEY", text: "..." }`
- **All 6 bindings in every deploy PUT** â€” redeploy without them silently removes existing bindings
- **Empty body â†’ 400** â€” `try { const body = await req.json(); } catch { return json({error}, 400); }`
- **Emotion caps**: energetic/intelligent/happy 1-10, bad 0-3, energy 0-100, confidence 0-100
- **Wrangler pinning**: wrangler 3.90.0 avoids v4 breaking changes

### Known Issues
1. **DuckDuckGo unreliable** from Cloudflare Workers (~50% timeout). Add Brave API key (`BRAVE_API_KEY` binding) to fix.
2. **GitHub Actions deploy** â€” `CF_API_TOKEN` variable set on both repos (`vars.CF_API_TOKEN`), deploy.yml updated to use `vars.` instead of `secrets.`. Source code committed to saraha-brain repo for CI/CD triggering.
3. **No auth on brain endpoints** â€” /brain/emotions, /brain/activity, /brain/logs, /monitor are public. Intentional for avatar UI.
4. **GITHUB_TOKEN** â€” deployed with actual GitHub token value. Tested: `github_read` works on buddhi-dwar repo (200), returns 404 on empty repos (saraha-brain has no committed files yet).
5. **GitHub token scope** â€” `github_read` on private repos or repos with different access may fail depending on token permissions.

### Fixes applied this session (2026-06-01)
- Empty body â†’ 400 (was 500)
- DuckDuckGo â†’ Brave Search API primary + DDG fallback
- TOOL: detection: `startsWith` â†’ `includes` (handles `<|python_tag|>TOOL:` wrappers)
- GitHub API: added `User-Agent: Saraha-Brain` header (required by GitHub API)
- `CF_API_TOKEN` set as `vars.CF_API_TOKEN` on both repos (avoids libsodium encryption requirement)
- Source committed to saraha-brain repo (index.ts, wrangler.toml, deploy.yml)
- All 6 bindings set in deploy metadata (DB, BUDDHI_DWAR, SENTINEL, BRAIN_KEY, BRAVE_API_KEY, GITHUB_TOKEN)

## Changes Made (Session 2026-06-01 â€” Autonomous Brain + DDG Lite)

### Autonomous brain driver
1. **Scheduled handler rewritten** â€” `/cron` route no longer just heartbeats. Every tick checks `busy_until` flag (set by `/think`), then picks phase:
   - **Sleeping** (1-6 AM UTC): replay random memory ("dreaming"), +15 energy
   - **Tired** (energy â‰¤ 20%): rest +10 energy
   - **Curious** (energy > 60% + energetic â‰¥ 6): auto-research â€” picks topic from learnings/memories, web searches, stores as learning
   - **Awake** (default): generate thought via LLM with context of emotions + recent thoughts + memories. If thought contains `TOOL:` and tool is safe (web_search, github_read), auto-execute + follow-up LLM. If dangerous, store as pending approval.
2. **`thought_stream` D1 table** â€” `id, content, mood, source, created_at`. Every autonomous thought stored here. `/brain/stream` (GET) returns latest 50 entries. Cron generates thoughts, approve handler also stores stream thoughts.
3. **`/brain/phase` (GET)** â€” returns current phase (awake/tired/curious/sleeping) + emotions + energy.
4. **`isToolSafe()` helper** â€” local Sentinel clone, checks tool name against safe list (no service call required).
5. **`busy_until` mechanism** â€” stored in identity table. `/think` sets it to current timestamp + 5min. Cron skips if busy. Prevents overlap.
6. **Approve re-executes tool + follow-up LLM** â€” approve handler now fetches stored tool params, rebuilds system prompt from current context, executes the tool directly (webSearch/githubRead/githubWrite), calls follow-up LLM, updates action with final answer, updates emotions, stores stream thought.

### DuckDuckGo switched to lite endpoint
- Changed from `html.duckduckgo.com/html/` to `lite.duckduckgo.com/lite/` with simpler regex parsing (`result-link` + `result-snippet` classes) for better reliability.

### CI/CD fixes
- Added `.github/workflows/**` to workflow paths filter
- Removed `cache: npm` (no package-lock.json in single-file project)
- Uses `npm install` instead of `npm ci`
- **Content-Type bug discovered**: Cloudflare API must use `application/javascript+module` (not `application/javascript`) for ES module workers. All previous CI/CD attempts failed silently with "Unexpected token 'export'" due to this.

### Cron schedule
- Set to `*/5 * * * *` via `PUT /accounts/:id/workers/scripts/:name/schedules` (body: raw JSON array `[{"cron":"*/5 * * * *"}]`). Later updated to `*/2 * * * *` for faster autonomous cycles.

### index.ts structure (grown to ~640 lines)
constants â†’ emotion/regulator/memory/webSearch/githubRead/githubWrite â†’ isToolSafe/getBrainPhase/getBusyUntil/setBusyUntil/storeStreamThought â†’ runTool â†’ classify â†’ AVATAR_HTML â†’ MONITOR_HTML â†’ DASHBOARD_HTML â†’ export default { fetch, scheduled }

### Verification
- `GET /brain/phase` â†’ `{"phase":"awake","emotions":{...},"energy":22}` (correct â€” energy 22% > 20, not sleeping, awake phase)
- Cron fired at 14:35 UTC â†’ autonomous thought generated: "I'm thinking that I've just started our conversation..."
- Thought stored in `thought_stream` with mood "awake"
- Energy dropped to 19% after thought generation (-3 energy), phase changed to "tired"
- `POST /think` works correctly (tested with file-based body after PowerShell encoding issue) â€” returns proper response with model, usage, emotions
- Emotions correctly tracking: energetic 1, intelligent 5, happy 10, bad 2

### Known Issues
1. DuckDuckGo lite reliability from Workers not yet verified (switched endpoint, needs observation)
2. No auth on brain endpoints â€” /brain/emotions, /brain/activity, /brain/logs, /monitor are public (intentional for now)
3. Cron set to `*/2 * * * *` â€” 2 minute cycles. Watch for 1008 CPU limit on Cloudflare Workers free plan (10ms CPU per invocation). Current handler is lightweight (DB reads + brief LLM calls through Buddhi Dwar).
