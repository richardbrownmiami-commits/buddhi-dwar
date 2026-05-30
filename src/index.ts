import { Hono } from 'hono';
const DAY_MS = 86400000;
const EVICT_DAYS = 5;
let _BF: KVNamespace;
let _WEBHOOK_URL = "";
let __MASTER_KEY = "bf-master-kun-2026";
let _ADMIN_PW = "itsgood";

interface KeyEntry { id: string; apiKey: string; label: string; addedAt: number; models?: string[]; }
type CBState = "closed" | "open" | "half-open";
interface HealthEntry { status: "active" | "warming" | "dead" | "expired"; cbState: CBState; lastCheck: number; consecutiveFailDays: number; consecutiveFailures: number; lastError: string; lastUsed: number; successCount: number; failCount: number; avgResponseTime: number; lastResponseTime: number; }
interface GatewayKey { word: string; label: string; createdAt: number; enabled: boolean; usage: number; }
interface ReqLog { model: string; provider: string; keyId: string; status: number; latencyMs: number; timestamp: number; promptTokens?: number; completionTokens?: number; cost?: number; }
interface DailyAnalytics { date: string; requests: number; successes: number; failures: number; totalLatencyMs: number; totalPromptTokens: number; totalCompletionTokens: number; totalCost: number; providerStats: Record<string, { requests: number; successes: number; failures: number; totalLatencyMs: number; totalPromptTokens: number; totalCompletionTokens: number; totalCost: number }>; }
type Strategy = "round-robin" | "lowest-latency" | "least-loaded";
interface ProviderConfig { name: string; baseUrl: string; type: "openai" | "google"; models: string[]; }
interface KeyUsage { date: string; requests: number; successes: number; failures: number; promptTokens: number; completionTokens: number; cost: number; }
const DEFAULT_PROVIDER_LIMITS: Record<string, { dailyRequests: number; dailyTokens: number; monthlyCostUSD: number }> = {
  groq: { dailyRequests: 14400, dailyTokens: 1000000, monthlyCostUSD: 0 },
  google: { dailyRequests: 1500, dailyTokens: 1000000, monthlyCostUSD: 0 },
  mistral: { dailyRequests: 5000, dailyTokens: 500000, monthlyCostUSD: 0 },
  openrouter: { dailyRequests: 500, dailyTokens: 200000, monthlyCostUSD: 5 },
  deepseek: { dailyRequests: 5000, dailyTokens: 1000000, monthlyCostUSD: 0 },
  together: { dailyRequests: 5000, dailyTokens: 1000000, monthlyCostUSD: 0 },
};

/* ── Rate Limiting ── */
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
  await _BF.put(k, v ? (parseInt(v) + 1).toString() : "1", { expirationTtl: 86400 * 30 });
}
function getToday() { return new Date().toISOString().slice(0, 10); }
async function getStat(date: string): Promise<number> {
  const v = await _BF.get("stat:req:" + date);
  return v ? parseInt(v) : 0;
}
function checkAdmin(req: Request): boolean {
  const c = req.headers.get("Cookie") || "";
  if (c.includes("bfadmin=" + _ADMIN_PW)) return true;
  const auth = req.headers.get("X-Admin-Auth") || "";
  return auth === _ADMIN_PW;
}
function maskKey(k: string): string { return k.length > 8 ? k.slice(0, 3) + "****" + k.slice(-4) : "****"; }
async function checkLoginRate(ip: string): Promise<boolean> {
  const raw = await _BF.get("login:rl:" + ip);
  if (raw) { const entry = JSON.parse(raw); if (entry.count >= 5) return false; }
  return true;
}
async function recordLoginAttempt(ip: string) {
  const raw = await _BF.get("login:rl:" + ip);
  const entry = raw ? JSON.parse(raw) : { count: 0 };
  entry.count++;
  await _BF.put("login:rl:" + ip, JSON.stringify(entry), { expirationTtl: 60 });
}
function getBearer(req: Request): string | null {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
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
    await fetch(_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e) { /* silent */ }
}

