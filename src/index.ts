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
  { name: "cerebras", baseUrl: "https://api.cerebras.ai/v1", type: "openai", models: ["llama3.1-8b", "llama-3.3-70b"] },
  { name: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", type: "openai", models: ["qwen-turbo", "qwen-plus"] },
  { name: "ai21", baseUrl: "https://api.ai21.com/studio/v1", type: "openai", models: ["jamba-1.5-mini", "jamba-1.5-large"] },
  { name: "huggingface", baseUrl: "https://api-inference.huggingface.co/v1", type: "openai", models: ["HuggingFaceH4/zephyr-7b-beta", "microsoft/Phi-3.5-mini-instruct"] },
  { name: "nvidia", baseUrl: "https://api.nvcf.nvidia.com/v1", type: "openai", models: ["meta/llama-3.1-8b-instruct"] },
  { name: "cohere", baseUrl: "https://api.cohere.ai/v1", type: "openai", models: ["command-r-plus", "command-r"] },
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

async function handleImageGen(req: Request): Promise<Response> {
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
      const resp = await fetch(p.baseUrl + "/v1/images/generations", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ke.apiKey }, body: JSON.stringify({ ...body, model }) });
      if (resp.ok) return new Response(resp.body, { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      if (resp.status === 429) await setKeyCooling(p.name, ke.id);
    }
    return new Response(JSON.stringify({ error: "no provider available for image model: " + model }), { status: 502, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "image gen error: " + e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

async function handleVideoGen(req: Request): Promise<Response> {
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
      const resp = await fetch(p.baseUrl + "/v1/video/generations", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ke.apiKey }, body: JSON.stringify({ ...body, model }) });
      if (resp.ok) return new Response(resp.body, { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      if (resp.status === 429) await setKeyCooling(p.name, ke.id);
    }
    return new Response(JSON.stringify({ error: "no provider available for video model: " + model }), { status: 502, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "video gen error: " + e.message }), { status: 500, headers: { "content-type": "application/json" } });
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
      const embedPath = p.name === "cohere" ? "/v1/embed" : "/v1/embeddings";
      const resp = await fetch(p.baseUrl + embedPath, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ke.apiKey }, body: JSON.stringify({ ...body, model }) });
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
          results.push({ provider: p.name, keyId: k.id, label: k.label, model: k.models?.[0] || p.models?.[0] || '', status: resp.ok ? "ok" : "fail", httpStatus: resp.status, cbState: h.cbState });
        } catch (e: any) {
          results.push({ provider: p.name, keyId: k.id, label: k.label, model: k.models?.[0] || p.models?.[0] || '', status: "error", error: e.message, cbState: h.cbState });
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

  if (path === "/admin/api/keys-health") {
    const result: any = {};
    for (const p of await getAllProviders()) {
      result[p.name] = {};
      const keys = await getKeys(p.name);
      for (const k of keys) {
        const h = await getHealth(p.name, k.id);
        const cooling = await isKeyCooling(p.name, k.id);
        result[p.name][k.id] = { status: h.status, cbState: h.cbState, cooling, lastError: h.lastError, lastUsed: h.lastUsed };
      }
    }
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
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
const ADMIN_PAGE_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEuMCI+Cjx0aXRsZT5CdWRkaGkgRHdhciBBZG1pbjwvdGl0bGU+CjxzdHlsZT4KKnttYXJnaW46MDtwYWRkaW5nOjA7Ym94LXNpemluZzpib3JkZXItYm94O2ZvbnQtZmFtaWx5OidJbnRlcicsc3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sc2Fucy1zZXJpZn0KYm9keXtkaXNwbGF5OmZsZXg7bWluLWhlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzBhMGUxYSAwJSwjMGYxNjI5IDQwJSwjMTIxYjMzIDEwMCUpO2NvbG9yOiNlMmU4ZjB9Ci5zaWRlYmFye3dpZHRoOjI0MHB4O2JhY2tncm91bmQ6cmdiYSgxNywyNCwzOSwuODUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO3BhZGRpbmc6MjRweCAwO2JvcmRlci1yaWdodDoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4xKTtmbGV4LXNocmluazowO2hlaWdodDoxMDB2aDtwb3NpdGlvbjpzdGlja3k7dG9wOjA7b3ZlcmZsb3cteTphdXRvfQouc2lkZWJhciBoMXtmb250LXNpemU6MjJweDtmb250LXdlaWdodDo4MDA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMzOGJkZjgsIzgxOGNmOCk7LXdlYmtpdC1iYWNrZ3JvdW5kLWNsaXA6dGV4dDstd2Via2l0LXRleHQtZmlsbC1jb2xvcjp0cmFuc3BhcmVudDtwYWRkaW5nOjAgMjBweCAyNHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMSk7bWFyZ2luLWJvdHRvbToxMnB4O2xldHRlci1zcGFjaW5nOi0uNXB4fQouc2lkZWJhciBhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHg7cGFkZGluZzoxMXB4IDIwcHg7Y29sb3I6Izg4OTliNDt0ZXh0LWRlY29yYXRpb246bm9uZTtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo1MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjJzO21hcmdpbjoycHggOHB4O2JvcmRlci1yYWRpdXM6MTBweH0KLnNpZGViYXIgYTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDgpO2NvbG9yOiNlMmU4ZjB9Ci5zaWRlYmFyIGEuYWN0aXZle2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU2LDE4OSwyNDgsLjEyKSxyZ2JhKDEyOSwxNDAsMjQ4LC4wOCkpO2NvbG9yOiMzOGJkZjg7Ym94LXNoYWRvdzppbnNldCAycHggMCAwICMzOGJkZjh9Ci5tYWlue2ZsZXg6MTtwYWRkaW5nOjMycHg7bWF4LXdpZHRoOjEyMDBweH1zZWN0aW9ue2Rpc3BsYXk6bm9uZX1zZWN0aW9uLmFjdGl2ZXtkaXNwbGF5OmJsb2NrfQpoMntmb250LXNpemU6MjJweDtmb250LXdlaWdodDo3MDA7Y29sb3I6I2YxZjVmOTttYXJnaW4tYm90dG9tOjIwcHg7cGFkZGluZy1ib3R0b206MTBweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtsZXR0ZXItc3BhY2luZzotLjNweH0KLmNhcmRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZml0LG1pbm1heCgyMDBweCwxZnIpKTtnYXA6MTRweDttYXJnaW4tYm90dG9tOjI4cHh9Ci5jYXJke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDMwLDQxLDU5LC42KSxyZ2JhKDMwLDQxLDU5LC4zKSk7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MjBweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMDgpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDhweCk7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzLGJvcmRlci1jb2xvciAuMnN9Ci5jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjpyZ2JhKDU2LDE4OSwyNDgsLjIpfQouY2FyZCAubnVte2ZvbnQtc2l6ZTozMHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjojMzhiZGY4O2xldHRlci1zcGFjaW5nOi0uNXB4fQouY2FyZCAubGJse2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLXRvcDo2cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi44cHg7Zm9udC13ZWlnaHQ6NjAwfQp0YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtmb250LXNpemU6MTRweDttYXJnaW4tYm90dG9tOjE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRlbn0KdGh7Y29sb3I6Izc0ODhhODtmb250LXdlaWdodDo2MDA7cGFkZGluZzoxNHB4IDEycHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wOCk7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouOHB4O2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNCl9CnRke3BhZGRpbmc6MTJweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDMwLDQxLDU5LC40KTtjb2xvcjojZTJlOGYwfQp0cjpob3ZlciB0ZHtiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDMpfQppbnB1dCxzZWxlY3R7cGFkZGluZzoxMXB4IDE0cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg3MSw4NSwxMDUsLjQpO2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNik7Y29sb3I6I2UyZThmMDtmb250LXNpemU6MTRweDt3aWR0aDoxMDAlO21heC13aWR0aDo0MDBweDttYXJnaW46NHB4IDA7b3V0bGluZTpub25lO3RyYW5zaXRpb246YWxsIC4yc30KaW5wdXQ6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojMzhiZGY4O2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoNTYsMTg5LDI0OCwuMTIpfQpidXR0b257cGFkZGluZzoxMXB4IDIycHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25lO2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjttYXJnaW46NHB4IDRweCA0cHggMDt0cmFuc2l0aW9uOmFsbCAuMnM7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVufQpidXR0b246YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTcpfQpidXR0b24ucHJpbWFyeXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzM4YmRmOCwjNjM2NmYxKTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDU2LDE4OSwyNDgsLjIpfWJ1dHRvbi5wcmltYXJ5OmhvdmVye2JveC1zaGFkb3c6MCA0cHggMjBweCByZ2JhKDU2LDE4OSwyNDgsLjM1KX0KYnV0dG9uLmRhbmdlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsI2VmNDQ0NCwjZGMyNjI2KTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDIzOSw2OCw2OCwuMil9YnV0dG9uLmRhbmdlcjpob3Zlcntib3gtc2hhZG93OjAgNHB4IDIwcHggcmdiYSgyMzksNjgsNjgsLjM1KX0KYnV0dG9uLnNlY29uZGFyeXtiYWNrZ3JvdW5kOnJnYmEoNTEsNjUsODUsLjUpO2NvbG9yOiNlMmU4ZjA7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDcxLDg1LDEwNSwuMyl9YnV0dG9uLnNlY29uZGFyeTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTEsNjUsODUsLjgpfQpwcmV7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC42KTtwYWRkaW5nOjE4cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmF1dG87Zm9udC1zaXplOjEzcHg7bWF4LWhlaWdodDo1MDBweDtsaW5lLWhlaWdodDoxLjY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtmb250LWZhbWlseTonRmlyYSBDb2RlJywnQ29uc29sYXMnLG1vbm9zcGFjZX0KLnRhZ3tkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjNweCAxMnB4O2JvcmRlci1yYWRpdXM6MjBweDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7bGV0dGVyLXNwYWNpbmc6LjNweH0KLnRhZy5va3tiYWNrZ3JvdW5kOnJnYmEoMjIsMTYzLDc0LC4xNSk7Y29sb3I6Izg2ZWZhYztib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjIsMTYzLDc0LC4zKX0KLnRhZy5mYWlse2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjE1KTtjb2xvcjojZmNhNWE1O2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzksNjgsNjgsLjMpfQoudGFnLmFjdGl2ZXtiYWNrZ3JvdW5kOnJnYmEoNTksMTMwLDI0NiwuMTUpO2NvbG9yOiM5M2M1ZmQ7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU5LDEzMCwyNDYsLjMpfQoudGFnLndhcm5pbmd7YmFja2dyb3VuZDpyZ2JhKDIzNCwxNzksOCwuMTUpO2NvbG9yOiNmZGU2OGE7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzNCwxNzksOCwuMyl9Ci50YWcuY2xvc2Vke2JhY2tncm91bmQ6cmdiYSgyMiwxNjMsNzQsLjE1KTtjb2xvcjojODZlZmFjO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMiwxNjMsNzQsLjMpfQoudGFnLm9wZW57YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9Ci50YWcuaGFsZi1vcGVue2JhY2tncm91bmQ6cmdiYSgyMzQsMTc5LDgsLjE1KTtjb2xvcjojZmRlNjhhO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzQsMTc5LDgsLjMpfQouZm9ybS1yb3d7ZGlzcGxheTpmbGV4O2dhcDoxNHB4O2FsaWduLWl0ZW1zOmVuZDtmbGV4LXdyYXA6d3JhcDttYXJnaW4tYm90dG9tOjIwcHh9Ci5mb3JtLXJvdz4qe2ZsZXg6MTttaW4td2lkdGg6MjAwcHh9Ci5mb3JtLXJvdyBidXR0b257ZmxleDowIDAgYXV0b30KLmZvcm0tZ3JvdXAgbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojNzQ4OGE4O21hcmdpbi1ib3R0b206NnB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouOHB4O2ZvbnQtd2VpZ2h0OjYwMH0KLnRvYXN0e3Bvc2l0aW9uOmZpeGVkO3RvcDoyNHB4O3JpZ2h0OjI0cHg7cGFkZGluZzoxNHB4IDI0cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjUwMDt6LWluZGV4OjEwMDA7YW5pbWF0aW9uOnNsaWRlSW4gLjM1cyBjdWJpYy1iZXppZXIoLjE2LDEsLjMsMSk7bWF4LXdpZHRoOjQyMHB4O2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JveC1zaGFkb3c6MCA4cHggMzJweCByZ2JhKDAsMCwwLC40KX0KLnRvYXN0LnN1Y2Nlc3N7YmFja2dyb3VuZDpyZ2JhKDIyLDE2Myw3NCwuMik7Y29sb3I6Izg2ZWZhYztib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjIsMTYzLDc0LC4zKX0KLnRvYXN0LmVycm9ye2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjIpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9CkBrZXlmcmFtZXMgc2xpZGVJbntmcm9te3RyYW5zZm9ybTp0cmFuc2xhdGVYKDEyMCUpIHNjYWxlKC45KTtvcGFjaXR5OjB9dG97dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMCkgc2NhbGUoMSk7b3BhY2l0eToxfX0KQGtleWZyYW1lcyBmYWRlSW57ZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoOHB4KX10b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCl9fQouZ3JpZC0ye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtnYXA6MjBweH0KLmljb3tkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7Ym9yZGVyLXJhZGl1czo2cHg7ZmxleC1zaHJpbms6MDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDB9Ci5pY28tb3ZlcnZpZXd7YmFja2dyb3VuZDpyZ2JhKDU2LDE4OSwyNDgsLjE1KTtjb2xvcjojMzhiZGY4fS5pY28ta2V5c3tiYWNrZ3JvdW5kOnJnYmEoMjQ1LDE1OCwxMSwuMTUpO2NvbG9yOiNmNTllMGJ9Ci5pY28tZ2F0ZXdheXtiYWNrZ3JvdW5kOnJnYmEoMTY3LDEzOSwyNTAsLjE1KTtjb2xvcjojYTc4YmZhfS5pY28tc3RyYXRlZ3l7YmFja2dyb3VuZDpyZ2JhKDUyLDIxMSwxNTMsLjE1KTtjb2xvcjojMzRkMzk5fQouaWNvLWxvZ3N7YmFja2dyb3VuZDpyZ2JhKDI0OCwxMTMsMTEzLC4xNSk7Y29sb3I6I2Y4NzE3MX0uaWNvLWFuYWx5dGljc3tiYWNrZ3JvdW5kOnJnYmEoMjUxLDE0Niw2MCwuMTUpO2NvbG9yOiNmYjkyM2N9Ci5pY28tc2V0dGluZ3N7YmFja2dyb3VuZDpyZ2JhKDE0OCwxNjMsMTg0LC4xNSk7Y29sb3I6I2UyZThmMH0uaWNvLWhlYWx0aHtiYWNrZ3JvdW5kOnJnYmEoMjQ0LDExNCwxODIsLjE1KTtjb2xvcjojZjQ3MmI2fQouaWNvLXNldHVwe2JhY2tncm91bmQ6cmdiYSgzNCwyMTEsMjM4LC4xNSk7Y29sb3I6IzIyZDNlZX0KCiNsb2FkaW5nLWJhcntwb3NpdGlvbjpmaXhlZDt0b3A6MDtsZWZ0OjA7aGVpZ2h0OjNweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZywjMzhiZGY4LCM4MThjZjgsIzM4YmRmOCk7YmFja2dyb3VuZC1zaXplOjIwMCUgMTAwJTt6LWluZGV4Ojk5OTk5O3RyYW5zaXRpb246d2lkdGggLjRzIGN1YmljLWJlemllciguMTYsMSwuMywxKSxvcGFjaXR5IC4zczt3aWR0aDowO29wYWNpdHk6MDtib3JkZXItcmFkaXVzOjAgMnB4IDJweCAwO2JveC1zaGFkb3c6MCAwIDEycHggcmdiYSg1NiwxODksMjQ4LC41KX0KI2xvYWRpbmctYmFyLmFjdGl2ZXtvcGFjaXR5OjF9YnV0dG9uLmxvYWRpbmd7cG9pbnRlci1ldmVudHM6bm9uZTtvcGFjaXR5Oi43O3Bvc2l0aW9uOnJlbGF0aXZlfWJ1dHRvbi5sb2FkaW5nOjphZnRlcntjb250ZW50OicnO3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7Ym9yZGVyLXJhZGl1czppbmhlcml0O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHRyYW5zcGFyZW50LHJnYmEoMjU1LDI1NSwyNTUsLjEpLHRyYW5zcGFyZW50KTtiYWNrZ3JvdW5kLXNpemU6MjAwJSAxMDAlO2FuaW1hdGlvbjpzaGltbWVyIDEuMnMgaW5maW5pdGV9CkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOjIwMCUgMH0xMDAle2JhY2tncm91bmQtcG9zaXRpb246LTIwMCUgMH19Ci5wYWdpbmF0aW9ue2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjEycHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6Izc0ODhhOH0KLnBhZ2luYXRpb24gYnV0dG9ue3BhZGRpbmc6NnB4IDE0cHg7Zm9udC1zaXplOjEycHg7Ym9yZGVyLXJhZGl1czo4cHh9CnN1bW1hcnl7Y29sb3I6IzM4YmRmODtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzo4cHggMDtmb250LXNpemU6MTRweH0KZGV0YWlsc3tiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjMpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjhweCAxNnB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wNik7bWFyZ2luLWJvdHRvbToxNnB4fQoucGFnZS1kZXNje2JhY2tncm91bmQ6cmdiYSg1NiwxODksMjQ4LC4wNik7Ym9yZGVyLWxlZnQ6M3B4IHNvbGlkICMzOGJkZjg7cGFkZGluZzoxMnB4IDE2cHg7Ym9yZGVyLXJhZGl1czowIDEwcHggMTBweCAwO21hcmdpbi1ib3R0b206MjBweDtmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4O2xpbmUtaGVpZ2h0OjEuNn0KLmtleS1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMjgwcHgsMWZyKSk7Z2FwOjE0cHh9Ci5rZXktY2FyZHtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgzMCw0MSw1OSwuNikscmdiYSgzMCw0MSw1OSwuMykpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE2cHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMsYm9yZGVyLWNvbG9yIC4yc30ua2V5LWNhcmQ6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym9yZGVyLWNvbG9yOnJnYmEoNTYsMTg5LDI0OCwuMil9CkBtZWRpYShtYXgtd2lkdGg6NzY4cHgpey5zaWRlYmFye3dpZHRoOjYwcHg7cGFkZGluZzoxNnB4IDB9LnNpZGViYXIgaDEsLnNpZGViYXIgYSBzcGFuOmxhc3QtY2hpbGR7ZGlzcGxheTpub25lfS5zaWRlYmFyIGF7anVzdGlmeS1jb250ZW50OmNlbnRlcjtwYWRkaW5nOjExcHggMDttYXJnaW46MnB4IDZweH0ubWFpbntwYWRkaW5nOjIwcHh9LmdyaWQtMntncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfX0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7LnNpZGViYXJ7d2lkdGg6NDhweH0ubWFpbntwYWRkaW5nOjE2cHh9LmNhcmRze2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBpZD0ibG9hZGluZy1iYXIiPjwvZGl2Pgo8ZGl2IGNsYXNzPSJzaWRlYmFyIj4KPGgxPkJ1ZGRoaSBEd2FyPC9oMT4KPGEgb25jbGljaz0ic2hvd1RhYignb3ZlcnZpZXcnKSIgaWQ9Im5hdi1vdmVydmlldyIgY2xhc3M9ImFjdGl2ZSI+PHNwYW4gY2xhc3M9ImljbyBpY28tb3ZlcnZpZXciPiYjOTY3OTs8L3NwYW4+PHNwYW4+T3ZlcnZpZXc8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdrZXlzJykiIGlkPSJuYXYta2V5cyI+PHNwYW4gY2xhc3M9ImljbyBpY28ta2V5cyI+JiM5ODgxOzwvc3Bhbj48c3Bhbj5BUEkgS2V5czwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ2dhdGV3YXknKSIgaWQ9Im5hdi1nYXRld2F5Ij48c3BhbiBjbGFzcz0iaWNvIGljby1nYXRld2F5Ij4mIzEyODI3NDs8L3NwYW4+PHNwYW4+R2F0ZXdheSBLZXlzPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ic2hvd1RhYignc3RyYXRlZ3knKSIgaWQ9Im5hdi1zdHJhdGVneSI+PHNwYW4gY2xhc3M9ImljbyBpY28tc3RyYXRlZ3kiPiYjODY0NDs8L3NwYW4+PHNwYW4+U3RyYXRlZ3k8L3NwYW4+PC9hPgo8IS0tIGxvZ3MgYW5kIHJlcS1sb2dzIHJlbW92ZWQgKEtWIHNwYWNlKSAtLT4KPGEgb25jbGljaz0ic2hvd1RhYignYW5hbHl0aWNzJykiIGlkPSJuYXYtYW5hbHl0aWNzIj48c3BhbiBjbGFzcz0iaWNvIGljby1hbmFseXRpY3MiPiYjMTI4MjAwOzwvc3Bhbj48c3Bhbj5BbmFseXRpY3M8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCd1c2FnZScpIiBpZD0ibmF2LXVzYWdlIj48c3BhbiBjbGFzcz0iaWNvIGljby1vdmVydmlldyI+JiMxMjgyMDA7PC9zcGFuPjxzcGFuPlVzYWdlPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ic2hvd1RhYignaGVhbHRoJykiIGlkPSJuYXYtaGVhbHRoIj48c3BhbiBjbGFzcz0iaWNvIGljby1oZWFsdGgiPiYjMTAwMDM7PC9zcGFuPjxzcGFuPkhlYWx0aCBDaGVjazwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ3NldHVwJykiIGlkPSJuYXYtc2V0dXAiPjxzcGFuIGNsYXNzPSJpY28gaWNvLXNldHVwIj4mIzg1MDU7PC9zcGFuPjxzcGFuPlNldHVwPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ibG9nb3V0KCkiIHN0eWxlPSJtYXJnaW4tdG9wOmF1dG87Y29sb3I6I2Y4NzE3MSI+PHNwYW4gY2xhc3M9ImljbyIgc3R5bGU9ImJhY2tncm91bmQ6cmdiYSgyNDgsMTEzLDExMywuMTUpO2NvbG9yOiNmODcxNzEiPiYjODU5NDs8L3NwYW4+PHNwYW4+TG9nb3V0PC9zcGFuPjwvYT4KPC9kaXY+CjxkaXYgY2xhc3M9Im1haW4iIGlkPSJtYWluLWNvbnRlbnQiPjwvZGl2Pgo8c2NyaXB0PgpsZXQgX2xvYWRpbmdDb3VudCA9IDA7CmZ1bmN0aW9uIHNob3dMb2FkaW5nKCkgeyBfbG9hZGluZ0NvdW50Kys7IGNvbnN0IGIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9hZGluZy1iYXInKTsgaWYgKGIpIHsgYi5zdHlsZS53aWR0aCA9ICczMCUnOyBiLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOyB9IH0KZnVuY3Rpb24gaGlkZUxvYWRpbmcoKSB7IF9sb2FkaW5nQ291bnQtLTsgaWYgKF9sb2FkaW5nQ291bnQgPD0gMCkgeyBfbG9hZGluZ0NvdW50ID0gMDsgY29uc3QgYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2FkaW5nLWJhcicpOyBpZiAoYikgeyBiLnN0eWxlLndpZHRoID0gJzEwMCUnOyBzZXRUaW1lb3V0KCgpID0+IHsgYi5zdHlsZS53aWR0aCA9ICcwJzsgYi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsgfSwgMzAwKTsgfSB9IH0KZnVuY3Rpb24gYXBpKHBhdGgsIG9wdHMpIHsKICBzaG93TG9hZGluZygpOwogIGNvbnN0IGhkcnMgPSB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsIC4uLihvcHRzIHx8IHt9KS5oZWFkZXJzIH07CiAgcmV0dXJuIGZldGNoKCcvYWRtaW4vYXBpJyArIHBhdGgsIHsKICAgIGhlYWRlcnM6IGhkcnMsCiAgICBjcmVkZW50aWFsczogJ3NhbWUtb3JpZ2luJywgLi4uKG9wdHMgfHwge30pCiAgfSkudGhlbihyID0+IHsgaGlkZUxvYWRpbmcoKTsgaWYgKHIuc3RhdHVzID09PSA0MDEpIHsgZG9jdW1lbnQuY29va2llID0gImJmYWRtaW49OyBtYXgtYWdlPTA7IHBhdGg9LyI7IHdpbmRvdy5sb2NhdGlvbi5ocmVmID0gIi9hZG1pbiI7IHRocm93IG5ldyBFcnJvcigndW5hdXRob3JpemVkJyk7IH0gcmV0dXJuIHIuanNvbigpOyB9KS5jYXRjaChlID0+IHsgaGlkZUxvYWRpbmcoKTsgdGhyb3cgZTsgfSk7Cn0KZnVuY3Rpb24gZXNjKHMpIHsgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC8mL2csJyZhbXA7JykucmVwbGFjZSgvPC9nLCcmbHQ7JykucmVwbGFjZSgvPi9nLCcmZ3Q7JykucmVwbGFjZSgvIi9nLCcmcXVvdDsnKS5yZXBsYWNlKC8nL2csJyYjeDI3OycpOyB9CmZ1bmN0aW9uIGNhcChzKSB7IHJldHVybiBzLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgcy5zbGljZSgxKTsgfQoKZnVuY3Rpb24gc2hvd1RvYXN0KG1zZywgdHlwZSkgewogIGNvbnN0IGljbyA9IHR5cGUgPT09ICdzdWNjZXNzJyA/ICdcdTI3MTMnIDogdHlwZSA9PT0gJ2Vycm9yJyA/ICdcdTI3MTcnIDogJ1x1MjEzOSc7CiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyB0LmNsYXNzTmFtZSA9ICd0b2FzdCAnICsgdHlwZTsKICB0LmlubmVySFRNTCA9ICc8c3BhbiBzdHlsZT0ibWFyZ2luLXJpZ2h0OjEwcHg7Zm9udC1zaXplOjE2cHgiPicgKyBpY28gKyAnPC9zcGFuPic7CiAgdC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShtc2cpKTsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHQpOyBzZXRUaW1lb3V0KCgpID0+IHQucmVtb3ZlKCksIDM1MDApOwp9CmZ1bmN0aW9uIGxvZ291dCgpIHsgZG9jdW1lbnQuY29va2llID0gImJmYWRtaW49OyBtYXgtYWdlPTA7IHBhdGg9LyI7IHdpbmRvdy5sb2NhdGlvbi5ocmVmID0gIi9hZG1pbiI7IH0KCmNvbnN0IFBST1ZJREVSX1VSTFMgPSB7CiAgZ3JvcTogJ2h0dHBzOi8vY29uc29sZS5ncm9xLmNvbS9rZXlzJywgZ29vZ2xlOiAnaHR0cHM6Ly9haXN0dWRpby5nb29nbGUuY29tL2FwaWtleScsCiAgb3BlbnJvdXRlcjogJ2h0dHBzOi8vb3BlbnJvdXRlci5haS9rZXlzJywgbWlzdHJhbDogJ2h0dHBzOi8vY29uc29sZS5taXN0cmFsLmFpL2FwaS1rZXlzJywKICBkZWVwc2VlazogJ2h0dHBzOi8vcGxhdGZvcm0uZGVlcHNlZWsuY29tL2FwaV9rZXlzJywgdG9nZXRoZXI6ICdodHRwczovL2FwaS50b2dldGhlci5haS9zZXR0aW5ncy9hcGkta2V5cycsCiAgY2VyZWJyYXM6ICdodHRwczovL2NvbnNvbGUuY2VyZWJyYXMuYWkvYXBpLWtleXMnLCBhbGliYWJhOiAnaHR0cHM6Ly9iYWlsaWFuLmNvbnNvbGUuYWxpeXVuLmNvbS8nLAogIGFpMjE6ICdodHRwczovL3N0dWRpby5haTIxLmNvbS9hY2NvdW50L2FwaS1rZXlzJywgaHVnZ2luZ2ZhY2U6ICdodHRwczovL2h1Z2dpbmdmYWNlLmNvL3NldHRpbmdzL3Rva2VucycsCiAgbnZpZGlhOiAnaHR0cHM6Ly9idWlsZC5udmlkaWEuY29tL25pbScsIGNvaGVyZTogJ2h0dHBzOi8vZGFzaGJvYXJkLmNvaGVyZS5jb20vYXBpLWtleXMnCn07CmNvbnN0IFBST1ZJREVSX0NPTE9SUyA9IHsKICBncm9xOicjZjU1MDM2JywgZ29vZ2xlOicjNDI4NWY0Jywgb3BlbnJvdXRlcjonIzEwYTM3ZicsIG1pc3RyYWw6JyNmZjZkMDAnLAogIGRlZXBzZWVrOicjNGY0NmU1JywgdG9nZXRoZXI6JyM3YzNhZWQnLCBjZXJlYnJhczonIzA2YjZkNCcsIGFsaWJhYmE6JyNmOTczMTYnLAogIGFpMjE6JyM4YjVjZjYnLCBodWdnaW5nZmFjZTonI2VhYjMwOCcsIG52aWRpYTonIzc2YjkwMCcsIGNvaGVyZTonIzA2ZDZhMCcKfTsKZnVuY3Rpb24gbG9nbyhwbmFtZSkgewogIGNvbnN0IGMgPSBQUk9WSURFUl9DT0xPUlNbcG5hbWVdIHx8ICcjMzhiZGY4JzsKICByZXR1cm4gJzxzcGFuIHN0eWxlPSJkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3dpZHRoOjI0cHg7aGVpZ2h0OjI0cHg7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDonICsgYyArICc7Y29sb3I6I2ZmZjtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo3MDA7bWFyZ2luLXJpZ2h0OjhweDtmbGV4LXNocmluazowIj4nICsgcG5hbWVbMF0udG9VcHBlckNhc2UoKSArICc8L3NwYW4+JzsKfQpmdW5jdGlvbiBzaG93VGFiKG5hbWUpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2lkZWJhciBhJykuZm9yRWFjaChhID0+IGEuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJykpOwogIGNvbnN0IG5hdiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCduYXYtJyArIG5hbWUpOyBpZiAobmF2KSBuYXYuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgaWYgKFBBR0VTW25hbWVdICYmIFBBR0VTW25hbWVdLnJlbmRlcikgUEFHRVNbbmFtZV0ucmVuZGVyKCk7Cn0KZnVuY3Rpb24gc2V0Q29udGVudChoKSB7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWFpbi1jb250ZW50Jyk7CiAgZWwuc3R5bGUub3BhY2l0eSA9ICcwJzsKICBzZXRUaW1lb3V0KCgpID0+IHsgZWwuaW5uZXJIVE1MID0gaDsgZWwuc3R5bGUudHJhbnNpdGlvbiA9ICdvcGFjaXR5IC4yNXMnOyBlbC5zdHlsZS5vcGFjaXR5ID0gJzEnOyB9LCA1MCk7Cn0KY29uc3QgUEFHRVMgPSB7CiAgb3ZlcnZpZXc6IHsgdGl0bGU6ICdEYXNoYm9hcmQgT3ZlcnZpZXcnLCByZW5kZXI6IHJlbmRlck92ZXJ2aWV3IH0sCiAga2V5czogeyB0aXRsZTogJ0FQSSBLZXlzJywgcmVuZGVyOiByZW5kZXJLZXlzIH0sCiAgZ2F0ZXdheTogeyB0aXRsZTogJ0dhdGV3YXkgS2V5cycsIHJlbmRlcjogcmVuZGVyR2F0ZXdheSB9LAogIHN0cmF0ZWd5OiB7IHRpdGxlOiAnUm91dGluZyBTdHJhdGVneScsIHJlbmRlcjogcmVuZGVyU3RyYXRlZ3kgfSwKICAvLyBsb2dzIGFuZCByZXEtbG9ncyByZW1vdmVkIChLViBzcGFjZSkKICBhbmFseXRpY3M6IHsgdGl0bGU6ICdBbmFseXRpY3MnLCByZW5kZXI6IHJlbmRlckFuYWx5dGljcyB9LAogIHVzYWdlOiB7IHRpdGxlOiAnVXNhZ2UgJiBMaW1pdHMnLCByZW5kZXI6IHJlbmRlclVzYWdlIH0sCiAgaGVhbHRoOiB7IHRpdGxlOiAnSGVhbHRoIENoZWNrJywgcmVuZGVyOiByZW5kZXJIZWFsdGggfSwKICBzZXR1cDogeyB0aXRsZTogJ1NldHVwIEd1aWRlJywgcmVuZGVyOiByZW5kZXJTZXR1cCB9Cn07CnNob3dUYWIoJ292ZXJ2aWV3Jyk7CmFzeW5jIGZ1bmN0aW9uIHJlbmRlck92ZXJ2aWV3KCkgewogIGNvbnN0IHMgPSBhd2FpdCBhcGkoJy9zdGF0cycpOwogIGNvbnN0IGEgPSBhd2FpdCBhcGkoJy9hbmFseXRpY3M/ZGF5cz03Jyk7CiAgbGV0IHRvdGFsQ29zdCA9IDA7IGxldCB0b3RhbFRva2VucyA9IDA7CiAgaWYgKEFycmF5LmlzQXJyYXkoYSkpIHsgYS5mb3JFYWNoKGQgPT4geyB0b3RhbENvc3QgKz0gZC50b3RhbENvc3QgfHwgMDsgdG90YWxUb2tlbnMgKz0gKGQudG90YWxQcm9tcHRUb2tlbnMgfHwgMCkgKyAoZC50b3RhbENvbXBsZXRpb25Ub2tlbnMgfHwgMCk7IH0pOyB9CiAgY29uc3QgY29weVVybCA9ICgpID0+IHsgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoJ2h0dHBzOi8vYnVkZGhpLWR3YXIucmljaGFyZC1icm93bi1taWFtaS53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zJyk7IHNob3dUb2FzdCgnVVJMIGNvcGllZCcsICdzdWNjZXNzJyk7IH07CiAgc2V0Q29udGVudChgCiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO21hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGgyIHN0eWxlPSJtYXJnaW46MDtib3JkZXI6bm9uZTtwYWRkaW5nOjAiPkRhc2hib2FyZCBPdmVydmlldzwvaDI+CiAgICAgIDxzcGFuIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojNzQ4OGE4Ij4ke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9PC9zcGFuPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPk1vbml0b3Igb3ZlcmFsbCBnYXRld2F5IHBlcmZvcm1hbmNlOiByZXF1ZXN0IGNvdW50LCBrZXkgaGVhbHRoIGJ5IHN0YXR1cyAoYWN0aXZlL2RlYWQvZXhwaXJlZC93YXJtaW5nKSwgZXN0aW1hdGVkIGNvc3QgYW5kIHRva2VuIHVzYWdlIGFjcm9zcyBhbGwgcHJvdmlkZXJzIG92ZXIgdGhlIGxhc3QgNyBkYXlzLjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZHMiPgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDgpLHJnYmEoOTksMTAyLDI0MSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIj4ke3MucmVxdWVzdHNUb2RheSB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+UmVxdWVzdHMgVG9kYXk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDk5LDEwMiwyNDEsLjA4KSxyZ2JhKDEzOSw5MiwyNDYsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSI+JHtzLnRvdGFsS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+VG90YWwgS2V5czwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMzQsMTk3LDk0LC4wOCkscmdiYSgyMiwxNjMsNzQsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM4NmVmYWMiPiR7cy5hY3RpdmVLZXlzIHx8IDB9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+QWN0aXZlIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzOSw2OCw2OCwuMDgpLHJnYmEoMjIwLDM4LDM4LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij4ke3MuZGVhZEtleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij5EZWFkIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzNCwxNzksOCwuMDgpLHJnYmEoMjAyLDEzOCw0LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmRlNjhhIj4ke3Mud2FybWluZ0tleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5XYXJtaW5nIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDE5MiwxMzIsMjUyLC4wOCkscmdiYSgxNjgsODUsMjQ3LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojYzA4NGZjIj4ke3MuZXhwaXJlZEtleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojYzA4NGZjIj5FeHBpcmVkIEtleXM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDI1MSwxOTEsMzYsLjA4KSxyZ2JhKDI0NSwxNTgsMTEsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiQke3RvdGFsQ29zdC50b0ZpeGVkKDQpfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPkVzdC4gQ29zdCAoN2QpPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1OSwxMzAsMjQ2LC4wOCkscmdiYSgzNyw5OSwyMzUsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM5M2M1ZmQiPiR7dG90YWxUb2tlbnMudG9Mb2NhbGVTdHJpbmcoKX08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojOTNjNWZkIj5Ub2tlbnMgKDdkKTwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iZ3JpZC1jb2x1bW46MS8tMTtib3JkZXItY29sb3I6cmdiYSg1NiwxODksMjQ4LC4yNSk7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDYpLHJnYmEoOTksMTAyLDI0MSwuMDQpKTttYXJnaW4tYm90dG9tOjIwcHgiPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206NnB4Ij4KICAgICAgICA8c3BhbiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6Izc0ODhhODtmb250LXdlaWdodDo2MDA7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi42cHgiPllvdXIgR2F0ZXdheSBVUkw8L3NwYW4+CiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSIke2NvcHlVcmx9IiBjbGFzcz0ic2Vjb25kYXJ5IiBzdHlsZT0icGFkZGluZzo2cHggMTRweDtmb250LXNpemU6MTJweDttYXJnaW46MCI+Q29weSBVUkw8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxjb2RlIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojMzhiZGY4O3dvcmQtYnJlYWs6YnJlYWstYWxsO2Rpc3BsYXk6YmxvY2s7cGFkZGluZzoxMHB4IDE0cHg7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC40KTtib3JkZXItcmFkaXVzOjhweDtmb250LWZhbWlseTonRmlyYSBDb2RlJywnQ29uc29sYXMnLG1vbm9zcGFjZSI+aHR0cHM6Ly9idWRkaGktZHdhci5yaWNoYXJkLWJyb3duLW1pYW1pLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnM8L2NvZGU+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOiNmZGU2OGE7bWFyZ2luLXRvcDo4cHgiPlVzZSBhIEdhdGV3YXkgS2V5IGFzIEJlYXJlciB0b2tlbi4gU2VlIFNldHVwIHRhYiBmb3IgZXhhbXBsZXMuPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPlByb3ZpZGVyIFVzYWdlIFRvZGF5PC9oMj4KICAgIDxkaXYgY2xhc3M9ImNhcmRzIiBpZD0idXNhZ2UtbWluaSIgc3R5bGU9ImdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDIwMHB4LDFmcikpIj5Mb2FkaW5nLi4uPC9kaXY+CiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5EYWlseSBSZXF1ZXN0cyAoNyBkYXlzKTwvaDI+CiAgICA8cHJlPiR7ZXNjKEpTT04uc3RyaW5naWZ5KGEsIG51bGwsIDIpKX08L3ByZT4KICBgKTsKICB0cnkgewogICAgY29uc3QgdXIgPSBhd2FpdCBhcGkoJy9rZXktdXNhZ2UnKTsKICAgIGNvbnN0IHVkID0gdXIucHJvdmlkZXJzIHx8IHVyOwogICAgY29uc3QgdCA9IHVyLnRvdGFscyB8fCB7IHJlcXVlc3RzOiAwLCBzdWNjZXNzZXM6IDAsIGZhaWx1cmVzOiAwLCBwcm9tcHRUb2tlbnM6IDAsIGNvbXBsZXRpb25Ub2tlbnM6IDAsIGNvc3Q6IDAsIGtleXM6IDAgfTsKICAgIGxldCByZW1SZXEgPSAwLCByZW1Ub2sgPSAwOwogICAgZm9yIChjb25zdCBbcG4sIHBkXSBvZiBPYmplY3QuZW50cmllcyh1ZCkpIHsgZm9yIChjb25zdCBrIG9mIHBkLmtleXMpIHsKICAgICAgaWYgKGsucmF0ZUxpbWl0KSB7IHJlbVJlcSArPSBwYXJzZUludChrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nLXJlcXVlc3RzJ10gfHwgay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LXJlbWFpbmluZyddIHx8IDApOyByZW1Ub2sgKz0gcGFyc2VJbnQoay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LXJlbWFpbmluZy10b2tlbnMnXSB8fCAwKTsgfQogICAgfX0KICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3VzYWdlLW1pbmknKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGxldCBjYXJkcyA9ICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDgpLHJnYmEoOTksMTAyLDI0MSwuMDUpKSI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjE2cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiMzOGJkZjgiPicgKyB0LnJlcXVlc3RzICsgJzwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTgiPlRvdGFsIFJlcTwvZGl2PjwvZGl2PicgKwogICAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InBhZGRpbmc6MTJweCAxNnB4Ij48ZGl2IHN0eWxlPSJmb250LXNpemU6MTZweDtmb250LXdlaWdodDo3MDA7Y29sb3I6Izg2ZWZhYyI+JyArIHJlbVJlcSArICc8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTBweDtjb2xvcjojNzQ4OGE4Ij5SZW1haW5pbmcgUmVxPC9kaXY+PC9kaXY+JyArCiAgICAgICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHgiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxNnB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojOTNjNWZkIj4nICsgcmVtVG9rLnRvTG9jYWxlU3RyaW5nKCkgKyAnPC9kaXY+PGRpdiBzdHlsZT0iZm9udC1zaXplOjEwcHg7Y29sb3I6Izc0ODhhOCI+UmVtYWluaW5nIFRvazwvZGl2PjwvZGl2PicgKwogICAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InBhZGRpbmc6MTJweCAxNnB4Ij48ZGl2IHN0eWxlPSJmb250LXNpemU6MTZweDtmb250LXdlaWdodDo3MDA7Y29sb3I6I2ZkZTY4YSI+JCcgKyB0LmNvc3QudG9GaXhlZCg0KSArICc8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTBweDtjb2xvcjojNzQ4OGE4Ij5Ub3RhbCBDb3N0PC9kaXY+PC9kaXY+JzsKICAgIGZvciAoY29uc3QgW3BuLCBwZF0gb2YgT2JqZWN0LmVudHJpZXModWQpKSB7CiAgICAgIGNvbnN0IGxpbSA9IHBkLmxpbWl0IHx8IHt9OyBjb25zdCBkUmVxID0gbGltLmRhaWx5UmVxdWVzdHMgfHwgOTk5OTk5OwogICAgICBsZXQgdHIgPSAwOyBmb3IgKGNvbnN0IGsgb2YgcGQua2V5cykgdHIgKz0gay51c2FnZS5yZXF1ZXN0czsKICAgICAgY29uc3QgcGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLnJvdW5kKHRyIC8gZFJlcSAqIDEwMCkpOwogICAgICBjb25zdCBjb2wgPSBwY3QgPiA4MCA/ICcjZjg3MTcxJyA6IHBjdCA+IDUwID8gJyNmYmJmMjQnIDogJyMzOGJkZjgnOwogICAgICBjYXJkcyArPSAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InBhZGRpbmc6MTJweCAxNnB4Ij48ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Zm9udC1zaXplOjEzcHg7bWFyZ2luLWJvdHRvbTo0cHgiPjxzcGFuPicgKyBlc2MocG4pICsgJzwvc3Bhbj48c3BhbiBzdHlsZT0iY29sb3I6JyArIGNvbCArICciPicgKyB0ciArICc8L3NwYW4+PC9kaXY+JyArCiAgICAgICAgJzxkaXYgc3R5bGU9ImhlaWdodDo2cHg7YmFja2dyb3VuZDpyZ2JhKDcxLDg1LDEwNSwuNCk7Ym9yZGVyLXJhZGl1czozcHg7b3ZlcmZsb3c6aGlkZGVuIj48ZGl2IHN0eWxlPSJ3aWR0aDonICsgcGN0ICsgJyU7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDonICsgY29sICsgJztib3JkZXItcmFkaXVzOjNweCI+PC9kaXY+PC9kaXY+JyArCiAgICAgICAgJzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLXRvcDoycHgiPmxpbWl0OiAnICsgZFJlcSArICcgcmVxL2RheTwvZGl2PjwvZGl2Pic7CiAgICB9CiAgICBlbC5pbm5lckhUTUwgPSBjYXJkcyB8fCAnPHAgc3R5bGU9ImNvbG9yOiM5NGEzYjgiPk5vIGRhdGE8L3A+JzsKICB9IGNhdGNoIHt9Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyS2V5cygpIHsKICBjb25zdCByYXcgPSBhd2FpdCBhcGkoJy9rZXlzJyk7CiAgY29uc3QgaGVhbHRoID0gYXdhaXQgYXBpKCcva2V5cy1oZWFsdGgnKTsKICBsZXQgY2FyZHMgPSAnJzsKICBmb3IgKGNvbnN0IHBuYW1lIG9mIE9iamVjdC5rZXlzKFBST1ZJREVSX1VSTFMpKSB7CiAgICBjb25zdCBrZXlzID0gcmF3W3BuYW1lXSB8fCBbXTsKICAgIGNvbnN0IHVybCA9IFBST1ZJREVSX1VSTFNbcG5hbWVdOwogICAgY29uc3QgcGhlYWx0aCA9IGhlYWx0aFtwbmFtZV0gfHwge307CiAgICBjb25zdCBoYXNLZXlzID0ga2V5cy5sZW5ndGggPiAwOwogICAgbGV0IGtleVJvd3MgPSAnJzsKICAgIGlmIChoYXNLZXlzKSB7CiAgICAgIGZvciAoY29uc3QgayBvZiBrZXlzKSB7CiAgICAgICAgY29uc3QgbWFza2VkID0gKGsuYXBpS2V5fHwnJykuaW5jbHVkZXMoJyoqKionKSA/IGsuYXBpS2V5IDogJyoqKionOwogICAgICAgIGNvbnN0IGggPSBwaGVhbHRoW2suaWRdIHx8IHt9OwogICAgICAgIGNvbnN0IGlzV29ya2luZyA9IGguY2JTdGF0ZSA9PT0gJ2Nsb3NlZCcgfHwgIWguY2JTdGF0ZTsKICAgICAgICBjb25zdCBiYWRnZSA9IGlzV29ya2luZyA/ICc8c3BhbiBjbGFzcz0idGFnIG9rIj5Xb3JraW5nPC9zcGFuPicgOiAnPHNwYW4gY2xhc3M9InRhZyBmYWlsIj5BbGVydDwvc3Bhbj4nOwogICAgICAgIGtleVJvd3MgKz0gJzxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjZweDtwYWRkaW5nOjZweCAwO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHJnYmEoNzEsODUsMTA1LC4yKSI+JyArCiAgICAgICAgICAnPGNvZGUgaWQ9ImtjLScgKyBrLmlkICsgJyIgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM3NDg4YTg7ZmxleDoxO2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNCk7cGFkZGluZzo0cHggOHB4O2JvcmRlci1yYWRpdXM6NHB4Ij4nICsgbWFza2VkICsgJzwvY29kZT4nICsgYmFkZ2UgKwogICAgICAgICAgJzxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0iZ2V0S2V5KFwnJyArIGVzYyhwbmFtZSkgKyAnXCcsXCcnICsgZXNjKGsuaWQpICsgJ1wnKSIgc3R5bGU9ImNvbG9yOiMzOGJkZjg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmUiPlNob3c8L2E+PC9kaXY+JzsKICAgICAgfQogICAgfSBlbHNlIHsKICAgICAga2V5Um93cyA9ICc8cCBzdHlsZT0iY29sb3I6Izc2ODhhODtmb250LXNpemU6MTNweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjE2cHggMCI+Tm8ga2V5cyBzYXZlZDwvcD4nOwogICAgfQogICAgY29uc3QgYnRuTGFiZWwgPSBoYXNLZXlzID8gJ0FkZCBtb3JlIEtleScgOiAnQWRkIEtleSc7CiAgICBjYXJkcyArPSAnPGRpdiBjbGFzcz0ia2V5LWNhcmQiPicgKwogICAgICAnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tYm90dG9tOjEwcHgiPicgKwogICAgICAnPHNwYW4gc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXIiPjxhIGhyZWY9IicgKyB1cmwgKyAnIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiMzOGJkZjg7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxNnB4O3RleHQtZGVjb3JhdGlvbjpub25lIj4nICsgbG9nbyhwbmFtZSkgKyBjYXAocG5hbWUpICsgJzwvYT48L3NwYW4+JyArCiAgICAgICc8YSBocmVmPSInICsgdXJsICsgJyIgdGFyZ2V0PSJfYmxhbmsiIHN0eWxlPSJjb2xvcjojNzQ4OGE4O2ZvbnQtc2l6ZToxMnB4O3RleHQtZGVjb3JhdGlvbjpub25lIj5HZXQgS2V5ICYjODU5OTs8L2E+PC9kaXY+JyArCiAgICAgIGtleVJvd3MgKwogICAgICAnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDo4cHg7bWFyZ2luLXRvcDoxMHB4Ij4nICsKICAgICAgJzxpbnB1dCBpZD0ia3Bpbi0nICsgZXNjKHBuYW1lKSArICciIHBsYWNlaG9sZGVyPSJzay0uLi4iIHN0eWxlPSJmbGV4OjE7Zm9udC1zaXplOjEycHg7cGFkZGluZzo4cHggMTBweCI+JyArCiAgICAgICc8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJzYXZlS2V5KFwnJyArIGVzYyhwbmFtZSkgKyAnXCcpIiBzdHlsZT0icGFkZGluZzo4cHggMTRweDtmb250LXNpemU6MTJweDt3aGl0ZS1zcGFjZTpub3dyYXAiPicgKyBidG5MYWJlbCArICc8L2J1dHRvbj48L2Rpdj48L2Rpdj4nOwogIH0KICBzZXRDb250ZW50KCc8aDI+QVBJIEtleXM8L2gyPjxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+TWFuYWdlIHByb3ZpZGVyIEFQSSBrZXlzLiBQcm92aWRlciBuYW1lcyBsaW5rIHRvIHRoZWlyIGtleS1nZW5lcmF0aW9uIHBhZ2VzLjwvZGl2PjxkaXYgY2xhc3M9ImtleS1ncmlkIj4nICsgY2FyZHMgKyAnPC9kaXY+Jyk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGdldEtleShwbmFtZSwgaWQpIHsKICB0cnkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2tleXM/ZnVsbD0xJnBuYW1lPScgKyBlbmNvZGVVUklDb21wb25lbnQocG5hbWUpICsgJyZpZD0nICsgZW5jb2RlVVJJQ29tcG9uZW50KGlkKSk7CiAgICBpZiAoci5hcGlLZXkpIHsKICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdrYy0nICsgaWQpOwogICAgICBpZiAoY29kZSkgeyBjb2RlLnRleHRDb250ZW50ID0gci5hcGlLZXk7IGNvZGUuc3R5bGUudXNlclNlbGVjdCA9ICdhdXRvJzsgfQogICAgfQogIH0gY2F0Y2gge30KfQphc3luYyBmdW5jdGlvbiBzYXZlS2V5KHBuYW1lKSB7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgna3Bpbi0nICsgcG5hbWUpOwogIGNvbnN0IGFwaUtleSA9IGlucHV0LnZhbHVlLnRyaW0oKTsKICBpZiAoIWFwaUtleSkgeyBzaG93VG9hc3QoJ0VudGVyIEFQSSBrZXknLCAnZXJyb3InKTsgcmV0dXJuOyB9CiAgY29uc3QgbGFiZWwgPSBwbmFtZSArICdfJyArIERhdGUubm93KCk7CiAgaW5wdXQuZGlzYWJsZWQgPSB0cnVlOwogIHRyeSB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpKCcva2V5cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcG5hbWUsIGFwaUtleSwgbGFiZWwgfSkgfSk7CiAgICBpZiAoci5vaykgewogICAgICBhd2FpdCBhcGkoJy90ZXN0LWtleScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcG5hbWUsIGlkOiByLmlkIH0pIH0pOwogICAgICBzaG93VG9hc3QoJ0tleSBzYXZlZCBhbmQgdGVzdGVkJywgJ3N1Y2Nlc3MnKTsKICAgIH0gZWxzZSB7CiAgICAgIHNob3dUb2FzdChyLmVycm9yIHx8ICdGYWlsZWQgdG8gc2F2ZSBrZXknLCAnZXJyb3InKTsKICAgIH0KICB9IGNhdGNoIHsgc2hvd1RvYXN0KCdFcnJvciBzYXZpbmcga2V5JywgJ2Vycm9yJyk7IH0KICByZW5kZXJLZXlzKCk7Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyR2F0ZXdheSgpIHsKICBjb25zdCBnID0gYXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyk7CiAgbGV0IHJvd3MgPSBnLm1hcChrID0+ICc8dHIgZGF0YS13b3JkPSInICsgZXNjKGsud29yZCkgKyAnIiBkYXRhLWVuYWJsZWQ9IicgKyBrLmVuYWJsZWQgKyAnIj48dGQ+JyArIGVzYyhrLndvcmQpICsgJzwvdGQ+JyArCiAgICAnPHRkPjxzcGFuIGNsYXNzPSJ0YWcgJyArIChrLmVuYWJsZWQ/J2FjdGl2ZSc6J2ZhaWwnKSArICciPicgKyAoay5lbmFibGVkPydBY3RpdmUnOidEaXNhYmxlZCcpICsgJzwvc3Bhbj48L3RkPicgKwogICAgJzx0ZD4nICsgKGsudXNhZ2V8fDApICsgJzwvdGQ+JyArCiAgICAnPHRkIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojOTRhM2I4Ij4nICsgKGsuY3JlYXRlZEF0ID8gbmV3IERhdGUoay5jcmVhdGVkQXQpLnRvTG9jYWxlRGF0ZVN0cmluZygpIDogJycpICsgJzwvdGQ+JyArCiAgICAnPHRkPjxidXR0b24gb25jbGljaz0idG9nZ2xlR3codGhpcykiIHN0eWxlPSJwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4Ij4nICsgKGsuZW5hYmxlZD8nRGlzYWJsZSc6J0VuYWJsZScpICsgJzwvYnV0dG9uPicgKwogICAgJzxidXR0b24gY2xhc3M9ImRhbmdlciIgb25jbGljaz0iZGVsZXRlR3codGhpcykiIHN0eWxlPSJwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4Ij5EZWw8L2J1dHRvbj48L3RkPjwvdHI+Jykuam9pbignJyk7CiAgc2V0Q29udGVudChgCiAgICA8aDI+R2F0ZXdheSBLZXlzPC9oMj4KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+Q3JlYXRlIEFQSSBrZXlzIGZvciBleHRlcm5hbCBjbGllbnRzIHRoYXQgcHJveHkgdGhyb3VnaCB0aGlzIGdhdGV3YXkuIEVhY2gga2V5IGhhcyB1c2FnZSB0cmFja2luZyBhbmQgY2FuIGJlIGVuYWJsZWQvZGlzYWJsZWQgaW5kZXBlbmRlbnRseS4gR2VuZXJhdGUgYSByYW5kb20ga2V5IG9yIGNyZWF0ZSBhIGN1c3RvbSB3b3JkLWJhc2VkIHRva2VuLjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZm9ybS1yb3ciPgogICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+R2F0ZXdheSBLZXkgKHdvcmQvdG9rZW4pPC9sYWJlbD48aW5wdXQgaWQ9Imd3LXdvcmQiIHBsYWNlaG9sZGVyPSJteS1hcHAta2V5Ij48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0iYWRkR3coKSI+QWRkIEtleTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIG9uY2xpY2s9Imdlbkd3S2V5KCkiPkdlbmVyYXRlIEtleTwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+V29yZDwvdGg+PHRoPlN0YXR1czwvdGg+PHRoPlVzYWdlPC90aD48dGg+Q3JlYXRlZDwvdGg+PHRoPjwvdGg+PC90cj48L3RoZWFkPgogICAgPHRib2R5PiR7cm93c308L3Rib2R5PjwvdGFibGU+CiAgYCk7Cn0KYXN5bmMgZnVuY3Rpb24gdG9nZ2xlR3coZWwpe2NvbnN0IHRyPWVsLmNsb3Nlc3QoJ3RyJyk7Y29uc3Qgd29yZD10ci5kYXRhc2V0LndvcmQ7Y29uc3QgZW5hYmxlZD10ci5kYXRhc2V0LmVuYWJsZWQ9PT0ndHJ1ZSc/ZmFsc2U6dHJ1ZTthd2FpdCBhcGkoJy9nYXRld2F5LWtleXMnLHttZXRob2Q6J1BBVENIJyxib2R5OkpTT04uc3RyaW5naWZ5KHt3b3JkLGVuYWJsZWR9KX0pOyByZW5kZXJHYXRld2F5KCk7fQphc3luYyBmdW5jdGlvbiBkZWxldGVHdyhlbCl7Y29uc3Qgd29yZD1lbC5jbG9zZXN0KCd0cicpLmRhdGFzZXQud29yZDtpZighY29uZmlybSgnRGVsZXRlICInK3dvcmQrJyI/JykpcmV0dXJuO2F3YWl0IGFwaSgnL2dhdGV3YXkta2V5cycse21ldGhvZDonREVMRVRFJyxib2R5OkpTT04uc3RyaW5naWZ5KHt3b3JkfSl9KTsgcmVuZGVyR2F0ZXdheSgpO30KYXN5bmMgZnVuY3Rpb24gYWRkR3coKXsKICBjb25zdCB3b3JkPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdndy13b3JkJykudmFsdWU7CiAgaWYoIXdvcmQpe3Nob3dUb2FzdCgnV29yZCByZXF1aXJlZCcsJ2Vycm9yJyk7cmV0dXJufQogIGF3YWl0IGFwaSgnL2dhdGV3YXkta2V5cycse21ldGhvZDonUE9TVCcsYm9keTpKU09OLnN0cmluZ2lmeSh7d29yZH0pfSk7CiAgc2hvd1RvYXN0KCdBZGRlZCcsJ3N1Y2Nlc3MnKTsgcmVuZGVyR2F0ZXdheSgpOwp9CmFzeW5jIGZ1bmN0aW9uIGdlbkd3S2V5KCkgewogIGNvbnN0IGNoYXJzID0gJ2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSc7CiAgbGV0IGtleSA9ICcnOwogIGZvciAobGV0IGkgPSAwOyBpIDwgMzI7IGkrKykgewogICAgaWYgKGkgPiAwICYmIGkgJSA4ID09PSAwKSBrZXkgKz0gJy0nOwogICAga2V5ICs9IGNoYXJzLmNoYXJBdChNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjaGFycy5sZW5ndGgpKTsKICB9CiAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2dhdGV3YXkta2V5cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgd29yZDoga2V5IH0pIH0pOwogIGlmIChyLm9rKSB7IHNob3dUb2FzdCgnS2V5IGdlbmVyYXRlZCBhbmQgc2F2ZWQ6ICcgKyBrZXksICdzdWNjZXNzJyk7IHJlbmRlckdhdGV3YXkoKTsgfQogIGVsc2UgeyBzaG93VG9hc3QoJ0ZhaWxlZCB0byBzYXZlIGtleScsICdlcnJvcicpOyB9Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyU3RyYXRlZ3koKSB7CiAgY29uc3QgcyA9IGF3YWl0IGFwaSgnL3N0cmF0ZWd5Jyk7CiAgbGV0IGh0bWwgPSAnPGgyPlJvdXRpbmcgU3RyYXRlZ3k8L2gyPjxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+Q2hvb3NlIGhvdyB0aGUgZ2F0ZXdheSBzZWxlY3RzIGJldHdlZW4gbXVsdGlwbGUgQVBJIGtleXMgZm9yIHRoZSBzYW1lIHByb3ZpZGVyLiBSb3VuZC1yb2JpbiBjeWNsZXMgZXZlbmx5LCBsb3dlc3QtbGF0ZW5jeSBwaWNrcyBmYXN0ZXN0LCBsZWFzdC1sb2FkZWQgcGlja3MgbG93ZXN0IGZhaWx1cmUgcmF0aW8uPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiPic7CiAgZm9yIChjb25zdCBbcHJvdiwgc3RyYXRdIG9mIE9iamVjdC5lbnRyaWVzKHMpKSB7CiAgICBodG1sICs9ICc8ZGl2IGNsYXNzPSJjYXJkIj48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbTo4cHgiPicgKyBlc2MocHJvdikgKyAnPC9oMz4nICsKICAgICAgJzxwIHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4Ij5TdHJhdGVneTogPGIgc3R5bGU9ImNvbG9yOiNlMmU4ZjAiPicgKyBlc2Moc3RyYXQpICsgJzwvYj48L3A+PC9kaXY+JzsKICB9CiAgaHRtbCArPSAnPC9kaXY+PGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPlNldCBTdHJhdGVneTwvaDI+PGRpdiBjbGFzcz0iZm9ybS1yb3ciPicgKwogICAgJzxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5Qcm92aWRlcjwvbGFiZWw+PHNlbGVjdCBpZD0ic3RyLXByb3ZpZGVyIj4nICsgT2JqZWN0LmtleXMoUFJPVklERVJfVVJMUykubWFwKHA9Pic8b3B0aW9uPicrcCsnPC9vcHRpb24+Jykuam9pbignJykgKyAnPC9zZWxlY3Q+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPlN0cmF0ZWd5PC9sYWJlbD48c2VsZWN0IGlkPSJzdHItc3RyYXRlZ3kiPjxvcHRpb24+cm91bmQtcm9iaW48L29wdGlvbj48b3B0aW9uPmxvd2VzdC1sYXRlbmN5PC9vcHRpb24+PG9wdGlvbj5sZWFzdC1sb2FkZWQ8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4nICsKICAgICc8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJ1cGRhdGVTdHIoKSI+U2V0PC9idXR0b24+PC9kaXY+JyArCiAgICAnPGgyPlJhdzwvaDI+PHByZT4nICsgZXNjKEpTT04uc3RyaW5naWZ5KHMsIG51bGwsIDIpKSArICc8L3ByZT4nOwogIHNldENvbnRlbnQoaHRtbCk7Cn0KYXN5bmMgZnVuY3Rpb24gdXBkYXRlU3RyKCkgewogIGNvbnN0IHBuYW1lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0ci1wcm92aWRlcicpLnZhbHVlOwogIGNvbnN0IHN0cmF0ZWd5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0ci1zdHJhdGVneScpLnZhbHVlOwogIGF3YWl0IGFwaSgnL3N0cmF0ZWd5JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwbmFtZSwgc3RyYXRlZ3kgfSkgfSk7CiAgc2hvd1RvYXN0KCdVcGRhdGVkJywgJ3N1Y2Nlc3MnKTsgcmVuZGVyU3RyYXRlZ3koKTsKfQphc3luYyBmdW5jdGlvbiByZW5kZXJBbmFseXRpY3MoKSB7CiAgY29uc3QgYSA9IGF3YWl0IGFwaSgnL2FuYWx5dGljcz9kYXlzPTMwJyk7CiAgaWYoIUFycmF5LmlzQXJyYXkoYSl8fGEubGVuZ3RoPT09MCl7c2V0Q29udGVudCgnPHA+Tm8gYW5hbHl0aWNzIGRhdGE8L3A+Jyk7cmV0dXJufQogIGxldCByb3dzID0gYS5tYXAoZCA9PiAnPHRyPjx0ZD4nICsgKGQuZGF0ZXx8J8Oi4oKs4oCdJykgKyAnPC90ZD48dGQ+JyArIChkLnJlcXVlc3RzfHwwKSArICc8L3RkPjx0ZD4nICsgKGQuZmFpbHVyZXN8fDApICsgJzwvdGQ+JyArCiAgICAnPHRkPicgKyAoZC5zdWNjZXNzZXN8fDApICsgJzwvdGQ+PHRkPicgKyAoKGQudG90YWxQcm9tcHRUb2tlbnN8fDApLnRvTG9jYWxlU3RyaW5nKCkpICsgJzwvdGQ+JyArCiAgICAnPHRkPicgKyAoKGQudG90YWxDb21wbGV0aW9uVG9rZW5zfHwwKS50b0xvY2FsZVN0cmluZygpKSArICc8L3RkPjx0ZD4kJyArICgoZC50b3RhbENvc3R8fDApLnRvRml4ZWQoNCkpICsgJzwvdGQ+PC90cj4nKS5qb2luKCcnKTsKICBsZXQgdG90YWxSZXE9MCx0b3RhbEZhaWw9MCx0b3RhbENvc3Q9MCx0b3RhbFByb21wdD0wLHRvdGFsQ29tcD0wOwogIGEuZm9yRWFjaChkPT57dG90YWxSZXErPWQucmVxdWVzdHN8fDA7dG90YWxGYWlsKz1kLmZhaWx1cmVzfHwwO3RvdGFsQ29zdCs9ZC50b3RhbENvc3R8fDA7dG90YWxQcm9tcHQrPWQudG90YWxQcm9tcHRUb2tlbnN8fDA7dG90YWxDb21wKz1kLnRvdGFsQ29tcGxldGlvblRva2Vuc3x8MDt9KTsKICBzZXRDb250ZW50KGAKICAgIDxoMj5BbmFseXRpY3M8L2gyPgogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5WaWV3IHJlcXVlc3QgbWV0cmljcyBvdmVyIHRoZSBsYXN0IDMwIGRheXM6IHZvbHVtZSwgc3VjY2Vzcy9mYWlsdXJlIHJhdGVzLCB0b2tlbiB1c2FnZSwgYW5kIGVzdGltYXRlZCBjb3N0IHBlciBwcm92aWRlci4gVXNlIHRoZSBFeHBvcnQgQ1NWIGJ1dHRvbiBmb3Igb2ZmbGluZSBhbmFseXNpcy48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmRzIj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIj4ke3RvdGFsUmVxfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+UmVxdWVzdHMgKDMwZCk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZjYTVhNSI+JHt0b3RhbEZhaWx9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5FcnJvcnMgKDMwZCk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+JCR7dG90YWxDb3N0LnRvRml4ZWQoNCl9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Db3N0ICgzMGQpPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9Im51bSI+JHsodG90YWxQcm9tcHQrdG90YWxDb21wKS50b0xvY2FsZVN0cmluZygpfTwvZGl2PjxkaXYgY2xhc3M9ImxibCI+VG9rZW5zICgzMGQpPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTJweCI+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiBvbmNsaWNrPSJleHBvcnRBbmFseXRpY3MoKSI+RXhwb3J0IENTVjwvYnV0dG9uPjwvZGl2PgogICAgPHRhYmxlPjx0aGVhZD48dHI+PHRoPkRhdGU8L3RoPjx0aD5SZXE8L3RoPjx0aD5FcnI8L3RoPjx0aD5TdWNjZXNzPC90aD48dGg+UHJvbXB0IFRvazwvdGg+PHRoPkNvbXAgVG9rPC90aD48dGg+Q29zdDwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4ke3Jvd3N9PC90Ym9keT48L3RhYmxlPgogIGApOwp9CmZ1bmN0aW9uIGV4cG9ydEFuYWx5dGljcygpIHsKICB3aW5kb3cub3BlbignL2FkbWluL2FwaS9hbmFseXRpY3M/ZGF5cz0zMCZmb3JtYXQ9Y3N2JywgJ19ibGFuaycpOwp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlclVzYWdlKCkgewogIGNvbnN0IHJhdyA9IGF3YWl0IGFwaSgnL2tleS11c2FnZScpOwogIGNvbnN0IGRhdGEgPSByYXcucHJvdmlkZXJzIHx8IHJhdzsKICBjb25zdCB0b3RhbHMgPSByYXcudG90YWxzIHx8IHsgcmVxdWVzdHM6IDAsIHN1Y2Nlc3NlczogMCwgZmFpbHVyZXM6IDAsIHByb21wdFRva2VuczogMCwgY29tcGxldGlvblRva2VuczogMCwgY29zdDogMCwgcHJvdmlkZXJzOiAwLCBrZXlzOiAwIH07CiAgbGV0IGh0bWwgPSAnPGgyPlVzYWdlICZhbXA7IExpbWl0czwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Nb25pdG9yIHRvZGF5XCdzIHJlcXVlc3Qgdm9sdW1lLCB0b2tlbiBjb25zdW1wdGlvbiwgYW5kIGVzdGltYXRlZCBjb3N0IHBlciBwcm92aWRlci4gUHJvZ3Jlc3MgYmFycyBzaG93IHVzYWdlIGFnYWluc3QgZGFpbHkgcXVvdGFzLiBSYXRlLWxpbWl0IGhlYWRlcnMgZnJvbSB1cHN0cmVhbSBwcm92aWRlcnMgYXJlIGRpc3BsYXllZCBwZXIga2V5LjwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIiBzdHlsZT0ibWFyZ2luLWJvdHRvbToyMHB4Ij4nICsKICAgICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoNTYsMTg5LDI0OCwuMDgpLHJnYmEoOTksMTAyLDI0MSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIj4nICsgdG90YWxzLnJlcXVlc3RzICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCI+VG90YWwgUmVxdWVzdHMgVG9kYXk8L2Rpdj48L2Rpdj4nICsKICAgICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMzQsMTk3LDk0LC4wOCkscmdiYSgyMiwxNjMsNzQsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM4NmVmYWMiPicgKyB0b3RhbHMuc3VjY2Vzc2VzICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiM4NmVmYWMiPlN1Y2Nlc3NlczwvZGl2PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgyMzksNjgsNjgsLjA4KSxyZ2JhKDIyMCwzOCwzOCwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZjYTVhNSI+JyArIHRvdGFscy5mYWlsdXJlcyArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij5GYWlsdXJlczwvZGl2PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1OSwxMzAsMjQ2LC4wOCkscmdiYSgzNyw5OSwyMzUsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiM5M2M1ZmQiPicgKyAodG90YWxzLnByb21wdFRva2VucyArIHRvdGFscy5jb21wbGV0aW9uVG9rZW5zKS50b0xvY2FsZVN0cmluZygpICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiM5M2M1ZmQiPlRvdGFsIFRva2VuczwvZGl2PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgyNTEsMTkxLDM2LC4wOCkscmdiYSgyNDUsMTU4LDExLC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmRlNjhhIj4kJyArIHRvdGFscy5jb3N0LnRvRml4ZWQoNikgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+VG90YWwgQ29zdDwvZGl2PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9Im51bSI+JyArIHRvdGFscy5rZXlzICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCI+QWN0aXZlIEtleXM8L2Rpdj48L2Rpdj4nICsKICAgICc8L2Rpdj48ZGl2IGNsYXNzPSJjYXJkcyIgc3R5bGU9ImdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDI4MHB4LDFmcikpIj4nOwogIGZvciAoY29uc3QgW3BuYW1lLCBwZGF0YV0gb2YgT2JqZWN0LmVudHJpZXMoZGF0YSkpIHsKICAgIGxldCB0b3RSZXEgPSAwLCB0b3RUb2sgPSAwLCB0b3RDb3N0ID0gMDsKICAgIGxldCBybEh0bWwgPSAnJzsKICAgIGZvciAoY29uc3QgayBvZiBwZGF0YS5rZXlzKSB7IAogICAgICB0b3RSZXEgKz0gay51c2FnZS5yZXF1ZXN0czsgdG90VG9rICs9IGsudXNhZ2UucHJvbXB0VG9rZW5zICsgay51c2FnZS5jb21wbGV0aW9uVG9rZW5zOyB0b3RDb3N0ICs9IGsudXNhZ2UuY29zdDsKICAgICAgaWYgKGsucmF0ZUxpbWl0KSB7CiAgICAgICAgY29uc3QgcnJlbSA9IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1yZW1haW5pbmctcmVxdWVzdHMnXSB8fCBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nJ10gfHwgJz8nOwogICAgICAgIGNvbnN0IHJsaW0gPSBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtbGltaXQtcmVxdWVzdHMnXSB8fCBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtbGltaXQnXSB8fCAnPyc7CiAgICAgICAgY29uc3QgdHJlbSA9IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1yZW1haW5pbmctdG9rZW5zJ10gfHwgJz8nOwogICAgICAgIGNvbnN0IHRsaW0gPSBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtbGltaXQtdG9rZW5zJ10gfHwgJz8nOwogICAgICAgIHJsSHRtbCArPSAnPHAgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM4NmVmYWM7bWFyZ2luLXRvcDo0cHgiPlJhdGUgbGltaXQ6ICcgKyBycmVtICsgJy8nICsgcmxpbSArICcgcmVxLCAnICsgdHJlbSArICcvJyArIHRsaW0gKyAnIHRvazwvcD4nOwogICAgICB9CiAgICB9CiAgICBodG1sICs9ICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxNnB4Ij48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbToxMnB4Ij4nICsgZXNjKHBuYW1lKSArICc8L2gzPicgKwogICAgICAnPHAgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOiNlMmU4ZjA7bWFyZ2luLWJvdHRvbTo0cHgiPlJlcXVlc3RzOiAnICsgdG90UmVxICsgJzwvcD4nICsKICAgICAgJzxwIHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjojOTNjNWZkO21hcmdpbi1ib3R0b206NHB4Ij5Ub2tlbnM6ICcgKyB0b3RUb2sudG9Mb2NhbGVTdHJpbmcoKSArICc8L3A+JyArCiAgICAgICh0b3RDb3N0ID4gMCA/ICc8cCBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6I2ZkZTY4YSI+Q29zdDogJCcgKyB0b3RDb3N0LnRvRml4ZWQoNikgKyAnPC9wPicgOiAnJykgKwogICAgICBybEh0bWwgKwogICAgICAnPHAgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOiM3NDg4YTgiPicgKyBwZGF0YS5rZXlzLmxlbmd0aCArICcga2V5KHMpPC9wPjwvZGl2Pic7CiAgfQogIGlmIChodG1sID09PSAnPGRpdiBjbGFzcz0iY2FyZHMiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZml0LG1pbm1heCgyODBweCwxZnIpKSI+JykgaHRtbCArPSAnPHAgc3R5bGU9ImNvbG9yOiM5NGEzYjgiPk5vIHVzYWdlIGRhdGEgeWV0PC9wPic7CiAgaHRtbCArPSAnPC9kaXY+JzsKICBzZXRDb250ZW50KGh0bWwpOwp9Cgphc3luYyBmdW5jdGlvbiByZW5kZXJIZWFsdGgoKSB7CiAgc2V0Q29udGVudCgnPGgyPkhlYWx0aCBDaGVjazwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Qcm9iZSBlYWNoIHByb3ZpZGVyIGtleSB0byB2ZXJpZnkgY29ubmVjdGl2aXR5IGFuZCBhdXRoZW50aWNhdGlvbi4gU2hvd3MgSFRUUCBzdGF0dXMsIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSwgYW5kIGFueSBlcnJvciBtZXNzYWdlcyByZXR1cm5lZCBieSB0aGUgdXBzdHJlYW0gQVBJLjwvZGl2PjxwPlJ1bm5pbmcgaGVhbHRoIGNoZWNrcy4uLjwvcD4nKTsKICBjb25zdCBoID0gYXdhaXQgYXBpKCcvaGVhbHRoLWNoZWNrJyk7CiAgbGV0IGNhcmRzID0gJyc7CiAgZm9yKGNvbnN0IGl0ZW0gb2YgaCkgewogICAgY29uc3Qgb2sgPSBpdGVtLnN0YXR1cyA9PT0gJ29rJyA/ICdvaycgOiAnZmFpbCc7CiAgICBjYXJkcyArPSAnPGRpdiBjbGFzcz0iY2FyZCI+PGgzIHN0eWxlPSJjb2xvcjojMzhiZGY4O21hcmdpbi1ib3R0b206NnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXIiPicgKyBsb2dvKGl0ZW0ucHJvdmlkZXIpICsgY2FwKGl0ZW0ucHJvdmlkZXIpICsgJyAtICcgKyBlc2MoaXRlbS5tb2RlbHx8JycpICsgJzwvaDM+JyArCiAgICAgICc8cD48c3BhbiBjbGFzcz0idGFnICcgKyBvayArICciPicgKyBlc2MoaXRlbS5zdGF0dXN8fCc/JykgKyAnPC9zcGFuPjwvcD4nICsKICAgICAgJzxwIHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4Ij5IVFRQOiAnICsgKGl0ZW0uaHR0cFN0YXR1c3x8J8Oi4oKs4oCdJykgKyAnIHwgQ0I6ICcgKyBlc2MoaXRlbS5jYlN0YXRlfHwnw6LigqzigJ0nKSArICc8L3A+JyArCiAgICAgIChpdGVtLmVycm9yID8gJzxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NHB4Ij4nICsgZXNjKGl0ZW0uZXJyb3IpICsgJzwvcHJlPicgOiAnJykgKyAnPC9kaXY+JzsKICB9CiAgc2V0Q29udGVudCgnPGgyPkhlYWx0aCBDaGVjazwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5Qcm9iZSBlYWNoIHByb3ZpZGVyIGtleSB0byB2ZXJpZnkgY29ubmVjdGl2aXR5IGFuZCBhdXRoZW50aWNhdGlvbi4gU2hvd3MgSFRUUCBzdGF0dXMsIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSwgYW5kIGFueSBlcnJvciBtZXNzYWdlcyByZXR1cm5lZCBieSB0aGUgdXBzdHJlYW0gQVBJLjwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIj4nICsgKGNhcmRzIHx8ICc8cD5ObyByZXN1bHRzPC9wPicpICsgJzwvZGl2PicpOwp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNldHVwKCkgewogIHNldENvbnRlbnQoYAogICAgPGgyPlNldHVwIEd1aWRlPC9oMj4KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+U3RlcC1ieS1zdGVwIGd1aWRlIGZvciBjb25uZWN0aW5nIGNsaWVudHMgdG8gdGhlIGdhdGV3YXkuIEdlbmVyYXRlIGEgR2F0ZXdheSBLZXksIHRoZW4gdXNlIGl0IGFzIHRoZSBCZWFyZXIgdG9rZW4gd2l0aCBhbnkgT3BlbkFJLWNvbXBhdGlibGUgY2xpZW50LiBTdXBwb3J0cyBjaGF0IGNvbXBsZXRpb25zLCBlbWJlZGRpbmdzLCBhbmQgQW50aHJvcGljLXN0eWxlIG1lc3NhZ2VzLjwvZGl2PgogICAgPGgyPllvdXIgR2F0ZXdheSBVUkw8L2gyPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjE0cHgiPlBPU1QgaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zCkF1dGhvcml6YXRpb246IEJlYXJlciAmbHQ7eW91ci1nYXRld2F5LWtleSZndDs8L3ByZT4KCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+R2VuZXJhdGUgYSBHYXRld2F5IEtleTwvaDI+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+R28gdG8gPGI+R2F0ZXdheSBLZXlzPC9iPiB0YWIgYW5kIGNsaWNrIDxiPkdlbmVyYXRlIEtleTwvYj4gdG8gY3JlYXRlIGEgcmFuZG9tIHRva2VuLCBvciBlbnRlciB5b3VyIG93biB3b3JkLiBVc2UgdGhhdCBrZXkgYXMgdGhlIEJlYXJlciB0b2tlbiBpbiB5b3VyIGFwcHMuPC9wPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBjVVJMPC9oMj4KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5jdXJsIC1YIFBPU1QgaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zIFxcCiAgLUggIkF1dGhvcml6YXRpb246IEJlYXJlciBZT1VSX0dBVEVXQVlfS0VZIiBcXAogIC1IICJDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24iIFxcCiAgLWQgJ3sibW9kZWwiOiJncHQtNG8iLCJtZXNzYWdlcyI6W3sicm9sZSI6InVzZXIiLCJjb250ZW50IjoiaGVsbG8ifV19JzwvcHJlPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBKYXZhU2NyaXB0IChmZXRjaCk8L2gyPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjEzcHgiPmNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCgiaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zIiwgewogIG1ldGhvZDogIlBPU1QiLAogIGhlYWRlcnM6IHsgIkF1dGhvcml6YXRpb24iOiAiQmVhcmVyIFlPVVJfR0FURVdBWV9LRVkiLCAiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24iIH0sCiAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtb2RlbDogImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNCIsIG1lc3NhZ2VzOiBbeyByb2xlOiAidXNlciIsIGNvbnRlbnQ6ICJoaSIgfV0gfSkKfSk7CmNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTs8L3ByZT4KCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+RXhhbXBsZTogUHl0aG9uPC9oMj4KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5pbXBvcnQgcmVxdWVzdHMKcmVzcCA9IHJlcXVlc3RzLnBvc3QoCiAgICAiaHR0cHM6Ly9idWRkaGktZHdhci55b3VyLWRvbWFpbi53b3JrZXJzLmRldi92MS9jaGF0L2NvbXBsZXRpb25zIiwKICAgIGhlYWRlcnM9eyJBdXRob3JpemF0aW9uIjogIkJlYXJlciBZT1VSX0dBVEVXQVlfS0VZIn0sCiAgICBqc29uPXsibW9kZWwiOiAiZ3B0LTRvIiwgIm1lc3NhZ2VzIjogW3sicm9sZSI6ICJ1c2VyIiwgImNvbnRlbnQiOiAiaGVsbG8ifV19CikKcHJpbnQocmVzcC5qc29uKCkpPC9wcmU+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPldlYmhvb2sgTm90aWZpY2F0aW9uczwvaDI+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+U2V0IDxjb2RlIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5XRUJIT09LX1VSTDwvY29kZT4gaW4geW91ciBDbG91ZGZsYXJlIFdvcmtlciBlbnZpcm9ubWVudCB2YXJpYWJsZXMgKGUuZy4gU2xhY2sgd2ViaG9vayBVUkwpLiBUaGUgZ2F0ZXdheSB3aWxsIFBPU1QgSlNPTiBhbGVydHMgZm9yIGF1dGggZmFpbHVyZXMgYW5kIGNpcmN1aXQtYnJlYWtlciBzdGF0ZSBjaGFuZ2VzLjwvcD4KICAgIDxwcmUgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5FeGFtcGxlIHBheWxvYWQ6ClBPU1QgJmx0O1dFQkhPT0tfVVJMJmd0Owp7ImV2ZW50IjoiYXV0aF9mYWlsdXJlIiwicHJvdmlkZXIiOiJvcGVuYWkiLCJrZXlJZCI6InNrLS4uLiIsInN0YXR1cyI6NDAxfTwvcHJlPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5BRE1JTl9QQVNTV09SRCAoRW52aXJvbm1lbnQgVmFyaWFibGUpPC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5TZXQgPGNvZGUgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPkFETUlOX1BBU1NXT1JEPC9jb2RlPiBpbiB5b3VyIENsb3VkZmxhcmUgV29ya2VyIGVudiB2YXJzIHRvIG92ZXJyaWRlIHRoZSBkZWZhdWx0IGFkbWluIHBhc3N3b3JkICg8Y29kZT4yMjAwPC9jb2RlPikuPC9wPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5TdXBwb3J0ZWQgTW9kZWxzPC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5GcmVlLXRpZXIgbW9kZWxzOiA8Yj5Hcm9xPC9iPiAobGxhbWEtMy4zLTcwYi12ZXJzYXRpbGUpLCA8Yj5Hb29nbGU8L2I+IChnZW1pbmktMi4wLWZsYXNoKSwgPGI+TWlzdHJhbDwvYj4gKG1pc3RyYWwtc21hbGwtbGF0ZXN0KSwgPGI+T3BlblJvdXRlcjwvYj4gKGZyZWUgbW9kZWxzKS48L3A+CiAgICA8cCBzdHlsZT0iZm9udC1zaXplOjE0cHg7Y29sb3I6Izk0YTNiOCI+Rmlyc3QgYWRkIHlvdXIgcHJvdmlkZXIgQVBJIGtleXMgaW4gdGhlIDxiPkFQSSBLZXlzPC9iPiB0YWIsIHRoZW4gZ2VuZXJhdGUgYSBHYXRld2F5IEtleSBpbiB0aGUgPGI+R2F0ZXdheSBLZXlzPC9iPiB0YWIuPC9wPgogIGApOwp9Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K";

const ADMIN_PAGE = atob(ADMIN_PAGE_B64);


/* ── Hono App ── */
const app = new Hono();

app.post("/v1/chat/completions", async (c) => handleProxy(c.req.raw));
app.post("/chat/completions", async (c) => handleProxy(c.req.raw));
app.post("/v1/embeddings", async (c) => handleEmbeddings(c.req.raw));
app.post("/v1/messages", async (c) => handleAnthropic(c.req.raw));
app.get("/v1/models", async (c) => handleModels());
app.get("/models", async (c) => handleModels());
app.post("/v1/images/generations", async (c) => handleImageGen(c.req.raw));
app.post("/v1/video/generations", async (c) => handleVideoGen(c.req.raw));

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

app.get("/admin/api/logout", async (c) => {
  return new Response("", { status: 302, headers: { "Set-Cookie": "bfadmin=; max-age=0; path=/", Location: "/admin", "Cache-Control": "no-cache" } });
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



