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

/* â”€â”€ Google Gemini Format â”€â”€ */
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

/* â”€â”€ Anthropic â†” OpenAI Format Converters â”€â”€ */
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

/* â”€â”€ Token Counting & Pricing â”€â”€ */
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

/* â”€â”€ Login Page HTML â”€â”€ */
const LOGIN_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Buddhi Dwar - Login</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',system-ui,-apple-system,sans-serif}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0a0e1a 0%,#0f1629 40%,#121b33 100%);color:#e2e8f0}.login-box{background:rgba(30,41,59,.6);backdrop-filter:blur(20px);padding:48px;border-radius:20px;border:1px solid rgba(56,189,248,.1);width:380px;max-width:90vw;box-shadow:0 16px 48px rgba(0,0,0,.5)}.login-box h1{font-size:28px;font-weight:800;background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}p{color:#8899b4;margin-bottom:24px;font-size:14px}input{width:100%;padding:14px 16px;border-radius:12px;border:1px solid rgba(71,85,105,.4);background:rgba(15,23,42,.6);color:#e2e8f0;font-size:16px;outline:none;transition:all .2s;margin-bottom:16px}input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.12)}button{width:100%;padding:14px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff;box-shadow:0 2px 12px rgba(56,189,248,.2)}button:hover{box-shadow:0 4px 20px rgba(56,189,248,.35)}.err{color:#fca5a5;font-size:13px;margin-top:10px;display:none}.err.show{display:block}</style></head><body><form class="login-box" method="POST" action="/admin/api/login"><h1>Buddhi Dwar</h1><p>Admin Dashboard Login</p><input type="password" name="password" placeholder="Enter admin password" autofocus><button type="submit">Login</button><p class="err" id="login-err">Invalid password</p></form></body></html>`;
/* â”€â”€ Dashboard Page HTML (base64-encoded to avoid escaping issues) â”€â”€ */
const ADMIN_PAGE_B64 = "PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8aGVhZD4NCjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4NCjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLjAiPg0KPHRpdGxlPkJ1ZGRoaSBEd2FyIEFkbWluPC90aXRsZT4NCjxzdHlsZT4NCip7bWFyZ2luOjA7cGFkZGluZzowO2JveC1zaXppbmc6Ym9yZGVyLWJveDtmb250LWZhbWlseTonSW50ZXInLHN5c3RlbS11aSwtYXBwbGUtc3lzdGVtLHNhbnMtc2VyaWZ9DQpib2R5e2Rpc3BsYXk6ZmxleDttaW4taGVpZ2h0OjEwMHZoO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMGEwZTFhIDAlLCMwZjE2MjkgNDAlLCMxMjFiMzMgMTAwJSk7Y29sb3I6I2UyZThmMH0NCi5zaWRlYmFye3dpZHRoOjI0MHB4O2JhY2tncm91bmQ6cmdiYSgxNywyNCwzOSwuODUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO3BhZGRpbmc6MjRweCAwO2JvcmRlci1yaWdodDoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4xKTtmbGV4LXNocmluazowO2hlaWdodDoxMDB2aDtwb3NpdGlvbjpzdGlja3k7dG9wOjA7b3ZlcmZsb3cteTphdXRvfQ0KLnNpZGViYXIgaDF7Zm9udC1zaXplOjIycHg7Zm9udC13ZWlnaHQ6ODAwO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMzhiZGY4LCM4MThjZjgpOy13ZWJraXQtYmFja2dyb3VuZC1jbGlwOnRleHQ7LXdlYmtpdC10ZXh0LWZpbGwtY29sb3I6dHJhbnNwYXJlbnQ7cGFkZGluZzowIDIwcHggMjRweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjEpO21hcmdpbi1ib3R0b206MTJweDtsZXR0ZXItc3BhY2luZzotLjVweH0NCi5zaWRlYmFyIGF7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtwYWRkaW5nOjExcHggMjBweDtjb2xvcjojODg5OWI0O3RleHQtZGVjb3JhdGlvbjpub25lO2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjUwMDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOmFsbCAuMnM7bWFyZ2luOjJweCA4cHg7Ym9yZGVyLXJhZGl1czoxMHB4fQ0KLnNpZGViYXIgYTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDgpO2NvbG9yOiNlMmU4ZjB9DQouc2lkZWJhciBhLmFjdGl2ZXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4xMikscmdiYSgxMjksMTQwLDI0OCwuMDgpKTtjb2xvcjojMzhiZGY4O2JveC1zaGFkb3c6aW5zZXQgMnB4IDAgMCAjMzhiZGY4fQ0KLm1haW57ZmxleDoxO3BhZGRpbmc6MzJweDttYXgtd2lkdGg6MTIwMHB4fXNlY3Rpb257ZGlzcGxheTpub25lfXNlY3Rpb24uYWN0aXZle2Rpc3BsYXk6YmxvY2t9DQpoMntmb250LXNpemU6MjJweDtmb250LXdlaWdodDo3MDA7Y29sb3I6I2YxZjVmOTttYXJnaW4tYm90dG9tOjIwcHg7cGFkZGluZy1ib3R0b206MTBweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtsZXR0ZXItc3BhY2luZzotLjNweH0NCi5jYXJkc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMjAwcHgsMWZyKSk7Z2FwOjE0cHg7bWFyZ2luLWJvdHRvbToyOHB4fQ0KLmNhcmR7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMzAsNDEsNTksLjYpLHJnYmEoMzAsNDEsNTksLjMpKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoyMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wOCk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoOHB4KTt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMsYm9yZGVyLWNvbG9yIC4yc30NCi5jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjpyZ2JhKDU2LDE4OSwyNDgsLjIpfQ0KLmNhcmQgLm51bXtmb250LXNpemU6MzBweDtmb250LXdlaWdodDo4MDA7Y29sb3I6IzM4YmRmODtsZXR0ZXItc3BhY2luZzotLjVweH0NCi5jYXJkIC5sYmx7Zm9udC1zaXplOjExcHg7Y29sb3I6Izc0ODhhODttYXJnaW4tdG9wOjZweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjhweDtmb250LXdlaWdodDo2MDB9DQp0YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtmb250LXNpemU6MTRweDttYXJnaW4tYm90dG9tOjE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRlbn0NCnRoe2NvbG9yOiM3NDg4YTg7Zm9udC13ZWlnaHQ6NjAwO3BhZGRpbmc6MTRweCAxMnB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMDgpO3RleHQtYWxpZ246bGVmdDtmb250LXNpemU6MTFweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjhweDtiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjQpfQ0KdGR7cGFkZGluZzoxMnB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHJnYmEoMzAsNDEsNTksLjQpO2NvbG9yOiNlMmU4ZjB9DQp0cjpob3ZlciB0ZHtiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDMpfQ0KaW5wdXQsc2VsZWN0e3BhZGRpbmc6MTFweCAxNHB4O2JvcmRlci1yYWRpdXM6MTBweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzEsODUsMTA1LC40KTtiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjYpO2NvbG9yOiNlMmU4ZjA7Zm9udC1zaXplOjE0cHg7d2lkdGg6MTAwJTttYXgtd2lkdGg6NDAwcHg7bWFyZ2luOjRweCAwO291dGxpbmU6bm9uZTt0cmFuc2l0aW9uOmFsbCAuMnN9DQppbnB1dDpmb2N1cyxzZWxlY3Q6Zm9jdXN7Ym9yZGVyLWNvbG9yOiMzOGJkZjg7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg1NiwxODksMjQ4LC4xMil9DQpidXR0b257cGFkZGluZzoxMXB4IDIycHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25lO2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjttYXJnaW46NHB4IDRweCA0cHggMDt0cmFuc2l0aW9uOmFsbCAuMnM7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVufQ0KYnV0dG9uOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUoLjk3KX0NCmJ1dHRvbi5wcmltYXJ5e2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMzhiZGY4LCM2MzY2ZjEpO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDJweCAxMnB4IHJnYmEoNTYsMTg5LDI0OCwuMil9YnV0dG9uLnByaW1hcnk6aG92ZXJ7Ym94LXNoYWRvdzowIDRweCAyMHB4IHJnYmEoNTYsMTg5LDI0OCwuMzUpfQ0KYnV0dG9uLmRhbmdlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsI2VmNDQ0NCwjZGMyNjI2KTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDIzOSw2OCw2OCwuMil9YnV0dG9uLmRhbmdlcjpob3Zlcntib3gtc2hhZG93OjAgNHB4IDIwcHggcmdiYSgyMzksNjgsNjgsLjM1KX0NCmJ1dHRvbi5zZWNvbmRhcnl7YmFja2dyb3VuZDpyZ2JhKDUxLDY1LDg1LC41KTtjb2xvcjojZTJlOGYwO2JvcmRlcjoxcHggc29saWQgcmdiYSg3MSw4NSwxMDUsLjMpfWJ1dHRvbi5zZWNvbmRhcnk6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDUxLDY1LDg1LC44KX0NCnByZXtiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjYpO3BhZGRpbmc6MThweDtib3JkZXItcmFkaXVzOjEycHg7b3ZlcmZsb3c6YXV0bztmb250LXNpemU6MTNweDttYXgtaGVpZ2h0OjUwMHB4O2xpbmUtaGVpZ2h0OjEuNjtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMDgpO2ZvbnQtZmFtaWx5OidGaXJhIENvZGUnLCdDb25zb2xhcycsbW9ub3NwYWNlfQ0KLnRhZ3tkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjNweCAxMnB4O2JvcmRlci1yYWRpdXM6MjBweDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7bGV0dGVyLXNwYWNpbmc6LjNweH0NCi50YWcub2t7YmFja2dyb3VuZDpyZ2JhKDIyLDE2Myw3NCwuMTUpO2NvbG9yOiM4NmVmYWM7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIyLDE2Myw3NCwuMyl9DQoudGFnLmZhaWx7YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9DQoudGFnLmFjdGl2ZXtiYWNrZ3JvdW5kOnJnYmEoNTksMTMwLDI0NiwuMTUpO2NvbG9yOiM5M2M1ZmQ7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU5LDEzMCwyNDYsLjMpfQ0KLnRhZy53YXJuaW5ne2JhY2tncm91bmQ6cmdiYSgyMzQsMTc5LDgsLjE1KTtjb2xvcjojZmRlNjhhO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzQsMTc5LDgsLjMpfQ0KLnRhZy5jbG9zZWR7YmFja2dyb3VuZDpyZ2JhKDIyLDE2Myw3NCwuMTUpO2NvbG9yOiM4NmVmYWM7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIyLDE2Myw3NCwuMyl9DQoudGFnLm9wZW57YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9DQoudGFnLmhhbGYtb3BlbntiYWNrZ3JvdW5kOnJnYmEoMjM0LDE3OSw4LC4xNSk7Y29sb3I6I2ZkZTY4YTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjM0LDE3OSw4LC4zKX0NCi5mb3JtLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjE0cHg7YWxpZ24taXRlbXM6ZW5kO2ZsZXgtd3JhcDp3cmFwO21hcmdpbi1ib3R0b206MjBweH0NCi5mb3JtLXJvdz4qe2ZsZXg6MTttaW4td2lkdGg6MjAwcHh9DQouZm9ybS1yb3cgYnV0dG9ue2ZsZXg6MCAwIGF1dG99DQouZm9ybS1ncm91cCBsYWJlbHtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLWJvdHRvbTo2cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi44cHg7Zm9udC13ZWlnaHQ6NjAwfQ0KLnRvYXN0e3Bvc2l0aW9uOmZpeGVkO3RvcDoyNHB4O3JpZ2h0OjI0cHg7cGFkZGluZzoxNHB4IDI0cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjUwMDt6LWluZGV4OjEwMDA7YW5pbWF0aW9uOnNsaWRlSW4gLjM1cyBjdWJpYy1iZXppZXIoLjE2LDEsLjMsMSk7bWF4LXdpZHRoOjQyMHB4O2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JveC1zaGFkb3c6MCA4cHggMzJweCByZ2JhKDAsMCwwLC40KX0NCi50b2FzdC5zdWNjZXNze2JhY2tncm91bmQ6cmdiYSgyMiwxNjMsNzQsLjIpO2NvbG9yOiM4NmVmYWM7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIyLDE2Myw3NCwuMyl9DQoudG9hc3QuZXJyb3J7YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMik7Y29sb3I6I2ZjYTVhNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjM5LDY4LDY4LC4zKX0NCkBrZXlmcmFtZXMgc2xpZGVJbntmcm9te3RyYW5zZm9ybTp0cmFuc2xhdGVYKDEyMCUpIHNjYWxlKC45KTtvcGFjaXR5OjB9dG97dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMCkgc2NhbGUoMSk7b3BhY2l0eToxfX0NCkBrZXlmcmFtZXMgZmFkZUlue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDhweCl9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApfX0NCi5ncmlkLTJ7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyO2dhcDoyMHB4fQ0KLmljb3tkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7Ym9yZGVyLXJhZGl1czo2cHg7ZmxleC1zaHJpbms6MDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDB9DQouaWNvLW92ZXJ2aWV3e2JhY2tncm91bmQ6cmdiYSg1NiwxODksMjQ4LC4xNSk7Y29sb3I6IzM4YmRmOH0uaWNvLWtleXN7YmFja2dyb3VuZDpyZ2JhKDI0NSwxNTgsMTEsLjE1KTtjb2xvcjojZjU5ZTBifQ0KLmljby1nYXRld2F5e2JhY2tncm91bmQ6cmdiYSgxNjcsMTM5LDI1MCwuMTUpO2NvbG9yOiNhNzhiZmF9Lmljby1zdHJhdGVneXtiYWNrZ3JvdW5kOnJnYmEoNTIsMjExLDE1MywuMTUpO2NvbG9yOiMzNGQzOTl9DQouaWNvLWxvZ3N7YmFja2dyb3VuZDpyZ2JhKDI0OCwxMTMsMTEzLC4xNSk7Y29sb3I6I2Y4NzE3MX0uaWNvLWFuYWx5dGljc3tiYWNrZ3JvdW5kOnJnYmEoMjUxLDE0Niw2MCwuMTUpO2NvbG9yOiNmYjkyM2N9DQouaWNvLXNldHRpbmdze2JhY2tncm91bmQ6cmdiYSgxNDgsMTYzLDE4NCwuMTUpO2NvbG9yOiNlMmU4ZjB9Lmljby1oZWFsdGh7YmFja2dyb3VuZDpyZ2JhKDI0NCwxMTQsMTgyLC4xNSk7Y29sb3I6I2Y0NzJiNn0NCi5pY28tc2V0dXB7YmFja2dyb3VuZDpyZ2JhKDM0LDIxMSwyMzgsLjE1KTtjb2xvcjojMjJkM2VlfQ0KDQojbG9hZGluZy1iYXJ7cG9zaXRpb246Zml4ZWQ7dG9wOjA7bGVmdDowO2hlaWdodDozcHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsIzM4YmRmOCwjODE4Y2Y4LCMzOGJkZjgpO2JhY2tncm91bmQtc2l6ZToyMDAlIDEwMCU7ei1pbmRleDo5OTk5OTt0cmFuc2l0aW9uOndpZHRoIC40cyBjdWJpYy1iZXppZXIoLjE2LDEsLjMsMSksb3BhY2l0eSAuM3M7d2lkdGg6MDtvcGFjaXR5OjA7Ym9yZGVyLXJhZGl1czowIDJweCAycHggMDtib3gtc2hhZG93OjAgMCAxMnB4IHJnYmEoNTYsMTg5LDI0OCwuNSl9DQojbG9hZGluZy1iYXIuYWN0aXZle29wYWNpdHk6MX1idXR0b24ubG9hZGluZ3twb2ludGVyLWV2ZW50czpub25lO29wYWNpdHk6Ljc7cG9zaXRpb246cmVsYXRpdmV9YnV0dG9uLmxvYWRpbmc6OmFmdGVye2NvbnRlbnQ6Jyc7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDtib3JkZXItcmFkaXVzOmluaGVyaXQ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdHJhbnNwYXJlbnQscmdiYSgyNTUsMjU1LDI1NSwuMSksdHJhbnNwYXJlbnQpO2JhY2tncm91bmQtc2l6ZToyMDAlIDEwMCU7YW5pbWF0aW9uOnNoaW1tZXIgMS4ycyBpbmZpbml0ZX0NCkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOjIwMCUgMH0xMDAle2JhY2tncm91bmQtcG9zaXRpb246LTIwMCUgMH19DQoucGFnaW5hdGlvbntkaXNwbGF5OmZsZXg7Z2FwOjhweDthbGlnbi1pdGVtczpjZW50ZXI7bWFyZ2luLXRvcDoxMnB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM3NDg4YTh9DQoucGFnaW5hdGlvbiBidXR0b257cGFkZGluZzo2cHggMTRweDtmb250LXNpemU6MTJweDtib3JkZXItcmFkaXVzOjhweH0NCnN1bW1hcnl7Y29sb3I6IzM4YmRmODtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzo4cHggMDtmb250LXNpemU6MTRweH0NCmRldGFpbHN7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC4zKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzo4cHggMTZweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMDYpO21hcmdpbi1ib3R0b206MTZweH0NCi5wYWdlLWRlc2N7YmFja2dyb3VuZDpyZ2JhKDU2LDE4OSwyNDgsLjA2KTtib3JkZXItbGVmdDozcHggc29saWQgIzM4YmRmODtwYWRkaW5nOjEycHggMTZweDtib3JkZXItcmFkaXVzOjAgMTBweCAxMHB4IDA7bWFyZ2luLWJvdHRvbToyMHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5NGEzYjg7bGluZS1oZWlnaHQ6MS42fQ0KQG1lZGlhKG1heC13aWR0aDo3NjhweCl7LnNpZGViYXJ7d2lkdGg6NjBweDtwYWRkaW5nOjE2cHggMH0uc2lkZWJhciBoMSwuc2lkZWJhciBhIHNwYW46bGFzdC1jaGlsZHtkaXNwbGF5Om5vbmV9LnNpZGViYXIgYXtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3BhZGRpbmc6MTFweCAwO21hcmdpbjoycHggNnB4fS5tYWlue3BhZGRpbmc6MjBweH0uZ3JpZC0ye2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9fQ0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7LnNpZGViYXJ7d2lkdGg6NDhweH0ubWFpbntwYWRkaW5nOjE2cHh9LmNhcmRze2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfX0NCjwvc3R5bGU+DQo8L2hlYWQ+DQo8Ym9keT4NCjxkaXYgaWQ9ImxvYWRpbmctYmFyIj48L2Rpdj4NCjxkaXYgY2xhc3M9InNpZGViYXIiPg0KPGgxPkJ1ZGRoaSBEd2FyPC9oMT4NCjxhIG9uY2xpY2s9InNob3dUYWIoJ292ZXJ2aWV3JykiIGlkPSJuYXYtb3ZlcnZpZXciIGNsYXNzPSJhY3RpdmUiPjxzcGFuIGNsYXNzPSJpY28gaWNvLW92ZXJ2aWV3Ij4mIzk2Nzk7PC9zcGFuPjxzcGFuPk92ZXJ2aWV3PC9zcGFuPjwvYT4NCjxhIG9uY2xpY2s9InNob3dUYWIoJ2tleXMnKSIgaWQ9Im5hdi1rZXlzIj48c3BhbiBjbGFzcz0iaWNvIGljby1rZXlzIj4mIzk4ODE7PC9zcGFuPjxzcGFuPkFQSSBLZXlzPC9zcGFuPjwvYT4NCjxhIG9uY2xpY2s9InNob3dUYWIoJ2dhdGV3YXknKSIgaWQ9Im5hdi1nYXRld2F5Ij48c3BhbiBjbGFzcz0iaWNvIGljby1nYXRld2F5Ij4mIzEyODI3NDs8L3NwYW4+PHNwYW4+R2F0ZXdheSBLZXlzPC9zcGFuPjwvYT4NCjxhIG9uY2xpY2s9InNob3dUYWIoJ3N0cmF0ZWd5JykiIGlkPSJuYXYtc3RyYXRlZ3kiPjxzcGFuIGNsYXNzPSJpY28gaWNvLXN0cmF0ZWd5Ij4mIzg2NDQ7PC9zcGFuPjxzcGFuPlN0cmF0ZWd5PC9zcGFuPjwvYT4NCjwhLS0gbG9ncyBhbmQgcmVxLWxvZ3MgcmVtb3ZlZCAoS1Ygc3BhY2UpIC0tPg0KPGEgb25jbGljaz0ic2hvd1RhYignYW5hbHl0aWNzJykiIGlkPSJuYXYtYW5hbHl0aWNzIj48c3BhbiBjbGFzcz0iaWNvIGljby1hbmFseXRpY3MiPiYjMTI4MjAwOzwvc3Bhbj48c3Bhbj5BbmFseXRpY3M8L3NwYW4+PC9hPg0KPGEgb25jbGljaz0ic2hvd1RhYigndXNhZ2UnKSIgaWQ9Im5hdi11c2FnZSI+PHNwYW4gY2xhc3M9ImljbyBpY28tb3ZlcnZpZXciPiYjMTI4MjAwOzwvc3Bhbj48c3Bhbj5Vc2FnZTwvc3Bhbj48L2E+DQo8YSBvbmNsaWNrPSJzaG93VGFiKCdzZXR0aW5ncycpIiBpZD0ibmF2LXNldHRpbmdzIj48c3BhbiBjbGFzcz0iaWNvIGljby1zZXR0aW5ncyI+JiM5ODgxOzwvc3Bhbj48c3Bhbj5TZXR0aW5nczwvc3Bhbj48L2E+DQo8YSBvbmNsaWNrPSJzaG93VGFiKCdoZWFsdGgnKSIgaWQ9Im5hdi1oZWFsdGgiPjxzcGFuIGNsYXNzPSJpY28gaWNvLWhlYWx0aCI+JiMxMDAwMzs8L3NwYW4+PHNwYW4+SGVhbHRoIENoZWNrPC9zcGFuPjwvYT4NCjxhIG9uY2xpY2s9InNob3dUYWIoJ3NldHVwJykiIGlkPSJuYXYtc2V0dXAiPjxzcGFuIGNsYXNzPSJpY28gaWNvLXNldHVwIj4mIzg1MDU7PC9zcGFuPjxzcGFuPlNldHVwPC9zcGFuPjwvYT4NCjwvZGl2Pg0KPGRpdiBjbGFzcz0ibWFpbiIgaWQ9Im1haW4tY29udGVudCI+PC9kaXY+DQo8c2NyaXB0Pg0KbGV0IF9sb2FkaW5nQ291bnQgPSAwOw0KZnVuY3Rpb24gc2hvd0xvYWRpbmcoKSB7IF9sb2FkaW5nQ291bnQrKzsgY29uc3QgYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2FkaW5nLWJhcicpOyBpZiAoYikgeyBiLnN0eWxlLndpZHRoID0gJzMwJSc7IGIuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7IH0gfQ0KZnVuY3Rpb24gaGlkZUxvYWRpbmcoKSB7IF9sb2FkaW5nQ291bnQtLTsgaWYgKF9sb2FkaW5nQ291bnQgPD0gMCkgeyBfbG9hZGluZ0NvdW50ID0gMDsgY29uc3QgYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2FkaW5nLWJhcicpOyBpZiAoYikgeyBiLnN0eWxlLndpZHRoID0gJzEwMCUnOyBzZXRUaW1lb3V0KCgpID0+IHsgYi5zdHlsZS53aWR0aCA9ICcwJzsgYi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsgfSwgMzAwKTsgfSB9IH0NCmZ1bmN0aW9uIGFwaShwYXRoLCBvcHRzKSB7DQogIHNob3dMb2FkaW5nKCk7DQogIGNvbnN0IGhkcnMgPSB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsIC4uLihvcHRzIHx8IHt9KS5oZWFkZXJzIH07DQogIHJldHVybiBmZXRjaCgnL2FkbWluL2FwaScgKyBwYXRoLCB7DQogICAgaGVhZGVyczogaGRycywNCiAgICBjcmVkZW50aWFsczogJ3NhbWUtb3JpZ2luJywgLi4uKG9wdHMgfHwge30pDQogIH0pLnRoZW4ociA9PiB7IGhpZGVMb2FkaW5nKCk7IGlmIChyLnN0YXR1cyA9PT0gNDAxKSB7IHNob3dUb2FzdCgnU2Vzc2lvbiBleHBpcmVkLCBwbGVhc2UgbG9naW4gYWdhaW4nLCAnZXJyb3InKTsgdGhyb3cgbmV3IEVycm9yKCd1bmF1dGhvcml6ZWQnKTsgfSByZXR1cm4gci5qc29uKCk7IH0pLmNhdGNoKGUgPT4geyBoaWRlTG9hZGluZygpOyB0aHJvdyBlOyB9KTsNCn0NCmZ1bmN0aW9uIGVzYyhzKSB7IHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7JykucmVwbGFjZSgvJy9nLCcmI3gyNzsnKTsgfQ0KYXN5bmMgZnVuY3Rpb24gY29weUtleShwbmFtZSwgaWQpIHsNCiAgdHJ5IHsgY29uc3QgciA9IGF3YWl0IGFwaSgnL2tleXM/ZnVsbD0xJnBuYW1lPScgKyBlbmNvZGVVUklDb21wb25lbnQocG5hbWUpICsgJyZpZD0nICsgZW5jb2RlVVJJQ29tcG9uZW50KGlkKSk7IGlmIChyLmFwaUtleSkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChyLmFwaUtleSk7IHNob3dUb2FzdCgnS2V5IGNvcGllZCcsICdzdWNjZXNzJyk7IH0gZWxzZSBzaG93VG9hc3QoJ0ZhaWxlZCB0byBnZXQga2V5JywgJ2Vycm9yJyk7IH0gY2F0Y2ggeyBzaG93VG9hc3QoJ0ZhaWxlZCB0byBjb3B5JywgJ2Vycm9yJyk7IH0NCn0NCmZ1bmN0aW9uIHNob3dUb2FzdChtc2csIHR5cGUpIHsNCiAgY29uc3QgaWNvID0gdHlwZSA9PT0gJ3N1Y2Nlc3MnID8gJ1x1MjcxMycgOiB0eXBlID09PSAnZXJyb3InID8gJ1x1MjcxNycgOiAnXHUyMTM5JzsNCiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyB0LmNsYXNzTmFtZSA9ICd0b2FzdCAnICsgdHlwZTsNCiAgdC5pbm5lckhUTUwgPSAnPHNwYW4gc3R5bGU9Im1hcmdpbi1yaWdodDoxMHB4O2ZvbnQtc2l6ZToxNnB4Ij4nICsgaWNvICsgJzwvc3Bhbj4nOw0KICB0LmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKG1zZykpOw0KICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHQpOyBzZXRUaW1lb3V0KCgpID0+IHQucmVtb3ZlKCksIDM1MDApOw0KfQ0KDQpmdW5jdGlvbiBzaG93VGFiKG5hbWUpIHsNCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNpZGViYXIgYScpLmZvckVhY2goYSA9PiBhLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTsNCiAgY29uc3QgbmF2ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25hdi0nICsgbmFtZSk7IGlmIChuYXYpIG5hdi5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsNCiAgaWYgKFBBR0VTW25hbWVdICYmIFBBR0VTW25hbWVdLnJlbmRlcikgUEFHRVNbbmFtZV0ucmVuZGVyKCk7DQp9DQpmdW5jdGlvbiBzZXRDb250ZW50KGgpIHsNCiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWFpbi1jb250ZW50Jyk7DQogIGVsLnN0eWxlLm9wYWNpdHkgPSAnMCc7DQogIHNldFRpbWVvdXQoKCkgPT4geyBlbC5pbm5lckhUTUwgPSBoOyBlbC5zdHlsZS50cmFuc2l0aW9uID0gJ29wYWNpdHkgLjI1cyc7IGVsLnN0eWxlLm9wYWNpdHkgPSAnMSc7IH0sIDUwKTsNCn0NCmNvbnN0IFBBR0VTID0gew0KICBvdmVydmlldzogeyB0aXRsZTogJ0Rhc2hib2FyZCBPdmVydmlldycsIHJlbmRlcjogcmVuZGVyT3ZlcnZpZXcgfSwNCiAga2V5czogeyB0aXRsZTogJ0FQSSBLZXlzJywgcmVuZGVyOiByZW5kZXJLZXlzIH0sDQogIGdhdGV3YXk6IHsgdGl0bGU6ICdHYXRld2F5IEtleXMnLCByZW5kZXI6IHJlbmRlckdhdGV3YXkgfSwNCiAgc3RyYXRlZ3k6IHsgdGl0bGU6ICdSb3V0aW5nIFN0cmF0ZWd5JywgcmVuZGVyOiByZW5kZXJTdHJhdGVneSB9LA0KICAvLyBsb2dzIGFuZCByZXEtbG9ncyByZW1vdmVkIChLViBzcGFjZSkNCiAgYW5hbHl0aWNzOiB7IHRpdGxlOiAnQW5hbHl0aWNzJywgcmVuZGVyOiByZW5kZXJBbmFseXRpY3MgfSwNCiAgdXNhZ2U6IHsgdGl0bGU6ICdVc2FnZSAmIExpbWl0cycsIHJlbmRlcjogcmVuZGVyVXNhZ2UgfSwNCiAgc2V0dGluZ3M6IHsgdGl0bGU6ICdTZXR0aW5ncycsIHJlbmRlcjogcmVuZGVyU2V0dGluZ3MgfSwNCiAgaGVhbHRoOiB7IHRpdGxlOiAnSGVhbHRoIENoZWNrJywgcmVuZGVyOiByZW5kZXJIZWFsdGggfSwNCiAgc2V0dXA6IHsgdGl0bGU6ICdTZXR1cCBHdWlkZScsIHJlbmRlcjogcmVuZGVyU2V0dXAgfQ0KfTsNCnNob3dUYWIoJ292ZXJ2aWV3Jyk7DQphc3luYyBmdW5jdGlvbiByZW5kZXJPdmVydmlldygpIHsNCiAgY29uc3QgcyA9IGF3YWl0IGFwaSgnL3N0YXRzJyk7DQogIGNvbnN0IGEgPSBhd2FpdCBhcGkoJy9hbmFseXRpY3M/ZGF5cz03Jyk7DQogIGxldCB0b3RhbENvc3QgPSAwOyBsZXQgdG90YWxUb2tlbnMgPSAwOw0KICBpZiAoQXJyYXkuaXNBcnJheShhKSkgeyBhLmZvckVhY2goZCA9PiB7IHRvdGFsQ29zdCArPSBkLnRvdGFsQ29zdCB8fCAwOyB0b3RhbFRva2VucyArPSAoZC50b3RhbFByb21wdFRva2VucyB8fCAwKSArIChkLnRvdGFsQ29tcGxldGlvblRva2VucyB8fCAwKTsgfSk7IH0NCiAgY29uc3QgY29weVVybCA9ICgpID0+IHsgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoJ2h0dHBzOi8vYnVkZGhpLWR3YXIucmljaGFyZC1icm93bi1taWFtaS53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zJyk7IHNob3dUb2FzdCgnVVJMIGNvcGllZCcsICdzdWNjZXNzJyk7IH07DQogIHNldENvbnRlbnQoYA0KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLWJvdHRvbTo4cHgiPg0KICAgICAgPGgyIHN0eWxlPSJtYXJnaW46MDtib3JkZXI6bm9uZTtwYWRkaW5nOjAiPkRhc2hib2FyZCBPdmVydmlldzwvaDI+DQogICAgICA8c3BhbiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6Izc0ODhhOCI+JHtuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpfTwvc3Bhbj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPk1vbml0b3Igb3ZlcmFsbCBnYXRld2F5IHBlcmZvcm1hbmNlOiByZXF1ZXN0IGNvdW50LCBrZXkgaGVhbHRoIGJ5IHN0YXR1cyAoYWN0aXZlL2RlYWQvZXhwaXJlZC93YXJtaW5nKSwgZXN0aW1hdGVkIGNvc3QgYW5kIHRva2VuIHVzYWdlIGFjcm9zcyBhbGwgcHJvdmlkZXJzIG92ZXIgdGhlIGxhc3QgNyBkYXlzLjwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImNhcmRzIj4NCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wOCkscmdiYSg5OSwxMDIsMjQxLC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iPiR7cy5yZXF1ZXN0c1RvZGF5IHx8IDB9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5SZXF1ZXN0cyBUb2RheTwvZGl2PjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDk5LDEwMiwyNDEsLjA4KSxyZ2JhKDEzOSw5MiwyNDYsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSI+JHtzLnRvdGFsS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+VG90YWwgS2V5czwvZGl2PjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDM0LDE5Nyw5NCwuMDgpLHJnYmEoMjIsMTYzLDc0LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojODZlZmFjIj4ke3MuYWN0aXZlS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiM4NmVmYWMiPkFjdGl2ZSBLZXlzPC9kaXY+PC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMjM5LDY4LDY4LC4wOCkscmdiYSgyMjAsMzgsMzgsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmY2E1YTUiPiR7cy5kZWFkS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmY2E1YTUiPkRlYWQgS2V5czwvZGl2PjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzNCwxNzksOCwuMDgpLHJnYmEoMjAyLDEzOCw0LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmRlNjhhIj4ke3Mud2FybWluZ0tleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5XYXJtaW5nIEtleXM8L2Rpdj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgxOTIsMTMyLDI1MiwuMDgpLHJnYmEoMTY4LDg1LDI0NywuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2MwODRmYyI+JHtzLmV4cGlyZWRLZXlzIHx8IDB9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6I2MwODRmYyI+RXhwaXJlZCBLZXlzPC9kaXY+PC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMjUxLDE5MSwzNiwuMDgpLHJnYmEoMjQ1LDE1OCwxMSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+JCR7dG90YWxDb3N0LnRvRml4ZWQoNCl9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+RXN0LiBDb3N0ICg3ZCk8L2Rpdj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1OSwxMzAsMjQ2LC4wOCkscmdiYSgzNyw5OSwyMzUsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM5M2M1ZmQiPiR7dG90YWxUb2tlbnMudG9Mb2NhbGVTdHJpbmcoKX08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojOTNjNWZkIj5Ub2tlbnMgKDdkKTwvZGl2PjwvZGl2Pg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJncmlkLWNvbHVtbjoxLy0xO2JvcmRlci1jb2xvcjpyZ2JhKDU2LDE4OSwyNDgsLjI1KTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wNikscmdiYSg5OSwxMDIsMjQxLC4wNCkpO21hcmdpbi1ib3R0b206MjBweCI+DQogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206NnB4Ij4NCiAgICAgICAgPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOiM3NDg4YTg7Zm9udC13ZWlnaHQ6NjAwO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouNnB4Ij5Zb3VyIEdhdGV3YXkgVVJMPC9zcGFuPg0KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9IiR7Y29weVVybH0iIGNsYXNzPSJzZWNvbmRhcnkiIHN0eWxlPSJwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxMnB4O21hcmdpbjowIj5Db3B5IFVSTDwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8Y29kZSBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6IzM4YmRmODt3b3JkLWJyZWFrOmJyZWFrLWFsbDtkaXNwbGF5OmJsb2NrO3BhZGRpbmc6MTBweCAxNHB4O2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNCk7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1mYW1pbHk6J0ZpcmEgQ29kZScsJ0NvbnNvbGFzJyxtb25vc3BhY2UiPmh0dHBzOi8vYnVkZGhpLWR3YXIucmljaGFyZC1icm93bi1taWFtaS53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zPC9jb2RlPg0KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6I2ZkZTY4YTttYXJnaW4tdG9wOjhweCI+VXNlIGEgR2F0ZXdheSBLZXkgYXMgQmVhcmVyIHRva2VuLiBTZWUgU2V0dXAgdGFiIGZvciBleGFtcGxlcy48L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5Qcm92aWRlciBVc2FnZSBUb2RheTwvaDI+DQogICAgPGRpdiBjbGFzcz0iY2FyZHMiIGlkPSJ1c2FnZS1taW5pIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMjAwcHgsMWZyKSkiPkxvYWRpbmcuLi48L2Rpdj4NCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5EYWlseSBSZXF1ZXN0cyAoNyBkYXlzKTwvaDI+DQogICAgPHByZT4ke2VzYyhKU09OLnN0cmluZ2lmeShhLCBudWxsLCAyKSl9PC9wcmU+DQogIGApOw0KICB0cnkgew0KICAgIGNvbnN0IHVyID0gYXdhaXQgYXBpKCcva2V5LXVzYWdlJyk7DQogICAgY29uc3QgdWQgPSB1ci5wcm92aWRlcnMgfHwgdXI7DQogICAgY29uc3QgdCA9IHVyLnRvdGFscyB8fCB7IHJlcXVlc3RzOiAwLCBzdWNjZXNzZXM6IDAsIGZhaWx1cmVzOiAwLCBwcm9tcHRUb2tlbnM6IDAsIGNvbXBsZXRpb25Ub2tlbnM6IDAsIGNvc3Q6IDAsIGtleXM6IDAgfTsNCiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd1c2FnZS1taW5pJyk7DQogICAgaWYgKCFlbCkgcmV0dXJuOw0KICAgIGxldCBjYXJkcyA9ICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDgpLHJnYmEoOTksMTAyLDI0MSwuMDUpKSI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjE2cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiMzOGJkZjgiPicgKyB0LnJlcXVlc3RzICsgJzwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTgiPlRvdGFsIFJlcTwvZGl2PjwvZGl2PicgKw0KICAgICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJwYWRkaW5nOjEycHggMTZweCI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjE2cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiNmZGU2OGEiPiQnICsgdC5jb3N0LnRvRml4ZWQoNCkgKyAnPC9kaXY+PGRpdiBzdHlsZT0iZm9udC1zaXplOjEwcHg7Y29sb3I6Izc0ODhhOCI+VG90YWwgQ29zdDwvZGl2PjwvZGl2Pic7DQogICAgZm9yIChjb25zdCBbcG4sIHBkXSBvZiBPYmplY3QuZW50cmllcyh1ZCkpIHsNCiAgICAgIGNvbnN0IGxpbSA9IHBkLmxpbWl0IHx8IHt9OyBjb25zdCBkUmVxID0gbGltLmRhaWx5UmVxdWVzdHMgfHwgOTk5OTk5Ow0KICAgICAgbGV0IHRyID0gMDsgZm9yIChjb25zdCBrIG9mIHBkLmtleXMpIHRyICs9IGsudXNhZ2UucmVxdWVzdHM7DQogICAgICBjb25zdCBwY3QgPSBNYXRoLm1pbigxMDAsIE1hdGgucm91bmQodHIgLyBkUmVxICogMTAwKSk7DQogICAgICBjb25zdCBjb2wgPSBwY3QgPiA4MCA/ICcjZjg3MTcxJyA6IHBjdCA+IDUwID8gJyNmYmJmMjQnIDogJyMzOGJkZjgnOw0KICAgICAgY2FyZHMgKz0gJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJwYWRkaW5nOjEycHggMTZweCI+PGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206NHB4Ij48c3Bhbj4nICsgZXNjKHBuKSArICc8L3NwYW4+PHNwYW4gc3R5bGU9ImNvbG9yOicgKyBjb2wgKyAnIj4nICsgdHIgKyAnPC9zcGFuPjwvZGl2PicgKw0KICAgICAgICAnPGRpdiBzdHlsZT0iaGVpZ2h0OjZweDtiYWNrZ3JvdW5kOnJnYmEoNzEsODUsMTA1LC40KTtib3JkZXItcmFkaXVzOjNweDtvdmVyZmxvdzpoaWRkZW4iPjxkaXYgc3R5bGU9IndpZHRoOicgKyBwY3QgKyAnJTtoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOicgKyBjb2wgKyAnO2JvcmRlci1yYWRpdXM6M3B4Ij48L2Rpdj48L2Rpdj4nICsNCiAgICAgICAgJzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLXRvcDoycHgiPmxpbWl0OiAnICsgZFJlcSArICcgcmVxL2RheTwvZGl2PjwvZGl2Pic7DQogICAgfQ0KICAgIGVsLmlubmVySFRNTCA9IGNhcmRzIHx8ICc8cCBzdHlsZT0iY29sb3I6Izk0YTNiOCI+Tm8gZGF0YTwvcD4nOw0KICB9IGNhdGNoIHt9DQp9DQphc3luYyBmdW5jdGlvbiByZW5kZXJLZXlzKCkgew0KICBjb25zdCBbcmF3LCBoZWFsdGhdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL2tleXMnKSwgYXBpKCcva2V5cy1oZWFsdGgnKV0pOw0KICBjb25zdCBoTWFwID0ge307DQogIGZvciAoY29uc3QgW3Byb3YsIGl0ZW1zXSBvZiBPYmplY3QuZW50cmllcyhoZWFsdGggfHwge30pKSB7IGhNYXBbcHJvdl0gPSB7fTsgZm9yIChjb25zdCBpdCBvZiBpdGVtcykgaE1hcFtwcm92XVtpdC5pZF0gPSBpdDsgfQ0KICBsZXQgcm93cyA9ICcnOw0KICBmb3IgKGNvbnN0IFtwbmFtZSwga2V5c10gb2YgT2JqZWN0LmVudHJpZXMocmF3KSkgew0KICAgIGZvciAoY29uc3QgayBvZiBrZXlzKSB7DQogICAgICBjb25zdCBtcyA9IChrLm1vZGVsc3x8W10pLnNsaWNlKDAsMykuam9pbignLCAnKTsNCiAgICAgIGNvbnN0IG1hc2tlZCA9IChrLmFwaUtleXx8JycpLmluY2x1ZGVzKCcqKioqJykgPyBrLmFwaUtleSA6ICcqKioqJzsNCiAgICAgIGNvbnN0IGhpID0gaE1hcFtwbmFtZV0/LltrLmlkXTsNCiAgICAgIGNvbnN0IHN0ID0gaGk/LnN0YXR1cyB8fCAndW5rbm93bic7DQogICAgICBjb25zdCBjYiA9IGhpPy5jYlN0YXRlIHx8ICdjbG9zZWQnOw0KICAgICAgY29uc3QgY29vbGluZyA9IGhpPy5jb29saW5nIHx8IGZhbHNlOw0KICAgICAgY29uc3QgZXJyID0gaGk/Lmxhc3RFcnJvciB8fCAnJzsNCiAgICAgIGNvbnN0IHN0Q2xhc3MgPSBzdCA9PT0gJ2FjdGl2ZScgPyAnb2snIDogc3QgPT09ICdkZWFkJyA/ICdmYWlsJyA6IHN0ID09PSAnZXhwaXJlZCcgPyAnd2FybmluZycgOiAnd2FybmluZyc7DQogICAgICBjb25zdCBzdExhYmVsID0gc3QgKyAoY2IgPT09ICdvcGVuJyA/ICcgw7DFuOKAneKAnCcgOiBjYiA9PT0gJ2hhbGYtb3BlbicgPyAnIMOwxbjigJ3igJ4nIDogJycpICsgKGNvb2xpbmcgPyAnIMOiwo/CsycgOiAnJyk7DQogICAgICBjb25zdCBlcnJTaG9ydCA9IGVyciA/ICcgPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiNmODcxNzEiPicgKyBlc2MoZXJyLnNsaWNlKDAsIDYwKSkgKyAnPC9zcGFuPicgOiAnJzsNCiAgICAgIHJvd3MgKz0gJzx0cj48dGQ+JyArIGVzYyhwbmFtZSkgKyAnPC90ZD48dGQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5NGEzYjgiPicgKyBlc2Moay5sYWJlbHx8JycpICsgJzwvdGQ+JyArDQogICAgICAgICc8dGQ+PGNvZGUgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5NGEzYjg7dXNlci1zZWxlY3Q6bm9uZSI+JyArIG1hc2tlZCArICc8L2NvZGU+PC90ZD4nICsNCiAgICAgICAgJzx0ZD48c3BhbiBjbGFzcz0idGFnICcgKyBzdENsYXNzICsgJyIgaWQ9InN0LScgKyBlc2Moay5pZCkgKyAnIiBzdHlsZT0iY3Vyc29yOmhlbHAiIHRpdGxlPSJDQjogJyArIGNiICsgKGNvb2xpbmcgPyAnIHwgY29vbGluZyA2MHMnIDogJycpICsgKGVyciA/ICcgfCAnICsgZXNjKGVycikgOiAnJykgKyAnIj4nICsgc3RMYWJlbCArICc8L3NwYW4+PC90ZD4nICsNCiAgICAgICAgJzx0ZCBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6IzhiOTQ5ZTttYXgtd2lkdGg6MTgwcHg7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXMiPicgKyBlc2MobXMgfHwgJ8Oi4oKs4oCdJykgKyAnPC90ZD4nICsNCiAgICAgICAgJzx0ZCBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6Izk0YTNiOCI+JyArIChrLmFkZGVkQXQgPyBuZXcgRGF0ZShrLmFkZGVkQXQpLnRvTG9jYWxlRGF0ZVN0cmluZygpIDogJ8Oi4oKs4oCdJykgKyAnPC90ZD4nICsNCic8dGQ+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0iY29weUtleShcJycgKyBlc2MocG5hbWUpICsgJ1wnLFwnJyArIGVzYyhrLmlkKSArICdcJykiIHN0eWxlPSJwYWRkaW5nOjRweCA4cHg7Zm9udC1zaXplOjExcHgiPkNvcHk8L2J1dHRvbj4gJyArDQonPGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiBvbmNsaWNrPSJ0ZXN0S2V5KFwnJyArIGVzYyhwbmFtZSkgKyAnXCcsXCcnICsgZXNjKGsuaWQpICsgJ1wnKSIgc3R5bGU9InBhZGRpbmc6NHB4IDhweDtmb250LXNpemU6MTFweCI+VGVzdDwvYnV0dG9uPiAnICsNCic8YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIG9uY2xpY2s9InJlRGV0ZWN0S2V5KFwnJyArIGVzYyhwbmFtZSkgKyAnXCcsXCcnICsgZXNjKGsuaWQpICsgJ1wnKSIgc3R5bGU9InBhZGRpbmc6NHB4IDhweDtmb250LXNpemU6MTFweCI+TW9kZWxzPC9idXR0b24+ICcgKw0KJzxidXR0b24gY2xhc3M9ImRhbmdlciIgb25jbGljaz0iZGVsZXRlS2V5KFwnJyArIGVzYyhwbmFtZSkgKyAnXCcsXCcnICsgZXNjKGsuaWQpICsgJ1wnKSIgc3R5bGU9InBhZGRpbmc6NHB4IDhweDtmb250LXNpemU6MTFweCI+RGVsPC9idXR0b24+PC90ZD48L3RyPic7DQogICAgfQ0KICB9DQogIHNldENvbnRlbnQoYA0KICAgIDxoMj5BUEkgS2V5czwvaDI+DQogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5NYW5hZ2UgcHJvdmlkZXIgQVBJIGtleXMgZm9yIEdyb3EsIEdvb2dsZSBHZW1pbmksIE1pc3RyYWwsIE9wZW5Sb3V0ZXIsIERlZXBTZWVrLCBhbmQgVG9nZXRoZXIgQUkuIEVhY2gga2V5IHNob3dzIGxpdmUgaGVhbHRoIHN0YXR1cyAoYWN0aXZlL2RlYWQvZXhwaXJlZC93YXJtaW5nKSwgY2lyY3VpdC1icmVha2VyIHN0YXRlIChjbG9zZWQvb3Blbi9oYWxmLW9wZW4pLCBhbmQgcmF0ZS1saW1pdCBjb29sZG93bi4gQ2xpY2sgVGVzdCB0byBwcm9iZSB0aGUga2V5LCBvciBNb2RlbHMgdG8gcmUtZGV0ZWN0IGF2YWlsYWJsZSBtb2RlbHMuIENpcmN1aXQgYnJlYWtlciBvcGVucyBhZnRlciA1IGNvbnNlY3V0aXZlIGZhaWx1cmVzOyByYXRlLWxpbWl0ICg0MjkpIHRyaWdnZXJzIGEgMS1taW51dGUgY29vbGRvd24uPC9kaXY+DQogICAgPGRpdiBjbGFzcz0iZm9ybS1yb3ciPg0KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPlByb3ZpZGVyPC9sYWJlbD48c2VsZWN0IGlkPSJrcC1wcm92aWRlciI+PG9wdGlvbj5ncm9xPC9vcHRpb24+PG9wdGlvbj5nb29nbGU8L29wdGlvbj48b3B0aW9uPm1pc3RyYWw8L29wdGlvbj48b3B0aW9uPm9wZW5yb3V0ZXI8L29wdGlvbj48b3B0aW9uPmRlZXBzZWVrPC9vcHRpb24+PG9wdGlvbj50b2dldGhlcjwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPkFQSSBLZXk8L2xhYmVsPjxpbnB1dCBpZD0ia3Ata2V5IiBwbGFjZWhvbGRlcj0ic2stLi4uIj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5MYWJlbDwvbGFiZWw+PGlucHV0IGlkPSJrcC1sYWJlbCIgcGxhY2Vob2xkZXI9Im15LWtleSI+PC9kaXY+DQogICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJhZGRLZXkoKSI+QWRkIEtleTwvYnV0dG9uPg0KICAgIDwvZGl2Pg0KICAgIDxkZXRhaWxzIHN0eWxlPSJtYXJnaW4tYm90dG9tOjE2cHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiODtjdXJzb3I6cG9pbnRlciI+DQogICAgICA8c3VtbWFyeSBzdHlsZT0iY29sb3I6IzM4YmRmODtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDAiPlByb3ZpZGVyIEtleSBMaW5rczwvc3VtbWFyeT4NCiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6OHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweCI+DQogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vY29uc29sZS5ncm9xLmNvbS9rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPkdyb3EgY29uc29sZS5ncm9xLmNvbTwvYT4NCiAgICAgICAgPGEgaHJlZj0iaHR0cHM6Ly9haXN0dWRpby5nb29nbGUuY29tL2FwaWtleSIgdGFyZ2V0PSJfYmxhbmsiIHN0eWxlPSJjb2xvcjojMzhiZGY4Ij5Hb29nbGUgYWlzdHVkaW8uZ29vZ2xlLmNvbTwvYT4NCiAgICAgICAgPGEgaHJlZj0iaHR0cHM6Ly9jb25zb2xlLm1pc3RyYWwuYWkvYXBpLWtleXMiIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6IzM4YmRmOCI+TWlzdHJhbCBjb25zb2xlLm1pc3RyYWwuYWk8L2E+DQogICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vb3BlbnJvdXRlci5haS9rZXlzIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjgiPk9wZW5Sb3V0ZXIgb3BlbnJvdXRlci5haTwvYT4NCiAgICAgIDwvZGl2Pg0KICAgIDwvZGV0YWlscz4NCiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+UHJvdmlkZXI8L3RoPjx0aD5MYWJlbDwvdGg+PHRoPktleTwvdGg+PHRoPlN0YXR1czwvdGg+PHRoPk1vZGVsczwvdGg+PHRoPkFkZGVkPC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+DQogICAgPHRib2R5PicgKyByb3dzICsgJzwvdGJvZHk+PC90YWJsZT4NCiAgYCk7DQp9DQp9DQphc3luYyBmdW5jdGlvbiByZW5kZXJHYXRld2F5KCkgew0KICBjb25zdCBnID0gYXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyk7DQogIGxldCByb3dzID0gZy5tYXAoayA9PiAnPHRyIGRhdGEtd29yZD0iJyArIGVzYyhrLndvcmQpICsgJyIgZGF0YS1lbmFibGVkPSInICsgay5lbmFibGVkICsgJyI+PHRkPicgKyBlc2Moay53b3JkKSArICc8L3RkPicgKw0KICAgICc8dGQ+PHNwYW4gY2xhc3M9InRhZyAnICsgKGsuZW5hYmxlZD8nYWN0aXZlJzonZmFpbCcpICsgJyI+JyArIChrLmVuYWJsZWQ/J0FjdGl2ZSc6J0Rpc2FibGVkJykgKyAnPC9zcGFuPjwvdGQ+JyArDQogICAgJzx0ZD4nICsgKGsudXNhZ2V8fDApICsgJzwvdGQ+JyArDQogICAgJzx0ZCBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6Izk0YTNiOCI+JyArIChrLmNyZWF0ZWRBdCA/IG5ldyBEYXRlKGsuY3JlYXRlZEF0KS50b0xvY2FsZURhdGVTdHJpbmcoKSA6ICcnKSArICc8L3RkPicgKw0KICAgICc8dGQ+PGJ1dHRvbiBvbmNsaWNrPSJ0b2dnbGVHdyh0aGlzKSIgc3R5bGU9InBhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHgiPicgKyAoay5lbmFibGVkPydEaXNhYmxlJzonRW5hYmxlJykgKyAnPC9idXR0b24+JyArDQogICAgJzxidXR0b24gY2xhc3M9ImRhbmdlciIgb25jbGljaz0iZGVsZXRlR3codGhpcykiIHN0eWxlPSJwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4Ij5EZWw8L2J1dHRvbj48L3RkPjwvdHI+Jykuam9pbignJyk7DQogIHNldENvbnRlbnQoYA0KICAgIDxoMj5HYXRld2F5IEtleXM8L2gyPg0KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+Q3JlYXRlIEFQSSBrZXlzIGZvciBleHRlcm5hbCBjbGllbnRzIHRoYXQgcHJveHkgdGhyb3VnaCB0aGlzIGdhdGV3YXkuIEVhY2gga2V5IGhhcyB1c2FnZSB0cmFja2luZyBhbmQgY2FuIGJlIGVuYWJsZWQvZGlzYWJsZWQgaW5kZXBlbmRlbnRseS4gR2VuZXJhdGUgYSByYW5kb20ga2V5IG9yIGNyZWF0ZSBhIGN1c3RvbSB3b3JkLWJhc2VkIHRva2VuLjwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImZvcm0tcm93Ij4NCiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5HYXRld2F5IEtleSAod29yZC90b2tlbik8L2xhYmVsPjxpbnB1dCBpZD0iZ3ctd29yZCIgcGxhY2Vob2xkZXI9Im15LWFwcC1rZXkiPjwvZGl2Pg0KICAgICAgPGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0iYWRkR3coKSI+QWRkIEtleTwvYnV0dG9uPg0KICAgICAgPGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiBvbmNsaWNrPSJnZW5Hd0tleSgpIj5HZW5lcmF0ZSBLZXk8L2J1dHRvbj4NCiAgICA8L2Rpdj4NCiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+V29yZDwvdGg+PHRoPlN0YXR1czwvdGg+PHRoPlVzYWdlPC90aD48dGg+Q3JlYXRlZDwvdGg+PHRoPjwvdGg+PC90cj48L3RoZWFkPg0KICAgIDx0Ym9keT4ke3Jvd3N9PC90Ym9keT48L3RhYmxlPg0KICBgKTsNCn0NCmFzeW5jIGZ1bmN0aW9uIHRvZ2dsZUd3KGVsKXtjb25zdCB0cj1lbC5jbG9zZXN0KCd0cicpO2NvbnN0IHdvcmQ9dHIuZGF0YXNldC53b3JkO2NvbnN0IGVuYWJsZWQ9dHIuZGF0YXNldC5lbmFibGVkPT09J3RydWUnP2ZhbHNlOnRydWU7YXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyx7bWV0aG9kOidQQVRDSCcsYm9keTpKU09OLnN0cmluZ2lmeSh7d29yZCxlbmFibGVkfSl9KTsgcmVuZGVyR2F0ZXdheSgpO30NCmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUd3KGVsKXtjb25zdCB3b3JkPWVsLmNsb3Nlc3QoJ3RyJykuZGF0YXNldC53b3JkO2lmKCFjb25maXJtKCdEZWxldGUgIicrd29yZCsnIj8nKSlyZXR1cm47YXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyx7bWV0aG9kOidERUxFVEUnLGJvZHk6SlNPTi5zdHJpbmdpZnkoe3dvcmR9KX0pOyByZW5kZXJHYXRld2F5KCk7fQ0KYXN5bmMgZnVuY3Rpb24gYWRkR3coKXsNCiAgY29uc3Qgd29yZD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ3ctd29yZCcpLnZhbHVlOw0KICBpZighd29yZCl7c2hvd1RvYXN0KCdXb3JkIHJlcXVpcmVkJywnZXJyb3InKTtyZXR1cm59DQogIGF3YWl0IGFwaSgnL2dhdGV3YXkta2V5cycse21ldGhvZDonUE9TVCcsYm9keTpKU09OLnN0cmluZ2lmeSh7d29yZH0pfSk7DQogIHNob3dUb2FzdCgnQWRkZWQnLCdzdWNjZXNzJyk7IHJlbmRlckdhdGV3YXkoKTsNCn0NCmFzeW5jIGZ1bmN0aW9uIGdlbkd3S2V5KCkgew0KICBjb25zdCBjaGFycyA9ICdhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODknOw0KICBsZXQga2V5ID0gJyc7DQogIGZvciAobGV0IGkgPSAwOyBpIDwgMzI7IGkrKykgew0KICAgIGlmIChpID4gMCAmJiBpICUgOCA9PT0gMCkga2V5ICs9ICctJzsNCiAgICBrZXkgKz0gY2hhcnMuY2hhckF0KE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNoYXJzLmxlbmd0aCkpOw0KICB9DQogIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9nYXRld2F5LWtleXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHdvcmQ6IGtleSB9KSB9KTsNCiAgaWYgKHIub2spIHsgc2hvd1RvYXN0KCdLZXkgZ2VuZXJhdGVkIGFuZCBzYXZlZDogJyArIGtleSwgJ3N1Y2Nlc3MnKTsgcmVuZGVyR2F0ZXdheSgpOyB9DQogIGVsc2UgeyBzaG93VG9hc3QoJ0ZhaWxlZCB0byBzYXZlIGtleScsICdlcnJvcicpOyB9DQp9DQphc3luYyBmdW5jdGlvbiByZW5kZXJTdHJhdGVneSgpIHsNCiAgY29uc3QgcyA9IGF3YWl0IGFwaSgnL3N0cmF0ZWd5Jyk7DQogIGxldCBodG1sID0gJzxoMj5Sb3V0aW5nIFN0cmF0ZWd5PC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPkNob29zZSBob3cgdGhlIGdhdGV3YXkgc2VsZWN0cyBiZXR3ZWVuIG11bHRpcGxlIEFQSSBrZXlzIGZvciB0aGUgc2FtZSBwcm92aWRlci4gUm91bmQtcm9iaW4gY3ljbGVzIGV2ZW5seSwgbG93ZXN0LWxhdGVuY3kgcGlja3MgZmFzdGVzdCwgbGVhc3QtbG9hZGVkIHBpY2tzIGxvd2VzdCBmYWlsdXJlIHJhdGlvLjwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIj4nOw0KICBmb3IgKGNvbnN0IFtwcm92LCBzdHJhdF0gb2YgT2JqZWN0LmVudHJpZXMocykpIHsNCiAgICBodG1sICs9ICc8ZGl2IGNsYXNzPSJjYXJkIj48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbTo4cHgiPicgKyBlc2MocHJvdikgKyAnPC9oMz4nICsNCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6Izk0YTNiOCI+U3RyYXRlZ3k6IDxiIHN0eWxlPSJjb2xvcjojZTJlOGYwIj4nICsgZXNjKHN0cmF0KSArICc8L2I+PC9wPjwvZGl2Pic7DQogIH0NCiAgaHRtbCArPSAnPC9kaXY+PGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPlNldCBTdHJhdGVneTwvaDI+PGRpdiBjbGFzcz0iZm9ybS1yb3ciPicgKw0KICAgICc8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+UHJvdmlkZXI8L2xhYmVsPjxzZWxlY3QgaWQ9InN0ci1wcm92aWRlciI+JyArIFsnZ3JvcScsJ2dvb2dsZScsJ21pc3RyYWwnLCdvcGVucm91dGVyJywnZGVlcHNlZWsnLCd0b2dldGhlciddLm1hcChwPT4nPG9wdGlvbj4nK3ArJzwvb3B0aW9uPicpLmpvaW4oJycpICsgJzwvc2VsZWN0PjwvZGl2PicgKw0KICAgICc8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+U3RyYXRlZ3k8L2xhYmVsPjxzZWxlY3QgaWQ9InN0ci1zdHJhdGVneSI+PG9wdGlvbj5yb3VuZC1yb2Jpbjwvb3B0aW9uPjxvcHRpb24+bG93ZXN0LWxhdGVuY3k8L29wdGlvbj48b3B0aW9uPmxlYXN0LWxvYWRlZDwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PicgKw0KICAgICc8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJ1cGRhdGVTdHIoKSI+U2V0PC9idXR0b24+PC9kaXY+JyArDQogICAgJzxoMj5SYXc8L2gyPjxwcmU+JyArIGVzYyhKU09OLnN0cmluZ2lmeShzLCBudWxsLCAyKSkgKyAnPC9wcmU+JzsNCiAgc2V0Q29udGVudChodG1sKTsNCn0NCmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZVN0cigpIHsNCiAgY29uc3QgcG5hbWUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RyLXByb3ZpZGVyJykudmFsdWU7DQogIGNvbnN0IHN0cmF0ZWd5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0ci1zdHJhdGVneScpLnZhbHVlOw0KICBhd2FpdCBhcGkoJy9zdHJhdGVneScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcG5hbWUsIHN0cmF0ZWd5IH0pIH0pOw0KICBzaG93VG9hc3QoJ1VwZGF0ZWQnLCAnc3VjY2VzcycpOyByZW5kZXJTdHJhdGVneSgpOw0KfQ0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyQW5hbHl0aWNzKCkgew0KICBjb25zdCBhID0gYXdhaXQgYXBpKCcvYW5hbHl0aWNzP2RheXM9MzAnKTsNCiAgaWYoIUFycmF5LmlzQXJyYXkoYSl8fGEubGVuZ3RoPT09MCl7c2V0Q29udGVudCgnPHA+Tm8gYW5hbHl0aWNzIGRhdGE8L3A+Jyk7cmV0dXJufQ0KICBsZXQgcm93cyA9IGEubWFwKGQgPT4gJzx0cj48dGQ+JyArIChkLmRhdGV8fCfDg8Kiw6LigJrCrMOi4oKswp0nKSArICc8L3RkPjx0ZD4nICsgKGQucmVxdWVzdHN8fDApICsgJzwvdGQ+PHRkPicgKyAoZC5mYWlsdXJlc3x8MCkgKyAnPC90ZD4nICsNCiAgICAnPHRkPicgKyAoZC5zdWNjZXNzZXN8fDApICsgJzwvdGQ+PHRkPicgKyAoKGQudG90YWxQcm9tcHRUb2tlbnN8fDApLnRvTG9jYWxlU3RyaW5nKCkpICsgJzwvdGQ+JyArDQogICAgJzx0ZD4nICsgKChkLnRvdGFsQ29tcGxldGlvblRva2Vuc3x8MCkudG9Mb2NhbGVTdHJpbmcoKSkgKyAnPC90ZD48dGQ+JCcgKyAoKGQudG90YWxDb3N0fHwwKS50b0ZpeGVkKDQpKSArICc8L3RkPjwvdHI+Jykuam9pbignJyk7DQogIGxldCB0b3RhbFJlcT0wLHRvdGFsRmFpbD0wLHRvdGFsQ29zdD0wLHRvdGFsUHJvbXB0PTAsdG90YWxDb21wPTA7DQogIGEuZm9yRWFjaChkPT57dG90YWxSZXErPWQucmVxdWVzdHN8fDA7dG90YWxGYWlsKz1kLmZhaWx1cmVzfHwwO3RvdGFsQ29zdCs9ZC50b3RhbENvc3R8fDA7dG90YWxQcm9tcHQrPWQudG90YWxQcm9tcHRUb2tlbnN8fDA7dG90YWxDb21wKz1kLnRvdGFsQ29tcGxldGlvblRva2Vuc3x8MDt9KTsNCiAgc2V0Q29udGVudChgDQogICAgPGgyPkFuYWx5dGljczwvaDI+DQogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5WaWV3IHJlcXVlc3QgbWV0cmljcyBvdmVyIHRoZSBsYXN0IDMwIGRheXM6IHZvbHVtZSwgc3VjY2Vzcy9mYWlsdXJlIHJhdGVzLCB0b2tlbiB1c2FnZSwgYW5kIGVzdGltYXRlZCBjb3N0IHBlciBwcm92aWRlci4gVXNlIHRoZSBFeHBvcnQgQ1NWIGJ1dHRvbiBmb3Igb2ZmbGluZSBhbmFseXNpcy48L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJjYXJkcyI+DQogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iPiR7dG90YWxSZXF9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5SZXF1ZXN0cyAoMzBkKTwvZGl2PjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZjYTVhNSI+JHt0b3RhbEZhaWx9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5FcnJvcnMgKDMwZCk8L2Rpdj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiQke3RvdGFsQ29zdC50b0ZpeGVkKDQpfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+Q29zdCAoMzBkKTwvZGl2PjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIj4keyh0b3RhbFByb21wdCt0b3RhbENvbXApLnRvTG9jYWxlU3RyaW5nKCl9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Ub2tlbnMgKDMwZCk8L2Rpdj48L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tYm90dG9tOjEycHgiPjxidXR0b24gY2xhc3M9InNlY29uZGFyeSIgb25jbGljaz0iZXhwb3J0QW5hbHl0aWNzKCkiPkV4cG9ydCBDU1Y8L2J1dHRvbj48L2Rpdj4NCiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+RGF0ZTwvdGg+PHRoPlJlcTwvdGg+PHRoPkVycjwvdGg+PHRoPlN1Y2Nlc3M8L3RoPjx0aD5Qcm9tcHQgVG9rPC90aD48dGg+Q29tcCBUb2s8L3RoPjx0aD5Db3N0PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PiR7cm93c308L3Rib2R5PjwvdGFibGU+DQogIGApOw0KfQ0KZnVuY3Rpb24gZXhwb3J0QW5hbHl0aWNzKCkgew0KICB3aW5kb3cub3BlbignL2FkbWluL2FwaS9hbmFseXRpY3M/ZGF5cz0zMCZmb3JtYXQ9Y3N2JywgJ19ibGFuaycpOw0KfQ0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyVXNhZ2UoKSB7DQogIGNvbnN0IHJhdyA9IGF3YWl0IGFwaSgnL2tleS11c2FnZScpOw0KICBjb25zdCBkYXRhID0gcmF3LnByb3ZpZGVycyB8fCByYXc7DQogIGNvbnN0IHRvdGFscyA9IHJhdy50b3RhbHMgfHwgeyByZXF1ZXN0czogMCwgc3VjY2Vzc2VzOiAwLCBmYWlsdXJlczogMCwgcHJvbXB0VG9rZW5zOiAwLCBjb21wbGV0aW9uVG9rZW5zOiAwLCBjb3N0OiAwLCBwcm92aWRlcnM6IDAsIGtleXM6IDAgfTsNCiAgbGV0IGh0bWwgPSAnPGgyPlVzYWdlICZhbXA7IExpbWl0czwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Nb25pdG9yIHRvZGF5XCdzIHJlcXVlc3Qgdm9sdW1lLCB0b2tlbiBjb25zdW1wdGlvbiwgYW5kIGVzdGltYXRlZCBjb3N0IHBlciBwcm92aWRlci4gUHJvZ3Jlc3MgYmFycyBzaG93IHVzYWdlIGFnYWluc3QgZGFpbHkgcXVvdGFzLiBSYXRlLWxpbWl0IGhlYWRlcnMgZnJvbSB1cHN0cmVhbSBwcm92aWRlcnMgYXJlIGRpc3BsYXllZCBwZXIga2V5LjwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIiBzdHlsZT0ibWFyZ2luLWJvdHRvbToyMHB4Ij4nICsNCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU2LDE4OSwyNDgsLjA4KSxyZ2JhKDk5LDEwMiwyNDEsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSI+JyArIHRvdGFscy5yZXF1ZXN0cyArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiPlRvdGFsIFJlcXVlc3RzIFRvZGF5PC9kaXY+PC9kaXY+JyArDQogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgzNCwxOTcsOTQsLjA4KSxyZ2JhKDIyLDE2Myw3NCwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+JyArIHRvdGFscy5zdWNjZXNzZXMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+U3VjY2Vzc2VzPC9kaXY+PC9kaXY+JyArDQogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgyMzksNjgsNjgsLjA4KSxyZ2JhKDIyMCwzOCwzOCwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZjYTVhNSI+JyArIHRvdGFscy5mYWlsdXJlcyArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij5GYWlsdXJlczwvZGl2PjwvZGl2PicgKw0KICAgICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTksMTMwLDI0NiwuMDgpLHJnYmEoMzcsOTksMjM1LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojOTNjNWZkIj4nICsgKHRvdGFscy5wcm9tcHRUb2tlbnMgKyB0b3RhbHMuY29tcGxldGlvblRva2VucykudG9Mb2NhbGVTdHJpbmcoKSArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojOTNjNWZkIj5Ub3RhbCBUb2tlbnM8L2Rpdj48L2Rpdj4nICsNCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDI1MSwxOTEsMzYsLjA4KSxyZ2JhKDI0NSwxNTgsMTEsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiQnICsgdG90YWxzLmNvc3QudG9GaXhlZCg2KSArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5Ub3RhbCBDb3N0PC9kaXY+PC9kaXY+JyArDQogICAgJzxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9Im51bSI+JyArIHRvdGFscy5rZXlzICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCI+QWN0aXZlIEtleXM8L2Rpdj48L2Rpdj4nICsNCiAgICAnPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZml0LG1pbm1heCgyODBweCwxZnIpKSI+JzsNCiAgZm9yIChjb25zdCBbcG5hbWUsIHBkYXRhXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkgew0KICAgIGNvbnN0IGxpbSA9IHBkYXRhLmxpbWl0IHx8IHt9Ow0KICAgIGNvbnN0IGRSZXEgPSBsaW0uZGFpbHlSZXF1ZXN0cyB8fCA5OTk5OTk7DQogICAgY29uc3QgZFRvayA9IGxpbS5kYWlseVRva2VucyB8fCA5OTk5OTk5OTk7DQogICAgbGV0IHRvdFJlcSA9IDAsIHRvdFRvayA9IDAsIHRvdENvc3QgPSAwOw0KICAgIGxldCBybEh0bWwgPSAnJzsNCiAgICBmb3IgKGNvbnN0IGsgb2YgcGRhdGEua2V5cykgeyANCiAgICAgIHRvdFJlcSArPSBrLnVzYWdlLnJlcXVlc3RzOyB0b3RUb2sgKz0gay51c2FnZS5wcm9tcHRUb2tlbnMgKyBrLnVzYWdlLmNvbXBsZXRpb25Ub2tlbnM7IHRvdENvc3QgKz0gay51c2FnZS5jb3N0Ow0KICAgICAgaWYgKGsucmF0ZUxpbWl0KSB7DQogICAgICAgIGNvbnN0IHJyZW0gPSBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nLXJlcXVlc3RzJ10gfHwgay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LXJlbWFpbmluZyddIHx8ICc/JzsNCiAgICAgICAgY29uc3QgcmxpbSA9IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1saW1pdC1yZXF1ZXN0cyddIHx8IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1saW1pdCddIHx8ICc/JzsNCiAgICAgICAgY29uc3QgdHJlbSA9IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1yZW1haW5pbmctdG9rZW5zJ10gfHwgJz8nOw0KICAgICAgICBjb25zdCB0bGltID0gay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LWxpbWl0LXRva2VucyddIHx8ICc/JzsNCiAgICAgICAgcmxIdG1sICs9ICc8cCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izg2ZWZhYzttYXJnaW4tdG9wOjRweCI+UmF0ZSBsaW1pdDogJyArIHJyZW0gKyAnLycgKyBybGltICsgJyByZXEsICcgKyB0cmVtICsgJy8nICsgdGxpbSArICcgdG9rPC9wPic7DQogICAgICB9DQogICAgfQ0KICAgIGNvbnN0IHJlcVBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCh0b3RSZXEgLyBkUmVxICogMTAwKSk7DQogICAgY29uc3QgdG9rUGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLnJvdW5kKHRvdFRvayAvIGRUb2sgKiAxMDApKTsNCiAgICBjb25zdCByZXFDb2xvciA9IHJlcVBjdCA+IDgwID8gJyNmODcxNzEnIDogcmVxUGN0ID4gNTAgPyAnI2ZiYmYyNCcgOiAnIzM4YmRmOCc7DQogICAgY29uc3QgdG9rQ29sb3IgPSB0b2tQY3QgPiA4MCA/ICcjZjg3MTcxJyA6IHRva1BjdCA+IDUwID8gJyNmYmJmMjQnIDogJyMzOGJkZjgnOw0KICAgIGh0bWwgKz0gJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjE2cHgiPjxoMyBzdHlsZT0iY29sb3I6IzM4YmRmODttYXJnaW4tYm90dG9tOjEycHgiPicgKyBlc2MocG5hbWUpICsgJzwvaDM+JyArDQogICAgICAnPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPjxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vlbjtmb250LXNpemU6MTJweDtjb2xvcjojOTRhM2I4O21hcmdpbi1ib3R0b206NHB4Ij48c3Bhbj5SZXF1ZXN0czwvc3Bhbj48c3Bhbj4nICsgdG90UmVxICsgJyAvICcgKyBkUmVxICsgJzwvc3Bhbj48L2Rpdj4nICsNCiAgICAgICc8ZGl2IHN0eWxlPSJoZWlnaHQ6OHB4O2JhY2tncm91bmQ6cmdiYSg3MSw4NSwxMDUsLjQpO2JvcmRlci1yYWRpdXM6NHB4O292ZXJmbG93OmhpZGRlbiI+PGRpdiBzdHlsZT0id2lkdGg6JyArIHJlcVBjdCArICclO2hlaWdodDoxMDAlO2JhY2tncm91bmQ6JyArIHJlcUNvbG9yICsgJztib3JkZXItcmFkaXVzOjRweDt0cmFuc2l0aW9uOndpZHRoIC4zcyI+PC9kaXY+PC9kaXY+PC9kaXY+JyArDQogICAgICAnPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPjxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vlbjtmb250LXNpemU6MTJweDtjb2xvcjojOTRhM2I4O21hcmdpbi1ib3R0b206NHB4Ij48c3Bhbj5Ub2tlbnM8L3NwYW4+PHNwYW4+JyArIHRvdFRvay50b0xvY2FsZVN0cmluZygpICsgJyAvICcgKyBkVG9rLnRvTG9jYWxlU3RyaW5nKCkgKyAnPC9zcGFuPjwvZGl2PicgKw0KICAgICAgJzxkaXYgc3R5bGU9ImhlaWdodDo4cHg7YmFja2dyb3VuZDpyZ2JhKDcxLDg1LDEwNSwuNCk7Ym9yZGVyLXJhZGl1czo0cHg7b3ZlcmZsb3c6aGlkZGVuIj48ZGl2IHN0eWxlPSJ3aWR0aDonICsgdG9rUGN0ICsgJyU7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDonICsgdG9rQ29sb3IgKyAnO2JvcmRlci1yYWRpdXM6NHB4O3RyYW5zaXRpb246d2lkdGggLjNzIj48L2Rpdj48L2Rpdj48L2Rpdj4nICsNCiAgICAgICh0b3RDb3N0ID4gMCA/ICc8cCBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6I2ZkZTY4YSI+Q29zdDogJCcgKyB0b3RDb3N0LnRvRml4ZWQoNikgKyAnPC9wPicgOiAnJykgKw0KICAgICAgcmxIdG1sICsNCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izc0ODhhOCI+JyArIHBkYXRhLmtleXMubGVuZ3RoICsgJyBrZXkocyk8L3A+PC9kaXY+JzsNCiAgfQ0KICBpZiAoaHRtbCA9PT0gJzxkaXYgY2xhc3M9ImNhcmRzIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMjgwcHgsMWZyKSkiPicpIGh0bWwgKz0gJzxwIHN0eWxlPSJjb2xvcjojOTRhM2I4Ij5ObyB1c2FnZSBkYXRhIHlldDwvcD4nOw0KICBodG1sICs9ICc8L2Rpdj4nOw0KICBzZXRDb250ZW50KGh0bWwpOw0KfQ0KDQphc3luYyBmdW5jdGlvbiByZW5kZXJTZXR0aW5ncygpIHsNCiAgY29uc3QgdyA9IGF3YWl0IGFwaSgnL3Byb3ZpZGVycycpOw0KICBjb25zdCBwcm92cyA9IHcucHJvdmlkZXJzIHx8IFtdOw0KICBjb25zdCBsaW1pdHMgPSB3LmxpbWl0cyB8fCB7fTsNCiAgbGV0IHByb3ZSb3dzID0gcHJvdnMubWFwKChwLCBpKSA9PiB7DQogICAgY29uc3QgaXNEZWZhdWx0ID0gWydncm9xJywnZ29vZ2xlJywnbWlzdHJhbCcsJ29wZW5yb3V0ZXInLCdkZWVwc2VlaycsJ3RvZ2V0aGVyJ10uaW5jbHVkZXMocC5uYW1lKTsNCiAgICByZXR1cm4gJzx0cj48dGQ+JyArIGVzYyhwLm5hbWUpICsgKGlzRGVmYXVsdCA/ICcgPHNwYW4gc3R5bGU9ImNvbG9yOiM3NDg4YTg7Zm9udC1zaXplOjEwcHgiPmRlZmF1bHQ8L3NwYW4+JyA6ICcnKSArICc8L3RkPicgKw0KICAgICAgJzx0ZCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izk0YTNiOCI+JyArIGVzYyhwLmJhc2VVcmwpICsgJzwvdGQ+JyArDQogICAgICAnPHRkPjxzcGFuIGNsYXNzPSJ0YWcgJyArIChwLnR5cGU9PT0nZ29vZ2xlJz8nd2FybmluZyc6J29rJykgKyAnIj4nICsgZXNjKHAudHlwZSkgKyAnPC9zcGFuPjwvdGQ+JyArDQogICAgICAnPHRkIHN0eWxlPSJmb250LXNpemU6MTFweDtjb2xvcjojOTRhM2I4O21heC13aWR0aDoxNjBweDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpcyI+JyArIGVzYygocC5tb2RlbHN8fFtdKS5zbGljZSgwLDMpLmpvaW4oJywgJykpICsgJzwvdGQ+JyArDQogICAgICAoaXNEZWZhdWx0ID8gJzx0ZD48L3RkPicgOiAnPHRkPjxidXR0b24gY2xhc3M9ImRhbmdlciIgb25jbGljaz0iZGVsZXRlUHJvdmlkZXIoXCcnICsgZXNjKHAubmFtZSkgKyAnXCcpIiBzdHlsZT0icGFkZGluZzo0cHggOHB4O2ZvbnQtc2l6ZToxMXB4Ij5SZW1vdmU8L2J1dHRvbj48L3RkPicpICsgJzwvdHI+JzsNCiAgfSkuam9pbignJyk7DQogIGxldCBsaW1Sb3dzID0gT2JqZWN0LmVudHJpZXMobGltaXRzKS5tYXAoKFtrLCB2XSkgPT4gJzx0cj48dGQ+JyArIGVzYyhrKSArICc8L3RkPjx0ZD48aW5wdXQgaWQ9ImxpbS1kcmVxLScgKyBlc2MoaykgKyAnIiB0eXBlPSJudW1iZXIiIHZhbHVlPSInICsgKHYuZGFpbHlSZXF1ZXN0c3x8OTk5OTk5KSArICciIHN0eWxlPSJ3aWR0aDoxMDBweDtwYWRkaW5nOjZweCA4cHg7Zm9udC1zaXplOjEycHgiPicgKw0KICAgICc8L3RkPjx0ZD48aW5wdXQgaWQ9ImxpbS1kdG9rLScgKyBlc2MoaykgKyAnIiB0eXBlPSJudW1iZXIiIHZhbHVlPSInICsgKHYuZGFpbHlUb2tlbnN8fDk5OTk5OTk5OSkgKyAnIiBzdHlsZT0id2lkdGg6MTIwcHg7cGFkZGluZzo2cHggOHB4O2ZvbnQtc2l6ZToxMnB4Ij4nICsNCiAgICAnPC90ZD48dGQ+PGlucHV0IGlkPSJsaW0tbWNvc3QtJyArIGVzYyhrKSArICciIHR5cGU9Im51bWJlciIgdmFsdWU9IicgKyAodi5tb250aGx5Q29zdFVTRHx8MCkgKyAnIiBzdHlsZT0id2lkdGg6MTAwcHg7cGFkZGluZzo2cHggOHB4O2ZvbnQtc2l6ZToxMnB4Ij48L3RkPjwvdHI+Jykuam9pbignJyk7DQogIHNldENvbnRlbnQoYA0KICAgIDxoMj5TZXR0aW5nczwvaDI+DQogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Db25maWd1cmUgY3VzdG9tIHByb3ZpZGVycyAoT3BlbkFJLWNvbXBhdGlibGUgb3IgR29vZ2xlLXN0eWxlKSB3aXRoIHRoZWlyIGJhc2UgVVJMcyBhbmQgbW9kZWwgbGlzdHMuIFNldCBkYWlseSByZXF1ZXN0L3Rva2VuIGxpbWl0cyBwZXIgcHJvdmlkZXIgZm9yIHVzYWdlIHRyYWNraW5nIGFuZCBxdW90YSBlbmZvcmNlbWVudC48L2Rpdj4NCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+Q3VzdG9tIFByb3ZpZGVyczwvaDI+DQogICAgPHAgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5NGEzYjg7bWFyZ2luLWJvdHRvbToxMnB4Ij5BZGQgT3BlbkFJLWNvbXBhdGlibGUgb3IgR29vZ2xlLXN0eWxlIHByb3ZpZGVycy4gVGhleSBhdXRvLXJlZ2lzdGVyIGluIHRoZSBtb2RlbCBsaXN0LCBwcm94eSwgYW5kIHJvdXRpbmcuPC9wPg0KICAgIDxkaXYgY2xhc3M9ImZvcm0tcm93Ij4NCiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5OYW1lPC9sYWJlbD48aW5wdXQgaWQ9ImNwLW5hbWUiIHBsYWNlaG9sZGVyPSJhbnRocm9waWMiPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPkJhc2UgVVJMPC9sYWJlbD48aW5wdXQgaWQ9ImNwLXVybCIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vYXBpLmFudGhyb3BpYy5jb20iPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPlR5cGU8L2xhYmVsPjxzZWxlY3QgaWQ9ImNwLXR5cGUiPjxvcHRpb24+b3BlbmFpPC9vcHRpb24+PG9wdGlvbj5nb29nbGU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5Nb2RlbHMgKGNvbW1hLXNlcCk8L2xhYmVsPjxpbnB1dCBpZD0iY3AtbW9kZWxzIiBwbGFjZWhvbGRlcj0iY2xhdWRlLTMtb3B1cyxjbGF1ZGUtMy1zb25uZXQiPjwvZGl2Pg0KICAgICAgPGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0iYWRkUHJvdmlkZXIoKSI+QWRkIFByb3ZpZGVyPC9idXR0b24+DQogICAgPC9kaXY+DQogICAgPHRhYmxlPjx0aGVhZD48dHI+PHRoPlByb3ZpZGVyPC90aD48dGg+QmFzZSBVUkw8L3RoPjx0aD5UeXBlPC90aD48dGg+TW9kZWxzPC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PiR7cHJvdlJvd3N9PC90Ym9keT48L3RhYmxlPg0KDQogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjMycHgiPlByb3ZpZGVyIExpbWl0czwvaDI+DQogICAgPHAgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5NGEzYjg7bWFyZ2luLWJvdHRvbTo4cHgiPlNldCBkYWlseSByZXF1ZXN0L3Rva2VuIGxpbWl0cyBwZXIgcHJvdmlkZXIgZm9yIHVzYWdlIHRyYWNraW5nPC9wPg0KICAgIDx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Qcm92aWRlcjwvdGg+PHRoPkRhaWx5IFJlcXVlc3RzPC90aD48dGg+RGFpbHkgVG9rZW5zPC90aD48dGg+TW9udGhseSBDb3N0ICQ8L3RoPjwvdHI+PC90aGVhZD48dGJvZHk+JHtsaW1Sb3dzfTwvdGJvZHk+PC90YWJsZT4NCiAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJzYXZlTGltaXRzKCkiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPlNhdmUgTGltaXRzPC9idXR0b24+DQogIGApOw0KfQ0KYXN5bmMgZnVuY3Rpb24gYWRkUHJvdmlkZXIoKSB7DQogIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3AtbmFtZScpLnZhbHVlLnRyaW0oKTsNCiAgY29uc3QgYmFzZVVybCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjcC11cmwnKS52YWx1ZS50cmltKCk7DQogIGNvbnN0IHR5cGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3AtdHlwZScpLnZhbHVlOw0KICBjb25zdCBtb2RlbHNSYXcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3AtbW9kZWxzJykudmFsdWUudHJpbSgpOw0KICBpZiAoIW5hbWUgfHwgIWJhc2VVcmwpIHsgc2hvd1RvYXN0KCdOYW1lIGFuZCBCYXNlIFVSTCByZXF1aXJlZCcsICdlcnJvcicpOyByZXR1cm47IH0NCiAgY29uc3QgbW9kZWxzID0gbW9kZWxzUmF3ID8gbW9kZWxzUmF3LnNwbGl0KCcsJykubWFwKHMgPT4gcy50cmltKCkpLmZpbHRlcihCb29sZWFuKSA6IFtdOw0KICBhd2FpdCBhcGkoJy9wcm92aWRlcnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG5hbWUsIGJhc2VVcmwsIHR5cGUsIG1vZGVscyB9KSB9KTsNCiAgc2hvd1RvYXN0KCdQcm92aWRlciAnICsgbmFtZSArICcgYWRkZWQnLCAnc3VjY2VzcycpOyByZW5kZXJTZXR0aW5ncygpOw0KfQ0KYXN5bmMgZnVuY3Rpb24gZGVsZXRlUHJvdmlkZXIobmFtZSkgew0KICBpZiAoIWNvbmZpcm0oJ1JlbW92ZSBwcm92aWRlciAiJyArIG5hbWUgKyAnIj8nKSkgcmV0dXJuOw0KICBhd2FpdCBhcGkoJy9wcm92aWRlcnM/bmFtZT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7DQogIHNob3dUb2FzdCgnUHJvdmlkZXIgcmVtb3ZlZCcsICdzdWNjZXNzJyk7IHJlbmRlclNldHRpbmdzKCk7DQp9DQphc3luYyBmdW5jdGlvbiBzYXZlTGltaXRzKCkgew0KICBjb25zdCBkID0gYXdhaXQgYXBpKCcvcHJvdmlkZXJzJyk7DQogIGNvbnN0IGxpbWl0cyA9IHt9Ow0KICBmb3IgKGNvbnN0IHBuYW1lIG9mIE9iamVjdC5rZXlzKGQubGltaXRzIHx8IHt9KSkgew0KICAgIGNvbnN0IGRyZXEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbGltLWRyZXEtJyArIHBuYW1lKT8udmFsdWU7DQogICAgY29uc3QgZHRvayA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsaW0tZHRvay0nICsgcG5hbWUpPy52YWx1ZTsNCiAgICBjb25zdCBtY29zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsaW0tbWNvc3QtJyArIHBuYW1lKT8udmFsdWU7DQogICAgaWYgKGRyZXEpIGxpbWl0c1twbmFtZV0gPSB7IGRhaWx5UmVxdWVzdHM6IHBhcnNlSW50KGRyZXEpIHx8IDk5OTk5OSwgZGFpbHlUb2tlbnM6IHBhcnNlSW50KGR0b2spIHx8IDk5OTk5OTk5OSwgbW9udGhseUNvc3RVU0Q6IHBhcnNlRmxvYXQobWNvc3QpIHx8IDAgfTsNCiAgfQ0KICBhd2FpdCBhcGkoJy9wcm92aWRlcnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFjdGlvbjogJ3NldC1saW1pdHMnLCBsaW1pdHMgfSkgfSk7DQogIHNob3dUb2FzdCgnTGltaXRzIHNhdmVkJywgJ3N1Y2Nlc3MnKTsgcmVuZGVyU2V0dGluZ3MoKTsNCn0NCmFzeW5jIGZ1bmN0aW9uIHJlbmRlckhlYWx0aCgpIHsNCiAgc2V0Q29udGVudCgnPGgyPkhlYWx0aCBDaGVjazwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Qcm9iZSBlYWNoIHByb3ZpZGVyIGtleSB0byB2ZXJpZnkgY29ubmVjdGl2aXR5IGFuZCBhdXRoZW50aWNhdGlvbi4gU2hvd3MgSFRUUCBzdGF0dXMsIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSwgYW5kIGFueSBlcnJvciBtZXNzYWdlcyByZXR1cm5lZCBieSB0aGUgdXBzdHJlYW0gQVBJLjwvZGl2PjxwPlJ1bm5pbmcgaGVhbHRoIGNoZWNrcy4uLjwvcD4nKTsNCiAgY29uc3QgaCA9IGF3YWl0IGFwaSgnL2hlYWx0aC1jaGVjaycpOw0KICBsZXQgY2FyZHMgPSAnJzsNCiAgZm9yKGNvbnN0IGl0ZW0gb2YgaCkgew0KICAgIGNvbnN0IG9rID0gaXRlbS5zdGF0dXMgPT09ICdvaycgPyAnb2snIDogJ2ZhaWwnOw0KICAgIGNhcmRzICs9ICc8ZGl2IGNsYXNzPSJjYXJkIj48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbTo2cHgiPicgKyBlc2MoaXRlbS5wcm92aWRlcnx8JycpICsgJyAvICcgKyBlc2MoKGl0ZW0ua2V5SWR8fCcnKS5zbGljZSgwLDgpKSArICc8L2gzPicgKw0KICAgICAgJzxwPjxzcGFuIGNsYXNzPSJ0YWcgJyArIG9rICsgJyI+JyArIGVzYyhpdGVtLnN0YXR1c3x8Jz8nKSArICc8L3NwYW4+PC9wPicgKw0KICAgICAgJzxwIHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4Ij5IVFRQOiAnICsgKGl0ZW0uaHR0cFN0YXR1c3x8J8ODwqLDouKAmsKsw6LigqzCnScpICsgJyB8IENCOiAnICsgZXNjKGl0ZW0uY2JTdGF0ZXx8J8ODwqLDouKAmsKsw6LigqzCnScpICsgJzwvcD4nICsNCiAgICAgIChpdGVtLmVycm9yID8gJzxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NHB4Ij4nICsgZXNjKGl0ZW0uZXJyb3IpICsgJzwvcHJlPicgOiAnJykgKyAnPC9kaXY+JzsNCiAgfQ0KICBzZXRDb250ZW50KCc8aDI+SGVhbHRoIENoZWNrPC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlByb2JlIGVhY2ggcHJvdmlkZXIga2V5IHRvIHZlcmlmeSBjb25uZWN0aXZpdHkgYW5kIGF1dGhlbnRpY2F0aW9uLiBTaG93cyBIVFRQIHN0YXR1cywgY2lyY3VpdC1icmVha2VyIHN0YXRlLCBhbmQgYW55IGVycm9yIG1lc3NhZ2VzIHJldHVybmVkIGJ5IHRoZSB1cHN0cmVhbSBBUEkuPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiPicgKyAoY2FyZHMgfHwgJzxwPk5vIHJlc3VsdHM8L3A+JykgKyAnPC9kaXY+Jyk7DQp9DQphc3luYyBmdW5jdGlvbiByZW5kZXJTZXR1cCgpIHsNCiAgc2V0Q29udGVudChgDQogICAgPGgyPlNldHVwIEd1aWRlPC9oMj4NCiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlN0ZXAtYnktc3RlcCBndWlkZSBmb3IgY29ubmVjdGluZyBjbGllbnRzIHRvIHRoZSBnYXRld2F5LiBHZW5lcmF0ZSBhIEdhdGV3YXkgS2V5LCB0aGVuIHVzZSBpdCBhcyB0aGUgQmVhcmVyIHRva2VuIHdpdGggYW55IE9wZW5BSS1jb21wYXRpYmxlIGNsaWVudC4gU3VwcG9ydHMgY2hhdCBjb21wbGV0aW9ucywgZW1iZWRkaW5ncywgYW5kIEFudGhyb3BpYy1zdHlsZSBtZXNzYWdlcy48L2Rpdj4NCiAgICA8aDI+WW91ciBHYXRld2F5IFVSTDwvaDI+DQogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjE0cHgiPlBPU1QgaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zDQpBdXRob3JpemF0aW9uOiBCZWFyZXIgJmx0O3lvdXItZ2F0ZXdheS1rZXkmZ3Q7PC9wcmU+DQoNCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+R2VuZXJhdGUgYSBHYXRld2F5IEtleTwvaDI+DQogICAgPHAgc3R5bGU9ImZvbnQtc2l6ZToxNHB4O2NvbG9yOiM5NGEzYjgiPkdvIHRvIDxiPkdhdGV3YXkgS2V5czwvYj4gdGFiIGFuZCBjbGljayA8Yj5HZW5lcmF0ZSBLZXk8L2I+IHRvIGNyZWF0ZSBhIHJhbmRvbSB0b2tlbiwgb3IgZW50ZXIgeW91ciBvd24gd29yZC4gVXNlIHRoYXQga2V5IGFzIHRoZSBCZWFyZXIgdG9rZW4gaW4geW91ciBhcHBzLjwvcD4NCg0KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBjVVJMPC9oMj4NCiAgICA8cHJlIHN0eWxlPSJmb250LXNpemU6MTNweCI+Y3VybCAtWCBQT1NUIGh0dHBzOi8vYnVkZGhpLWR3YXIueW91ci1kb21haW4ud29ya2Vycy5kZXYvdjEvY2hhdC9jb21wbGV0aW9ucyBcXA0KICAtSCAiQXV0aG9yaXphdGlvbjogQmVhcmVyIFlPVVJfR0FURVdBWV9LRVkiIFxcDQogIC1IICJDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24iIFxcDQogIC1kICd7Im1vZGVsIjoiZ3B0LTRvIiwibWVzc2FnZXMiOlt7InJvbGUiOiJ1c2VyIiwiY29udGVudCI6ImhlbGxvIn1dfSc8L3ByZT4NCg0KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBKYXZhU2NyaXB0IChmZXRjaCk8L2gyPg0KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5jb25zdCByZXNwID0gYXdhaXQgZmV0Y2goImh0dHBzOi8vYnVkZGhpLWR3YXIueW91ci1kb21haW4ud29ya2Vycy5kZXYvdjEvY2hhdC9jb21wbGV0aW9ucyIsIHsNCiAgbWV0aG9kOiAiUE9TVCIsDQogIGhlYWRlcnM6IHsgIkF1dGhvcml6YXRpb24iOiAiQmVhcmVyIFlPVVJfR0FURVdBWV9LRVkiLCAiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24iIH0sDQogIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbW9kZWw6ICJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTQiLCBtZXNzYWdlczogW3sgcm9sZTogInVzZXIiLCBjb250ZW50OiAiaGkiIH1dIH0pDQp9KTsNCmNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTs8L3ByZT4NCg0KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBQeXRob248L2gyPg0KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5pbXBvcnQgcmVxdWVzdHMNCnJlc3AgPSByZXF1ZXN0cy5wb3N0KA0KICAgICJodHRwczovL2J1ZGRoaS1kd2FyLnlvdXItZG9tYWluLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnMiLA0KICAgIGhlYWRlcnM9eyJBdXRob3JpemF0aW9uIjogIkJlYXJlciBZT1VSX0dBVEVXQVlfS0VZIn0sDQogICAganNvbj17Im1vZGVsIjogImdwdC00byIsICJtZXNzYWdlcyI6IFt7InJvbGUiOiAidXNlciIsICJjb250ZW50IjogImhlbGxvIn1dfQ0KKQ0KcHJpbnQocmVzcC5qc29uKCkpPC9wcmU+DQoNCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+V2ViaG9vayBOb3RpZmljYXRpb25zPC9oMj4NCiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+U2V0IDxjb2RlIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5XRUJIT09LX1VSTDwvY29kZT4gaW4geW91ciBDbG91ZGZsYXJlIFdvcmtlciBlbnZpcm9ubWVudCB2YXJpYWJsZXMgKGUuZy4gU2xhY2sgd2ViaG9vayBVUkwpLiBUaGUgZ2F0ZXdheSB3aWxsIFBPU1QgSlNPTiBhbGVydHMgZm9yIGF1dGggZmFpbHVyZXMgYW5kIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSBjaGFuZ2VzLjwvcD4NCiAgICA8cHJlIHN0eWxlPSJmb250LXNpemU6MTNweCI+RXhhbXBsZSBwYXlsb2FkOg0KUE9TVCAmbHQ7V0VCSE9PS19VUkwmZ3Q7DQp7ImV2ZW50IjoiYXV0aF9mYWlsdXJlIiwicHJvdmlkZXIiOiJvcGVuYWkiLCJrZXlJZCI6InNrLS4uLiIsInN0YXR1cyI6NDAxfTwvcHJlPg0KDQogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPkFETUlOX1BBU1NXT1JEIChFbnZpcm9ubWVudCBWYXJpYWJsZSk8L2gyPg0KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5TZXQgPGNvZGUgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPkFETUlOX1BBU1NXT1JEPC9jb2RlPiBpbiB5b3VyIENsb3VkZmxhcmUgV29ya2VyIGVudiB2YXJzIHRvIG92ZXJyaWRlIHRoZSBkZWZhdWx0IGFkbWluIHBhc3N3b3JkICg8Y29kZT4yMjAwPC9jb2RlPikuPC9wPg0KDQogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPlN1cHBvcnRlZCBNb2RlbHM8L2gyPg0KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5GcmVlLXRpZXIgbW9kZWxzOiA8Yj5Hcm9xPC9iPiAobGxhbWEtMy4zLTcwYi12ZXJzYXRpbGUpLCA8Yj5Hb29nbGU8L2I+IChnZW1pbmktMi4wLWZsYXNoKSwgPGI+TWlzdHJhbDwvYj4gKG1pc3RyYWwtc21hbGwtbGF0ZXN0KSwgPGI+T3BlblJvdXRlcjwvYj4gKGZyZWUgbW9kZWxzKS48L3A+DQogICAgPHAgc3R5bGU9ImZvbnQtc2l6ZToxNHB4O2NvbG9yOiM5NGEzYjgiPkZpcnN0IGFkZCB5b3VyIHByb3ZpZGVyIEFQSSBrZXlzIGluIHRoZSA8Yj5BUEkgS2V5czwvYj4gdGFiLCB0aGVuIGdlbmVyYXRlIGEgR2F0ZXdheSBLZXkgaW4gdGhlIDxiPkdhdGV3YXkgS2V5czwvYj4gdGFiLjwvcD4NCiAgYCk7DQp9DQo8L3NjcmlwdD4NCjwvYm9keT4NCjwvaHRtbD4NCg==";

