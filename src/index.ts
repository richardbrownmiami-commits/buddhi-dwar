const ADMIN_PASSWORD = "2200";
const DAY_MS = 86400000;
const EVICT_DAYS = 5;
let _BF: KVNamespace;
let _WEBHOOK_URL = "";
let __MASTER_KEY = "bf-master-kun-2026";

interface KeyEntry { id: string; apiKey: string; label: string; addedAt: number; }
type CBState = "closed" | "open" | "half-open";
interface HealthEntry { status: "active" | "warming" | "dead" | "expired"; cbState: CBState; lastCheck: number; consecutiveFailDays: number; consecutiveFailures: number; lastError: string; lastUsed: number; successCount: number; failCount: number; avgResponseTime: number; lastResponseTime: number; }
interface GatewayKey { word: string; provider: string; model: string; label: string; createdAt: number; enabled: boolean; usage: number; }
interface EvictionLog { id: string; provider: string; keyId: string; reason: string; evictedAt: number; }
interface ReqLog { model: string; provider: string; keyId: string; status: number; latencyMs: number; timestamp: number; promptTokens?: number; completionTokens?: number; cost?: number; }
interface DailyAnalytics { date: string; requests: number; successes: number; failures: number; totalLatencyMs: number; totalPromptTokens: number; totalCompletionTokens: number; totalCost: number; providerStats: Record<string, { requests: number; successes: number; failures: number; totalLatencyMs: number; totalPromptTokens: number; totalCompletionTokens: number; totalCost: number }>; }
type Strategy = "round-robin" | "lowest-latency" | "least-loaded";

/* â”€â”€ Rate Limiting â”€â”€ */
interface RateLimitConfig { maxRequests: number; windowMs: number; }
const DEFAULT_RATE_LIMIT: RateLimitConfig = { maxRequests: 60, windowMs: 60000 };

async function getRateLimit(word?: string): Promise<RateLimitConfig> {
  if (!word) return DEFAULT_RATE_LIMIT;
  const raw = await _BF.get("ratelimit:" + word, "json");
  return (raw as RateLimitConfig) || DEFAULT_RATE_LIMIT;
}
async function setRateLimit(word: string, cfg: RateLimitConfig) {
  await _BF.put("ratelimit:" + word, JSON.stringify(cfg));
}
async function checkRateLimit(key: string, cfg: RateLimitConfig): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
  const now = Date.now();
  const windowKey = "rl:" + key + ":" + Math.floor(now / cfg.windowMs);
  const raw = await _BF.get(windowKey);
  const count = raw ? parseInt(raw) : 0;
  if (count >= cfg.maxRequests) {
    const resetMs = cfg.windowMs - (now % cfg.windowMs);
    return { allowed: false, remaining: 0, resetMs };
  }
  await _BF.put(windowKey, (count + 1).toString(), { expirationTtl: Math.ceil(cfg.windowMs / 1000) });
  return { allowed: true, remaining: cfg.maxRequests - count - 1, resetMs: 0 };
}