const PROVIDERS = [
  { name: "groq", baseUrl: "https://api.groq.com/openai", type: "openai", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { name: "google", baseUrl: "https://generativelanguage.googleapis.com", type: "google", models: ["gemini-2.0-flash"] },
  { name: "openrouter", baseUrl: "https://openrouter.ai/api", type: "openai", models: ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-v4-flash:free", "meta-llama/llama-3.2-3b-instruct:free"] },
  { name: "mistral", baseUrl: "https://api.mistral.ai", type: "openai", models: ["mistral-small-latest"] },
  { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", type: "openai", models: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "together", baseUrl: "https://api.together.xyz/v1", type: "openai", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo-Free"] },
];

async function getCustomProviders(): Promise<ProviderConfig[]> {
  const raw = await _BF.get("providers:custom", "json");
  return (raw as any) || [];
}
async function setCustomProviders(ps: ProviderConfig[]) {
  await _BF.put("providers:custom", JSON.stringify(ps));
}
async function getAllProviders(): Promise<ProviderConfig[]> {
  const custom = await getCustomProviders();
  return [...PROVIDERS, ...custom];
}
async function saveRateLimit(provider: string, keyId: string, resp: Response) {
  const rl: Record<string, string> = {};
  for (const [k, v] of resp.headers) {
    if (k.startsWith("x-ratelimit-") || k.startsWith("X-RateLimit-")) rl[k.toLowerCase()] = v;
  }
  if (Object.keys(rl).length) await _BF.put("ratelimit:" + provider + ":" + keyId, JSON.stringify(rl), { expirationTtl: 86400 });
}
async function trackKeyUsage(rl: ReqLog) {
  const key = "keyusage:" + rl.provider + ":" + rl.keyId + ":" + getToday();
  const raw = await _BF.get(key, "json");
  const u: KeyUsage = (raw as any) || { date: getToday(), requests: 0, successes: 0, failures: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  u.requests++;
  if (rl.status >= 200 && rl.status < 400) u.successes++; else u.failures++;
  u.promptTokens += rl.promptTokens || 0; u.completionTokens += rl.completionTokens || 0; u.cost += rl.cost || 0;
  await _BF.put(key, JSON.stringify(u), { expirationTtl: 86400 * 20 });
}
async function getProviderLimits(): Promise<Record<string, { dailyRequests: number; dailyTokens: number; monthlyCostUSD: number }>> {
  const raw = await _BF.get("providers:limits", "json");
  return (raw as any) || DEFAULT_PROVIDER_LIMITS;
}
async function setProviderLimits(limits: any) {
  await _BF.put("providers:limits", JSON.stringify(limits));
}
async function getCacheCfg(): Promise<{ ttlSeconds: number; enabled: boolean }> {
  const raw = await _BF.get("cache:config", "json");
  return (raw as any) || { ttlSeconds: 300, enabled: false };
}
async function setCacheCfg(cfg: { ttlSeconds: number; enabled: boolean }) {
  await _BF.put("cache:config", JSON.stringify(cfg));
}

/* ── Google Gemini Format ── */
function oaiToGemini(body: any, model: string) {
  const contents = (body.messages || []).filter((m: any) => m.role !== 'system').map((m: any) => ({ role: m.role === 'assistant' ? 'model' : m.role, parts: [{ text: m.content || '' }] }));
  const sys = (body.messages || []).find((m: any) => m.role === 'system');
  const r: any = { contents };
  if (sys) r.systemInstruction = { parts: [{ text: sys.content }] };
  r.generationConfig = {};
  if (body.max_tokens) r.generationConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) r.generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) r.generationConfig.topP = body.top_p;
  return r;
}
function geminiToOai(data: any, model: string) {
  const choices = (data.candidates || []).map((c: any, i: number) => ({
    index: i, message: { role: 'assistant', content: c.content?.parts?.[0]?.text || '' },
    finish_reason: (c.finishReason || 'stop').toLowerCase()
  }));
  return { id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

/* ── Anthropic ↔ OpenAI Format Converters ── */
function anthropicToOpenAI(body: any): any {
  const messages: any[] = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  for (const m of (body.messages || [])) {
    const content = typeof m.content === "string" ? m.content : (m.content || []).map((c: any) => c.text || "").join("");
    messages.push({ role: m.role, content });
  }
  return { model: body.model, messages, max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stream: body.stream === true, stop: body.stop_sequences };
}
function openAIToAnthropic(oai: any, model: string): any {
  const choice = oai.choices?.[0] || {};
  const stopMap: Record<string, string> = { stop: "end_turn", length: "max_tokens" };
  return { id: "msg_" + (oai.id || Date.now()), type: "message", role: "assistant", content: [{ type: "text", text: choice.message?.content || "" }], model, stop_reason: stopMap[choice.finish_reason || ""] || null, stop_sequence: null, usage: { input_tokens: oai.usage?.prompt_tokens || 0, output_tokens: oai.usage?.completion_tokens || 0 } };
}

/* ── Token Counting & Pricing ── */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "llama-3.3-70b": { input: 0.59, output: 0.79 }, "llama-3.1-8b": { input: 0.05, output: 0.08 },
  "mistral-small": { input: 0.2, output: 0.6 },
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

interface Env { BF: KVNamespace; WEBHOOK_URL?: string; ADMIN_PASSWORD?: string; }

const CB_COOLDOWN_MS = 300000; // 5 min cooldown before half-open probe
const KEY_COOLDOWN_MS = 60000; // 1 min cooldown after 429 rate-limit

function isKeyUsable(h: HealthEntry): boolean {
  if (h.status === "expired") return false;
  if (h.cbState === "open") {
    if (Date.now() - h.lastCheck > CB_COOLDOWN_MS) return true; // allow probe
    return false;
  }
  if (h.cbState === "half-open") return h.consecutiveFailures < 3;
  return h.status !== "dead";
}

async function isKeyCooling(provider: string, keyId: string): Promise<boolean> {
  const v = await _BF.get("cooling:" + provider + ":" + keyId);
  if (!v) return false;
  if (Number(v) > Date.now()) return true;
  return false;
}
async function setKeyCooling(provider: string, keyId: string) {
  await _BF.put("cooling:" + provider + ":" + keyId, String(Date.now() + KEY_COOLDOWN_MS), { expirationTtl: Math.ceil(KEY_COOLDOWN_MS / 1000) + 60 });
}

async function selectKey(provider: string, keys: KeyEntry[], strategy: Strategy): Promise<{ key: KeyEntry; index: number } | null> {
  if (!keys.length) return null;
  const usable = [];
  for (let i = 0; i < keys.length; i++) {
    const h = await getHealth(provider, keys[i].id);
    if (isKeyUsable(h) && !(await isKeyCooling(provider, keys[i].id))) usable.push({ key: keys[i], index: i, h });
  }
  if (!usable.length) return null;
  if (strategy === "round-robin") {
    const idx = await getRotation(provider);
    for (let i = 0; i < usable.length; i++) {
      const ki = (idx + i) % keys.length;
      const u = usable.find((u: any) => u.index === ki);
      if (u) return { key: u.key, index: u.index };
    }
    return usable[0] ? { key: usable[0].key, index: usable[0].index } : null;
  }
  if (strategy === "lowest-latency") {
    usable.sort((a: any, b: any) => (a.h.avgResponseTime || Infinity) - (b.h.avgResponseTime || Infinity));
    return { key: usable[0].key, index: usable[0].index };
  }
  if (strategy === "least-loaded") {
    usable.sort((a: any, b: any) => {
      const rA = (a.h.successCount + a.h.failCount) > 0 ? a.h.failCount / (a.h.successCount + a.h.failCount) : 0;
      const rB = (b.h.successCount + b.h.failCount) > 0 ? b.h.failCount / (b.h.successCount + b.h.failCount) : 0;
      return rA - rB;
    });
    return { key: usable[0].key, index: usable[0].index };
  }
  return null;
}

/* ── Streaming Timeout ── */
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

async function handleProxy(req: Request): Promise<Response> {
  const start = Date.now();
  try {
    const key = getBearer(req);
    if (!key) return new Response(JSON.stringify({ error: "missing auth" }), { status: 401, headers: { "content-type": "application/json" } });
    if (key !== __MASTER_KEY) {
      const gw = await getGwKey(key);
      if (!gw || !gw.enabled) return new Response(JSON.stringify({ error: "invalid gateway key" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const rlCfg = key !== __MASTER_KEY ? await getRateLimit(key) : await getRateLimit();
    const rl = await checkRateLimit(key, rlCfg);
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "rate limit exceeded", retryAfterMs: rl.resetMs }), { status: 429, headers: { "content-type": "application/json", "Retry-After": String(Math.ceil(rl.resetMs / 1000)), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(rl.resetMs) } });
    }
    const body = await req.json() as any;
    const models = Array.isArray(body.model) ? body.model : [body.model || ""];
    const isStream = body.stream === true;
    const allProvs = await getAllProviders();
    const lastErrors: string[] = [];
    let hasRateLimit = false;
    const modelIsArray = Array.isArray(body.model);
    for (const model of models) {
      let candidates = allProvs.filter((pr: any) => pr.models.some((m: string) => model.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(model.toLowerCase().split("/").pop() || "")));
      if (!candidates.length && !modelIsArray) candidates = allProvs.sort((a: any) => a.name === "openrouter" ? -1 : 0);
      if (!candidates.length) { lastErrors.push(model + ":no_provider"); continue; }
      for (const p of candidates) {
        const keys = await getKeys(p.name);
        if (!keys.length) { lastErrors.push(p.name + ":no_keys"); continue; }
        const strategy = await getStrategy(p.name);
        const selected = await selectKey(p.name, keys, strategy);
        if (!selected) { lastErrors.push(p.name + ":no_healthy"); continue; }
        const ke = selected.key;
        const h = await getHealth(p.name, ke.id);
        const tryModels = [model, ...p.models.filter((m: string) => m.toLowerCase() !== model.toLowerCase())];
        let fellback = false;
        for (const tryModel of tryModels) {
          if (fellback) break;
          try {
            const isGoogle = p.type === "google";
            const targetUrl = isGoogle ? p.baseUrl + "/v1beta/models/" + tryModel + ":generateContent" : p.baseUrl + (p.type === "openai" ? "/v1/chat/completions" : "");
            const hdrs: any = { "Content-Type": "application/json" };
            if (isGoogle) hdrs["x-goog-api-key"] = ke.apiKey;
            else if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
            const reqBody = isGoogle ? JSON.stringify(oaiToGemini(body, tryModel)) : JSON.stringify({ ...body, model: tryModel });
            const resp = await fetch(targetUrl, { method: "POST", headers: hdrs, body: reqBody });
            const latency = Date.now() - start;
            const promptText = JSON.stringify(body.messages || "");
            const promptTokens = estimateTokens(promptText);
            let completionTokens = 0;
            if (resp.ok) {
              if (isGoogle) {
                try { const j = await resp.clone().json() as any; completionTokens = estimateTokens(j.candidates?.[0]?.content?.parts?.[0]?.text || ""); } catch { completionTokens = 0; }
              } else {
                try { const j = await resp.clone().json() as any; completionTokens = j.usage?.completion_tokens || estimateTokens(JSON.stringify(j.choices?.[0]?.message?.content || "")); } catch { completionTokens = 0; }
              }
            }
            const cost = estimateCost(tryModel, promptTokens, completionTokens);
            const rl: ReqLog = { model: tryModel, provider: p.name, keyId: ke.id, status: resp.status, latencyMs: latency, timestamp: Date.now(), promptTokens, completionTokens, cost };
            await updateAnalytics(rl);
            await trackKeyUsage(rl);
            await saveRateLimit(p.name, ke.id, resp);
            if (resp.ok) {
              if (tryModel !== model) fellback = true;
              await setRotation(p.name, (selected.index + 1) % keys.length);
              h.status = "active"; h.cbState = "closed"; h.consecutiveFailures = 0; h.successCount++; h.lastUsed = Date.now(); h.lastCheck = Date.now();
              h.lastResponseTime = latency;
              h.avgResponseTime = h.avgResponseTime ? Math.round((h.avgResponseTime * (h.successCount - 1) + latency) / h.successCount) : latency;
              await setHealth(p.name, ke.id, h);
              await incrStat(getToday());
              if (isStream) {
                const stream = streamWithTimeout(resp.body!, 60000);
                return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" } });
              }
              if (isGoogle) {
                const j = await resp.clone().json() as any;
                const oai = geminiToOai(j, model);
                return new Response(JSON.stringify(oai), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
              }
              const j = await resp.json() as any;
              j.model = model;
              return new Response(JSON.stringify(j), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
            }
            const txt = await resp.text();
            h.failCount++; h.lastError = tryModel + " " + resp.status + ": " + txt.slice(0, 200); h.lastCheck = Date.now();
            if (resp.status === 401 || resp.status === 403) { h.consecutiveFailDays++; } else { h.consecutiveFailures++; }
            if (h.consecutiveFailures >= 5) h.cbState = "open";
            await setHealth(p.name, ke.id, h);
            lastErrors.push(p.name + ":" + tryModel + ":" + resp.status);
            if (resp.status === 429) { hasRateLimit = true; await setKeyCooling(p.name, ke.id); }
            if (resp.status === 401 || resp.status === 403) {
              await sendWebhook("auth_failure", { provider: p.name, keyId: ke.id, status: resp.status });
            }
            if (resp.status === 401 || resp.status === 403 || resp.status >= 500) break;
          } catch (e: any) {
            const latency = Date.now() - start;
            const promptText = JSON.stringify(body.messages || "");
            const promptTokens = estimateTokens(promptText);
            const rl: ReqLog = { model: tryModel, provider: p.name, keyId: ke.id, status: 0, latencyMs: latency, timestamp: Date.now(), promptTokens, completionTokens: 0, cost: estimateCost(tryModel, promptTokens, 0) };
            await updateAnalytics(rl); await trackKeyUsage(rl);
            h.failCount++; h.lastError = tryModel + " " + e.message; h.lastCheck = Date.now(); h.consecutiveFailures++;
            if (h.consecutiveFailures >= 5) h.cbState = "open";
            await setHealth(p.name, ke.id, h);
            lastErrors.push(p.name + ":" + tryModel + ":error:" + e.message.slice(0, 50));
            break;
          }
        }
      }
    }
    const finalStatus = hasRateLimit ? 429 : 502;
    const finalError = hasRateLimit ? "upstream rate limited, retry later" : "all providers failed";
    return new Response(JSON.stringify({ error: finalError, details: lastErrors }), { status: finalStatus, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "gateway error: " + e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

async function handleModels(): Promise<Response> {
  const all: any[] = [];
  for (const p of await getAllProviders()) {
    all.push(...p.models.map((m: string) => ({ id: m, provider: p.name, object: "model", created: Date.now(), owned_by: "bifrost" })));
  }
  return new Response(JSON.stringify({ object: "list", data: all }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

async function handleEmbeddings(req: Request): Promise<Response> {
  const start = Date.now();
  try {
    const key = getBearer(req);
    if (!key) return new Response(JSON.stringify({ error: "missing auth" }), { status: 401, headers: { "content-type": "application/json" } });
    if (key !== __MASTER_KEY) {
      const gw = await getGwKey(key);
      if (!gw || !gw.enabled) return new Response(JSON.stringify({ error: "invalid gateway key" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const rl = await checkRateLimit(key, key !== __MASTER_KEY ? await getRateLimit(key) : await getRateLimit());
    if (!rl.allowed) return new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429, headers: { "content-type": "application/json" } });
    const body = await req.json() as any;
    const model = body.model || "";
    if (!model) return new Response(JSON.stringify({ error: "model required" }), { status: 400, headers: { "content-type": "application/json" } });
    const provs = (await getAllProviders()).filter((p: any) => p.type !== "google" && p.models.some((m: string) => model.toLowerCase().includes(m.toLowerCase())));
    for (const p of provs) {
      const keys = await getKeys(p.name);
      if (!keys.length) continue;
      const selected = await selectKey(p.name, keys, await getStrategy(p.name));
      if (!selected) continue;
      const ke = selected.key;
      const resp = await fetch(p.baseUrl + "/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ke.apiKey }, body: JSON.stringify({ ...body, model }) });
      const rl: ReqLog = { model, provider: p.name, keyId: ke.id, status: resp.status, latencyMs: Date.now() - start, timestamp: Date.now(), promptTokens: 0, completionTokens: 0, cost: 0 };
      await updateAnalytics(rl); await trackKeyUsage(rl); await saveRateLimit(p.name, ke.id, resp);
      if (resp.status === 429) await setKeyCooling(p.name, ke.id);
      if (resp.ok) return new Response(resp.body, { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
    return new Response(JSON.stringify({ error: "no provider available for embedding model: " + model }), { status: 502, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "embedding error: " + e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

async function handleAnthropic(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any;
    if (!body.model) return new Response(JSON.stringify({ error: "model required" }), { status: 400, headers: { "content-type": "application/json" } });
    const oaiBody = anthropicToOpenAI(body);
    const newReq = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(oaiBody) });
    const resp = await handleProxy(newReq);
    if (!resp.ok) return resp;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) return resp;
    const oaiData = await resp.json() as any;
    const anthData = openAIToAnthropic(oaiData, body.model);
    return new Response(JSON.stringify(anthData), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "anthropic error: " + e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

async function handleAdminApi(req: Request, path: string): Promise<Response> {
  if (!checkAdmin(req)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  const url = new URL(req.url);

  if (path === "/admin/api/providers") {
    if (req.method === "GET") {
      const merged = await getAllProviders();
      const limits = await getProviderLimits();
      return new Response(JSON.stringify({ providers: merged, limits }), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (body.action === "set-limits") { await setProviderLimits(body.limits); return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); }
      if (!body.name || !body.baseUrl || !body.type) return new Response(JSON.stringify({ error: "name, baseUrl, type required" }), { status: 400, headers: { "content-type": "application/json" } });
      const custom = await getCustomProviders();
      const idx = custom.findIndex((p: any) => p.name === body.name);
      const entry: ProviderConfig = { name: body.name, baseUrl: body.baseUrl, type: body.type, models: body.models || [] };
      if (idx >= 0) custom[idx] = entry; else custom.push(entry);
      await setCustomProviders(custom);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "DELETE") {
      const name = url.searchParams.get("name");
      if (!name) return new Response(JSON.stringify({ error: "name required" }), { status: 400, headers: { "content-type": "application/json" } });
      const custom = await getCustomProviders();
      await setCustomProviders(custom.filter((p: any) => p.name !== name));
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/keys") {
    if (req.method === "GET") {
      if (url.searchParams.has("full")) {
        const pname = url.searchParams.get("pname"); const id = url.searchParams.get("id");
        if (!pname || !id) return new Response(JSON.stringify({ error: "pname and id required" }), { status: 400, headers: { "content-type": "application/json" } });
        const keys = await getKeys(pname); const ke = keys.find((k: any) => k.id === id);
        if (!ke) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ apiKey: ke.apiKey }), { headers: { "content-type": "application/json" } });
      }
      const result: any = {};
      const list = await _BF.list({ prefix: "prov:", limit: 200 });
      const seen = new Set<string>();
      for (const k of list.keys) {
        const m = k.name.match(/^prov:([^:]+):keys$/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); result[m[1]] = await getKeys(m[1]); }
      }
      for (const p of await getAllProviders()) {
        if (!seen.has(p.name)) { result[p.name] = await getKeys(p.name); seen.add(p.name); }
      }
      for (const pname of Object.keys(result)) result[pname] = result[pname].map((ke: any) => ({ ...ke, apiKey: maskKey(ke.apiKey || "") }));
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any;
      const { pname, apiKey, label } = body;
      if (!pname || !apiKey) return new Response(JSON.stringify({ error: "provider and apiKey required" }), { status: 400, headers: { "content-type": "application/json" } });
      const keys = await getKeys(pname);
      const id = Date.now().toString(36);
      const allProvs = await getAllProviders();
      const p = allProvs.find((pr: any) => pr.name === pname);
      let models: string[] = [];
      if (p) {
        try {
          const hdrs: any = {};
          if (p.type === "openai") hdrs["Authorization"] = "Bearer " + apiKey;
          const mr = await fetch(p.baseUrl + "/v1/models", { headers: hdrs });
          if (mr.ok) { const md = await mr.json() as any; models = (md.data || []).map((m: any) => m.id).slice(0, 30); }
        } catch { /* silent */ }
      }
      keys.push({ id, apiKey, label: label || "key-" + keys.length, addedAt: Date.now(), models });
      await setKeys(pname, keys);
      return new Response(JSON.stringify({ ok: true, id, models }), { headers: { "content-type": "application/json" } });
    }
    if (req.method === "DELETE") {
      const body = await req.json() as any;
      const { pname, id } = body;
      if (!pname || !id) return new Response(JSON.stringify({ error: "provider and id required" }), { status: 400, headers: { "content-type": "application/json" } });
      let keys = await getKeys(pname);
      keys = keys.filter((k: any) => k.id !== id);
      await setKeys(pname, keys);
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
      if (!body.word) return new Response(JSON.stringify({ error: "word required" }), { status: 400, headers: { "content-type": "application/json" } });
      const gw: GatewayKey = { word: body.word, label: body.label || body.word, createdAt: Date.now(), enabled: true, usage: 0 };
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
      if (body.label) gw.label = body.label;
      await setGwKey(body.word, gw);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (path === "/admin/api/strategy") {
    if (req.method === "GET") {
      const result: any = {};
      for (const p of await getAllProviders()) result[p.name] = await getStrategy(p.name);
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
    for (const p of await getAllProviders()) {
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

  if (path === "/admin/api/analytics") {
    const days = parseInt(url.searchParams.get("days") || "7");
    const fmt = url.searchParams.get("format") || "json";
    const result: DailyAnalytics[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = "analytics:" + d.toISOString().slice(0, 10);
      const raw = await _BF.get(key, "json");
      if (raw) result.unshift(raw as any);
    }
    if (fmt === "csv") {
      const header = "date,totalRequests,totalTokens,totalCost(USD),uniqueProviders,uniqueModels";
      const rows = result.map((r: any) => `${r.date},${r.totalRequests||0},${r.totalTokens||0},${(r.totalCostUSD||0).toFixed(6)},${(r.uniqueProviders||[]).length},${(r.uniqueModels||[]).length}`);
      return new Response(header + "\n" + rows.join("\n"), { headers: { "content-type": "text/csv", "Content-Disposition": "attachment; filename=analytics.csv" } });
    }
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/key-usage") {
    const today = getToday();
    const result: Record<string, any> = {};
    const limits = await getProviderLimits();
    const totals = { requests: 0, successes: 0, failures: 0, promptTokens: 0, completionTokens: 0, cost: 0, providers: 0, keys: 0 };
    for (const p of await getAllProviders()) {
      const keys = await getKeys(p.name);
      result[p.name] = { keys: [], limit: limits[p.name] || { dailyRequests: 999999, dailyTokens: 999999999, monthlyCostUSD: 999 } };
      for (const k of keys) {
        const uk = "keyusage:" + p.name + ":" + k.id + ":" + today;
        const raw = await _BF.get(uk, "json");
        const u = (raw as KeyUsage) || { requests: 0, successes: 0, failures: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
        const rlData = await _BF.get("ratelimit:" + p.name + ":" + k.id, "json");
        result[p.name].keys.push({ id: k.id, label: k.label, addedAt: k.addedAt, usage: u, monthCost: 0, rateLimit: rlData });
        totals.requests += u.requests; totals.successes += u.successes; totals.failures += u.failures;
        totals.promptTokens += u.promptTokens; totals.completionTokens += u.completionTokens; totals.cost += u.cost;
        totals.keys++;
      }
      if (keys.length) totals.providers++;
    }
    return new Response(JSON.stringify({ providers: result, totals }), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/test-key") {
    const body = await req.json() as any;
    const { pname, id } = body;
    if (!pname || !id) return new Response(JSON.stringify({ error: "provider and id required" }), { status: 400, headers: { "content-type": "application/json" } });
    const tip = req.headers.get("CF-Connecting-IP") || "test-key";
    const trl = await checkRateLimit("test:" + tip, { maxRequests: 30, windowMs: 60000 });
    if (!trl.allowed) return new Response(JSON.stringify({ error: "too many test requests", retryAfterMs: trl.resetMs }), { status: 429, headers: { "content-type": "application/json" } });
    const keys = await getKeys(pname);
    const ke = keys.find((k: any) => k.id === id);
    if (!ke) return new Response(JSON.stringify({ error: "key not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const allProvs = await getAllProviders();
    const p = allProvs.find((pr: any) => pr.name === pname);
    if (!p) return new Response(JSON.stringify({ error: "provider not found" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const hdrs: any = { "Content-Type": "application/json" };
      const isGoogle = p.type === "google";
      if (isGoogle) hdrs["x-goog-api-key"] = ke.apiKey;
      else if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
      const testBody = isGoogle
        ? { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }
        : { model: p.models[0], messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
      const url = isGoogle ? p.baseUrl + "/v1beta/models/" + p.models[0] + ":generateContent" : p.baseUrl + "/v1/chat/completions";
      const resp = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify(testBody) });
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

  if (path === "/admin/api/list-models") {
    const body = await req.json() as any;
    const { pname, id } = body;
    if (!pname || !id) return new Response(JSON.stringify({ error: "provider and id required" }), { status: 400, headers: { "content-type": "application/json" } });
    const keys = await getKeys(pname);
    const ke = keys.find((k: any) => k.id === id);
    if (!ke) return new Response(JSON.stringify({ error: "key not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const allProvs = await getAllProviders();
    const p = allProvs.find((pr: any) => pr.name === pname);
    if (!p) return new Response(JSON.stringify({ error: "provider not found" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const hdrs: any = { "Content-Type": "application/json" };
      const isGoogle = p.type === "google";
      if (isGoogle) hdrs["x-goog-api-key"] = ke.apiKey;
      else if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
      const url = isGoogle ? p.baseUrl + "/v1beta/models" : p.baseUrl + "/v1/models";
      const resp = await fetch(url, { headers: hdrs });
      if (!resp.ok) return new Response(JSON.stringify({ error: "HTTP " + resp.status }), { status: 502, headers: { "content-type": "application/json" } });
      const j = await resp.json() as any;
      const models = (j.data || []).map((m: any) => m.id || m.name).filter(Boolean);
      return new Response(JSON.stringify({ models }), { headers: { "content-type": "application/json" } });
    } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "content-type": "application/json" } }); }
  }

  if (path === "/admin/api/health-check") {
    const results: any[] = [];
    for (const p of await getAllProviders()) {
      const keys = await getKeys(p.name);
      for (const k of keys) {
        const h = await getHealth(p.name, k.id);
        try {
          const hdrs: any = { "Content-Type": "application/json" };
          const isGoogle = p.type === "google";
          if (isGoogle) hdrs["x-goog-api-key"] = k.apiKey;
          else if (p.type === "openai") hdrs["Authorization"] = "Bearer " + k.apiKey;
          const testBody = isGoogle
            ? { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }
            : { model: p.models[0], messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
          const url = isGoogle ? p.baseUrl + "/v1beta/models/" + p.models[0] + ":generateContent" : p.baseUrl + "/v1/chat/completions";
          const resp = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify(testBody) });
          results.push({ provider: p.name, keyId: k.id, label: k.label, status: resp.ok ? "ok" : "fail", httpStatus: resp.status, cbState: h.cbState });
        } catch (e: any) {
          results.push({ provider: p.name, keyId: k.id, label: k.label, status: "error", error: e.message, cbState: h.cbState });
        }
      }
    }
    return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } });
  }

  if (path === "/admin/api/redetect-models") {
    const { pname, id } = await req.json() as any;
    if (!pname || !id) return new Response(JSON.stringify({ error: "provider and id required" }), { status: 400, headers: { "content-type": "application/json" } });
    const keys = await getKeys(pname);
    const ke = keys.find((k: any) => k.id === id);
    if (!ke) return new Response(JSON.stringify({ error: "key not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const allProvs2 = await getAllProviders();
    const p = allProvs2.find((pr: any) => pr.name === pname);
    if (!p) return new Response(JSON.stringify({ error: "provider not found" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const hdrs: any = {};
      const isGoogle = p.type === "google";
      if (isGoogle) hdrs["x-goog-api-key"] = ke.apiKey;
      else if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
      const resp = isGoogle
        ? await fetch(p.baseUrl + "/v1beta/models?key=" + ke.apiKey)
        : await fetch(p.baseUrl + "/v1/models", { headers: hdrs });
      if (!resp.ok) return new Response(JSON.stringify({ error: "HTTP " + resp.status }), { status: 502, headers: { "content-type": "application/json" } });
      const data = await resp.json() as any;
      const models = isGoogle ? (data.models || []).map((m: any) => m.name).filter((n: string) => n.includes("gemini")) : (data.data || []).map((m: any) => m.id);
      p.models = models.slice(0, 10);
      const custom = await getCustomProviders();
      const ci = custom.findIndex((cp: any) => cp.name === pname);
      if (ci >= 0) { custom[ci].models = p.models; await setCustomProviders(custom); }
      return new Response(JSON.stringify({ ok: true, models: p.models }), { headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { "content-type": "application/json" } });
    }
  }

  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
}

async function handleCron() {
  for (const p of await getAllProviders()) {
    let keys = await getKeys(p.name);
    let changed = false;
    const cutoff = Date.now() - EVICT_DAYS * DAY_MS;
    for (let i = keys.length - 1; i >= 0; i--) {
      const h = await getHealth(p.name, keys[i].id);
      if (h.status === "expired" || h.lastUsed > 0 && h.lastUsed < cutoff) {
        sendWebhook("eviction", { provider: p.name, keyId: keys[i].id, reason: h.status === "expired" ? "expired" : "inactive", evictedAt: Date.now() });
        keys.splice(i, 1);
        changed = true;
      }
    }
    if (changed) await setKeys(p.name, keys);
  }
}

/* ── Login Page HTML ── */
const LOGIN_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Buddhi Dwar - Login</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',system-ui,-apple-system,sans-serif}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0a0e1a 0%,#0f1629 40%,#121b33 100%);color:#e2e8f0}.login-box{background:rgba(30,41,59,.6);backdrop-filter:blur(20px);padding:48px;border-radius:20px;border:1px solid rgba(56,189,248,.1);width:380px;max-width:90vw;box-shadow:0 16px 48px rgba(0,0,0,.5)}.login-box h1{font-size:28px;font-weight:800;background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}p{color:#8899b4;margin-bottom:24px;font-size:14px}input{width:100%;padding:14px 16px;border-radius:12px;border:1px solid rgba(71,85,105,.4);background:rgba(15,23,42,.6);color:#e2e8f0;font-size:16px;outline:none;transition:all .2s;margin-bottom:16px}input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.12)}button{width:100%;padding:14px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff;box-shadow:0 2px 12px rgba(56,189,248,.2)}button:hover{box-shadow:0 4px 20px rgba(56,189,248,.35)}.err{color:#fca5a5;font-size:13px;margin-top:10px;display:none}.err.show{display:block}</style></head><body><form class="login-box" method="POST" action="/admin/api/login"><h1>Buddhi Dwar</h1><p>Admin Dashboard Login</p><input type="password" name="password" placeholder="Enter admin password" autofocus><button type="submit">Login</button><p class="err" id="login-err">Invalid password</p></form></body></html>`;
/* ── Dashboard Page HTML (base64-encoded to avoid escaping issues) ── */
const ADMIN_PAGE_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEuMCI+Cjx0aXRsZT5CdWRkaGkgRHdhciBBZG1pbjwvdGl0bGU+CjxzdHlsZT4KKnttYXJnaW46MDtwYWRkaW5nOjA7Ym94LXNpemluZzpib3JkZXItYm94O2ZvbnQtZmFtaWx5OidJbnRlcicsc3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sc2Fucy1zZXJpZn0KYm9keXtkaXNwbGF5OmZsZXg7bWluLWhlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzBhMGUxYSAwJSwjMGYxNjI5IDQwJSwjMTIxYjMzIDEwMCUpO2NvbG9yOiNlMmU4ZjB9Ci5zaWRlYmFye3dpZHRoOjI0MHB4O2JhY2tncm91bmQ6cmdiYSgxNywyNCwzOSwuODUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO3BhZGRpbmc6MjRweCAwO2JvcmRlci1yaWdodDoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4xKTtmbGV4LXNocmluazowO2hlaWdodDoxMDB2aDtwb3NpdGlvbjpzdGlja3k7dG9wOjA7b3ZlcmZsb3cteTphdXRvfQouc2lkZWJhciBoMXtmb250LXNpemU6MjJweDtmb250LXdlaWdodDo4MDA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMzOGJkZjgsIzgxOGNmOCk7LXdlYmtpdC1iYWNrZ3JvdW5kLWNsaXA6dGV4dDstd2Via2l0LXRleHQtZmlsbC1jb2xvcjp0cmFuc3BhcmVudDtwYWRkaW5nOjAgMjBweCAyNHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMSk7bWFyZ2luLWJvdHRvbToxMnB4O2xldHRlci1zcGFjaW5nOi0uNXB4fQouc2lkZWJhciBhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHg7cGFkZGluZzoxMXB4IDIwcHg7Y29sb3I6Izg4OTliNDt0ZXh0LWRlY29yYXRpb246bm9uZTtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo1MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjJzO21hcmdpbjoycHggOHB4O2JvcmRlci1yYWRpdXM6MTBweH0KLnNpZGViYXIgYTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDgpO2NvbG9yOiNlMmU4ZjB9Ci5zaWRlYmFyIGEuYWN0aXZle2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU2LDE4OSwyNDgsLjEyKSxyZ2JhKDEyOSwxNDAsMjQ4LC4wOCkpO2NvbG9yOiMzOGJkZjg7Ym94LXNoYWRvdzppbnNldCAycHggMCAwICMzOGJkZjh9Ci5tYWlue2ZsZXg6MTtwYWRkaW5nOjMycHg7bWF4LXdpZHRoOjEyMDBweH1zZWN0aW9ue2Rpc3BsYXk6bm9uZX1zZWN0aW9uLmFjdGl2ZXtkaXNwbGF5OmJsb2NrfQpoMntmb250LXNpemU6MjJweDtmb250LXdlaWdodDo3MDA7Y29sb3I6I2YxZjVmOTttYXJnaW4tYm90dG9tOjIwcHg7cGFkZGluZy1ib3R0b206MTBweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtsZXR0ZXItc3BhY2luZzotLjNweH0KLmNhcmRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZml0LG1pbm1heCgyMDBweCwxZnIpKTtnYXA6MTRweDttYXJnaW4tYm90dG9tOjI4cHh9Ci5jYXJke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDMwLDQxLDU5LC42KSxyZ2JhKDMwLDQxLDU5LC4zKSk7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MjBweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMDgpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDhweCk7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzLGJvcmRlci1jb2xvciAuMnN9Ci5jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjpyZ2JhKDU2LDE4OSwyNDgsLjIpfQouY2FyZCAubnVte2ZvbnQtc2l6ZTozMHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjojMzhiZGY4O2xldHRlci1zcGFjaW5nOi0uNXB4fQouY2FyZCAubGJse2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLXRvcDo2cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi44cHg7Zm9udC13ZWlnaHQ6NjAwfQp0YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtmb250LXNpemU6MTRweDttYXJnaW4tYm90dG9tOjE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRlbn0KdGh7Y29sb3I6Izc0ODhhODtmb250LXdlaWdodDo2MDA7cGFkZGluZzoxNHB4IDEycHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wOCk7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouOHB4O2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNCl9CnRke3BhZGRpbmc6MTJweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDMwLDQxLDU5LC40KTtjb2xvcjojZTJlOGYwfQp0cjpob3ZlciB0ZHtiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDMpfQppbnB1dCxzZWxlY3R7cGFkZGluZzoxMXB4IDE0cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg3MSw4NSwxMDUsLjQpO2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNik7Y29sb3I6I2UyZThmMDtmb250LXNpemU6MTRweDt3aWR0aDoxMDAlO21heC13aWR0aDo0MDBweDttYXJnaW46NHB4IDA7b3V0bGluZTpub25lO3RyYW5zaXRpb246YWxsIC4yc30KaW5wdXQ6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojMzhiZGY4O2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoNTYsMTg5LDI0OCwuMTIpfQpidXR0b257cGFkZGluZzoxMXB4IDIycHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25lO2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjttYXJnaW46NHB4IDRweCA0cHggMDt0cmFuc2l0aW9uOmFsbCAuMnM7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVufQpidXR0b246YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTcpfQpidXR0b24ucHJpbWFyeXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzM4YmRmOCwjNjM2NmYxKTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDU2LDE4OSwyNDgsLjIpfWJ1dHRvbi5wcmltYXJ5OmhvdmVye2JveC1zaGFkb3c6MCA0cHggMjBweCByZ2JhKDU2LDE4OSwyNDgsLjM1KX0KYnV0dG9uLmRhbmdlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsI2VmNDQ0NCwjZGMyNjI2KTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDIzOSw2OCw2OCwuMil9YnV0dG9uLmRhbmdlcjpob3Zlcntib3gtc2hhZG93OjAgNHB4IDIwcHggcmdiYSgyMzksNjgsNjgsLjM1KX0KYnV0dG9uLnNlY29uZGFyeXtiYWNrZ3JvdW5kOnJnYmEoNTEsNjUsODUsLjUpO2NvbG9yOiNlMmU4ZjA7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDcxLDg1LDEwNSwuMyl9YnV0dG9uLnNlY29uZGFyeTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTEsNjUsODUsLjgpfQpwcmV7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC42KTtwYWRkaW5nOjE4cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmF1dG87Zm9udC1zaXplOjEzcHg7bWF4LWhlaWdodDo1MDBweDtsaW5lLWhlaWdodDoxLjY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtmb250LWZhbWlseTonRmlyYSBDb2RlJywnQ29uc29sYXMnLG1vbm9zcGFjZX0KLnRhZ3tkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjNweCAxMnB4O2JvcmRlci1yYWRpdXM6MjBweDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7bGV0dGVyLXNwYWNpbmc6LjNweH0KLnRhZy5va3tiYWNrZ3JvdW5kOnJnYmEoMjIsMTYzLDc0LC4xNSk7Y29sb3I6Izg2ZWZhYztib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjIsMTYzLDc0LC4zKX0KLnRhZy5mYWlse2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjE1KTtjb2xvcjojZmNhNWE1O2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzksNjgsNjgsLjMpfQoudGFnLmFjdGl2ZXtiYWNrZ3JvdW5kOnJnYmEoNTksMTMwLDI0NiwuMTUpO2NvbG9yOiM5M2M1ZmQ7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU5LDEzMCwyNDYsLjMpfQoudGFnLndhcm5pbmd7YmFja2dyb3VuZDpyZ2JhKDIzNCwxNzksOCwuMTUpO2NvbG9yOiNmZGU2OGE7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzNCwxNzksOCwuMyl9Ci50YWcuY2xvc2Vke2JhY2tncm91bmQ6cmdiYSgyMiwxNjMsNzQsLjE1KTtjb2xvcjojODZlZmFjO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMiwxNjMsNzQsLjMpfQoudGFnLm9wZW57YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9Ci50YWcuaGFsZi1vcGVue2JhY2tncm91bmQ6cmdiYSgyMzQsMTc5LDgsLjE1KTtjb2xvcjojZmRlNjhhO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzQsMTc5LDgsLjMpfQouZm9ybS1yb3d7ZGlzcGxheTpmbGV4O2dhcDoxNHB4O2FsaWduLWl0ZW1zOmVuZDtmbGV4LXdyYXA6d3JhcDttYXJnaW4tYm90dG9tOjIwcHh9Ci5mb3JtLXJvdz4qe2ZsZXg6MTttaW4td2lkdGg6MjAwcHh9Ci5mb3JtLXJvdyBidXR0b257ZmxleDowIDAgYXV0b30KLmZvcm0tZ3JvdXAgbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojNzQ4OGE4O21hcmdpbi1ib3R0b206NnB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouOHB4O2ZvbnQtd2VpZ2h0OjYwMH0KLnRvYXN0e3Bvc2l0aW9uOmZpeGVkO3RvcDoyNHB4O3JpZ2h0OjI0cHg7cGFkZGluZzoxNHB4IDI0cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjUwMDt6LWluZGV4OjEwMDA7YW5pbWF0aW9uOnNsaWRlSW4gLjM1cyBjdWJpYy1iZXppZXIoLjE2LDEsLjMsMSk7bWF4LXdpZHRoOjQyMHB4O2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JveC1zaGFkb3c6MCA4cHggMzJweCByZ2JhKDAsMCwwLC40KX0KLnRvYXN0LnN1Y2Nlc3N7YmFja2dyb3VuZDpyZ2JhKDIyLDE2Myw3NCwuMik7Y29sb3I6Izg2ZWZhYztib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjIsMTYzLDc0LC4zKX0KLnRvYXN0LmVycm9ye2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjIpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9CkBrZXlmcmFtZXMgc2xpZGVJbntmcm9te3RyYW5zZm9ybTp0cmFuc2xhdGVYKDEyMCUpIHNjYWxlKC45KTtvcGFjaXR5OjB9dG97dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMCkgc2NhbGUoMSk7b3BhY2l0eToxfX0KQGtleWZyYW1lcyBmYWRlSW57ZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoOHB4KX10b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCl9fQouZ3JpZC0ye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtnYXA6MjBweH0KLmljb3tkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7Ym9yZGVyLXJhZGl1czo2cHg7ZmxleC1zaHJpbms6MDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDB9Ci5pY28tb3ZlcnZpZXd7YmFja2dyb3VuZDpyZ2JhKDU2LDE4OSwyNDgsLjE1KTtjb2xvcjojMzhiZGY4fS5pY28ta2V5c3tiYWNrZ3JvdW5kOnJnYmEoMjQ1LDE1OCwxMSwuMTUpO2NvbG9yOiNmNTllMGJ9Ci5pY28tZ2F0ZXdheXtiYWNrZ3JvdW5kOnJnYmEoMTY3LDEzOSwyNTAsLjE1KTtjb2xvcjojYTc4YmZhfS5pY28tc3RyYXRlZ3l7YmFja2dyb3VuZDpyZ2JhKDUyLDIxMSwxNTMsLjE1KTtjb2xvcjojMzRkMzk5fQouaWNvLWxvZ3N7YmFja2dyb3VuZDpyZ2JhKDI0OCwxMTMsMTEzLC4xNSk7Y29sb3I6I2Y4NzE3MX0uaWNvLWFuYWx5dGljc3tiYWNrZ3JvdW5kOnJnYmEoMjUxLDE0Niw2MCwuMTUpO2NvbG9yOiNmYjkyM2N9Ci5pY28tc2V0dGluZ3N7YmFja2dyb3VuZDpyZ2JhKDE0OCwxNjMsMTg0LC4xNSk7Y29sb3I6I2UyZThmMH0uaWNvLWhlYWx0aHtiYWNrZ3JvdW5kOnJnYmEoMjQ0LDExNCwxODIsLjE1KTtjb2xvcjojZjQ3MmI2fQouaWNvLXNldHVwe2JhY2tncm91bmQ6cmdiYSgzNCwyMTEsMjM4LC4xNSk7Y29sb3I6IzIyZDNlZX0KCiNsb2FkaW5nLWJhcntwb3NpdGlvbjpmaXhlZDt0b3A6MDtsZWZ0OjA7aGVpZ2h0OjNweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZywjMzhiZGY4LCM4MThjZjgsIzM4YmRmOCk7YmFja2dyb3VuZC1zaXplOjIwMCUgMTAwJTt6LWluZGV4Ojk5OTk5O3RyYW5zaXRpb246d2lkdGggLjRzIGN1YmljLWJlemllciguMTYsMSwuMywxKSxvcGFjaXR5IC4zczt3aWR0aDowO29wYWNpdHk6MDtib3JkZXItcmFkaXVzOjAgMnB4IDJweCAwO2JveC1zaGFkb3c6MCAwIDEycHggcmdiYSg1NiwxODksMjQ4LC41KX0KI2xvYWRpbmctYmFyLmFjdGl2ZXtvcGFjaXR5OjF9YnV0dG9uLmxvYWRpbmd7cG9pbnRlci1ldmVudHM6bm9uZTtvcGFjaXR5Oi43O3Bvc2l0aW9uOnJlbGF0aXZlfWJ1dHRvbi5sb2FkaW5nOjphZnRlcntjb250ZW50OicnO3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7Ym9yZGVyLXJhZGl1czppbmhlcml0O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHRyYW5zcGFyZW50LHJnYmEoMjU1LDI1NSwyNTUsLjEpLHRyYW5zcGFyZW50KTtiYWNrZ3JvdW5kLXNpemU6MjAwJSAxMDAlO2FuaW1hdGlvbjpzaGltbWVyIDEuMnMgaW5maW5pdGV9CkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOjIwMCUgMH0xMDAle2JhY2tncm91bmQtcG9zaXRpb246LTIwMCUgMH19Ci5wYWdpbmF0aW9ue2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjEycHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6Izc0ODhhOH0KLnBhZ2luYXRpb24gYnV0dG9ue3BhZGRpbmc6NnB4IDE0cHg7Zm9udC1zaXplOjEycHg7Ym9yZGVyLXJhZGl1czo4cHh9CnN1bW1hcnl7Y29sb3I6IzM4YmRmODtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzo4cHggMDtmb250LXNpemU6MTRweH0KZGV0YWlsc3tiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjMpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjhweCAxNnB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wNik7bWFyZ2luLWJvdHRvbToxNnB4fQoucGFnZS1kZXNje2JhY2tncm91bmQ6cmdiYSg1NiwxODksMjQ4LC4wNik7Ym9yZGVyLWxlZnQ6M3B4IHNvbGlkICMzOGJkZjg7cGFkZGluZzoxMnB4IDE2cHg7Ym9yZGVyLXJhZGl1czowIDEwcHggMTBweCAwO21hcmdpbi1ib3R0b206MjBweDtmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4O2xpbmUtaGVpZ2h0OjEuNn0KQG1lZGlhKG1heC13aWR0aDo3NjhweCl7LnNpZGViYXJ7d2lkdGg6NjBweDtwYWRkaW5nOjE2cHggMH0uc2lkZWJhciBoMSwuc2lkZWJhciBhIHNwYW46bGFzdC1jaGlsZHtkaXNwbGF5Om5vbmV9LnNpZGViYXIgYXtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3BhZGRpbmc6MTFweCAwO21hcmdpbjoycHggNnB4fS5tYWlue3BhZGRpbmc6MjBweH0uZ3JpZC0ye2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9fQpAbWVkaWEobWF4LXdpZHRoOjQ4MHB4KXsuc2lkZWJhcnt3aWR0aDo0OHB4fS5tYWlue3BhZGRpbmc6MTZweH0uY2FyZHN7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9fQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGlkPSJsb2FkaW5nLWJhciI+PC9kaXY+CjxkaXYgY2xhc3M9InNpZGViYXIiPgo8aDE+QnVkZGhpIER3YXI8L2gxPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdvdmVydmlldycpIiBpZD0ibmF2LW92ZXJ2aWV3IiBjbGFzcz0iYWN0aXZlIj48c3BhbiBjbGFzcz0iaWNvIGljby1vdmVydmlldyI+JiM5Njc5Ozwvc3Bhbj48c3Bhbj5PdmVydmlldzwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ2tleXMnKSIgaWQ9Im5hdi1rZXlzIj48c3BhbiBjbGFzcz0iaWNvIGljby1rZXlzIj4mIzk4ODE7PC9zcGFuPjxzcGFuPkFQSSBLZXlzPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ic2hvd1RhYignZ2F0ZXdheScpIiBpZD0ibmF2LWdhdGV3YXkiPjxzcGFuIGNsYXNzPSJpY28gaWNvLWdhdGV3YXkiPiYjMTI4Mjc0Ozwvc3Bhbj48c3Bhbj5HYXRld2F5IEtleXM8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdzdHJhdGVneScpIiBpZD0ibmF2LXN0cmF0ZWd5Ij48c3BhbiBjbGFzcz0iaWNvIGljby1zdHJhdGVneSI+JiM4NjQ0Ozwvc3Bhbj48c3Bhbj5TdHJhdGVneTwvc3Bhbj48L2E+CjwhLS0gbG9ncyBhbmQgcmVxLWxvZ3MgcmVtb3ZlZCAoS1Ygc3BhY2UpIC0tPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdhbmFseXRpY3MnKSIgaWQ9Im5hdi1hbmFseXRpY3MiPjxzcGFuIGNsYXNzPSJpY28gaWNvLWFuYWx5dGljcyI+JiMxMjgyMDA7PC9zcGFuPjxzcGFuPkFuYWx5dGljczwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ3VzYWdlJykiIGlkPSJuYXYtdXNhZ2UiPjxzcGFuIGNsYXNzPSJpY28gaWNvLW92ZXJ2aWV3Ij4mIzEyODIwMDs8L3NwYW4+PHNwYW4+VXNhZ2U8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdzZXR0aW5ncycpIiBpZD0ibmF2LXNldHRpbmdzIj48c3BhbiBjbGFzcz0iaWNvIGljby1zZXR0aW5ncyI+JiM5ODgxOzwvc3Bhbj48c3Bhbj5TZXR0aW5nczwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ2hlYWx0aCcpIiBpZD0ibmF2LWhlYWx0aCI+PHNwYW4gY2xhc3M9ImljbyBpY28taGVhbHRoIj4mIzEwMDAzOzwvc3Bhbj48c3Bhbj5IZWFsdGggQ2hlY2s8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdzZXR1cCcpIiBpZD0ibmF2LXNldHVwIj48c3BhbiBjbGFzcz0iaWNvIGljby1zZXR1cCI+JiM4NTA1Ozwvc3Bhbj48c3Bhbj5TZXR1cDwvc3Bhbj48L2E+CjwvZGl2Pgo8ZGl2IGNsYXNzPSJtYWluIiBpZD0ibWFpbi1jb250ZW50Ij48L2Rpdj4KPHNjcmlwdD4KbGV0IF9sb2FkaW5nQ291bnQgPSAwOwpmdW5jdGlvbiBzaG93TG9hZGluZygpIHsgX2xvYWRpbmdDb3VudCsrOyBjb25zdCBiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvYWRpbmctYmFyJyk7IGlmIChiKSB7IGIuc3R5bGUud2lkdGggPSAnMzAlJzsgYi5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsgfSB9CmZ1bmN0aW9uIGhpZGVMb2FkaW5nKCkgeyBfbG9hZGluZ0NvdW50LS07IGlmIChfbG9hZGluZ0NvdW50IDw9IDApIHsgX2xvYWRpbmdDb3VudCA9IDA7IGNvbnN0IGIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9hZGluZy1iYXInKTsgaWYgKGIpIHsgYi5zdHlsZS53aWR0aCA9ICcxMDAlJzsgc2V0VGltZW91dCgoKSA9PiB7IGIuc3R5bGUud2lkdGggPSAnMCc7IGIuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7IH0sIDMwMCk7IH0gfSB9CmZ1bmN0aW9uIGFwaShwYXRoLCBvcHRzKSB7CiAgc2hvd0xvYWRpbmcoKTsKICBjb25zdCBoZHJzID0geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAuLi4ob3B0cyB8fCB7fSkuaGVhZGVycyB9OwogIHJldHVybiBmZXRjaCgnL2FkbWluL2FwaScgKyBwYXRoLCB7CiAgICBoZWFkZXJzOiBoZHJzLAogICAgY3JlZGVudGlhbHM6ICdzYW1lLW9yaWdpbicsIC4uLihvcHRzIHx8IHt9KQogIH0pLnRoZW4ociA9PiB7IGhpZGVMb2FkaW5nKCk7IGlmIChyLnN0YXR1cyA9PT0gNDAxKSB7IHNob3dUb2FzdCgnU2Vzc2lvbiBleHBpcmVkLCBwbGVhc2UgbG9naW4gYWdhaW4nLCAnZXJyb3InKTsgdGhyb3cgbmV3IEVycm9yKCd1bmF1dGhvcml6ZWQnKTsgfSByZXR1cm4gci5qc29uKCk7IH0pLmNhdGNoKGUgPT4geyBoaWRlTG9hZGluZygpOyB0aHJvdyBlOyB9KTsKfQpmdW5jdGlvbiBlc2MocykgeyByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywnJmFtcDsnKS5yZXBsYWNlKC88L2csJyZsdDsnKS5yZXBsYWNlKC8+L2csJyZndDsnKS5yZXBsYWNlKC8iL2csJyZxdW90OycpLnJlcGxhY2UoLycvZywnJiN4Mjc7Jyk7IH0KYXN5bmMgZnVuY3Rpb24gY29weUtleShwbmFtZSwgaWQpIHsKICB0cnkgeyBjb25zdCByID0gYXdhaXQgYXBpKCcva2V5cz9mdWxsPTEmcG5hbWU9JyArIGVuY29kZVVSSUNvbXBvbmVudChwbmFtZSkgKyAnJmlkPScgKyBlbmNvZGVVUklDb21wb25lbnQoaWQpKTsgaWYgKHIuYXBpS2V5KSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHIuYXBpS2V5KTsgc2hvd1RvYXN0KCdLZXkgY29waWVkJywgJ3N1Y2Nlc3MnKTsgfSBlbHNlIHNob3dUb2FzdCgnRmFpbGVkIHRvIGdldCBrZXknLCAnZXJyb3InKTsgfSBjYXRjaCB7IHNob3dUb2FzdCgnRmFpbGVkIHRvIGNvcHknLCAnZXJyb3InKTsgfQp9CmZ1bmN0aW9uIHNob3dUb2FzdChtc2csIHR5cGUpIHsKICBjb25zdCBpY28gPSB0eXBlID09PSAnc3VjY2VzcycgPyAnXHUyNzEzJyA6IHR5cGUgPT09ICdlcnJvcicgPyAnXHUyNzE3JyA6ICdcdTIxMzknOwogIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgdC5jbGFzc05hbWUgPSAndG9hc3QgJyArIHR5cGU7CiAgdC5pbm5lckhUTUwgPSAnPHNwYW4gc3R5bGU9Im1hcmdpbi1yaWdodDoxMHB4O2ZvbnQtc2l6ZToxNnB4Ij4nICsgaWNvICsgJzwvc3Bhbj4nOwogIHQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUobXNnKSk7CiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh0KTsgc2V0VGltZW91dCgoKSA9PiB0LnJlbW92ZSgpLCAzNTAwKTsKfQoKZnVuY3Rpb24gc2hvd1RhYihuYW1lKSB7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNpZGViYXIgYScpLmZvckVhY2goYSA9PiBhLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTsKICBjb25zdCBuYXYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbmF2LScgKyBuYW1lKTsgaWYgKG5hdikgbmF2LmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwogIGlmIChQQUdFU1tuYW1lXSAmJiBQQUdFU1tuYW1lXS5yZW5kZXIpIFBBR0VTW25hbWVdLnJlbmRlcigpOwp9CmZ1bmN0aW9uIHNldENvbnRlbnQoaCkgewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21haW4tY29udGVudCcpOwogIGVsLnN0eWxlLm9wYWNpdHkgPSAnMCc7CiAgc2V0VGltZW91dCgoKSA9PiB7IGVsLmlubmVySFRNTCA9IGg7IGVsLnN0eWxlLnRyYW5zaXRpb24gPSAnb3BhY2l0eSAuMjVzJzsgZWwuc3R5bGUub3BhY2l0eSA9ICcxJzsgfSwgNTApOwp9CmNvbnN0IFBBR0VTID0gewogIG92ZXJ2aWV3OiB7IHRpdGxlOiAnRGFzaGJvYXJkIE92ZXJ2aWV3JywgcmVuZGVyOiByZW5kZXJPdmVydmlldyB9LAogIGtleXM6IHsgdGl0bGU6ICdBUEkgS2V5cycsIHJlbmRlcjogcmVuZGVyS2V5cyB9LAogIGdhdGV3YXk6IHsgdGl0bGU6ICdHYXRld2F5IEtleXMnLCByZW5kZXI6IHJlbmRlckdhdGV3YXkgfSwKICBzdHJhdGVneTogeyB0aXRsZTogJ1JvdXRpbmcgU3RyYXRlZ3knLCByZW5kZXI6IHJlbmRlclN0cmF0ZWd5IH0sCiAgLy8gbG9ncyBhbmQgcmVxLWxvZ3MgcmVtb3ZlZCAoS1Ygc3BhY2UpCiAgYW5hbHl0aWNzOiB7IHRpdGxlOiAnQW5hbHl0aWNzJywgcmVuZGVyOiByZW5kZXJBbmFseXRpY3MgfSwKICB1c2FnZTogeyB0aXRsZTogJ1VzYWdlICYgTGltaXRzJywgcmVuZGVyOiByZW5kZXJVc2FnZSB9LAogIHNldHRpbmdzOiB7IHRpdGxlOiAnU2V0dGluZ3MnLCByZW5kZXI6IHJlbmRlclNldHRpbmdzIH0sCiAgaGVhbHRoOiB7IHRpdGxlOiAnSGVhbHRoIENoZWNrJywgcmVuZGVyOiByZW5kZXJIZWFsdGggfSwKICBzZXR1cDogeyB0aXRsZTogJ1NldHVwIEd1aWRlJywgcmVuZGVyOiByZW5kZXJTZXR1cCB9Cn07CnNob3dUYWIoJ292ZXJ2aWV3Jyk7CmFzeW5jIGZ1bmN0aW9uIHJlbmRlck92ZXJ2aWV3KCkgewogIGNvbnN0IHMgPSBhd2FpdCBhcGkoJy9zdGF0cycpOwogIGNvbnN0IGEgPSBhd2FpdCBhcGkoJy9hbmFseXRpY3M/ZGF5cz03Jyk7CiAgbGV0IHRvdGFsQ29zdCA9IDA7IGxldCB0b3RhbFRva2VucyA9IDA7CiAgaWYgKEFycmF5LmlzQXJyYXkoYSkpIHsgYS5mb3JFYWNoKGQgPT4geyB0b3RhbENvc3QgKz0gZC50b3RhbENvc3QgfHwgMDsgdG90YWxUb2tlbnMgKz0gKGQudG90YWxQcm9tcHRUb2tlbnMgfHwgMCkgKyAoZC50b3RhbENvbXBsZXRpb25Ub2tlbnMgfHwgMCk7IH0pOyB9CiAgY29uc3QgY29weVVybCA9ICgpID0+IHsgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoJ2h0dHBzOi8vYnVkZGhpLWR3YXIucmljaGFyZC1icm93bi1taWFtaS53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zJyk7IHNob3dUb2FzdCgnVVJMIGNvcGllZCcsICdzdWNjZXNzJyk7IH07CiAgc2V0Q29udGVudChgCiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO21hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGgyIHN0eWxlPSJtYXJnaW46MDtib3JkZXI6bm9uZTtwYWRkaW5nOjAiPkRhc2hib2FyZCBPdmVydmlldzwvaDI+CiAgICAgIDxzcGFuIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojNzQ4OGE4Ij4ke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9PC9zcGFuPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPk1vbml0b3Igb3ZlcmFsbCBnYXRld2F5IHBlcmZvcm1hbmNlOiByZXF1ZXN0IGNvdW50LCBrZXkgaGVhbHRoIGJ5IHN0YXR1cyAoYWN0aXZlL2RlYWQvZXhwaXJlZC93YXJtaW5nKSwgZXN0aW1hdGVkIGNvc3QgYW5kIHRva2VuIHVzYWdlIGFjcm9zcyBhbGwgcHJvdmlkZXJzIG92ZXIgdGhlIGxhc3QgNyBkYXlzLjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZHMiPgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDgpLHJnYmEoOTksMTAyLDI0MSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIj4ke3MucmVxdWVzdHNUb2RheSB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+UmVxdWVzdHMgVG9kYXk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDk5LDEwMiwyNDEsLjA4KSxyZ2JhKDEzOSw5MiwyNDYsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSI+JHtzLnRvdGFsS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+VG90YWwgS2V5czwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMzQsMTk3LDk0LC4wOCkscmdiYSgyMiwxNjMsNzQsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM4NmVmYWMiPiR7cy5hY3RpdmVLZXlzIHx8IDB9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+QWN0aXZlIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzOSw2OCw2OCwuMDgpLHJnYmEoMjIwLDM4LDM4LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij4ke3MuZGVhZEtleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij5EZWFkIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzNCwxNzksOCwuMDgpLHJnYmEoMjAyLDEzOCw0LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmRlNjhhIj4ke3Mud2FybWluZ0tleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5XYXJtaW5nIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDE5MiwxMzIsMjUyLC4wOCkscmdiYSgxNjgsODUsMjQ3LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojYzA4NGZjIj4ke3MuZXhwaXJlZEtleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojYzA4NGZjIj5FeHBpcmVkIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDI1MSwxOTEsMzYsLjA4KSxyZ2JhKDI0NSwxNTgsMTEsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiQke3RvdGFsQ29zdC50b0ZpeGVkKDQpfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPkVzdC4gQ29zdCAoN2QpPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1OSwxMzAsMjQ2LC4wOCkscmdiYSgzNyw5OSwyMzUsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM5M2M1ZmQiPiR7dG90YWxUb2tlbnMudG9Mb2NhbGVTdHJpbmcoKX08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojOTNjNWZkIj5Ub2tlbnMgKDdkKTwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iZ3JpZC1jb2x1bW46MS8tMTtib3JkZXItY29sb3I6cmdiYSg1NiwxODksMjQ4LC4yNSk7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDYpLHJnYmEoOTksMTAyLDI0MSwuMDQpKTttYXJnaW4tYm90dG9tOjIwcHgiPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206NnB4Ij4KICAgICAgICA8c3BhbiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6Izc0ODhhODtmb250LXdlaWdodDo2MDA7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi42cHgiPllvdXIgR2F0ZXdheSBVUkw8L3NwYW4+CiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSIke2NvcHlVcmx9IiBjbGFzcz0ic2Vjb25kYXJ5IiBzdHlsZT0icGFkZGluZzo2cHggMTRweDtmb250LXNpemU6MTJweDttYXJnaW46MCI+Q29weSBVUkw8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxjb2RlIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojMzhiZGY4O3dvcmQtYnJlYWs6YnJlYWstYWxsO2Rpc3BsYXk6YmxvY2s7cGFkZGluZzoxMHB4IDE0cHg7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC40KTtib3JkZXItcmFkaXVzOjhweDtmb250LWZhbWlseTonRmlyYSBDb2RlJywnQ29uc29sYXMnLG1vbm9zcGFjZSI+aHR0cHM6Ly9idWRkaGktZHdhci5yaWNoYXJkLWJyb3duLW1pYW1pLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnM8L2NvZGU+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOiNmZGU2OGE7bWFyZ2luLXRvcDo4cHgiPlVzZSBhIEdhdGV3YXkgS2V5IGFzIEJlYXJlciB0b2tlbi4gU2VlIFNldHVwIHRhYiBmb3IgZXhhbXBsZXMuPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPlByb3ZpZGVyIFVzYWdlIFRvZGF5PC9oMj4KICAgIDxkaXYgY2xhc3M9ImNhcmRzIiBpZD0idXNhZ2UtbWluaSIgc3R5bGU9ImdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDIwMHB4LDFmcikpIj5Mb2FkaW5nLi4uPC9kaXY+CiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5EYWlseSBSZXF1ZXN0cyAoNyBkYXlzKTwvaDI+CiAgICA8cHJlPiR7ZXNjKEpTT04uc3RyaW5naWZ5KGEsIG51bGwsIDIpKX08L3ByZT4KICBgKTsKICB0cnkgewogICAgY29uc3QgdXIgPSBhd2FpdCBhcGkoJy9rZXktdXNhZ2UnKTsKICAgIGNvbnN0IHVkID0gdXIucHJvdmlkZXJzIHx8IHVyOwogICAgY29uc3QgdCA9IHVyLnRvdGFscyB8fCB7IHJlcXVlc3RzOiAwLCBzdWNjZXNzZXM6IDAsIGZhaWx1cmVzOiAwLCBwcm9tcHRUb2tlbnM6IDAsIGNvbXBsZXRpb25Ub2tlbnM6IDAsIGNvc3Q6IDAsIGtleXM6IDAgfTsKICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3VzYWdlLW1pbmknKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGxldCBjYXJkcyA9ICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDgpLHJnYmEoOTksMTAyLDI0MSwuMDUpKSI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjE2cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiMzOGJkZjgiPicgKyB0LnJlcXVlc3RzICsgJzwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTgiPlRvdGFsIFJlcTwvZGl2PjwvZGl2PicgKwogICAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InBhZGRpbmc6MTJweCAxNnB4Ij48ZGl2IHN0eWxlPSJmb250LXNpemU6MTZweDtmb250LXdlaWdodDo3MDA7Y29sb3I6I2ZkZTY4YSI+JCcgKyB0LmNvc3QudG9GaXhlZCg0KSArICc8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTBweDtjb2xvcjojNzQ4OGE4Ij5Ub3RhbCBDb3N0PC9kaXY+PC9kaXY+JzsKICAgIGZvciAoY29uc3QgW3BuLCBwZF0gb2YgT2JqZWN0LmVudHJpZXModWQpKSB7CiAgICAgIGNvbnN0IGxpbSA9IHBkLmxpbWl0IHx8IHt9OyBjb25zdCBkUmVxID0gbGltLmRhaWx5UmVxdWVzdHMgfHwgOTk5OTk5OwogICAgICBsZXQgdHIgPSAwOyBmb3IgKGNvbnN0IGsgb2YgcGQua2V5cykgdHIgKz0gay51c2FnZS5yZXF1ZXN0czsKICAgICAgY29uc3QgcGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLnJvdW5kKHRyIC8gZFJlcSAqIDEwMCkpOwogICAgICBjb25zdCBjb2wgPSBwY3QgPiA4MCA/ICcjZjg3MTcxJyA6IHBjdCA+IDUwID8gJyNmYmJmMjQnIDogJyMzOGJkZjgnOwogICAgICBjYXJkcyArPSAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InBhZGRpbmc6MTJweCAxNnB4Ij48ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Zm9udC1zaXplOjEzcHg7bWFyZ2luLWJvdHRvbTo0cHgiPjxzcGFuPicgKyBlc2MocG4pICsgJzwvc3Bhbj48c3BhbiBzdHlsZT0iY29sb3I6JyArIGNvbCArICciPicgKyB0ciArICc8L3NwYW4+PC9kaXY+JyArCiAgICAgICAgJzxkaXYgc3R5bGU9ImhlaWdodDo2cHg7YmFja2dyb3VuZDpyZ2JhKDcxLDg1LDEwNSwuNCk7Ym9yZGVyLXJhZGl1czozcHg7b3ZlcmZsb3c6aGlkZGVuIj48ZGl2IHN0eWxlPSJ3aWR0aDonICsgcGN0ICsgJyU7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDonICsgY29sICsgJztib3JkZXItcmFkaXVzOjNweCI+PC9kaXY+PC9kaXY+JyArCiAgICAgICAgJzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLXRvcDoycHgiPmxpbWl0OiAnICsgZFJlcSArICcgcmVxL2RheTwvZGl2PjwvZGl2Pic7CiAgICB9CiAgICBlbC5pbm5lckhUTUwgPSBjYXJkcyB8fCAnPHAgc3R5bGU9ImNvbG9yOiM5NGEzYjgiPk5vIGRhdGE8L3A+JzsKICB9IGNhdGNoIHt9Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyS2V5cygpIHsKICBjb25zdCBbcmF3LCBoZWFsdGhdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL2tleXMnKSwgYXBpKCcva2V5cy1oZWFsdGgnKV0pOwogIGNvbnN0IGhNYXAgPSB7fTsKICBmb3IgKGNvbnN0IFtwcm92LCBpdGVtc10gb2YgT2JqZWN0LmVudHJpZXMoaGVhbHRoIHx8IHt9KSkgeyBoTWFwW3Byb3ZdID0ge307IGZvciAoY29uc3QgaXQgb2YgaXRlbXMpIGhNYXBbcHJvdl1baXQuaWRdID0gaXQ7IH0KICBsZXQgcm93cyA9ICcnOwogIGZvciAoY29uc3QgW3BuYW1lLCBrZXlzXSBvZiBPYmplY3QuZW50cmllcyhyYXcpKSB7CiAgICBmb3IgKGNvbnN0IGsgb2Yga2V5cykgewogICAgICBjb25zdCBtcyA9IChrLm1vZGVsc3x8W10pLnNsaWNlKDAsMykuam9pbignLCAnKTsKICAgICAgY29uc3QgbWFza2VkID0gKGsuYXBpS2V5fHwnJykuaW5jbHVkZXMoJyoqKionKSA/IGsuYXBpS2V5IDogJyoqKionOwogICAgICBjb25zdCBoaSA9IGhNYXBbcG5hbWVdPy5bay5pZF07CiAgICAgIGNvbnN0IHN0ID0gaGk/LnN0YXR1cyB8fCAndW5rbm93bic7CiAgICAgIGNvbnN0IGNiID0gaGk/LmNiU3RhdGUgfHwgJ2Nsb3NlZCc7CiAgICAgIGNvbnN0IGNvb2xpbmcgPSBoaT8uY29vbGluZyB8fCBmYWxzZTsKICAgICAgY29uc3QgZXJyID0gaGk/Lmxhc3RFcnJvciB8fCAnJzsKICAgICAgY29uc3Qgc3RDbGFzcyA9IHN0ID09PSAnYWN0aXZlJyA/ICdvaycgOiBzdCA9PT0gJ2RlYWQnID8gJ2ZhaWwnIDogc3QgPT09ICdleHBpcmVkJyA/ICd3YXJuaW5nJyA6ICd3YXJuaW5nJzsKICAgICAgY29uc3Qgc3RMYWJlbCA9IHN0ICsgKGNiID09PSAnb3BlbicgPyAnIMOwxbjigJ3igJwnIDogY2IgPT09ICdoYWxmLW9wZW4nID8gJyDDsMW44oCd4oCeJyA6ICcnKSArIChjb29saW5nID8gJyDDosKPwrMnIDogJycpOwogICAgICBjb25zdCBlcnJTaG9ydCA9IGVyciA/ICcgPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiNmODcxNzEiPicgKyBlc2MoZXJyLnNsaWNlKDAsIDYwKSkgKyAnPC9zcGFuPicgOiAnJzsKICAgICAgcm93cyArPSAnPHRyPjx0ZD4nICsgZXNjKHBuYW1lKSArICc8L3RkPjx0ZCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izk0YTNiOCI+JyArIGVzYyhrLmxhYmVsfHwnJykgKyAnPC90ZD4nICsKICAgICAgICAnPHRkPjxjb2RlIHN0eWxlPSJmb250LXNpemU6MTFweDtjb2xvcjojOTRhM2I4O3VzZXItc2VsZWN0Om5vbmUiPicgKyBtYXNrZWQgKyAnPC9jb2RlPjwvdGQ+JyArCiAgICAgICAgJzx0ZD48c3BhbiBjbGFzcz0idGFnICcgKyBzdENsYXNzICsgJyIgaWQ9InN0LScgKyBlc2Moay5pZCkgKyAnIiBzdHlsZT0iY3Vyc29yOmhlbHAiIHRpdGxlPSJDQjogJyArIGNiICsgKGNvb2xpbmcgPyAnIHwgY29vbGluZyA2MHMnIDogJycpICsgKGVyciA/ICcgfCAnICsgZXNjKGVycikgOiAnJykgKyAnIj4nICsgc3RMYWJlbCArICc8L3NwYW4+PC90ZD4nICsKICAgICAgICAnPHRkIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojOGI5NDllO21heC13aWR0aDoxODBweDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpcyI+JyArIGVzYyhtcyB8fCAnw6LigqzigJ0nKSArICc8L3RkPicgKwogICAgICAgICc8dGQgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5NGEzYjgiPicgKyAoay5hZGRlZEF0ID8gbmV3IERhdGUoay5hZGRlZEF0KS50b0xvY2FsZURhdGVTdHJpbmcoKSA6ICfDouKCrOKAnScpICsgJzwvdGQ+JyArCic8dGQ+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0iY29weUtleShcJycgKyBlc2MocG5hbWUpICsgJ1wnLFwnJyArIGVzYyhrLmlkKSArICdcJykiIHN0eWxlPSJwYWRkaW5nOjRweCA4cHg7Zm9udC1zaXplOjExcHgiPkNvcHk8L2J1dHRvbj4gJyArCic8YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIG9uY2xpY2s9InRlc3RLZXkoXCcnICsgZXNjKHBuYW1lKSArICdcJyxcJycgKyBlc2Moay5pZCkgKyAnXCcpIiBzdHlsZT0icGFkZGluZzo0cHggOHB4O2ZvbnQtc2l6ZToxMXB4Ij5UZXN0PC9idXR0b24+ICcgKwonPGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiBvbmNsaWNrPSJyZURldGVjdEtleShcJycgKyBlc2MocG5hbWUpICsgJ1wnLFwnJyArIGVzYyhrLmlkKSArICdcJykiIHN0eWxlPSJwYWRkaW5nOjRweCA4cHg7Zm9udC1zaXplOjExcHgiPk1vZGVsczwvYnV0dG9uPiAnICsKJzxidXR0b24gY2xhc3M9ImRhbmdlciIgb25jbGljaz0iZGVsZXRlS2V5KFwnJyArIGVzYyhwbmFtZSkgKyAnXCcsXCcnICsgZXNjKGsuaWQpICsgJ1wnKSIgc3R5bGU9InBhZGRpbmc6NHB4IDhweDtmb250LXNpemU6MTFweCI+RGVsPC9idXR0b24+PC90ZD48L3RyPic7CiAgICB9CiAgfQogIHNldENvbnRlbnQoYAogICAgPGgyPkFQSSBLZXlzPC9oMj4KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+TWFuYWdlIHByb3ZpZGVyIEFQSSBrZXlzIGZvciBHcm9xLCBHb29nbGUgR2VtaW5pLCBNaXN0cmFsLCBPcGVuUm91dGVyLCBEZWVwU2VlaywgYW5kIFRvZ2V0aGVyIEFJLiBFYWNoIGtleSBzaG93cyBsaXZlIGhlYWx0aCBzdGF0dXMgKGFjdGl2ZS9kZWFkL2V4cGlyZWQvd2FybWluZyksIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSAoY2xvc2VkL29wZW4vaGFsZi1vcGVuKSwgYW5kIHJhdGUtbGltaXQgY29vbGRvd24uIENsaWNrIFRlc3QgdG8gcHJvYmUgdGhlIGtleSwgb3IgTW9kZWxzIHRvIHJlLWRldGVjdCBhdmFpbGFibGUgbW9kZWxzLiBDaXJjdWl0IGJyZWFrZXIgb3BlbnMgYWZ0ZXIgNSBjb25zZWN1dGl2ZSBmYWlsdXJlczsgcmF0ZS1saW1pdCAoNDI5KSB0cmlnZ2VycyBhIDEtbWludXRlIGNvb2xkb3duLjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZm9ybS1yb3ciPgogICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+UHJvdmlkZXI8L2xhYmVsPjxzZWxlY3QgaWQ9ImtwLXByb3ZpZGVyIj48b3B0aW9uPmdyb3E8L29wdGlvbj48b3B0aW9uPmdvb2dsZTwvb3B0aW9uPjxvcHRpb24+bWlzdHJhbDwvb3B0aW9uPjxvcHRpb24+b3BlbnJvdXRlcjwvb3B0aW9uPjxvcHRpb24+ZGVlcHNlZWs8L29wdGlvbj48b3B0aW9uPnRvZ2V0aGVyPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5BUEkgS2V5PC9sYWJlbD48aW5wdXQgaWQ9ImtwLWtleSIgcGxhY2Vob2xkZXI9InNrLS4uLiI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5MYWJlbDwvbGFiZWw+PGlucHV0IGlkPSJrcC1sYWJlbCIgcGxhY2Vob2xkZXI9Im15LWtleSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9ImFkZEtleSgpIj5BZGQgS2V5PC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkZXRhaWxzIHN0eWxlPSJtYXJnaW4tYm90dG9tOjE2cHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiODtjdXJzb3I6cG9pbnRlciI+CiAgICAgIDxzdW1tYXJ5IHN0eWxlPSJjb2xvcjojMzhiZGY4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMCI+UHJvdmlkZXIgS2V5IExpbmtzPC9zdW1tYXJ5PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjhweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo2cHgiPgogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vY29uc29sZS5ncm9xLmNvbS9rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPkdyb3EgY29uc29sZS5ncm9xLmNvbTwvYT4KICAgICAgICA8YSBocmVmPSJodHRwczovL2Fpc3R1ZGlvLmdvb2dsZS5jb20vYXBpa2V5IiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPkdvb2dsZSBhaXN0dWRpby5nb29nbGUuY29tPC9hPgogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vY29uc29sZS5taXN0cmFsLmFpL2FwaS1rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPk1pc3RyYWwgY29uc29sZS5taXN0cmFsLmFpPC9hPgogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vb3BlbnJvdXRlci5haS9rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPk9wZW5Sb3V0ZXIgb3BlbnJvdXRlci5haTwvYT4KICAgICAgPC9kaXY+CiAgICA8L2RldGFpbHM+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+UHJvdmlkZXI8L3RoPjx0aD5MYWJlbDwvdGg+PHRoPktleTwvdGg+PHRoPlN0YXR1czwvdGg+PHRoPk1vZGVsczwvdGg+PHRoPkFkZGVkPC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+CiAgICA8dGJvZHk+JyArIHJvd3MgKyAnPC90Ym9keT48L3RhYmxlPgogIGApOwp9CiAgfQogIHNldENvbnRlbnQoYAogICAgPGgyPkFQSSBLZXlzPC9oMj4KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+TWFuYWdlIHByb3ZpZGVyIEFQSSBrZXlzIGZvciBHcm9xLCBHb29nbGUgR2VtaW5pLCBNaXN0cmFsLCBPcGVuUm91dGVyLCBEZWVwU2VlaywgYW5kIFRvZ2V0aGVyIEFJLiBLZXlzIHRoYXQgZmFpbCA1KyBjb25zZWN1dGl2ZSByZXF1ZXN0cyBhcmUgY2lyY3VpdC1icm9rZW4uIEtleXMgaGl0IGJ5IHJhdGUtbGltaXQgKDQyOSkgZ2V0IGEgMS1taW51dGUgY29vbGRvd24gYmVmb3JlIHJldHJ5LjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZm9ybS1yb3ciPgogICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+UHJvdmlkZXI8L2xhYmVsPjxzZWxlY3QgaWQ9ImtwLXByb3ZpZGVyIj48b3B0aW9uPmdyb3E8L29wdGlvbj48b3B0aW9uPmdvb2dsZTwvb3B0aW9uPjxvcHRpb24+bWlzdHJhbDwvb3B0aW9uPjxvcHRpb24+b3BlbnJvdXRlcjwvb3B0aW9uPjxvcHRpb24+ZGVlcHNlZWs8L29wdGlvbj48b3B0aW9uPnRvZ2V0aGVyPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5BUEkgS2V5PC9sYWJlbD48aW5wdXQgaWQ9ImtwLWtleSIgcGxhY2Vob2xkZXI9InNrLS4uLiI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5MYWJlbDwvbGFiZWw+PGlucHV0IGlkPSJrcC1sYWJlbCIgcGxhY2Vob2xkZXI9Im15LWtleSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9ImFkZEtleSgpIj5BZGQgS2V5PC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkZXRhaWxzIHN0eWxlPSJtYXJnaW4tYm90dG9tOjE2cHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiODtjdXJzb3I6cG9pbnRlciI+CiAgICAgIDxzdW1tYXJ5IHN0eWxlPSJjb2xvcjojMzhiZGY4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMCI+UHJvdmlkZXIgS2V5IExpbmtzPC9zdW1tYXJ5PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjhweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo2cHgiPgogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vY29uc29sZS5ncm9xLmNvbS9rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPkdyb3EgY29uc29sZS5ncm9xLmNvbTwvYT4KICAgICAgICA8YSBocmVmPSJodHRwczovL2Fpc3R1ZGlvLmdvb2dsZS5jb20vYXBpa2V5IiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPkdvb2dsZSBhaXN0dWRpby5nb29nbGUuY29tPC9hPgogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vY29uc29sZS5taXN0cmFsLmFpL2FwaS1rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPk1pc3RyYWwgY29uc29sZS5taXN0cmFsLmFpPC9hPgogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vb3BlbnJvdXRlci5haS9rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPk9wZW5Sb3V0ZXIgb3BlbnJvdXRlci5haTwvYT4KICAgICAgPC9kaXY+CiAgICA8L2RldGFpbHM+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+UHJvdmlkZXI8L3RoPjx0aD5MYWJlbDwvdGg+PHRoPktleTwvdGg+PHRoPlN0YXR1czwvdGg+PHRoPk1vZGVsczwvdGg+PHRoPkFkZGVkPC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+CiAgICA8dGJvZHk+JyArIHJvd3MgKyAnPC90Ym9keT48L3RhYmxlPgogIGApOwp9CmFzeW5jIGZ1bmN0aW9uIHRlc3RLZXkocG5hbWUsIGlkKSB7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3QtJyArIGlkKTsKICBpZiAoZWwpIGVsLmlubmVySFRNTCA9ICd0ZXN0aW5nLi4uJzsKICBjb25zdCBoID0gYXdhaXQgYXBpKCcvdGVzdC1rZXknLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHBuYW1lLCBpZCB9KSB9KTsKICBjb25zdCBzdCA9IGgub2sgPyAnb2snIDogJ2ZhaWwnOwogIGlmIChlbCkgeyBlbC5jbGFzc05hbWUgPSAndGFnICcgKyBzdDsgZWwuaW5uZXJIVE1MID0gc3Q7IH0KfQphc3luYyBmdW5jdGlvbiByZURldGVjdEtleShwbmFtZSwgaWQpIHsKICBjb25zdCByID0gYXdhaXQgYXBpKCcvcmVkZXRlY3QtbW9kZWxzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwbmFtZSwgaWQgfSkgfSk7CiAgaWYgKHIub2spIHsgc2hvd1RvYXN0KCdNb2RlbHMgdXBkYXRlZDogJyArIChyLm1vZGVsc3x8W10pLmpvaW4oJywgJyksICdzdWNjZXNzJyk7IHJlbmRlcktleXMoKTsgfQogIGVsc2UgeyBzaG93VG9hc3Qoci5lcnJvciB8fCAnRmFpbGVkJywgJ2Vycm9yJyk7IH0KfQphc3luYyBmdW5jdGlvbiBkZWxldGVLZXkocG5hbWUsIGlkKSB7IGlmICghY29uZmlybSgnRGVsZXRlIGtleT8nKSkgcmV0dXJuOyBhd2FpdCBhcGkoJy9rZXlzJywgeyBtZXRob2Q6ICdERUxFVEUnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHBuYW1lLCBpZCB9KSB9KTsgcmVuZGVyS2V5cygpOyB9CmFzeW5jIGZ1bmN0aW9uIGFkZEtleSgpIHsKICBjb25zdCBwbmFtZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdrcC1wcm92aWRlcicpLnZhbHVlOwogIGNvbnN0IGFwaUtleSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdrcC1rZXknKS52YWx1ZTsKICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdrcC1sYWJlbCcpLnZhbHVlIHx8IChwbmFtZSArICdfJyArIERhdGUubm93KCkpOwogIGlmICghYXBpS2V5KSB7IHNob3dUb2FzdCgnRW50ZXIgQVBJIGtleScsICdlcnJvcicpOyByZXR1cm47IH0KICBjb25zdCByID0gYXdhaXQgYXBpKCcva2V5cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcG5hbWUsIGFwaUtleSwgbGFiZWwgfSkgfSk7CiAgaWYgKHIub2spIHsgc2hvd1RvYXN0KCdLZXkgYWRkZWQgc3VjY2Vzc2Z1bGx5JywgJ3N1Y2Nlc3MnKTsgcmVuZGVyS2V5cygpOyB9CiAgZWxzZSB7IHNob3dUb2FzdChyLmVycm9yIHx8ICdGYWlsZWQnLCAnZXJyb3InKTsgfQp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlckdhdGV3YXkoKSB7CiAgY29uc3QgZyA9IGF3YWl0IGFwaSgnL2dhdGV3YXkta2V5cycpOwogIGxldCByb3dzID0gZy5tYXAoayA9PiAnPHRyIGRhdGEtd29yZD0iJyArIGVzYyhrLndvcmQpICsgJyIgZGF0YS1lbmFibGVkPSInICsgay5lbmFibGVkICsgJyI+PHRkPicgKyBlc2Moay53b3JkKSArICc8L3RkPicgKwogICAgJzx0ZD48c3BhbiBjbGFzcz0idGFnICcgKyAoay5lbmFibGVkPydhY3RpdmUnOidmYWlsJykgKyAnIj4nICsgKGsuZW5hYmxlZD8nQWN0aXZlJzonRGlzYWJsZWQnKSArICc8L3NwYW4+PC90ZD4nICsKICAgICc8dGQ+JyArIChrLnVzYWdlfHwwKSArICc8L3RkPicgKwogICAgJzx0ZCBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6Izk0YTNiOCI+JyArIChrLmNyZWF0ZWRBdCA/IG5ldyBEYXRlKGsuY3JlYXRlZEF0KS50b0xvY2FsZURhdGVTdHJpbmcoKSA6ICcnKSArICc8L3RkPicgKwogICAgJzx0ZD48YnV0dG9uIG9uY2xpY2s9InRvZ2dsZUd3KHRoaXMpIiBzdHlsZT0icGFkZGluZzo0cHggMTBweDtmb250LXNpemU6MTJweCI+JyArIChrLmVuYWJsZWQ/J0Rpc2FibGUnOidFbmFibGUnKSArICc8L2J1dHRvbj4nICsKICAgICc8YnV0dG9uIGNsYXNzPSJkYW5nZXIiIG9uY2xpY2s9ImRlbGV0ZUd3KHRoaXMpIiBzdHlsZT0icGFkZGluZzo0cHggMTBweDtmb250LXNpemU6MTJweCI+RGVsPC9idXR0b24+PC90ZD48L3RyPicpLmpvaW4oJycpOwogIHNldENvbnRlbnQoYAogICAgPGgyPkdhdGV3YXkgS2V5czwvaDI+CiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPkNyZWF0ZSBBUEkga2V5cyBmb3IgZXh0ZXJuYWwgY2xpZW50cyB0aGF0IHByb3h5IHRocm91Z2ggdGhpcyBnYXRld2F5LiBFYWNoIGtleSBoYXMgdXNhZ2UgdHJhY2tpbmcgYW5kIGNhbiBiZSBlbmFibGVkL2Rpc2FibGVkIGluZGVwZW5kZW50bHkuIEdlbmVyYXRlIGEgcmFuZG9tIGtleSBvciBjcmVhdGUgYSBjdXN0b20gd29yZC1iYXNlZCB0b2tlbi48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZvcm0tcm93Ij4KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPkdhdGV3YXkgS2V5ICh3b3JkL3Rva2VuKTwvbGFiZWw+PGlucHV0IGlkPSJndy13b3JkIiBwbGFjZWhvbGRlcj0ibXktYXBwLWtleSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9ImFkZEd3KCkiPkFkZCBLZXk8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiBvbmNsaWNrPSJnZW5Hd0tleSgpIj5HZW5lcmF0ZSBLZXk8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPHRhYmxlPjx0aGVhZD48dHI+PHRoPldvcmQ8L3RoPjx0aD5TdGF0dXM8L3RoPjx0aD5Vc2FnZTwvdGg+PHRoPkNyZWF0ZWQ8L3RoPjx0aD48L3RoPjwvdHI+PC90aGVhZD4KICAgIDx0Ym9keT4ke3Jvd3N9PC90Ym9keT48L3RhYmxlPgogIGApOwp9CmFzeW5jIGZ1bmN0aW9uIHRvZ2dsZUd3KGVsKXtjb25zdCB0cj1lbC5jbG9zZXN0KCd0cicpO2NvbnN0IHdvcmQ9dHIuZGF0YXNldC53b3JkO2NvbnN0IGVuYWJsZWQ9dHIuZGF0YXNldC5lbmFibGVkPT09J3RydWUnP2ZhbHNlOnRydWU7YXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyx7bWV0aG9kOidQQVRDSCcsYm9keTpKU09OLnN0cmluZ2lmeSh7d29yZCxlbmFibGVkfSl9KTsgcmVuZGVyR2F0ZXdheSgpO30KYXN5bmMgZnVuY3Rpb24gZGVsZXRlR3coZWwpe2NvbnN0IHdvcmQ9ZWwuY2xvc2VzdCgndHInKS5kYXRhc2V0LndvcmQ7aWYoIWNvbmZpcm0oJ0RlbGV0ZSAiJyt3b3JkKyciPycpKXJldHVybjthd2FpdCBhcGkoJy9nYXRld2F5LWtleXMnLHttZXRob2Q6J0RFTEVURScsYm9keTpKU09OLnN0cmluZ2lmeSh7d29yZH0pfSk7IHJlbmRlckdhdGV3YXkoKTt9CmFzeW5jIGZ1bmN0aW9uIGFkZEd3KCl7CiAgY29uc3Qgd29yZD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ3ctd29yZCcpLnZhbHVlOwogIGlmKCF3b3JkKXtzaG93VG9hc3QoJ1dvcmQgcmVxdWlyZWQnLCdlcnJvcicpO3JldHVybn0KICBhd2FpdCBhcGkoJy9nYXRld2F5LWtleXMnLHttZXRob2Q6J1BPU1QnLGJvZHk6SlNPTi5zdHJpbmdpZnkoe3dvcmR9KX0pOwogIHNob3dUb2FzdCgnQWRkZWQnLCdzdWNjZXNzJyk7IHJlbmRlckdhdGV3YXkoKTsKfQphc3luYyBmdW5jdGlvbiBnZW5Hd0tleSgpIHsKICBjb25zdCBjaGFycyA9ICdhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODknOwogIGxldCBrZXkgPSAnJzsKICBmb3IgKGxldCBpID0gMDsgaSA8IDMyOyBpKyspIHsKICAgIGlmIChpID4gMCAmJiBpICUgOCA9PT0gMCkga2V5ICs9ICctJzsKICAgIGtleSArPSBjaGFycy5jaGFyQXQoTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogY2hhcnMubGVuZ3RoKSk7CiAgfQogIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9nYXRld2F5LWtleXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHdvcmQ6IGtleSB9KSB9KTsKICBpZiAoci5vaykgeyBzaG93VG9hc3QoJ0tleSBnZW5lcmF0ZWQgYW5kIHNhdmVkOiAnICsga2V5LCAnc3VjY2VzcycpOyByZW5kZXJHYXRld2F5KCk7IH0KICBlbHNlIHsgc2hvd1RvYXN0KCdGYWlsZWQgdG8gc2F2ZSBrZXknLCAnZXJyb3InKTsgfQp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlclN0cmF0ZWd5KCkgewogIGNvbnN0IHMgPSBhd2FpdCBhcGkoJy9zdHJhdGVneScpOwogIGxldCBodG1sID0gJzxoMj5Sb3V0aW5nIFN0cmF0ZWd5PC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPkNob29zZSBob3cgdGhlIGdhdGV3YXkgc2VsZWN0cyBiZXR3ZWVuIG11bHRpcGxlIEFQSSBrZXlzIGZvciB0aGUgc2FtZSBwcm92aWRlci4gUm91bmQtcm9iaW4gY3ljbGVzIGV2ZW5seSwgbG93ZXN0LWxhdGVuY3kgcGlja3MgZmFzdGVzdCwgbGVhc3QtbG9hZGVkIHBpY2tzIGxvd2VzdCBmYWlsdXJlIHJhdGlvLjwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIj4nOwogIGZvciAoY29uc3QgW3Byb3YsIHN0cmF0XSBvZiBPYmplY3QuZW50cmllcyhzKSkgewogICAgaHRtbCArPSAnPGRpdiBjbGFzcz0iY2FyZCI+PGgzIHN0eWxlPSJjb2xvcjojMzhiZGY4O21hcmdpbi1ib3R0b206OHB4Ij4nICsgZXNjKHByb3YpICsgJzwvaDM+JyArCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiOCI+U3RyYXRlZ3k6IDxiIHN0eWxlPSJjb2xvcjojZTJlOGYwIj4nICsgZXNjKHN0cmF0KSArICc8L2I+PC9wPjwvZGl2Pic7CiAgfQogIGh0bWwgKz0gJzwvZGl2PjxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5TZXQgU3RyYXRlZ3k8L2gyPjxkaXYgY2xhc3M9ImZvcm0tcm93Ij4nICsKICAgICc8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+UHJvdmlkZXI8L2xhYmVsPjxzZWxlY3QgaWQ9InN0ci1wcm92aWRlciI+JyArIFsnZ3JvcScsJ2dvb2dsZScsJ21pc3RyYWwnLCdvcGVucm91dGVyJywnZGVlcHNlZWsnLCd0b2dldGhlciddLm1hcChwPT4nPG9wdGlvbj4nK3ArJzwvb3B0aW9uPicpLmpvaW4oJycpICsgJzwvc2VsZWN0PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5TdHJhdGVneTwvbGFiZWw+PHNlbGVjdCBpZD0ic3RyLXN0cmF0ZWd5Ij48b3B0aW9uPnJvdW5kLXJvYmluPC9vcHRpb24+PG9wdGlvbj5sb3dlc3QtbGF0ZW5jeTwvb3B0aW9uPjxvcHRpb24+bGVhc3QtbG9hZGVkPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+JyArCiAgICAnPGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0idXBkYXRlU3RyKCkiPlNldDwvYnV0dG9uPjwvZGl2PicgKwogICAgJzxoMj5SYXc8L2gyPjxwcmU+JyArIGVzYyhKU09OLnN0cmluZ2lmeShzLCBudWxsLCAyKSkgKyAnPC9wcmU+JzsKICBzZXRDb250ZW50KGh0bWwpOwp9CmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZVN0cigpIHsKICBjb25zdCBwbmFtZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdHItcHJvdmlkZXInKS52YWx1ZTsKICBjb25zdCBzdHJhdGVneSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdHItc3RyYXRlZ3knKS52YWx1ZTsKICBhd2FpdCBhcGkoJy9zdHJhdGVneScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcG5hbWUsIHN0cmF0ZWd5IH0pIH0pOwogIHNob3dUb2FzdCgnVXBkYXRlZCcsICdzdWNjZXNzJyk7IHJlbmRlclN0cmF0ZWd5KCk7Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyQW5hbHl0aWNzKCkgewogIGNvbnN0IGEgPSBhd2FpdCBhcGkoJy9hbmFseXRpY3M/ZGF5cz0zMCcpOwogIGlmKCFBcnJheS5pc0FycmF5KGEpfHxhLmxlbmd0aD09PTApe3NldENvbnRlbnQoJzxwPk5vIGFuYWx5dGljcyBkYXRhPC9wPicpO3JldHVybn0KICBsZXQgcm93cyA9IGEubWFwKGQgPT4gJzx0cj48dGQ+JyArIChkLmRhdGV8fCfDg8Kiw6LigJrCrMOi4oKswp0nKSArICc8L3RkPjx0ZD4nICsgKGQucmVxdWVzdHN8fDApICsgJzwvdGQ+PHRkPicgKyAoZC5mYWlsdXJlc3x8MCkgKyAnPC90ZD4nICsKICAgICc8dGQ+JyArIChkLnN1Y2Nlc3Nlc3x8MCkgKyAnPC90ZD48dGQ+JyArICgoZC50b3RhbFByb21wdFRva2Vuc3x8MCkudG9Mb2NhbGVTdHJpbmcoKSkgKyAnPC90ZD4nICsKICAgICc8dGQ+JyArICgoZC50b3RhbENvbXBsZXRpb25Ub2tlbnN8fDApLnRvTG9jYWxlU3RyaW5nKCkpICsgJzwvdGQ+PHRkPiQnICsgKChkLnRvdGFsQ29zdHx8MCkudG9GaXhlZCg0KSkgKyAnPC90ZD48L3RyPicpLmpvaW4oJycpOwogIGxldCB0b3RhbFJlcT0wLHRvdGFsRmFpbD0wLHRvdGFsQ29zdD0wLHRvdGFsUHJvbXB0PTAsdG90YWxDb21wPTA7CiAgYS5mb3JFYWNoKGQ9Pnt0b3RhbFJlcSs9ZC5yZXF1ZXN0c3x8MDt0b3RhbEZhaWwrPWQuZmFpbHVyZXN8fDA7dG90YWxDb3N0Kz1kLnRvdGFsQ29zdHx8MDt0b3RhbFByb21wdCs9ZC50b3RhbFByb21wdFRva2Vuc3x8MDt0b3RhbENvbXArPWQudG90YWxDb21wbGV0aW9uVG9rZW5zfHwwO30pOwogIHNldENvbnRlbnQoYAogICAgPGgyPkFuYWx5dGljczwvaDI+CiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlZpZXcgcmVxdWVzdCBtZXRyaWNzIG92ZXIgdGhlIGxhc3QgMzAgZGF5czogdm9sdW1lLCBzdWNjZXNzL2ZhaWx1cmUgcmF0ZXMsIHRva2VuIHVzYWdlLCBhbmQgZXN0aW1hdGVkIGNvc3QgcGVyIHByb3ZpZGVyLiBVc2UgdGhlIEV4cG9ydCBDU1YgYnV0dG9uIGZvciBvZmZsaW5lIGFuYWx5c2lzLjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZHMiPgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iPiR7dG90YWxSZXF9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5SZXF1ZXN0cyAoMzBkKTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij4ke3RvdGFsRmFpbH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiPkVycm9ycyAoMzBkKTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmRlNjhhIj4kJHt0b3RhbENvc3QudG9GaXhlZCg0KX08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiPkNvc3QgKDMwZCk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIj4keyh0b3RhbFByb21wdCt0b3RhbENvbXApLnRvTG9jYWxlU3RyaW5nKCl9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Ub2tlbnMgKDMwZCk8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxMnB4Ij48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIG9uY2xpY2s9ImV4cG9ydEFuYWx5dGljcygpIj5FeHBvcnQgQ1NWPC9idXR0b24+PC9kaXY+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+RGF0ZTwvdGg+PHRoPlJlcTwvdGg+PHRoPkVycjwvdGg+PHRoPlN1Y2Nlc3M8L3RoPjx0aD5Qcm9tcHQgVG9rPC90aD48dGg+Q29tcCBUb2s8L3RoPjx0aD5Db3N0PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PiR7cm93c308L3Rib2R5PjwvdGFibGU+CiAgYCk7Cn0KZnVuY3Rpb24gZXhwb3J0QW5hbHl0aWNzKCkgewogIHdpbmRvdy5vcGVuKCcvYWRtaW4vYXBpL2FuYWx5dGljcz9kYXlzPTMwJmZvcm1hdD1jc3YnLCAnX2JsYW5rJyk7Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyVXNhZ2UoKSB7CiAgY29uc3QgcmF3ID0gYXdhaXQgYXBpKCcva2V5LXVzYWdlJyk7CiAgY29uc3QgZGF0YSA9IHJhdy5wcm92aWRlcnMgfHwgcmF3OwogIGNvbnN0IHRvdGFscyA9IHJhdy50b3RhbHMgfHwgeyByZXF1ZXN0czogMCwgc3VjY2Vzc2VzOiAwLCBmYWlsdXJlczogMCwgcHJvbXB0VG9rZW5zOiAwLCBjb21wbGV0aW9uVG9rZW5zOiAwLCBjb3N0OiAwLCBwcm92aWRlcnM6IDAsIGtleXM6IDAgfTsKICBsZXQgaHRtbCA9ICc8aDI+VXNhZ2UgJmFtcDsgTGltaXRzPC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPk1vbml0b3IgdG9kYXlcJ3MgcmVxdWVzdCB2b2x1bWUsIHRva2VuIGNvbnN1bXB0aW9uLCBhbmQgZXN0aW1hdGVkIGNvc3QgcGVyIHByb3ZpZGVyLiBQcm9ncmVzcyBiYXJzIHNob3cgdXNhZ2UgYWdhaW5zdCBkYWlseSBxdW90YXMuIFJhdGUtbGltaXQgaGVhZGVycyBmcm9tIHVwc3RyZWFtIHByb3ZpZGVycyBhcmUgZGlzcGxheWVkIHBlciBrZXkuPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjIwcHgiPicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wOCkscmdiYSg5OSwxMDIsMjQxLC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iPicgKyB0b3RhbHMucmVxdWVzdHMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Ub3RhbCBSZXF1ZXN0cyBUb2RheTwvZGl2PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgzNCwxOTcsOTQsLjA4KSxyZ2JhKDIyLDE2Myw3NCwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+JyArIHRvdGFscy5zdWNjZXNzZXMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+U3VjY2Vzc2VzPC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzOSw2OCw2OCwuMDgpLHJnYmEoMjIwLDM4LDM4LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij4nICsgdG90YWxzLmZhaWx1cmVzICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmY2E1YTUiPkZhaWx1cmVzPC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU5LDEzMCwyNDYsLjA4KSxyZ2JhKDM3LDk5LDIzNSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6IzkzYzVmZCI+JyArICh0b3RhbHMucHJvbXB0VG9rZW5zICsgdG90YWxzLmNvbXBsZXRpb25Ub2tlbnMpLnRvTG9jYWxlU3RyaW5nKCkgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6IzkzYzVmZCI+VG90YWwgVG9rZW5zPC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDI1MSwxOTEsMzYsLjA4KSxyZ2JhKDI0NSwxNTgsMTEsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiQnICsgdG90YWxzLmNvc3QudG9GaXhlZCg2KSArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5Ub3RhbCBDb3N0PC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIj4nICsgdG90YWxzLmtleXMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5BY3RpdmUgS2V5czwvZGl2PjwvZGl2PicgKwogICAgJzwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMjgwcHgsMWZyKSkiPic7CiAgZm9yIChjb25zdCBbcG5hbWUsIHBkYXRhXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkgewogICAgY29uc3QgbGltID0gcGRhdGEubGltaXQgfHwge307CiAgICBjb25zdCBkUmVxID0gbGltLmRhaWx5UmVxdWVzdHMgfHwgOTk5OTk5OwogICAgY29uc3QgZFRvayA9IGxpbS5kYWlseVRva2VucyB8fCA5OTk5OTk5OTk7CiAgICBsZXQgdG90UmVxID0gMCwgdG90VG9rID0gMCwgdG90Q29zdCA9IDA7CiAgICBsZXQgcmxIdG1sID0gJyc7CiAgICBmb3IgKGNvbnN0IGsgb2YgcGRhdGEua2V5cykgeyAKICAgICAgdG90UmVxICs9IGsudXNhZ2UucmVxdWVzdHM7IHRvdFRvayArPSBrLnVzYWdlLnByb21wdFRva2VucyArIGsudXNhZ2UuY29tcGxldGlvblRva2VuczsgdG90Q29zdCArPSBrLnVzYWdlLmNvc3Q7CiAgICAgIGlmIChrLnJhdGVMaW1pdCkgewogICAgICAgIGNvbnN0IHJyZW0gPSBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nLXJlcXVlc3RzJ10gfHwgay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LXJlbWFpbmluZyddIHx8ICc/JzsKICAgICAgICBjb25zdCBybGltID0gay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LWxpbWl0LXJlcXVlc3RzJ10gfHwgay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LWxpbWl0J10gfHwgJz8nOwogICAgICAgIGNvbnN0IHRyZW0gPSBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nLXRva2VucyddIHx8ICc/JzsKICAgICAgICBjb25zdCB0bGltID0gay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LWxpbWl0LXRva2VucyddIHx8ICc/JzsKICAgICAgICBybEh0bWwgKz0gJzxwIHN0eWxlPSJmb250LXNpemU6MTFweDtjb2xvcjojODZlZmFjO21hcmdpbi10b3A6NHB4Ij5SYXRlIGxpbWl0OiAnICsgcnJlbSArICcvJyArIHJsaW0gKyAnIHJlcSwgJyArIHRyZW0gKyAnLycgKyB0bGltICsgJyB0b2s8L3A+JzsKICAgICAgfQogICAgfQogICAgY29uc3QgcmVxUGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLnJvdW5kKHRvdFJlcSAvIGRSZXEgKiAxMDApKTsKICAgIGNvbnN0IHRva1BjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCh0b3RUb2sgLyBkVG9rICogMTAwKSk7CiAgICBjb25zdCByZXFDb2xvciA9IHJlcVBjdCA+IDgwID8gJyNmODcxNzEnIDogcmVxUGN0ID4gNTAgPyAnI2ZiYmYyNCcgOiAnIzM4YmRmOCc7CiAgICBjb25zdCB0b2tDb2xvciA9IHRva1BjdCA+IDgwID8gJyNmODcxNzEnIDogdG9rUGN0ID4gNTAgPyAnI2ZiYmYyNCcgOiAnIzM4YmRmOCc7CiAgICBodG1sICs9ICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxNnB4Ij48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbToxMnB4Ij4nICsgZXNjKHBuYW1lKSArICc8L2gzPicgKwogICAgICAnPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPjxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vlbjtmb250LXNpemU6MTJweDtjb2xvcjojOTRhM2I4O21hcmdpbi1ib3R0b206NHB4Ij48c3Bhbj5SZXF1ZXN0czwvc3Bhbj48c3Bhbj4nICsgdG90UmVxICsgJyAvICcgKyBkUmVxICsgJzwvc3Bhbj48L2Rpdj4nICsKICAgICAgJzxkaXYgc3R5bGU9ImhlaWdodDo4cHg7YmFja2dyb3VuZDpyZ2JhKDcxLDg1LDEwNSwuNCk7Ym9yZGVyLXJhZGl1czo0cHg7b3ZlcmZsb3c6aGlkZGVuIj48ZGl2IHN0eWxlPSJ3aWR0aDonICsgcmVxUGN0ICsgJyU7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDonICsgcmVxQ29sb3IgKyAnO2JvcmRlci1yYWRpdXM6NHB4O3RyYW5zaXRpb246d2lkdGggLjNzIj48L2Rpdj48L2Rpdj48L2Rpdj4nICsKICAgICAgJzxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij48ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Zm9udC1zaXplOjEycHg7Y29sb3I6Izk0YTNiODttYXJnaW4tYm90dG9tOjRweCI+PHNwYW4+VG9rZW5zPC9zcGFuPjxzcGFuPicgKyB0b3RUb2sudG9Mb2NhbGVTdHJpbmcoKSArICcgLyAnICsgZFRvay50b0xvY2FsZVN0cmluZygpICsgJzwvc3Bhbj48L2Rpdj4nICsKICAgICAgJzxkaXYgc3R5bGU9ImhlaWdodDo4cHg7YmFja2dyb3VuZDpyZ2JhKDcxLDg1LDEwNSwuNCk7Ym9yZGVyLXJhZGl1czo0cHg7b3ZlcmZsb3c6aGlkZGVuIj48ZGl2IHN0eWxlPSJ3aWR0aDonICsgdG9rUGN0ICsgJyU7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDonICsgdG9rQ29sb3IgKyAnO2JvcmRlci1yYWRpdXM6NHB4O3RyYW5zaXRpb246d2lkdGggLjNzIj48L2Rpdj48L2Rpdj48L2Rpdj4nICsKICAgICAgKHRvdENvc3QgPiAwID8gJzxwIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojZmRlNjhhIj5Db3N0OiAkJyArIHRvdENvc3QudG9GaXhlZCg2KSArICc8L3A+JyA6ICcnKSArCiAgICAgIHJsSHRtbCArCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izc0ODhhOCI+JyArIHBkYXRhLmtleXMubGVuZ3RoICsgJyBrZXkocyk8L3A+PC9kaXY+JzsKICB9CiAgaWYgKGh0bWwgPT09ICc8ZGl2IGNsYXNzPSJjYXJkcyIgc3R5bGU9ImdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDI4MHB4LDFmcikpIj4nKSBodG1sICs9ICc8cCBzdHlsZT0iY29sb3I6Izk0YTNiOCI+Tm8gdXNhZ2UgZGF0YSB5ZXQ8L3A+JzsKICBodG1sICs9ICc8L2Rpdj4nOwogIHNldENvbnRlbnQoaHRtbCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNldHRpbmdzKCkgewogIGNvbnN0IHcgPSBhd2FpdCBhcGkoJy9wcm92aWRlcnMnKTsKICBjb25zdCBwcm92cyA9IHcucHJvdmlkZXJzIHx8IFtdOwogIGNvbnN0IGxpbWl0cyA9IHcubGltaXRzIHx8IHt9OwogIGxldCBwcm92Um93cyA9IHByb3ZzLm1hcCgocCwgaSkgPT4gewogICAgY29uc3QgaXNEZWZhdWx0ID0gWydncm9xJywnZ29vZ2xlJywnbWlzdHJhbCcsJ29wZW5yb3V0ZXInLCdkZWVwc2VlaycsJ3RvZ2V0aGVyJ10uaW5jbHVkZXMocC5uYW1lKTsKICAgIHJldHVybiAnPHRyPjx0ZD4nICsgZXNjKHAubmFtZSkgKyAoaXNEZWZhdWx0ID8gJyA8c3BhbiBzdHlsZT0iY29sb3I6Izc0ODhhODtmb250LXNpemU6MTBweCI+ZGVmYXVsdDwvc3Bhbj4nIDogJycpICsgJzwvdGQ+JyArCiAgICAgICc8dGQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5NGEzYjgiPicgKyBlc2MocC5iYXNlVXJsKSArICc8L3RkPicgKwogICAgICAnPHRkPjxzcGFuIGNsYXNzPSJ0YWcgJyArIChwLnR5cGU9PT0nZ29vZ2xlJz8nd2FybmluZyc6J29rJykgKyAnIj4nICsgZXNjKHAudHlwZSkgKyAnPC9zcGFuPjwvdGQ+JyArCiAgICAgICc8dGQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5NGEzYjg7bWF4LXdpZHRoOjE2MHB4O292ZXJmbG93OmhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzIj4nICsgZXNjKChwLm1vZGVsc3x8W10pLnNsaWNlKDAsMykuam9pbignLCAnKSkgKyAnPC90ZD4nICsKICAgICAgKGlzRGVmYXVsdCA/ICc8dGQ+PC90ZD4nIDogJzx0ZD48YnV0dG9uIGNsYXNzPSJkYW5nZXIiIG9uY2xpY2s9ImRlbGV0ZVByb3ZpZGVyKFwnJyArIGVzYyhwLm5hbWUpICsgJ1wnKSIgc3R5bGU9InBhZGRpbmc6NHB4IDhweDtmb250LXNpemU6MTFweCI+UmVtb3ZlPC9idXR0b24+PC90ZD4nKSArICc8L3RyPic7CiAgfSkuam9pbignJyk7CiAgbGV0IGxpbVJvd3MgPSBPYmplY3QuZW50cmllcyhsaW1pdHMpLm1hcCgoW2ssIHZdKSA9PiAnPHRyPjx0ZD4nICsgZXNjKGspICsgJzwvdGQ+PHRkPjxpbnB1dCBpZD0ibGltLWRyZXEtJyArIGVzYyhrKSArICciIHR5cGU9Im51bWJlciIgdmFsdWU9IicgKyAodi5kYWlseVJlcXVlc3RzfHw5OTk5OTkpICsgJyIgc3R5bGU9IndpZHRoOjEwMHB4O3BhZGRpbmc6NnB4IDhweDtmb250LXNpemU6MTJweCI+JyArCiAgICAnPC90ZD48dGQ+PGlucHV0IGlkPSJsaW0tZHRvay0nICsgZXNjKGspICsgJyIgdHlwZT0ibnVtYmVyIiB2YWx1ZT0iJyArICh2LmRhaWx5VG9rZW5zfHw5OTk5OTk5OTkpICsgJyIgc3R5bGU9IndpZHRoOjEyMHB4O3BhZGRpbmc6NnB4IDhweDtmb250LXNpemU6MTJweCI+JyArCiAgICAnPC90ZD48dGQ+PGlucHV0IGlkPSJsaW0tbWNvc3QtJyArIGVzYyhrKSArICciIHR5cGU9Im51bWJlciIgdmFsdWU9IicgKyAodi5tb250aGx5Q29zdFVTRHx8MCkgKyAnIiBzdHlsZT0id2lkdGg6MTAwcHg7cGFkZGluZzo2cHggOHB4O2ZvbnQtc2l6ZToxMnB4Ij48L3RkPjwvdHI+Jykuam9pbignJyk7CiAgc2V0Q29udGVudChgCiAgICA8aDI+U2V0dGluZ3M8L2gyPgogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Db25maWd1cmUgY3VzdG9tIHByb3ZpZGVycyAoT3BlbkFJLWNvbXBhdGlibGUgb3IgR29vZ2xlLXN0eWxlKSB3aXRoIHRoZWlyIGJhc2UgVVJMcyBhbmQgbW9kZWwgbGlzdHMuIFNldCBkYWlseSByZXF1ZXN0L3Rva2VuIGxpbWl0cyBwZXIgcHJvdmlkZXIgZm9yIHVzYWdlIHRyYWNraW5nIGFuZCBxdW90YSBlbmZvcmNlbWVudC48L2Rpdj4KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoxNnB4Ij5DdXN0b20gUHJvdmlkZXJzPC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4O21hcmdpbi1ib3R0b206MTJweCI+QWRkIE9wZW5BSS1jb21wYXRpYmxlIG9yIEdvb2dsZS1zdHlsZSBwcm92aWRlcnMuIFRoZXkgYXV0by1yZWdpc3RlciBpbiB0aGUgbW9kZWwgbGlzdCwgcHJveHksIGFuZCByb3V0aW5nLjwvcD4KICAgIDxkaXYgY2xhc3M9ImZvcm0tcm93Ij4KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPk5hbWU8L2xhYmVsPjxpbnB1dCBpZD0iY3AtbmFtZSIgcGxhY2Vob2xkZXI9ImFudGhyb3BpYyI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5CYXNlIFVSTDwvbGFiZWw+PGlucHV0IGlkPSJjcC11cmwiIHBsYWNlaG9sZGVyPSJodHRwczovL2FwaS5hbnRocm9waWMuY29tIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPlR5cGU8L2xhYmVsPjxzZWxlY3QgaWQ9ImNwLXR5cGUiPjxvcHRpb24+b3BlbmFpPC9vcHRpb24+PG9wdGlvbj5nb29nbGU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPk1vZGVscyAoY29tbWEtc2VwKTwvbGFiZWw+PGlucHV0IGlkPSJjcC1tb2RlbHMiIHBsYWNlaG9sZGVyPSJjbGF1ZGUtMy1vcHVzLGNsYXVkZS0zLXNvbm5ldCI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9ImFkZFByb3ZpZGVyKCkiPkFkZCBQcm92aWRlcjwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+UHJvdmlkZXI8L3RoPjx0aD5CYXNlIFVSTDwvdGg+PHRoPlR5cGU8L3RoPjx0aD5Nb2RlbHM8L3RoPjx0aD48L3RoPjwvdHI+PC90aGVhZD48dGJvZHk+JHtwcm92Um93c308L3Rib2R5PjwvdGFibGU+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjMycHgiPlByb3ZpZGVyIExpbWl0czwvaDI+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiODttYXJnaW4tYm90dG9tOjhweCI+U2V0IGRhaWx5IHJlcXVlc3QvdG9rZW4gbGltaXRzIHBlciBwcm92aWRlciBmb3IgdXNhZ2UgdHJhY2tpbmc8L3A+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+UHJvdmlkZXI8L3RoPjx0aD5EYWlseSBSZXF1ZXN0czwvdGg+PHRoPkRhaWx5IFRva2VuczwvdGg+PHRoPk1vbnRobHkgQ29zdCAkPC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PiR7bGltUm93c308L3Rib2R5PjwvdGFibGU+CiAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJzYXZlTGltaXRzKCkiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPlNhdmUgTGltaXRzPC9idXR0b24+CiAgYCk7Cn0KYXN5bmMgZnVuY3Rpb24gYWRkUHJvdmlkZXIoKSB7CiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjcC1uYW1lJykudmFsdWUudHJpbSgpOwogIGNvbnN0IGJhc2VVcmwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3AtdXJsJykudmFsdWUudHJpbSgpOwogIGNvbnN0IHR5cGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3AtdHlwZScpLnZhbHVlOwogIGNvbnN0IG1vZGVsc1JhdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjcC1tb2RlbHMnKS52YWx1ZS50cmltKCk7CiAgaWYgKCFuYW1lIHx8ICFiYXNlVXJsKSB7IHNob3dUb2FzdCgnTmFtZSBhbmQgQmFzZSBVUkwgcmVxdWlyZWQnLCAnZXJyb3InKTsgcmV0dXJuOyB9CiAgY29uc3QgbW9kZWxzID0gbW9kZWxzUmF3ID8gbW9kZWxzUmF3LnNwbGl0KCcsJykubWFwKHMgPT4gcy50cmltKCkpLmZpbHRlcihCb29sZWFuKSA6IFtdOwogIGF3YWl0IGFwaSgnL3Byb3ZpZGVycycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbmFtZSwgYmFzZVVybCwgdHlwZSwgbW9kZWxzIH0pIH0pOwogIHNob3dUb2FzdCgnUHJvdmlkZXIgJyArIG5hbWUgKyAnIGFkZGVkJywgJ3N1Y2Nlc3MnKTsgcmVuZGVyU2V0dGluZ3MoKTsKfQphc3luYyBmdW5jdGlvbiBkZWxldGVQcm92aWRlcihuYW1lKSB7CiAgaWYgKCFjb25maXJtKCdSZW1vdmUgcHJvdmlkZXIgIicgKyBuYW1lICsgJyI/JykpIHJldHVybjsKICBhd2FpdCBhcGkoJy9wcm92aWRlcnM/bmFtZT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgc2hvd1RvYXN0KCdQcm92aWRlciByZW1vdmVkJywgJ3N1Y2Nlc3MnKTsgcmVuZGVyU2V0dGluZ3MoKTsKfQphc3luYyBmdW5jdGlvbiBzYXZlTGltaXRzKCkgewogIGNvbnN0IGQgPSBhd2FpdCBhcGkoJy9wcm92aWRlcnMnKTsKICBjb25zdCBsaW1pdHMgPSB7fTsKICBmb3IgKGNvbnN0IHBuYW1lIG9mIE9iamVjdC5rZXlzKGQubGltaXRzIHx8IHt9KSkgewogICAgY29uc3QgZHJlcSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsaW0tZHJlcS0nICsgcG5hbWUpPy52YWx1ZTsKICAgIGNvbnN0IGR0b2sgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbGltLWR0b2stJyArIHBuYW1lKT8udmFsdWU7CiAgICBjb25zdCBtY29zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsaW0tbWNvc3QtJyArIHBuYW1lKT8udmFsdWU7CiAgICBpZiAoZHJlcSkgbGltaXRzW3BuYW1lXSA9IHsgZGFpbHlSZXF1ZXN0czogcGFyc2VJbnQoZHJlcSkgfHwgOTk5OTk5LCBkYWlseVRva2VuczogcGFyc2VJbnQoZHRvaykgfHwgOTk5OTk5OTk5LCBtb250aGx5Q29zdFVTRDogcGFyc2VGbG9hdChtY29zdCkgfHwgMCB9OwogIH0KICBhd2FpdCBhcGkoJy9wcm92aWRlcnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFjdGlvbjogJ3NldC1saW1pdHMnLCBsaW1pdHMgfSkgfSk7CiAgc2hvd1RvYXN0KCdMaW1pdHMgc2F2ZWQnLCAnc3VjY2VzcycpOyByZW5kZXJTZXR0aW5ncygpOwp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlckhlYWx0aCgpIHsKICBzZXRDb250ZW50KCc8aDI+SGVhbHRoIENoZWNrPC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlByb2JlIGVhY2ggcHJvdmlkZXIga2V5IHRvIHZlcmlmeSBjb25uZWN0aXZpdHkgYW5kIGF1dGhlbnRpY2F0aW9uLiBTaG93cyBIVFRQIHN0YXR1cywgY2lyY3VpdC1icmVha2VyIHN0YXRlLCBhbmQgYW55IGVycm9yIG1lc3NhZ2VzIHJldHVybmVkIGJ5IHRoZSB1cHN0cmVhbSBBUEkuPC9kaXY+PHA+UnVubmluZyBoZWFsdGggY2hlY2tzLi4uPC9wPicpOwogIGNvbnN0IGggPSBhd2FpdCBhcGkoJy9oZWFsdGgtY2hlY2snKTsKICBsZXQgY2FyZHMgPSAnJzsKICBmb3IoY29uc3QgaXRlbSBvZiBoKSB7CiAgICBjb25zdCBvayA9IGl0ZW0uc3RhdHVzID09PSAnb2snID8gJ29rJyA6ICdmYWlsJzsKICAgIGNhcmRzICs9ICc8ZGl2IGNsYXNzPSJjYXJkIj48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbTo2cHgiPicgKyBlc2MoaXRlbS5wcm92aWRlcnx8JycpICsgJyAvICcgKyBlc2MoKGl0ZW0ua2V5SWR8fCcnKS5zbGljZSgwLDgpKSArICc8L2gzPicgKwogICAgICAnPHA+PHNwYW4gY2xhc3M9InRhZyAnICsgb2sgKyAnIj4nICsgZXNjKGl0ZW0uc3RhdHVzfHwnPycpICsgJzwvc3Bhbj48L3A+JyArCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiOCI+SFRUUDogJyArIChpdGVtLmh0dHBTdGF0dXN8fCfDg8Kiw6LigJrCrMOi4oKswp0nKSArICcgfCBDQjogJyArIGVzYyhpdGVtLmNiU3RhdGV8fCfDg8Kiw6LigJrCrMOi4oKswp0nKSArICc8L3A+JyArCiAgICAgIChpdGVtLmVycm9yID8gJzxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NHB4Ij4nICsgZXNjKGl0ZW0uZXJyb3IpICsgJzwvcHJlPicgOiAnJykgKyAnPC9kaXY+JzsKICB9CiAgc2V0Q29udGVudCgnPGgyPkhlYWx0aCBDaGVjazwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Qcm9iZSBlYWNoIHByb3ZpZGVyIGtleSB0byB2ZXJpZnkgY29ubmVjdGl2aXR5IGFuZCBhdXRoZW50aWNhdGlvbi4gU2hvd3MgSFRUUCBzdGF0dXMsIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSwgYW5kIGFueSBlcnJvciBtZXNzYWdlcyByZXR1cm5lZCBieSB0aGUgdXBzdHJlYW0gQVBJLjwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIj4nICsgKGNhcmRzIHx8ICc8cD5ObyByZXN1bHRzPC9wPicpICsgJzwvZGl2PicpOwp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNldHVwKCkgewogIHNldENvbnRlbnQoYAogICAgPGgyPlNldHVwIEd1aWRlPC9oMj4KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+U3RlcC1ieS1zdGVwIGd1aWRlIGZvciBjb25uZWN0aW5nIGNsaWVudHMgdG8gdGhlIGdhdGV3YXkuIEdlbmVyYXRlIGEgR2F0ZXdheSBLZXksIHRoZW4gdXNlIGl0IGFzIHRoZSBCZWFyZXIgdG9rZW4gd2l0aCBhbnkgT3BlbkFJLWNvbXBhdGlibGUgY2xpZW50LiBTdXBwb3J0cyBjaGF0IGNvbXBsZXRpb25zLCBlbWJlZGRpbmdzLCBhbmQgQW50aHJvcGljLXN0eWxlIG1lc3NhZ2VzLjwvZGl2PgogICAgPGgyPllvdXIgR2F0ZXdheSBVUkw8L2gyPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjE0cHgiPlBPU1QgaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zCkF1dGhvcml6YXRpb246IEJlYXJlciAmbHQ7eW91ci1nYXRld2F5LWtleSZndDs8L3ByZT4KCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+R2VuZXJhdGUgYSBHYXRld2F5IEtleTwvaDI+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+R28gdG8gPGI+R2F0ZXdheSBLZXlzPC9iPiB0YWIgYW5kIGNsaWNrIDxiPkdlbmVyYXRlIEtleTwvYj4gdG8gY3JlYXRlIGEgcmFuZG9tIHRva2VuLCBvciBlbnRlciB5b3VyIG93biB3b3JkLiBVc2UgdGhhdCBrZXkgYXMgdGhlIEJlYXJlciB0b2tlbiBpbiB5b3VyIGFwcHMuPC9wPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBjVVJMPC9oMj4KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5jdXJsIC1YIFBPU1QgaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zIFxcCiAgLUggIkF1dGhvcml6YXRpb246IEJlYXJlciBZT1VSX0dBVEVXQVlfS0VZIiBcXAogIC1IICJDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24iIFxcCiAgLWQgJ3sibW9kZWwiOiJncHQtNG8iLCJtZXNzYWdlcyI6W3sicm9sZSI6InVzZXIiLCJjb250ZW50IjoiaGVsbG8ifV19JzwvcHJlPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBKYXZhU2NyaXB0IChmZXRjaCk8L2gyPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjEzcHgiPmNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCgiaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zIiwgewogIG1ldGhvZDogIlBPU1QiLAogIGhlYWRlcnM6IHsgIkF1dGhvcml6YXRpb24iOiAiQmVhcmVyIFlPVVJfR0FURVdBWV9LRVkiLCAiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24iIH0sCiAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtb2RlbDogImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNCIsIG1lc3NhZ2VzOiBbeyByb2xlOiAidXNlciIsIGNvbnRlbnQ6ICJoaSIgfV0gfSkKfSk7CmNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTs8L3ByZT4KCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+RXhhbXBsZTogUHl0aG9uPC9oMj4KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5pbXBvcnQgcmVxdWVzdHMKcmVzcCA9IHJlcXVlc3RzLnBvc3QoCiAgICAiaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zIiwKICAgIGhlYWRlcnM9eyJBdXRob3JpemF0aW9uIjogIkJlYXJlciBZT1VSX0dBVEVXQVlfS0VZIn0sCiAgICBqc29uPXsibW9kZWwiOiAiZ3B0LTRvIiwgIm1lc3NhZ2VzIjogW3sicm9sZSI6ICJ1c2VyIiwgImNvbnRlbnQiOiAiaGVsbG8ifV19CikKcHJpbnQocmVzcC5qc29uKCkpPC9wcmU+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPldlYmhvb2sgTm90aWZpY2F0aW9uczwvaDI+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+U2V0IDxjb2RlIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5XRUJIT09LX1VSTDwvY29kZT4gaW4geW91ciBDbG91ZGZsYXJlIFdvcmtlciBlbnZpcm9ubWVudCB2YXJpYWJsZXMgKGUuZy4gU2xhY2sgd2ViaG9vayBVUkwpLiBUaGUgZ2F0ZXdheSB3aWxsIFBPU1QgSlNPTiBhbGVydHMgZm9yIGF1dGggZmFpbHVyZXMgYW5kIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSBjaGFuZ2VzLjwvcD4KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5FeGFtcGxlIHBheWxvYWQ6ClBPU1QgJmx0O1dFQkhPT0tfVVJMJmd0Owp7ImV2ZW50IjoiYXV0aF9mYWlsdXJlIiwicHJvdmlkZXIiOiJvcGVuYWkiLCJrZXlJZCI6InNrLS4uLiIsInN0YXR1cyI6NDAxfTwvcHJlPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5BRE1JTl9QQVNTV09SRCAoRW52aXJvbm1lbnQgVmFyaWFibGUpPC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5TZXQgPGNvZGUgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPkFETUlOX1BBU1NXT1JEPC9jb2RlPiBpbiB5b3VyIENsb3VkZmxhcmUgV29ya2VyIGVudiB2YXJzIHRvIG92ZXJyaWRlIHRoZSBkZWZhdWx0IGFkbWluIHBhc3N3b3JkICg8Y29kZT4yMjAwPC9jb2RlPikuPC9wPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5TdXBwb3J0ZWQgTW9kZWxzPC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5GcmVlLXRpZXIgbW9kZWxzOiA8Yj5Hcm9xPC9iPiAobGxhbWEtMy4zLTcwYi12ZXJzYXRpbGUpLCA8Yj5Hb29nbGU8L2I+IChnZW1pbmktMi4wLWZsYXNoKSwgPGI+TWlzdHJhbDwvYj4gKG1pc3RyYWwtc21hbGwtbGF0ZXN0KSwgPGI+T3BlblJvdXRlcjwvYj4gKGZyZWUgbW9kZWxzKS48L3A+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+Rmlyc3QgYWRkIHlvdXIgcHJvdmlkZXIgQVBJIGtleXMgaW4gdGhlIDxiPkFQSSBLZXlzPC9iPiB0YWIsIHRoZW4gZ2VuZXJhdGUgYSBHYXRld2F5IEtleSBpbiB0aGUgPGI+R2F0ZXdheSBLZXlzPC9iPiB0YWIuPC9wPgogIGApOwp9Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K";

const ADMIN_PAGE = atob(ADMIN_PAGE_B64);


/* ── Hono App ── */
const app = new Hono();

app.post("/v1/chat/completions", async (c) => handleProxy(c.req));
app.post("/chat/completions", async (c) => handleProxy(c.req));
app.post("/v1/embeddings", async (c) => handleEmbeddings(c.req));
app.post("/v1/messages", async (c) => handleAnthropic(c.req));
app.get("/v1/models", async (c) => handleModels());
app.get("/models", async (c) => handleModels());

app.post("/admin/api/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!(await checkLoginRate(ip))) return c.json({ error: "too many attempts, try later" }, 429);
  let password = "";
  const ct = c.req.header("Content-Type") || "";
  if (ct.includes("json")) {
    try { const j = await c.req.json() as any; password = j.password || ""; } catch {}
  } else {
    try { const fd = await c.req.formData(); password = fd.get("password") as string || ""; } catch {}
  }
  if (password === _ADMIN_PW) {
    const redirect = c.req.query("redirect") || "/admin";
    return new Response("", { status: 302, headers: { Location: redirect, "Set-Cookie": "bfadmin=" + _ADMIN_PW + "; path=/; SameSite=Lax", "Cache-Control": "no-cache" } });
  }
  await recordLoginAttempt(ip);
  const redirect = c.req.query("redirect") || "/admin";
  return new Response("", { status: 302, headers: { Location: redirect + "?error=1", "Cache-Control": "no-cache" } });
});

app.get("/admin", async (c) => {
  const cookie = c.req.header("Cookie") || "";
  if (cookie.includes("bfadmin=" + _ADMIN_PW)) {
    return new Response(ADMIN_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
  }
  const err = c.req.query("error") || "";
  let body = LOGIN_PAGE;
  if (err === "1") body = body.replace('id="login-err"', 'id="login-err" style="display:block"');
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
});
app.get("/admin/", async (c) => c.redirect("/admin"));
app.all("/admin/*", async (c) => handleAdminApi(c.req, c.req.path));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    _BF = env.BF; _WEBHOOK_URL = env.WEBHOOK_URL || ""; _ADMIN_PW = env.ADMIN_PASSWORD || "itsgood";
    return app.fetch(req, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    _BF = env.BF; _WEBHOOK_URL = env.WEBHOOK_URL || ""; _ADMIN_PW = env.ADMIN_PASSWORD || "itsgood";
    await handleCron();
  },
};