const ADMIN_PAGE = atob(ADMIN_PAGE_B64);


/* â”€â”€ Hono App â”€â”€ */
const app = new Hono();

app.post("/v1/chat/completions", async (c) => handleProxy(c.req.raw));
app.post("/chat/completions", async (c) => handleProxy(c.req.raw));
app.post("/v1/embeddings", async (c) => handleEmbeddings(c.req.raw));
app.post("/v1/messages", async (c) => handleAnthropic(c.req.raw));
app.get("/v1/models", async (c) => handleModels());
app.get("/models", async (c) => handleModels());

app.post("/admin/api/login", async (c) => {
  const ip = c.req.raw.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await checkLoginRate(ip))) return c.json({ error: "too many attempts, try later" }, 429);
  let password = "";
  const ct = c.req.raw.headers.get("Content-Type") || "";
  if (ct.includes("json")) {
    try { const j = await c.req.raw.json() as any; password = j.password || ""; } catch {}
  } else {
    try { const fd = await c.req.raw.formData(); password = fd.get("password") as string || ""; } catch {}
  }
  if (password === _ADMIN_PW) {
    const redirect = new URL(c.req.raw.url).searchParams.get("redirect") || "/admin";
    return new Response("", { status: 302, headers: { Location: redirect, "Set-Cookie": "bfadmin=" + _ADMIN_PW + "; path=/; SameSite=Lax", "Cache-Control": "no-cache" } });
  }
  await recordLoginAttempt(ip);
  const redirect = new URL(c.req.raw.url).searchParams.get("redirect") || "/admin";
  return new Response("", { status: 302, headers: { Location: redirect + "?error=1", "Cache-Control": "no-cache" } });
});

app.get("/admin", async (c) => {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  if (cookie.includes("bfadmin=" + _ADMIN_PW)) {
    return new Response(ADMIN_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
  }
  const err = new URL(c.req.raw.url).searchParams.get("error") || "";
  let body = LOGIN_PAGE;
  if (err === "1") body = body.replace('id="login-err"', 'id="login-err" style="display:block"');
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
});
app.get("/admin/", async (c) => c.redirect("/admin"));
app.all("/admin/api/*", async (c) => handleAdminApi(c.req.raw, new URL(c.req.raw.url).pathname));

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