async function getKeys(provider: string): Promise<KeyEntry[]> {
  const raw = await _BF.get("prov:" + provider + ":keys", "json");
  return (raw as any) || [];
}
async function setKeys(provider: string, keys: KeyEntry[]) {
  await _BF.put("prov:" + provider + ":keys", JSON.stringify(keys));
}
async function getHealth(provider: string, keyId: string): Promise<HealthEntry> {
  const raw = await _BF.get("prov:" + provider + ":health:" + keyId, "json");
  return (raw as any) || { status: "warming", cbState: "closed", lastCheck: 0, consecutiveFailDays: 0, consecutiveFailures: 0, lastError: "", lastUsed: 0, successCount: 0, failCount: 0, avgResponseTime: 0, lastResponseTime: 0 };
}
async function setHealth(provider: string, keyId: string, h: HealthEntry) {
  await _BF.put("prov:" + provider + ":health:" + keyId, JSON.stringify(h));
}
async function getRotation(provider: string): Promise<number> {
  const raw = await _BF.get("prov:" + provider + ":rotation");
  return raw ? parseInt(raw) : 0;
}
async function setRotation(provider: string, idx: number) {
  await _BF.put("prov:" + provider + ":rotation", idx.toString());
}
async function getStrategy(provider: string): Promise<Strategy> {
  const raw = await _BF.get("prov:" + provider + ":strategy");
  return (raw as Strategy) || "round-robin";
}
async function setStrategy(provider: string, s: Strategy) {
  await _BF.put("prov:" + provider + ":strategy", s);
}
async function getGwKey(word: string): Promise<GatewayKey | null> {
  const raw = await _BF.get("gw:" + word, "json");
  return (raw as any) || null;
}
async function setGwKey(word: string, gk: GatewayKey) {
  await _BF.put("gw:" + word, JSON.stringify(gk));
}
async function getAllGwKeys(): Promise<GatewayKey[]> {
  const list = await _BF.list({ prefix: "gw:" });
  const out: GatewayKey[] = [];
  for (const k of list.keys) {
    const v = await _BF.get(k.name, "json");
    if (v) out.push(v as any);
  }
  return out;
}
async function incrStat(date: string) {
  const k = "stat:req:" + date;
  const v = await _BF.get(k);
  await _BF.put(k, v ? (parseInt(v) + 1).toString() : "1");
}
function getToday() { return new Date().toISOString().slice(0, 10); }
async function getStat(date: string): Promise<number> {
  const v = await _BF.get("stat:req:" + date);
  return v ? parseInt(v) : 0;
}
async function logError(provider: string, keyId: string, error: string, message: string) {
  await _BF.put("log:err:" + Date.now(), JSON.stringify({ provider, keyId, error, message, ts: Date.now() }), { expirationTtl: 604800 });
}
async function logEviction(provider: string, keyId: string, reason: string) {
  const entry = { provider, keyId, reason, evictedAt: Date.now() };
  await _BF.put("log:evict:" + Date.now(), JSON.stringify(entry), { expirationTtl: 604800 });
  await sendWebhook("eviction", entry);
}
async function getRecentLogs(): Promise<any[]> {
  const list = await _BF.list({ prefix: "log:", limit: 100 });
  const out: any[] = [];
  for (const k of list.keys) {
    const v = await _BF.get(k.name, "json");
    if (v) out.push(v as any);
  }
  return out.sort((a: any, b: any) => (b.ts || b.evictedAt || 0) - (a.ts || a.evictedAt || 0));
}
function checkAdmin(req: Request): boolean {
  const c = req.headers.get("Cookie") || "";
  return c.includes("bfadmin=" + ADMIN_PASSWORD);
}
function getBearer(req: Request): string | null {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function logRequest(rl: ReqLog) {
  const key = "reqlog:" + getToday() + ":" + Date.now();
  await _BF.put(key, JSON.stringify(rl), { expirationTtl: 604800 });
}

async function updateAnalytics(rl: ReqLog) {
  const key = "analytics:" + getToday();
  const raw = await _BF.get(key, "json");
  const a: DailyAnalytics = (raw as any) || { date: getToday(), requests: 0, successes: 0, failures: 0, totalLatencyMs: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalCost: 0, providerStats: {} };
  a.requests++;
  if (rl.status >= 200 && rl.status < 400) a.successes++; else a.failures++;
  a.totalLatencyMs += rl.latencyMs;
  const pt = rl.promptTokens || 0; const ct = rl.completionTokens || 0; const c = rl.cost || 0;
  a.totalPromptTokens += pt; a.totalCompletionTokens += ct; a.totalCost += c;
  if (!a.providerStats[rl.provider]) a.providerStats[rl.provider] = { requests: 0, successes: 0, failures: 0, totalLatencyMs: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalCost: 0 };
  a.providerStats[rl.provider].requests++;
  if (rl.status >= 200 && rl.status < 400) a.providerStats[rl.provider].successes++; else a.providerStats[rl.provider].failures++;
  a.providerStats[rl.provider].totalLatencyMs += rl.latencyMs;
  a.providerStats[rl.provider].totalPromptTokens += pt; a.providerStats[rl.provider].totalCompletionTokens += ct; a.providerStats[rl.provider].totalCost += c;
  await _BF.put(key, JSON.stringify(a), { expirationTtl: 86400 * 30 });
}

async function sendWebhook(event: string, data: any) {
  try {
    if (!_WEBHOOK_URL) return;
    const payload = {
      content: null,
      embeds: [{
        title: event === "eviction" ? "Key Evicted" : "Key Auth Failure",
        color: event === "eviction" ? 0xff4444 : 0xffaa00,
        fields: Object.entries(data).map(([k, v]) => ({ name: k, value: String(v), inline: true })),
        timestamp: new Date().toISOString()
      }]
    };
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e) { /* silent */ }
}

const PROVIDERS = [
  { name: "openai", baseUrl: "https://api.openai.com", type: "openai", models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo", "o1", "o1-mini", "o3-mini"] },
  { name: "anthropic", baseUrl: "https://api.anthropic.com", type: "openai", models: ["claude-3-5-sonnet", "claude-3-opus", "claude-3-sonnet", "claude-3-haiku"] },
  { name: "google", baseUrl: "https://generativelanguage.googleapis.com", type: "openai", models: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro", "gemini-1.5-flash"] },
  { name: "deepseek", baseUrl: "https://api.deepseek.com", type: "openai", models: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "groq", baseUrl: "https://api.groq.com/openai", type: "openai", models: ["llama-3.3-70b", "llama-3.1-8b", "mixtral-8x7b", "deepseek-r1-distill"] },
  { name: "mistral", baseUrl: "https://api.mistral.ai", type: "openai", models: ["mistral-large", "mistral-small", "codestral"] },
  { name: "openrouter", baseUrl: "https://openrouter.ai/api", type: "openai", models: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-2.0-flash", "deepseek/deepseek-r1", "meta-llama/llama-3.3-70b"] },
];

/* â”€â”€ Token Counting & Pricing â”€â”€ */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 }, "gpt-4o-mini": { input: 0.15, output: 0.6 }, "gpt-4-turbo": { input: 10, output: 30 }, "gpt-4": { input: 30, output: 60 }, "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1": { input: 15, output: 60 }, "o1-mini": { input: 1.1, output: 4.4 }, "o3-mini": { input: 1.1, output: 4.4 },
  "claude-3-5-sonnet": { input: 3, output: 15 }, "claude-3-opus": { input: 15, output: 75 }, "claude-3-sonnet": { input: 3, output: 15 }, "claude-3-haiku": { input: 0.25, output: 1.25 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 }, "gemini-2.0-pro": { input: 2, output: 8 }, "gemini-1.5-pro": { input: 3.5, output: 10.5 }, "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "deepseek-chat": { input: 0.14, output: 0.28 }, "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "llama-3.3-70b": { input: 0.59, output: 0.79 }, "llama-3.1-8b": { input: 0.05, output: 0.08 }, "mixtral-8x7b": { input: 0.24, output: 0.24 }, "deepseek-r1-distill": { input: 0.5, output: 0.5 },
  "mistral-large": { input: 2, output: 6 }, "mistral-small": { input: 0.2, output: 0.6 }, "codestral": { input: 1, output: 3 },
};
function getPrice(model: string): { input: number; output: number } {
  const key = Object.keys(MODEL_PRICING).find(k => model.toLowerCase().includes(k.toLowerCase()));
  return key ? MODEL_PRICING[key] : { input: 1, output: 2 };
}
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = getPrice(model);
  return (promptTokens * p.input + completionTokens * p.output) / 1000000;
}

interface Env { BF: KVNamespace; WEBHOOK_URL?: string; }

const CB_COOLDOWN_MS = 300000; // 5 min cooldown before half-open probe

function isKeyUsable(h: HealthEntry): boolean {
  if (h.status === "expired") return false;
  if (h.cbState === "open") {
    if (Date.now() - h.lastCheck > CB_COOLDOWN_MS) return true; // allow probe
    return false;
  }
  if (h.cbState === "half-open") return h.consecutiveFailures < 3;
  return h.status !== "dead";
}

async function selectKey(provider: string, keys: KeyEntry[], strategy: Strategy): Promise<{ key: KeyEntry; index: number } | null> {
  if (!keys.length) return null;
  if (strategy === "round-robin") {
    const idx = await getRotation(provider);
    for (let i = 0; i < keys.length; i++) {
      const ki = (idx + i) % keys.length;
      const h = await getHealth(provider, keys[ki].id);
      if (isKeyUsable(h)) return { key: keys[ki], index: ki };
    }
    return null;
  }
  if (strategy === "lowest-latency") {
    let best: { key: KeyEntry; index: number; latency: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      const h = await getHealth(provider, keys[i].id);
      if (!isKeyUsable(h)) continue;
      const lat = h.avgResponseTime || Infinity;
      if (!best || lat < best.latency) best = { key: keys[i], index: i, latency: lat };
    }
    return best ? { key: best.key, index: best.index } : null;
  }
  if (strategy === "least-loaded") {
    let best: { key: KeyEntry; index: number; ratio: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      const h = await getHealth(provider, keys[i].id);
      if (!isKeyUsable(h)) continue;
      const total = h.successCount + h.failCount;
      const ratio = total > 0 ? h.failCount / total : 0;
      if (!best || ratio < best.ratio) best = { key: keys[i], index: i, ratio };
    }
    return best ? { key: best.key, index: best.index } : null;
  }
  return null;
}

/* â”€â”€ Streaming Timeout â”€â”€ */
function streamWithTimeout(readable: ReadableStream, timeoutMs: number = 60000): ReadableStream {
  const reader = readable.getReader();
  return new ReadableStream({
    async pull(ctrl) {
      const timer = setTimeout(() => ctrl.error(new Error("stream timeout")), timeoutMs);
      try {
        const { done, value } = await reader.read();
        clearTimeout(timer);
        if (done) ctrl.close(); else ctrl.enqueue(value);
      } catch (e) { clearTimeout(timer); ctrl.error(e); }
    },
    cancel() { reader.cancel(); }
  });
}

/* â”€â”€ Response Caching â”€â”€ */
interface CacheConfig { ttlSeconds: number; enabled: boolean; }
const DEFAULT_CACHE: CacheConfig = { ttlSeconds: 300, enabled: false };
async function getCacheCfg(): Promise<CacheConfig> {
  const raw = await _BF.get("cache:config", "json");
  return (raw as CacheConfig) || DEFAULT_CACHE;
}
async function setCacheCfg(cfg: CacheConfig) {
  await _BF.put("cache:config", JSON.stringify(cfg));
}
function cacheKey(body: any): string {
  const h = String(body.model) + ":" + JSON.stringify(body.messages) + ":" + (body.temperature ?? "") + ":" + (body.max_tokens ?? "") + ":" + (body.top_p ?? "");
  let hash = 0;
  for (let i = 0; i < h.length; i++) { const c = h.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
  return "cache:" + hash.toString(36);
}
async function getCached(key: string): Promise<string | null> {
  return await _BF.get(key);
}
async function setCached(key: string, data: string, ttl: number) {
  await _BF.put(key, data, { expirationTtl: ttl });
}

async function handleProxy(req: Request): Promise<Response> {
  const start = Date.now();
  try {
    const key = getBearer(req);
    if (!key) return new Response(JSON.stringify({ error: "missing auth" }), { status: 401, headers: { "content-type": "application/json" } });
    if (key !== _MASTER_KEY) {
      const gw = await getGwKey(key);
      if (!gw || !gw.enabled) return new Response(JSON.stringify({ error: "invalid gateway key" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const rlCfg = key !== _MASTER_KEY ? await getRateLimit(key) : await getRateLimit();
    const rl = await checkRateLimit(key, rlCfg);
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "rate limit exceeded", retryAfterMs: rl.resetMs }), { status: 429, headers: { "content-type": "application/json", "Retry-After": String(Math.ceil(rl.resetMs / 1000)), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(rl.resetMs) } });
    }
    const body = await req.json() as any;
    const model = body.model || "";
    const isStream = body.stream === true;
    const candidates = PROVIDERS.filter((pr: any) => pr.models.some((m: string) => model.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(model.toLowerCase().split("/").pop() || "")));
    if (!candidates.length) return new Response(JSON.stringify({ error: "unsupported model: " + model }), { status: 400, headers: { "content-type": "application/json" } });
    const cacheCfg = await getCacheCfg();
    if (cacheCfg.enabled && !isStream) {
      const ck = cacheKey(body);
      const cached = await getCached(ck);
      if (cached) return new Response(cached, { headers: { "content-type": "application/json", "X-Cache": "HIT", "access-control-allow-origin": "*" } });
    }
    const lastErrors: string[] = [];
    for (const p of candidates) {
      const keys = await getKeys(p.name);
      if (!keys.length) { lastErrors.push(p.name + ":no_keys"); continue; }
      const strategy = await getStrategy(p.name);
      const selected = await selectKey(p.name, keys, strategy);
      if (!selected) { lastErrors.push(p.name + ":no_healthy"); continue; }
      const ke = selected.key;
      const h = await getHealth(p.name, ke.id);
      try {
        const targetUrl = p.baseUrl + (p.type === "openai" ? "/chat/completions" : "");
        const hdrs: any = { "Content-Type": "application/json" };
        if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
        const resp = await fetch(targetUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        const latency = Date.now() - start;
        const promptText = JSON.stringify(body.messages || "");
        const promptTokens = estimateTokens(promptText);
        let completionTokens = 0;
        if (resp.ok) {
          const clone = resp.clone();
          try { const json = await clone.json() as any; completionTokens = json.usage?.completion_tokens || estimateTokens(JSON.stringify(json.choices?.[0]?.message?.content || "")); } catch { completionTokens = 0; }
        }
        const cost = estimateCost(model, promptTokens, completionTokens);
        const rl: ReqLog = { model, provider: p.name, keyId: ke.id, status: resp.status, latencyMs: latency, timestamp: Date.now(), promptTokens, completionTokens, cost };
        await logRequest(rl);
        await updateAnalytics(rl);
        if (resp.ok) {
          await setRotation(p.name, (selected.index + 1) % keys.length);
          h.status = "active"; h.cbState = "closed"; h.consecutiveFailures = 0; h.successCount++; h.lastUsed = Date.now(); h.lastCheck = Date.now();
          h.lastResponseTime = latency;
          h.avgResponseTime = h.avgResponseTime ? Math.round((h.avgResponseTime * (h.successCount - 1) + latency) / h.successCount) : latency;
          await setHealth(p.name, ke.id, h);
          await incrStat(getToday());
          if (cacheCfg.enabled && !isStream) {
            const txt = await resp.clone().text();
            await setCached(cacheKey(body), txt, cacheCfg.ttlSeconds);
          }
          if (isStream) {
            const stream = streamWithTimeout(resp.body!, 60000);
            return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" } });
          }
          return resp;
        }
        const txt = await resp.text();
        h.failCount++; h.lastError = resp.status + ": " + txt.slice(0, 200); h.lastCheck = Date.now();
        if (resp.status === 401 || resp.status === 403) { h.consecutiveFailDays++; } else { h.consecutiveFailures++; }
        if (h.consecutiveFailures >= 5) h.cbState = "open";
        await setHealth(p.name, ke.id, h);
        lastErrors.push(p.name + ":" + resp.status);
        if (resp.status === 401 || resp.status === 403) {
          await sendWebhook("auth_failure", { provider: p.name, keyId: ke.id, status: resp.status });
          await logError(p.name, ke.id, "auth", resp.status + ": " + txt.slice(0, 200));
        }
      } catch (e: any) {
        const latency = Date.now() - start;
        const promptText = JSON.stringify(body.messages || "");
        const promptTokens = estimateTokens(promptText);
        const rl: ReqLog = { model, provider: p.name, keyId: ke.id, status: 0, latencyMs: latency, timestamp: Date.now(), promptTokens, completionTokens: 0, cost: estimateCost(model, promptTokens, 0) };
        await logRequest(rl); await updateAnalytics(rl);
        h.failCount++; h.lastError = e.message; h.lastCheck = Date.now(); h.consecutiveFailures++;
        if (h.consecutiveFailures >= 5) h.cbState = "open";
        await setHealth(p.name, ke.id, h);
        await logError(p.name, ke.id, "network", e.message);
        lastErrors.push(p.name + ":error:" + e.message.slice(0, 50));
      }
    }
    return new Response(JSON.stringify({ error: "all providers failed", details: lastErrors }), { status: 502, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "gateway error: " + e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

async function handleModels(): Promise<Response> {
  const all: any[] = [];
  for (const p of PROVIDERS) {
    all.push(...p.models.map((m: string) => ({ id: m, provider: p.name, object: "model", created: Date.now(), owned_by: "bifrost" })));
  }
  return new Response(JSON.stringify({ object: "list", data: all }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

async function handleAdminApi(req: Request, path: string): Promise<Response> {
  if (!checkAdmin(req)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  const url = new URL(req.url);

  if (path === "/admin/api/providers") {
    if (req.method === "GET") return new Response(JSON.stringify(PROVIDERS), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/keys") {
    if (req.method === "GET") {
      const result: any = {};
      for (const p of PROVIDERS) result[p.name] = await getKeys(p.name);
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any;
      const { pname, apiKey, label } = body;
      if (!pname || !apiKey) return new Response(JSON.stringify({ error: "provider and apiKey required" }), { status: 400, headers: { "content-type": "application/json" } });
      const keys = await getKeys(pname);
      const id = Date.now().toString(36);
      keys.push({ id, apiKey, label: label || "key-" + keys.length, addedAt: Date.now() });
      await setKeys(pname, keys);
      return new Response(JSON.stringify({ ok: true, id }), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "DELETE") {
      const body = await req.json() as any;
      const { pname, id } = body;
      if (!pname || !id) return new Response(JSON.stringify({ error: "provider and id required" }), { status: 400, headers: { "content-type": "application/json" } });
      let keys = await getKeys(pname);
      keys = keys.filter((k: any) => k.id !== id);
      await setKeys(pname, keys);
      await logEviction(pname, id, "manual_remove");
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/gateway-keys") {
    if (req.method === "GET") {
      const gws = await getAllGwKeys();
      return new Response(JSON.stringify(gws), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (!body.word || !body.provider) return new Response(JSON.stringify({ error: "word and provider required" }), { status: 400, headers: { "content-type": "application/json" } });
      const gw: GatewayKey = { word: body.word, provider: body.provider, model: body.model || "", label: body.label || body.word, createdAt: Date.now(), enabled: true, usage: 0 };
      await setGwKey(body.word, gw);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "DELETE") {
      const body = await req.json() as any;
      if (!body.word) return new Response(JSON.stringify({ error: "word required" }), { status: 400, headers: { "content-type": "application/json" } });
      await _BF.delete("gw:" + body.word);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "PATCH") {
      const body = await req.json() as any;
      if (!body.word) return new Response(JSON.stringify({ error: "word required" }), { status: 400, headers: { "content-type": "application/json" } });
      const gw = await getGwKey(body.word);
      if (!gw) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
      if (body.enabled !== undefined) gw.enabled = body.enabled;
      if (body.model) gw.model = body.model;
      if (body.label) gw.label = body.label;
      await setGwKey(body.word, gw);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/strategy") {
    if (req.method === "GET") {
      const result: any = {};
      for (const p of PROVIDERS) result[p.name] = await getStrategy(p.name);
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (!body.pname || !body.strategy) return new Response(JSON.stringify({ error: "pname and strategy required" }), { status: 400, headers: { "content-type": "application/json" } });
      await setStrategy(body.pname, body.strategy);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/rate-limits") {
    if (req.method === "GET") {
      const word = url.searchParams.get("word");
      if (word) return new Response(JSON.stringify(await getRateLimit(word)), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(DEFAULT_RATE_LIMIT), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (!body.word || !body.maxRequests) return new Response(JSON.stringify({ error: "word and maxRequests required" }), { status: 400, headers: { "content-type": "application/json" } });
      await setRateLimit(body.word, { maxRequests: body.maxRequests, windowMs: body.windowMs || 60000 });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/cache") {
    if (req.method === "GET") return new Response(JSON.stringify(await getCacheCfg()), { headers: { "content-type": "application/json" } });
    if (req.method === "POST") {
      const body = await req.json() as any;
      await setCacheCfg({ ttlSeconds: body.ttlSeconds ?? 300, enabled: body.enabled ?? false });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/stats") {
    const today = getToday();
    const reqsToday = await getStat(today);
    let totalKeys = 0; let activeKeys = 0; let deadKeys = 0; let warmingKeys = 0; let expiredKeys = 0;
    for (const p of PROVIDERS) {
      const keys = await getKeys(p.name);
      totalKeys += keys.length;
      for (const k of keys) {
        const h = await getHealth(p.name, k.id);
        if (h.status === "active") activeKeys++;
        else if (h.status === "dead") deadKeys++;
        else if (h.status === "expired") expiredKeys++;
        else warmingKeys++;
      }
    }
    return new Response(JSON.stringify({ requestsToday: reqsToday, totalKeys, activeKeys, deadKeys, warmingKeys, expiredKeys }), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/logs") {
    const logs = await getRecentLogs();
    return new Response(JSON.stringify(logs), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/request-logs") {
    const date = url.searchParams.get("date") || getToday();
    const list = await _BF.list({ prefix: "reqlog:" + date + ":", limit: 200 });
    const out: ReqLog[] = [];
    for (const k of list.keys) {
      const v = await _BF.get(k.name, "json");
      if (v) out.push(v as any);
    }
    return new Response(JSON.stringify(out.sort((a, b) => b.timestamp - a.timestamp)), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/analytics") {
    const days = parseInt(url.searchParams.get("days") || "7");
    const result: DailyAnalytics[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = "analytics:" + d.toISOString().slice(0, 10);
      const raw = await _BF.get(key, "json");
      if (raw) result.unshift(raw as any);
    }
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/test-key") {
    const body = await req.json() as any;
    const { pname, id } = body;
    if (!pname || !id) return new Response(JSON.stringify({ error: "provider and id required" }), { status: 400, headers: { "content-type": "application/json" } });
    const keys = await getKeys(pname);
    const ke = keys.find((k: any) => k.id === id);
    if (!ke) return new Response(JSON.stringify({ error: "key not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const p = PROVIDERS.find((pr: any) => pr.name === pname);
    if (!p) return new Response(JSON.stringify({ error: "provider not found" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const hdrs: any = { "Content-Type": "application/json" };
      if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
      const testBody = { model: p.models[0], messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
      const resp = await fetch(p.baseUrl + "/chat/completions", { method: "POST", headers: hdrs, body: JSON.stringify(testBody) });
      const h = await getHealth(pname, ke.id);
      if (resp.ok) {
        h.status = "active"; h.lastCheck = Date.now(); h.consecutiveFailDays = 0; h.lastError = "";
        await setHealth(pname, ke.id, h);
        return new Response(JSON.stringify({ ok: true, status: resp.status }), { headers: { "content-type": "application/json" } });
      } else {
        const txt = await resp.text();
        h.lastError = resp.status + ": " + txt.slice(0, 200); h.lastCheck = Date.now();
        if (resp.status === 401 || resp.status === 403) h.consecutiveFailDays++;
        await setHealth(pname, ke.id, h);
        return new Response(JSON.stringify({ ok: false, status: resp.status, error: txt.slice(0, 200) }), { headers: { "content-type": "application/json" } });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/health-check") {
    const results: any[] = [];
    for (const p of PROVIDERS) {
      const keys = await getKeys(p.name);
      for (const k of keys) {
        const h = await getHealth(p.name, k.id);
        try {
          const hdrs: any = { "Content-Type": "application/json" };
          if (p.type === "openai") hdrs["Authorization"] = "Bearer " + k.apiKey;
          const testBody = { model: p.models[0], messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
          const resp = await fetch(p.baseUrl + "/chat/completions", { method: "POST", headers: hdrs, body: JSON.stringify(testBody) });
          results.push({ provider: p.name, keyId: k.id, label: k.label, status: resp.ok ? "ok" : "fail", httpStatus: resp.status, cbState: h.cbState });
        } catch (e: any) {
          results.push({ provider: p.name, keyId: k.id, label: k.label, status: "error", error: e.message, cbState: h.cbState });
        }
      }
    }
    return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin" || path === "/admin/") {
    const today = getToday();
    const reqsToday = await getStat(today);
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Buddhi Dwar Admin</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px}
h1{color:#38bdf8;margin-bottom:8px}.sub{color:#94a3b8;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.card{background:#1e293b;border-radius:8px;padding:16px}.card .num{font-size:28px;font-weight:700;color:#38bdf8}
.card .lbl{font-size:13px;color:#94a3b8;margin-top:4px}
nav{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}
nav a{color:#e2e8f0;text-decoration:none;background:#1e293b;padding:8px 16px;border-radius:6px;font-size:14px}
nav a:hover{background:#334155}
section{background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px;display:none}
section.active{display:block}h2{color:#38bdf8;margin-bottom:12px;font-size:18px}
pre{background:#0f172a;padding:12px;border-radius:6px;overflow:auto;font-size:13px;max-height:400px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid #334155}
th{color:#94a3b8;font-weight:600}input,select{padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;margin:4px}
button{padding:8px 16px;border-radius:6px;border:none;background:#38bdf8;color:#0f172a;font-weight:600;cursor:pointer;margin:4px}
button.danger{background:#ef4444}.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.tag.ok{background:#166534;color:#86efac}.tag.fail{background:#991b1b;color:#fca5a5}.tag.active{background:#1e40af;color:#93c5fd}
.tag.warning{background:#92400e;color:#fde68a}.tag.dead{background:#7c3aed;color:#ddd6fe}
</style></head><body>
<h1>ðŸª· Buddhi Dwar</h1><p class="sub">AI API Gateway â€” Admin Dashboard</p>
<div class="cards"><div class="card"><div class="num">${reqsToday}</div><div class="lbl">Requests Today</div></div></div>
<nav>
<a href="#" onclick="showTab('overview')" class="active-tab" id="nav-overview">Overview</a>
<a href="#" onclick="showTab('keys')" id="nav-keys">API Keys</a>
<a href="#" onclick="showTab('gateway')" id="nav-gateway">Gateway Keys</a>
<a href="#" onclick="showTab('strategy')" id="nav-strategy">Strategy</a>
<a href="#" onclick="showTab('logs')" id="nav-logs">Logs</a>
<a href="#" onclick="showTab('analytics')" id="nav-analytics">Analytics</a>
<a href="#" onclick="showTab('settings')" id="nav-settings">Settings</a>
</nav>

<section id="tab-overview" class="active"><h2>Overview</h2><pre id="overview-data">Loading...</pre></section>
<section id="tab-keys"><h2>API Keys</h2><div id="keys-data">Loading...</div></section>
<section id="tab-gateway"><h2>Gateway Keys</h2><div id="gw-data">Loading...</div></section>
<section id="tab-strategy"><h2>Routing Strategy</h2><div id="strategy-data">Loading...</div></section>
<section id="tab-logs"><h2>Recent Logs</h2><pre id="logs-data">Loading...</pre></section>
<section id="tab-analytics"><h2>Analytics</h2><pre id="analytics-data">Loading...</pre></section>
<section id="tab-settings"><h2>Settings</h2><pre id="settings-data">Loading...</pre></section>

<script>
const ADMIN_PW = "${ADMIN_PASSWORD}";
function api(path, opts){return fetch('/admin/api'+path,{headers:{'Cookie':'bfadmin='+ADMIN_PW,...(opts||{}).headers},...(opts||{})}).then(r=>r.json())}
function showTab(name){document.querySelectorAll('section').forEach(s=>s.classList.remove('active'));document.querySelectorAll('nav a').forEach(a=>a.style.background='');const el=document.getElementById('tab-'+name);if(el)el.classList.add('active');const nav=document.getElementById('nav-'+name);if(nav)nav.style.background='#334155';}

async function loadOverview(){const s=await api('/stats');document.getElementById('overview-data').textContent=JSON.stringify(s,null,2)}
async function loadKeys(){const k=await api('/keys');let h='<table><tr><th>Provider</th><th>ID</th><th>Label</th><th>Status</th><th>CB</th><th>Actions</th></tr>';
for(const[prov,keys]of Object.entries(k)){for(const key of keys){const s=await api('/test-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pname:prov,id:key.id})});const st=s.ok?'ok':'fail';h+='<tr><td>'+prov+'</td><td style="font-size:12px">'+key.id+'</td><td>'+(key.label||'')+'</td><td><span class="tag '+(st==='ok'?'ok':'fail')+'">'+st+'</span></td><td>-</td><td><button onclick="deleteKey(\\''+prov+'\\',\\''+key.id+'\\')" class="danger">Del</button></td></tr>'}}
h+='</table>';document.getElementById('keys-data').innerHTML=h}
async function deleteKey(p,id){if(!confirm('Delete key?'))return;await api('/keys',{method:'DELETE',body:JSON.stringify({pname:p,id:id})});loadKeys()}

async function loadGw(){const g=await api('/gateway-keys');let h='<table><tr><th>Word</th><th>Provider</th><th>Model</th><th>Enabled</th><th>Usage</th><th>Actions</th></tr>';
for(const gw of g){h+='<tr><td>'+gw.word+'</td><td>'+(gw.provider||'')+'</td><td>'+(gw.model||'')+'</td><td>'+(gw.enabled?'âœ…':'âŒ')+'</td><td>'+(gw.usage||0)+'</td><td><button onclick="toggleGw(\\''+gw.word+'\\','+!gw.enabled+')" class="'+(gw.enabled?'danger':'')+'">'+(gw.enabled?'Disable':'Enable')+'</button> <button onclick="deleteGw(\\''+gw.word+'\\')" class="danger">Del</button></td></tr>'}
h+='</table>';document.getElementById('gw-data').innerHTML=h}
async function toggleGw(w,e){await api('/gateway-keys',{method:'PATCH',body:JSON.stringify({word:w,enabled:e})});loadGw()}
async function deleteGw(w){if(!confirm('Delete gateway key?'))return;await api('/gateway-keys',{method:'DELETE',body:JSON.stringify({word:w})});loadGw()}

async function loadStrategy(){const s=await api('/strategy');document.getElementById('strategy-data').textContent=JSON.stringify(s,null,2)}
async function loadLogs(){const l=await api('/logs');document.getElementById('logs-data').textContent=JSON.stringify(l,null,2)}
async function loadAnalytics(){const a=await api('/analytics?days=7');document.getElementById('analytics-data').textContent=JSON.stringify(a,null,2)}
async function loadSettings(){const c=await api('/cache');document.getElementById('settings-data').textContent=JSON.stringify(c,null,2)}

loadOverview();loadKeys();loadGw();loadStrategy();loadLogs();loadAnalytics();loadSettings();
</script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
  }

  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
}

async function handleCron() {
  for (const p of PROVIDERS) {
    let keys = await getKeys(p.name);
    let changed = false;
    const cutoff = Date.now() - EVICT_DAYS * DAY_MS;
    for (let i = keys.length - 1; i >= 0; i--) {
      const h = await getHealth(p.name, keys[i].id);
      if (h.status === "expired" || h.lastUsed > 0 && h.lastUsed < cutoff) {
        await logEviction(p.name, keys[i].id, h.status === "expired" ? "expired" : "inactive");
        keys.splice(i, 1);
        changed = true;
      }
    }
    if (changed) await setKeys(p.name, keys);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    _BF = env.BF;
    _WEBHOOK_URL = env.WEBHOOK_URL || "";
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.match(/^\/(v1\/)?chat\/completions$/)) return handleProxy(req);
    if (path.match(/^\/(v1\/)?models$/)) return handleModels();
    if (path.startsWith("/admin")) return handleAdminApi(req, path);
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    _BF = env.BF;
    _WEBHOOK_URL = env.WEBHOOK_URL || "";
    await handleCron();
  },
};
