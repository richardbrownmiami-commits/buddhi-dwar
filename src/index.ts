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

interface Env { BF: KVNamespace; WEBHOOK_URL?: string; ADMIN_PASSWORD?: string; MASTER_KEY?: string; }

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
  if (["POST","PUT","DELETE","PATCH"].includes(req.method)) {
    const origin = req.headers.get("Origin") || "";
    if (origin && origin !== url.origin) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }

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
const ADMIN_PAGE_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEuMCI+Cjx0aXRsZT5CdWRkaGkgRHdhciBBZG1pbjwvdGl0bGU+CjxzdHlsZT4KKnttYXJnaW46MDtwYWRkaW5nOjA7Ym94LXNpemluZzpib3JkZXItYm94O2ZvbnQtZmFtaWx5OidJbnRlcicsc3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sc2Fucy1zZXJpZn0KYm9keXtkaXNwbGF5OmZsZXg7bWluLWhlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzBhMGUxYSAwJSwjMGYxNjI5IDQwJSwjMTIxYjMzIDEwMCUpO2NvbG9yOiNlMmU4ZjB9Ci5zaWRlYmFye3dpZHRoOjI0MHB4O2JhY2tncm91bmQ6cmdiYSgxNywyNCwzOSwuODUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO3BhZGRpbmc6MjRweCAwO2JvcmRlci1yaWdodDoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4xKTtmbGV4LXNocmluazowO2hlaWdodDoxMDB2aDtwb3NpdGlvbjpzdGlja3k7dG9wOjA7b3ZlcmZsb3cteTphdXRvfQouc2lkZWJhciBoMXtmb250LXNpemU6MjJweDtmb250LXdlaWdodDo4MDA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMzOGJkZjgsIzgxOGNmOCk7LXdlYmtpdC1iYWNrZ3JvdW5kLWNsaXA6dGV4dDstd2Via2l0LXRleHQtZmlsbC1jb2xvcjp0cmFuc3BhcmVudDtwYWRkaW5nOjAgMjBweCAyNHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMSk7bWFyZ2luLWJvdHRvbToxMnB4O2xldHRlci1zcGFjaW5nOi0uNXB4fQouc2lkZWJhciBhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHg7cGFkZGluZzoxMXB4IDIwcHg7Y29sb3I6Izg4OTliNDt0ZXh0LWRlY29yYXRpb246bm9uZTtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo1MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjJzO21hcmdpbjoycHggOHB4O2JvcmRlci1yYWRpdXM6MTBweH0KLnNpZGViYXIgYTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDgpO2NvbG9yOiNlMmU4ZjB9Ci5zaWRlYmFyIGEuYWN0aXZle2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU2LDE4OSwyNDgsLjEyKSxyZ2JhKDEyOSwxNDAsMjQ4LC4wOCkpO2NvbG9yOiMzOGJkZjg7Ym94LXNoYWRvdzppbnNldCAycHggMCAwICMzOGJkZjh9Ci5tYWlue2ZsZXg6MTtwYWRkaW5nOjMycHg7bWF4LXdpZHRoOjEyMDBweH1zZWN0aW9ue2Rpc3BsYXk6bm9uZX1zZWN0aW9uLmFjdGl2ZXtkaXNwbGF5OmJsb2NrfQpoMntmb250LXNpemU6MjJweDtmb250LXdlaWdodDo3MDA7Y29sb3I6I2YxZjVmOTttYXJnaW4tYm90dG9tOjIwcHg7cGFkZGluZy1ib3R0b206MTBweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtsZXR0ZXItc3BhY2luZzotLjNweH0KLmNhcmRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZml0LG1pbm1heCgyMDBweCwxZnIpKTtnYXA6MTRweDttYXJnaW4tYm90dG9tOjI4cHh9Ci5jYXJke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDMwLDQxLDU5LC42KSxyZ2JhKDMwLDQxLDU5LC4zKSk7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MjBweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNTYsMTg5LDI0OCwuMDgpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDhweCk7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzLGJvcmRlci1jb2xvciAuMnN9Ci5jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjpyZ2JhKDU2LDE4OSwyNDgsLjIpfQouY2FyZCAubnVte2ZvbnQtc2l6ZTozMHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjojMzhiZGY4O2xldHRlci1zcGFjaW5nOi0uNXB4fQouY2FyZCAubGJse2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM3NDg4YTg7bWFyZ2luLXRvcDo2cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi44cHg7Zm9udC13ZWlnaHQ6NjAwfQp0YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtmb250LXNpemU6MTRweDttYXJnaW4tYm90dG9tOjE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRlbn0KdGh7Y29sb3I6Izc0ODhhODtmb250LXdlaWdodDo2MDA7cGFkZGluZzoxNHB4IDEycHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wOCk7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouOHB4O2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNCl9CnRke3BhZGRpbmc6MTJweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCByZ2JhKDMwLDQxLDU5LC40KTtjb2xvcjojZTJlOGYwfQp0cjpob3ZlciB0ZHtiYWNrZ3JvdW5kOnJnYmEoNTYsMTg5LDI0OCwuMDMpfQppbnB1dCxzZWxlY3R7cGFkZGluZzoxMXB4IDE0cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg3MSw4NSwxMDUsLjQpO2JhY2tncm91bmQ6cmdiYSgxNSwyMyw0MiwuNik7Y29sb3I6I2UyZThmMDtmb250LXNpemU6MTRweDt3aWR0aDoxMDAlO21heC13aWR0aDo0MDBweDttYXJnaW46NHB4IDA7b3V0bGluZTpub25lO3RyYW5zaXRpb246YWxsIC4yc30KaW5wdXQ6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojMzhiZGY4O2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoNTYsMTg5LDI0OCwuMTIpfQpidXR0b257cGFkZGluZzoxMXB4IDIycHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25lO2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjttYXJnaW46NHB4IDRweCA0cHggMDt0cmFuc2l0aW9uOmFsbCAuMnM7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVufQpidXR0b246YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTcpfQpidXR0b24ucHJpbWFyeXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzM4YmRmOCwjNjM2NmYxKTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDU2LDE4OSwyNDgsLjIpfWJ1dHRvbi5wcmltYXJ5OmhvdmVye2JveC1zaGFkb3c6MCA0cHggMjBweCByZ2JhKDU2LDE4OSwyNDgsLjM1KX0KYnV0dG9uLmRhbmdlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsI2VmNDQ0NCwjZGMyNjI2KTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDIzOSw2OCw2OCwuMil9YnV0dG9uLmRhbmdlcjpob3Zlcntib3gtc2hhZG93OjAgNHB4IDIwcHggcmdiYSgyMzksNjgsNjgsLjM1KX0KYnV0dG9uLnNlY29uZGFyeXtiYWNrZ3JvdW5kOnJnYmEoNTEsNjUsODUsLjUpO2NvbG9yOiNlMmU4ZjA7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDcxLDg1LDEwNSwuMyl9YnV0dG9uLnNlY29uZGFyeTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoNTEsNjUsODUsLjgpfQpwcmV7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC42KTtwYWRkaW5nOjE4cHg7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmF1dG87Zm9udC1zaXplOjEzcHg7bWF4LWhlaWdodDo1MDBweDtsaW5lLWhlaWdodDoxLjY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTtmb250LWZhbWlseTonRmlyYSBDb2RlJywnQ29uc29sYXMnLG1vbm9zcGFjZX0KLnRhZ3tkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjNweCAxMnB4O2JvcmRlci1yYWRpdXM6MjBweDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7bGV0dGVyLXNwYWNpbmc6LjNweH0KLnRhZy5va3tiYWNrZ3JvdW5kOnJnYmEoMjIsMTYzLDc0LC4xNSk7Y29sb3I6Izg2ZWZhYztib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjIsMTYzLDc0LC4zKX0KLnRhZy5mYWlse2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjE1KTtjb2xvcjojZmNhNWE1O2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzksNjgsNjgsLjMpfQoudGFnLmFjdGl2ZXtiYWNrZ3JvdW5kOnJnYmEoNTksMTMwLDI0NiwuMTUpO2NvbG9yOiM5M2M1ZmQ7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU5LDEzMCwyNDYsLjMpfQoudGFnLndhcm5pbmd7YmFja2dyb3VuZDpyZ2JhKDIzNCwxNzksOCwuMTUpO2NvbG9yOiNmZGU2OGE7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzNCwxNzksOCwuMyl9Ci50YWcuY2xvc2Vke2JhY2tncm91bmQ6cmdiYSgyMiwxNjMsNzQsLjE1KTtjb2xvcjojODZlZmFjO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMiwxNjMsNzQsLjMpfQoudGFnLm9wZW57YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9Ci50YWcuaGFsZi1vcGVue2JhY2tncm91bmQ6cmdiYSgyMzQsMTc5LDgsLjE1KTtjb2xvcjojZmRlNjhhO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMzQsMTc5LDgsLjMpfQouZm9ybS1yb3d7ZGlzcGxheTpmbGV4O2dhcDoxNHB4O2FsaWduLWl0ZW1zOmVuZDtmbGV4LXdyYXA6d3JhcDttYXJnaW4tYm90dG9tOjIwcHh9Ci5mb3JtLXJvdz4qe2ZsZXg6MTttaW4td2lkdGg6MjAwcHh9Ci5mb3JtLXJvdyBidXR0b257ZmxleDowIDAgYXV0b30KLmZvcm0tZ3JvdXAgbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojNzQ4OGE4O21hcmdpbi1ib3R0b206NnB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouOHB4O2ZvbnQtd2VpZ2h0OjYwMH0KLnRvYXN0e3Bvc2l0aW9uOmZpeGVkO3RvcDoyNHB4O3JpZ2h0OjI0cHg7cGFkZGluZzoxNHB4IDI0cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjUwMDt6LWluZGV4OjEwMDA7YW5pbWF0aW9uOnNsaWRlSW4gLjM1cyBjdWJpYy1iZXppZXIoLjE2LDEsLjMsMSk7bWF4LXdpZHRoOjQyMHB4O2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JveC1zaGFkb3c6MCA4cHggMzJweCByZ2JhKDAsMCwwLC40KX0KLnRvYXN0LnN1Y2Nlc3N7YmFja2dyb3VuZDpyZ2JhKDIyLDE2Myw3NCwuMik7Y29sb3I6Izg2ZWZhYztib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjIsMTYzLDc0LC4zKX0KLnRvYXN0LmVycm9ye2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjIpO2NvbG9yOiNmY2E1YTU7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwuMyl9CkBrZXlmcmFtZXMgc2xpZGVJbntmcm9te3RyYW5zZm9ybTp0cmFuc2xhdGVYKDEyMCUpIHNjYWxlKC45KTtvcGFjaXR5OjB9dG97dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMCkgc2NhbGUoMSk7b3BhY2l0eToxfX0KQGtleWZyYW1lcyBmYWRlSW57ZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoOHB4KX10b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCl9fQouZ3JpZC0ye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtnYXA6MjBweH0KLmljb3tkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7Ym9yZGVyLXJhZGl1czo2cHg7ZmxleC1zaHJpbms6MDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDB9Ci5pY28tb3ZlcnZpZXd7YmFja2dyb3VuZDpyZ2JhKDU2LDE4OSwyNDgsLjE1KTtjb2xvcjojMzhiZGY4fS5pY28ta2V5c3tiYWNrZ3JvdW5kOnJnYmEoMjQ1LDE1OCwxMSwuMTUpO2NvbG9yOiNmNTllMGJ9Ci5pY28tZ2F0ZXdheXtiYWNrZ3JvdW5kOnJnYmEoMTY3LDEzOSwyNTAsLjE1KTtjb2xvcjojYTc4YmZhfS5pY28tc3RyYXRlZ3l7YmFja2dyb3VuZDpyZ2JhKDUyLDIxMSwxNTMsLjE1KTtjb2xvcjojMzRkMzk5fQouaWNvLWxvZ3N7YmFja2dyb3VuZDpyZ2JhKDI0OCwxMTMsMTEzLC4xNSk7Y29sb3I6I2Y4NzE3MX0uaWNvLWFuYWx5dGljc3tiYWNrZ3JvdW5kOnJnYmEoMjUxLDE0Niw2MCwuMTUpO2NvbG9yOiNmYjkyM2N9Ci5pY28tc2V0dGluZ3N7YmFja2dyb3VuZDpyZ2JhKDE0OCwxNjMsMTg0LC4xNSk7Y29sb3I6I2UyZThmMH0uaWNvLWhlYWx0aHtiYWNrZ3JvdW5kOnJnYmEoMjQ0LDExNCwxODIsLjE1KTtjb2xvcjojZjQ3MmI2fQouaWNvLXNldHVwe2JhY2tncm91bmQ6cmdiYSgzNCwyMTEsMjM4LC4xNSk7Y29sb3I6IzIyZDNlZX0KCiNsb2FkaW5nLWJhcntwb3NpdGlvbjpmaXhlZDt0b3A6MDtsZWZ0OjA7aGVpZ2h0OjNweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZywjMzhiZGY4LCM4MThjZjgsIzM4YmRmOCk7YmFja2dyb3VuZC1zaXplOjIwMCUgMTAwJTt6LWluZGV4Ojk5OTk5O3RyYW5zaXRpb246d2lkdGggLjRzIGN1YmljLWJlemllciguMTYsMSwuMywxKSxvcGFjaXR5IC4zczt3aWR0aDowO29wYWNpdHk6MDtib3JkZXItcmFkaXVzOjAgMnB4IDJweCAwO2JveC1zaGFkb3c6MCAwIDEycHggcmdiYSg1NiwxODksMjQ4LC41KX0KI2xvYWRpbmctYmFyLmFjdGl2ZXtvcGFjaXR5OjF9YnV0dG9uLmxvYWRpbmd7cG9pbnRlci1ldmVudHM6bm9uZTtvcGFjaXR5Oi43O3Bvc2l0aW9uOnJlbGF0aXZlfWJ1dHRvbi5sb2FkaW5nOjphZnRlcntjb250ZW50OicnO3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7Ym9yZGVyLXJhZGl1czppbmhlcml0O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHRyYW5zcGFyZW50LHJnYmEoMjU1LDI1NSwyNTUsLjEpLHRyYW5zcGFyZW50KTtiYWNrZ3JvdW5kLXNpemU6MjAwJSAxMDAlO2FuaW1hdGlvbjpzaGltbWVyIDEuMnMgaW5maW5pdGV9CkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOjIwMCUgMH0xMDAle2JhY2tncm91bmQtcG9zaXRpb246LTIwMCUgMH19Ci5wYWdpbmF0aW9ue2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjEycHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6Izc0ODhhOH0KLnBhZ2luYXRpb24gYnV0dG9ue3BhZGRpbmc6NnB4IDE0cHg7Zm9udC1zaXplOjEycHg7Ym9yZGVyLXJhZGl1czo4cHh9CnN1bW1hcnl7Y29sb3I6IzM4YmRmODtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzo4cHggMDtmb250LXNpemU6MTRweH0KZGV0YWlsc3tiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjMpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjhweCAxNnB4O2JvcmRlcjoxcHggc29saWQgcmdiYSg1NiwxODksMjQ4LC4wNik7bWFyZ2luLWJvdHRvbToxNnB4fQoucGFnZS1kZXNje2JhY2tncm91bmQ6cmdiYSg1NiwxODksMjQ4LC4wNik7Ym9yZGVyLWxlZnQ6M3B4IHNvbGlkICMzOGJkZjg7cGFkZGluZzoxMnB4IDE2cHg7Ym9yZGVyLXJhZGl1czowIDEwcHggMTBweCAwO21hcmdpbi1ib3R0b206MjBweDtmb250LXNpemU6MTNweDtjb2xvcjojOTRhM2I4O2xpbmUtaGVpZ2h0OjEuNn0KLmtleS1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMjgwcHgsMWZyKSk7Z2FwOjE0cHh9Ci5rZXktY2FyZHtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgzMCw0MSw1OSwuNikscmdiYSgzMCw0MSw1OSwuMykpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE2cHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDU2LDE4OSwyNDgsLjA4KTt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMsYm9yZGVyLWNvbG9yIC4yc30ua2V5LWNhcmQ6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym9yZGVyLWNvbG9yOnJnYmEoNTYsMTg5LDI0OCwuMil9CkBtZWRpYShtYXgtd2lkdGg6NzY4cHgpey5zaWRlYmFye3dpZHRoOjYwcHg7cGFkZGluZzoxNnB4IDB9LnNpZGViYXIgaDEsLnNpZGViYXIgYSBzcGFuOmxhc3QtY2hpbGR7ZGlzcGxheTpub25lfS5zaWRlYmFyIGF7anVzdGlmeS1jb250ZW50OmNlbnRlcjtwYWRkaW5nOjExcHggMDttYXJnaW46MnB4IDZweH0ubWFpbntwYWRkaW5nOjIwcHh9LmdyaWQtMntncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfX0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7LnNpZGViYXJ7d2lkdGg6NDhweH0ubWFpbntwYWRkaW5nOjE2cHh9LmNhcmRze2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBpZD0ibG9hZGluZy1iYXIiPjwvZGl2Pgo8ZGl2IGNsYXNzPSJzaWRlYmFyIj4KPGgxPkJ1ZGRoaSBEd2FyPC9oMT4KPGEgb25jbGljaz0ic2hvd1RhYignb3ZlcnZpZXcnKSIgaWQ9Im5hdi1vdmVydmlldyIgY2xhc3M9ImFjdGl2ZSI+PHNwYW4gY2xhc3M9ImljbyBpY28tb3ZlcnZpZXciPiYjOTY3OTs8L3NwYW4+PHNwYW4+T3ZlcnZpZXc8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCdrZXlzJykiIGlkPSJuYXYta2V5cyI+PHNwYW4gY2xhc3M9ImljbyBpY28ta2V5cyI+JiM5ODgxOzwvc3Bhbj48c3Bhbj5BUEkgS2V5czwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ2dhdGV3YXknKSIgaWQ9Im5hdi1nYXRld2F5Ij48c3BhbiBjbGFzcz0iaWNvIGljby1nYXRld2F5Ij4mIzEyODI3NDs8L3NwYW4+PHNwYW4+R2F0ZXdheSBLZXlzPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ic2hvd1RhYignc3RyYXRlZ3knKSIgaWQ9Im5hdi1zdHJhdGVneSI+PHNwYW4gY2xhc3M9ImljbyBpY28tc3RyYXRlZ3kiPiYjODY0NDs8L3NwYW4+PHNwYW4+U3RyYXRlZ3k8L3NwYW4+PC9hPgo8IS0tIGxvZ3MgYW5kIHJlcS1sb2dzIHJlbW92ZWQgKEtWIHNwYWNlKSAtLT4KPGEgb25jbGljaz0ic2hvd1RhYignYW5hbHl0aWNzJykiIGlkPSJuYXYtYW5hbHl0aWNzIj48c3BhbiBjbGFzcz0iaWNvIGljby1hbmFseXRpY3MiPiYjMTI4MjAwOzwvc3Bhbj48c3Bhbj5BbmFseXRpY3M8L3NwYW4+PC9hPgo8YSBvbmNsaWNrPSJzaG93VGFiKCd1c2FnZScpIiBpZD0ibmF2LXVzYWdlIj48c3BhbiBjbGFzcz0iaWNvIGljby1vdmVydmlldyI+JiMxMjgyMDA7PC9zcGFuPjxzcGFuPlVzYWdlPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ic2hvd1RhYignaGVhbHRoJykiIGlkPSJuYXYtaGVhbHRoIj48c3BhbiBjbGFzcz0iaWNvIGljby1oZWFsdGgiPiYjMTAwMDM7PC9zcGFuPjxzcGFuPkhlYWx0aCBDaGVjazwvc3Bhbj48L2E+CjxhIG9uY2xpY2s9InNob3dUYWIoJ3NldHVwJykiIGlkPSJuYXYtc2V0dXAiPjxzcGFuIGNsYXNzPSJpY28gaWNvLXNldHVwIj4mIzg1MDU7PC9zcGFuPjxzcGFuPlNldHVwPC9zcGFuPjwvYT4KPGEgb25jbGljaz0ibG9nb3V0KCkiIHN0eWxlPSJtYXJnaW4tdG9wOmF1dG87Y29sb3I6I2Y4NzE3MSI+PHNwYW4gY2xhc3M9ImljbyIgc3R5bGU9ImJhY2tncm91bmQ6cmdiYSgyNDgsMTEzLDExMywuMTUpO2NvbG9yOiNmODcxNzEiPiYjODU5NDs8L3NwYW4+PHNwYW4+TG9nb3V0PC9zcGFuPjwvYT4KPC9kaXY+CjxkaXYgY2xhc3M9Im1haW4iIGlkPSJtYWluLWNvbnRlbnQiPjwvZGl2Pgo8c2NyaXB0PgpsZXQgX2xvYWRpbmdDb3VudCA9IDA7CmZ1bmN0aW9uIHNob3dMb2FkaW5nKCkgeyBfbG9hZGluZ0NvdW50Kys7IGNvbnN0IGIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9hZGluZy1iYXInKTsgaWYgKGIpIHsgYi5zdHlsZS53aWR0aCA9ICczMCUnOyBiLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOyB9IH0KZnVuY3Rpb24gaGlkZUxvYWRpbmcoKSB7IF9sb2FkaW5nQ291bnQtLTsgaWYgKF9sb2FkaW5nQ291bnQgPD0gMCkgeyBfbG9hZGluZ0NvdW50ID0gMDsgY29uc3QgYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2FkaW5nLWJhcicpOyBpZiAoYikgeyBiLnN0eWxlLndpZHRoID0gJzEwMCUnOyBzZXRUaW1lb3V0KCgpID0+IHsgYi5zdHlsZS53aWR0aCA9ICcwJzsgYi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsgfSwgMzAwKTsgfSB9IH0KZnVuY3Rpb24gYXBpKHBhdGgsIG9wdHMpIHsKICBzaG93TG9hZGluZygpOwogIGNvbnN0IGhkcnMgPSB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsIC4uLihvcHRzIHx8IHt9KS5oZWFkZXJzIH07CiAgcmV0dXJuIGZldGNoKCcvYWRtaW4vYXBpJyArIHBhdGgsIHsKICAgIGhlYWRlcnM6IGhkcnMsCiAgICBjcmVkZW50aWFsczogJ3NhbWUtb3JpZ2luJywgLi4uKG9wdHMgfHwge30pCiAgfSkudGhlbihyID0+IHsgaGlkZUxvYWRpbmcoKTsgaWYgKHIuc3RhdHVzID09PSA0MDEpIHsgd2luZG93LmxvY2F0aW9uLmhyZWYgPSAiL2FkbWluL2FwaS9sb2dvdXQiOyB0aHJvdyBuZXcgRXJyb3IoJ3VuYXV0aG9yaXplZCcpOyB9IHJldHVybiByLmpzb24oKTsgfSkuY2F0Y2goZSA9PiB7IGhpZGVMb2FkaW5nKCk7IHRocm93IGU7IH0pOwp9CmZ1bmN0aW9uIGVzYyhzKSB7IHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7JykucmVwbGFjZSgvJy9nLCcmI3gyNzsnKTsgfQpmdW5jdGlvbiBjYXAocykgeyByZXR1cm4gcy5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHMuc2xpY2UoMSk7IH0KCmZ1bmN0aW9uIHNob3dUb2FzdChtc2csIHR5cGUpIHsKICBjb25zdCBpY28gPSB0eXBlID09PSAnc3VjY2VzcycgPyAnXHUyNzEzJyA6IHR5cGUgPT09ICdlcnJvcicgPyAnXHUyNzE3JyA6ICdcdTIxMzknOwogIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgdC5jbGFzc05hbWUgPSAndG9hc3QgJyArIHR5cGU7CiAgdC5pbm5lckhUTUwgPSAnPHNwYW4gc3R5bGU9Im1hcmdpbi1yaWdodDoxMHB4O2ZvbnQtc2l6ZToxNnB4Ij4nICsgaWNvICsgJzwvc3Bhbj4nOwogIHQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUobXNnKSk7CiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh0KTsgc2V0VGltZW91dCgoKSA9PiB0LnJlbW92ZSgpLCAzNTAwKTsKfQpmdW5jdGlvbiBsb2dvdXQoKSB7IHdpbmRvdy5sb2NhdGlvbi5ocmVmID0gIi9hZG1pbi9hcGkvbG9nb3V0IjsgfQoKY29uc3QgUFJPVklERVJfVVJMUyA9IHsKICBncm9xOiAnaHR0cHM6Ly9jb25zb2xlLmdyb3EuY29tL2tleXMnLCBnb29nbGU6ICdodHRwczovL2Fpc3R1ZGlvLmdvb2dsZS5jb20vYXBpa2V5JywKICBvcGVucm91dGVyOiAnaHR0cHM6Ly9vcGVucm91dGVyLmFpL2tleXMnLCBtaXN0cmFsOiAnaHR0cHM6Ly9jb25zb2xlLm1pc3RyYWwuYWkvYXBpLWtleXMnLAogIGRlZXBzZWVrOiAnaHR0cHM6Ly9wbGF0Zm9ybS5kZWVwc2Vlay5jb20vYXBpX2tleXMnLCB0b2dldGhlcjogJ2h0dHBzOi8vYXBpLnRvZ2V0aGVyLmFpL3NldHRpbmdzL2FwaS1rZXlzJywKICBjZXJlYnJhczogJ2h0dHBzOi8vY29uc29sZS5jZXJlYnJhcy5haS9hcGkta2V5cycsIGFsaWJhYmE6ICdodHRwczovL2JhaWxpYW4uY29uc29sZS5hbGl5dW4uY29tLycsCiAgYWkyMTogJ2h0dHBzOi8vc3R1ZGlvLmFpMjEuY29tL2FjY291bnQvYXBpLWtleXMnLCBodWdnaW5nZmFjZTogJ2h0dHBzOi8vaHVnZ2luZ2ZhY2UuY28vc2V0dGluZ3MvdG9rZW5zJywKICBudmlkaWE6ICdodHRwczovL2J1aWxkLm52aWRpYS5jb20vbmltJywgY29oZXJlOiAnaHR0cHM6Ly9kYXNoYm9hcmQuY29oZXJlLmNvbS9hcGkta2V5cycKfTsKY29uc3QgUFJPVklERVJfQ09MT1JTID0gewogIGdyb3E6JyNmNTUwMzYnLCBnb29nbGU6JyM0Mjg1ZjQnLCBvcGVucm91dGVyOicjMTBhMzdmJywgbWlzdHJhbDonI2ZmNmQwMCcsCiAgZGVlcHNlZWs6JyM0ZjQ2ZTUnLCB0b2dldGhlcjonIzdjM2FlZCcsIGNlcmVicmFzOicjMDZiNmQ0JywgYWxpYmFiYTonI2Y5NzMxNicsCiAgYWkyMTonIzhiNWNmNicsIGh1Z2dpbmdmYWNlOicjZWFiMzA4JywgbnZpZGlhOicjNzZiOTAwJywgY29oZXJlOicjMDZkNmEwJwp9OwpmdW5jdGlvbiBsb2dvKHBuYW1lKSB7CiAgY29uc3QgYyA9IFBST1ZJREVSX0NPTE9SU1twbmFtZV0gfHwgJyMzOGJkZjgnOwogIHJldHVybiAnPHNwYW4gc3R5bGU9ImRpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7d2lkdGg6MjRweDtoZWlnaHQ6MjRweDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOicgKyBjICsgJztjb2xvcjojZmZmO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjcwMDttYXJnaW4tcmlnaHQ6OHB4O2ZsZXgtc2hyaW5rOjAiPicgKyBwbmFtZVswXS50b1VwcGVyQ2FzZSgpICsgJzwvc3Bhbj4nOwp9CmZ1bmN0aW9uIHNob3dUYWIobmFtZSkgewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zaWRlYmFyIGEnKS5mb3JFYWNoKGEgPT4gYS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7CiAgY29uc3QgbmF2ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25hdi0nICsgbmFtZSk7IGlmIChuYXYpIG5hdi5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICBpZiAoUEFHRVNbbmFtZV0gJiYgUEFHRVNbbmFtZV0ucmVuZGVyKSBQQUdFU1tuYW1lXS5yZW5kZXIoKTsKfQpmdW5jdGlvbiBzZXRDb250ZW50KGgpIHsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtYWluLWNvbnRlbnQnKTsKICBlbC5zdHlsZS5vcGFjaXR5ID0gJzAnOwogIHNldFRpbWVvdXQoKCkgPT4geyBlbC5pbm5lckhUTUwgPSBoOyBlbC5zdHlsZS50cmFuc2l0aW9uID0gJ29wYWNpdHkgLjI1cyc7IGVsLnN0eWxlLm9wYWNpdHkgPSAnMSc7IH0sIDUwKTsKfQpjb25zdCBQQUdFUyA9IHsKICBvdmVydmlldzogeyB0aXRsZTogJ0Rhc2hib2FyZCBPdmVydmlldycsIHJlbmRlcjogcmVuZGVyT3ZlcnZpZXcgfSwKICBrZXlzOiB7IHRpdGxlOiAnQVBJIEtleXMnLCByZW5kZXI6IHJlbmRlcktleXMgfSwKICBnYXRld2F5OiB7IHRpdGxlOiAnR2F0ZXdheSBLZXlzJywgcmVuZGVyOiByZW5kZXJHYXRld2F5IH0sCiAgc3RyYXRlZ3k6IHsgdGl0bGU6ICdSb3V0aW5nIFN0cmF0ZWd5JywgcmVuZGVyOiByZW5kZXJTdHJhdGVneSB9LAogIC8vIGxvZ3MgYW5kIHJlcS1sb2dzIHJlbW92ZWQgKEtWIHNwYWNlKQogIGFuYWx5dGljczogeyB0aXRsZTogJ0FuYWx5dGljcycsIHJlbmRlcjogcmVuZGVyQW5hbHl0aWNzIH0sCiAgdXNhZ2U6IHsgdGl0bGU6ICdVc2FnZSAmIExpbWl0cycsIHJlbmRlcjogcmVuZGVyVXNhZ2UgfSwKICBoZWFsdGg6IHsgdGl0bGU6ICdIZWFsdGggQ2hlY2snLCByZW5kZXI6IHJlbmRlckhlYWx0aCB9LAogIHNldHVwOiB7IHRpdGxlOiAnU2V0dXAgR3VpZGUnLCByZW5kZXI6IHJlbmRlclNldHVwIH0KfTsKc2hvd1RhYignb3ZlcnZpZXcnKTsKYXN5bmMgZnVuY3Rpb24gcmVuZGVyT3ZlcnZpZXcoKSB7CiAgY29uc3QgcyA9IGF3YWl0IGFwaSgnL3N0YXRzJyk7CiAgY29uc3QgYSA9IGF3YWl0IGFwaSgnL2FuYWx5dGljcz9kYXlzPTcnKTsKICBsZXQgdG90YWxDb3N0ID0gMDsgbGV0IHRvdGFsVG9rZW5zID0gMDsKICBpZiAoQXJyYXkuaXNBcnJheShhKSkgeyBhLmZvckVhY2goZCA9PiB7IHRvdGFsQ29zdCArPSBkLnRvdGFsQ29zdCB8fCAwOyB0b3RhbFRva2VucyArPSAoZC50b3RhbFByb21wdFRva2VucyB8fCAwKSArIChkLnRvdGFsQ29tcGxldGlvblRva2VucyB8fCAwKTsgfSk7IH0KICBjb25zdCBjb3B5VXJsID0gKCkgPT4geyBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCgnaHR0cHM6Ly9idWRkaGktZHdhci5yaWNoYXJkLWJyb3duLW1pYW1pLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnMnKTsgc2hvd1RvYXN0KCdVUkwgY29waWVkJywgJ3N1Y2Nlc3MnKTsgfTsKICBzZXRDb250ZW50KGAKICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLWJvdHRvbTo4cHgiPgogICAgICA8aDIgc3R5bGU9Im1hcmdpbjowO2JvcmRlcjpub25lO3BhZGRpbmc6MCI+RGFzaGJvYXJkIE92ZXJ2aWV3PC9oMj4KICAgICAgPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOiM3NDg4YTgiPiR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX08L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InBhZ2UtZGVzYyI+TW9uaXRvciBvdmVyYWxsIGdhdGV3YXkgcGVyZm9ybWFuY2U6IHJlcXVlc3QgY291bnQsIGtleSBoZWFsdGggYnkgc3RhdHVzIChhY3RpdmUvZGVhZC9leHBpcmVkL3dhcm1pbmcpLCBlc3RpbWF0ZWQgY29zdCBhbmQgdG9rZW4gdXNhZ2UgYWNyb3NzIGFsbCBwcm92aWRlcnMgb3ZlciB0aGUgbGFzdCA3IGRheXMuPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkcyI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wOCkscmdiYSg5OSwxMDIsMjQxLC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iPiR7cy5yZXF1ZXN0c1RvZGF5IHx8IDB9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5SZXF1ZXN0cyBUb2RheTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoOTksMTAyLDI0MSwuMDgpLHJnYmEoMTM5LDkyLDI0NiwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIj4ke3MudG90YWxLZXlzIHx8IDB9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Ub3RhbCBLZXlzPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgzNCwxOTcsOTQsLjA4KSxyZ2JhKDIyLDE2Myw3NCwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+JHtzLmFjdGl2ZUtleXMgfHwgMH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojODZlZmFjIj5BY3RpdmUgS2V5czwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMjM5LDY4LDY4LC4wOCkscmdiYSgyMjAsMzgsMzgsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmY2E1YTUiPiR7cy5kZWFkS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmY2E1YTUiPkRlYWQgS2V5czwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMjM0LDE3OSw4LC4wOCkscmdiYSgyMDIsMTM4LDQsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiR7cy53YXJtaW5nS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPldhcm1pbmcgS2V5czwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMTkyLDEzMiwyNTIsLjA4KSxyZ2JhKDE2OCw4NSwyNDcsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNjMDg0ZmMiPiR7cy5leHBpcmVkS2V5cyB8fCAwfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNjMDg0ZmMiPkV4cGlyZWQgS2V5czwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHJnYmEoMjUxLDE5MSwzNiwuMDgpLHJnYmEoMjQ1LDE1OCwxMSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+JCR7dG90YWxDb3N0LnRvRml4ZWQoNCl9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+RXN0LiBDb3N0ICg3ZCk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU5LDEzMCwyNDYsLjA4KSxyZ2JhKDM3LDk5LDIzNSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6IzkzYzVmZCI+JHt0b3RhbFRva2Vucy50b0xvY2FsZVN0cmluZygpfTwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiM5M2M1ZmQiPlRva2VucyAoN2QpPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJncmlkLWNvbHVtbjoxLy0xO2JvcmRlci1jb2xvcjpyZ2JhKDU2LDE4OSwyNDgsLjI1KTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wNikscmdiYSg5OSwxMDIsMjQxLC4wNCkpO21hcmdpbi1ib3R0b206MjBweCI+CiAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7bWFyZ2luLWJvdHRvbTo2cHgiPgogICAgICAgIDxzcGFuIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojNzQ4OGE4O2ZvbnQtd2VpZ2h0OjYwMDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjZweCI+WW91ciBHYXRld2F5IFVSTDwvc3Bhbj4KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9IiR7Y29weVVybH0iIGNsYXNzPSJzZWNvbmRhcnkiIHN0eWxlPSJwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxMnB4O21hcmdpbjowIj5Db3B5IFVSTDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGNvZGUgc3R5bGU9ImZvbnQtc2l6ZToxNHB4O2NvbG9yOiMzOGJkZjg7d29yZC1icmVhazpicmVhay1hbGw7ZGlzcGxheTpibG9jaztwYWRkaW5nOjEwcHggMTRweDtiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjQpO2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtZmFtaWx5OidGaXJhIENvZGUnLCdDb25zb2xhcycsbW9ub3NwYWNlIj5odHRwczovL2J1ZGRoaS1kd2FyLnJpY2hhcmQtYnJvd24tbWlhbWkud29ya2Vycy5kZXYvdjEvY2hhdC9jb21wbGV0aW9uczwvY29kZT4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6I2ZkZTY4YTttYXJnaW4tdG9wOjhweCI+VXNlIGEgR2F0ZXdheSBLZXkgYXMgQmVhcmVyIHRva2VuLiBTZWUgU2V0dXAgdGFiIGZvciBleGFtcGxlcy48L2Rpdj4KICAgIDwvZGl2PgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+UHJvdmlkZXIgVXNhZ2UgVG9kYXk8L2gyPgogICAgPGRpdiBjbGFzcz0iY2FyZHMiIGlkPSJ1c2FnZS1taW5pIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMjAwcHgsMWZyKSkiPkxvYWRpbmcuLi48L2Rpdj4KICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkRhaWx5IFJlcXVlc3RzICg3IGRheXMpPC9oMj4KICAgIDxwcmU+JHtlc2MoSlNPTi5zdHJpbmdpZnkoYSwgbnVsbCwgMikpfTwvcHJlPgogIGApOwogIHRyeSB7CiAgICBjb25zdCB1ciA9IGF3YWl0IGFwaSgnL2tleS11c2FnZScpOwogICAgY29uc3QgdWQgPSB1ci5wcm92aWRlcnMgfHwgdXI7CiAgICBjb25zdCB0ID0gdXIudG90YWxzIHx8IHsgcmVxdWVzdHM6IDAsIHN1Y2Nlc3NlczogMCwgZmFpbHVyZXM6IDAsIHByb21wdFRva2VuczogMCwgY29tcGxldGlvblRva2VuczogMCwgY29zdDogMCwga2V5czogMCB9OwogICAgbGV0IHJlbVJlcSA9IDAsIHJlbVRvayA9IDA7CiAgICBmb3IgKGNvbnN0IFtwbiwgcGRdIG9mIE9iamVjdC5lbnRyaWVzKHVkKSkgeyBmb3IgKGNvbnN0IGsgb2YgcGQua2V5cykgewogICAgICBpZiAoay5yYXRlTGltaXQpIHsgcmVtUmVxICs9IHBhcnNlSW50KGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1yZW1haW5pbmctcmVxdWVzdHMnXSB8fCBrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nJ10gfHwgMCk7IHJlbVRvayArPSBwYXJzZUludChrLnJhdGVMaW1pdFsneC1yYXRlbGltaXQtcmVtYWluaW5nLXRva2VucyddIHx8IDApOyB9CiAgICB9fQogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndXNhZ2UtbWluaScpOwogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgbGV0IGNhcmRzID0gJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJwYWRkaW5nOjEycHggMTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wOCkscmdiYSg5OSwxMDIsMjQxLC4wNSkpIj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTZweDtmb250LXdlaWdodDo3MDA7Y29sb3I6IzM4YmRmOCI+JyArIHQucmVxdWVzdHMgKyAnPC9kaXY+PGRpdiBzdHlsZT0iZm9udC1zaXplOjEwcHg7Y29sb3I6Izc0ODhhOCI+VG90YWwgUmVxPC9kaXY+PC9kaXY+JyArCiAgICAgICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHgiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxNnB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojODZlZmFjIj4nICsgcmVtUmVxICsgJzwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTgiPlJlbWFpbmluZyBSZXE8L2Rpdj48L2Rpdj4nICsKICAgICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJwYWRkaW5nOjEycHggMTZweCI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjE2cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiM5M2M1ZmQiPicgKyByZW1Ub2sudG9Mb2NhbGVTdHJpbmcoKSArICc8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTBweDtjb2xvcjojNzQ4OGE4Ij5SZW1haW5pbmcgVG9rPC9kaXY+PC9kaXY+JyArCiAgICAgICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHgiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxNnB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojZmRlNjhhIj4kJyArIHQuY29zdC50b0ZpeGVkKDQpICsgJzwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMHB4O2NvbG9yOiM3NDg4YTgiPlRvdGFsIENvc3Q8L2Rpdj48L2Rpdj4nOwogICAgZm9yIChjb25zdCBbcG4sIHBkXSBvZiBPYmplY3QuZW50cmllcyh1ZCkpIHsKICAgICAgY29uc3QgbGltID0gcGQubGltaXQgfHwge307IGNvbnN0IGRSZXEgPSBsaW0uZGFpbHlSZXF1ZXN0cyB8fCA5OTk5OTk7CiAgICAgIGxldCB0ciA9IDA7IGZvciAoY29uc3QgayBvZiBwZC5rZXlzKSB0ciArPSBrLnVzYWdlLnJlcXVlc3RzOwogICAgICBjb25zdCBwY3QgPSBNYXRoLm1pbigxMDAsIE1hdGgucm91bmQodHIgLyBkUmVxICogMTAwKSk7CiAgICAgIGNvbnN0IGNvbCA9IHBjdCA+IDgwID8gJyNmODcxNzEnIDogcGN0ID4gNTAgPyAnI2ZiYmYyNCcgOiAnIzM4YmRmOCc7CiAgICAgIGNhcmRzICs9ICc8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0icGFkZGluZzoxMnB4IDE2cHgiPjxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vlbjtmb250LXNpemU6MTNweDttYXJnaW4tYm90dG9tOjRweCI+PHNwYW4+JyArIGVzYyhwbikgKyAnPC9zcGFuPjxzcGFuIHN0eWxlPSJjb2xvcjonICsgY29sICsgJyI+JyArIHRyICsgJzwvc3Bhbj48L2Rpdj4nICsKICAgICAgICAnPGRpdiBzdHlsZT0iaGVpZ2h0OjZweDtiYWNrZ3JvdW5kOnJnYmEoNzEsODUsMTA1LC40KTtib3JkZXItcmFkaXVzOjNweDtvdmVyZmxvdzpoaWRkZW4iPjxkaXYgc3R5bGU9IndpZHRoOicgKyBwY3QgKyAnJTtoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOicgKyBjb2wgKyAnO2JvcmRlci1yYWRpdXM6M3B4Ij48L2Rpdj48L2Rpdj4nICsKICAgICAgICAnPGRpdiBzdHlsZT0iZm9udC1zaXplOjEwcHg7Y29sb3I6Izc0ODhhODttYXJnaW4tdG9wOjJweCI+bGltaXQ6ICcgKyBkUmVxICsgJyByZXEvZGF5PC9kaXY+PC9kaXY+JzsKICAgIH0KICAgIGVsLmlubmVySFRNTCA9IGNhcmRzIHx8ICc8cCBzdHlsZT0iY29sb3I6Izk0YTNiOCI+Tm8gZGF0YTwvcD4nOwogIH0gY2F0Y2gge30KfQphc3luYyBmdW5jdGlvbiByZW5kZXJLZXlzKCkgewogIGNvbnN0IHJhdyA9IGF3YWl0IGFwaSgnL2tleXMnKTsKICBjb25zdCBoZWFsdGggPSBhd2FpdCBhcGkoJy9rZXlzLWhlYWx0aCcpOwogIGxldCBjYXJkcyA9ICcnOwogIGZvciAoY29uc3QgcG5hbWUgb2YgT2JqZWN0LmtleXMoUFJPVklERVJfVVJMUykpIHsKICAgIGNvbnN0IGtleXMgPSByYXdbcG5hbWVdIHx8IFtdOwogICAgY29uc3QgdXJsID0gUFJPVklERVJfVVJMU1twbmFtZV07CiAgICBjb25zdCBwaGVhbHRoID0gaGVhbHRoW3BuYW1lXSB8fCB7fTsKICAgIGNvbnN0IGhhc0tleXMgPSBrZXlzLmxlbmd0aCA+IDA7CiAgICBsZXQga2V5Um93cyA9ICcnOwogICAgaWYgKGhhc0tleXMpIHsKICAgICAgZm9yIChjb25zdCBrIG9mIGtleXMpIHsKICAgICAgICBjb25zdCBtYXNrZWQgPSAoay5hcGlLZXl8fCcnKS5pbmNsdWRlcygnKioqKicpID8gay5hcGlLZXkgOiAnKioqKic7CiAgICAgICAgY29uc3QgaCA9IHBoZWFsdGhbay5pZF0gfHwge307CiAgICAgICAgY29uc3QgaXNXb3JraW5nID0gaC5jYlN0YXRlID09PSAnY2xvc2VkJyB8fCAhaC5jYlN0YXRlOwogICAgICAgIGNvbnN0IGJhZGdlID0gaXNXb3JraW5nID8gJzxzcGFuIGNsYXNzPSJ0YWcgb2siPldvcmtpbmc8L3NwYW4+JyA6ICc8c3BhbiBjbGFzcz0idGFnIGZhaWwiPkFsZXJ0PC9zcGFuPic7CiAgICAgICAga2V5Um93cyArPSAnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NnB4O3BhZGRpbmc6NnB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSg3MSw4NSwxMDUsLjIpIj4nICsKICAgICAgICAgICc8Y29kZSBpZD0ia2MtJyArIGsuaWQgKyAnIiBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izc0ODhhODtmbGV4OjE7YmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC40KTtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo0cHgiPicgKyBtYXNrZWQgKyAnPC9jb2RlPicgKyBiYWRnZSArCiAgICAgICAgICAnPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJnZXRLZXkoXCcnICsgZXNjKHBuYW1lKSArICdcJyxcJycgKyBlc2Moay5pZCkgKyAnXCcpIiBzdHlsZT0iY29sb3I6IzM4YmRmODtmb250LXNpemU6MTJweDt0ZXh0LWRlY29yYXRpb246bm9uZSI+U2hvdzwvYT48L2Rpdj4nOwogICAgICB9CiAgICB9IGVsc2UgewogICAgICBrZXlSb3dzID0gJzxwIHN0eWxlPSJjb2xvcjojNzY4OGE4O2ZvbnQtc2l6ZToxM3B4O3RleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6MTZweCAwIj5ObyBrZXlzIHNhdmVkPC9wPic7CiAgICB9CiAgICBjb25zdCBidG5MYWJlbCA9IGhhc0tleXMgPyAnQWRkIG1vcmUgS2V5JyA6ICdBZGQgS2V5JzsKICAgIGNhcmRzICs9ICc8ZGl2IGNsYXNzPSJrZXktY2FyZCI+JyArCiAgICAgICc8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206MTBweCI+JyArCiAgICAgICc8c3BhbiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlciI+PGEgaHJlZj0iJyArIHVybCArICciIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6IzM4YmRmODtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE2cHg7dGV4dC1kZWNvcmF0aW9uOm5vbmUiPicgKyBsb2dvKHBuYW1lKSArIGNhcChwbmFtZSkgKyAnPC9hPjwvc3Bhbj4nICsKICAgICAgJzxhIGhyZWY9IicgKyB1cmwgKyAnIiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOiM3NDg4YTg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmUiPkdldCBLZXkgJiM4NTk5OzwvYT48L2Rpdj4nICsKICAgICAga2V5Um93cyArCiAgICAgICc8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjhweDttYXJnaW4tdG9wOjEwcHgiPicgKwogICAgICAnPGlucHV0IGlkPSJrcGluLScgKyBlc2MocG5hbWUpICsgJyIgcGxhY2Vob2xkZXI9InNrLS4uLiIgc3R5bGU9ImZsZXg6MTtmb250LXNpemU6MTJweDtwYWRkaW5nOjhweCAxMHB4Ij4nICsKICAgICAgJzxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9InNhdmVLZXkoXCcnICsgZXNjKHBuYW1lKSArICdcJykiIHN0eWxlPSJwYWRkaW5nOjhweCAxNHB4O2ZvbnQtc2l6ZToxMnB4O3doaXRlLXNwYWNlOm5vd3JhcCI+JyArIGJ0bkxhYmVsICsgJzwvYnV0dG9uPjwvZGl2PjwvZGl2Pic7CiAgfQogIHNldENvbnRlbnQoJzxoMj5BUEkgS2V5czwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5NYW5hZ2UgcHJvdmlkZXIgQVBJIGtleXMuIFByb3ZpZGVyIG5hbWVzIGxpbmsgdG8gdGhlaXIga2V5LWdlbmVyYXRpb24gcGFnZXMuPC9kaXY+PGRpdiBjbGFzcz0ia2V5LWdyaWQiPicgKyBjYXJkcyArICc8L2Rpdj4nKTsKfQoKYXN5bmMgZnVuY3Rpb24gZ2V0S2V5KHBuYW1lLCBpZCkgewogIHRyeSB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpKCcva2V5cz9mdWxsPTEmcG5hbWU9JyArIGVuY29kZVVSSUNvbXBvbmVudChwbmFtZSkgKyAnJmlkPScgKyBlbmNvZGVVUklDb21wb25lbnQoaWQpKTsKICAgIGlmIChyLmFwaUtleSkgewogICAgICBjb25zdCBjb2RlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2tjLScgKyBpZCk7CiAgICAgIGlmIChjb2RlKSB7IGNvZGUudGV4dENvbnRlbnQgPSByLmFwaUtleTsgY29kZS5zdHlsZS51c2VyU2VsZWN0ID0gJ2F1dG8nOyB9CiAgICB9CiAgfSBjYXRjaCB7fQp9CmFzeW5jIGZ1bmN0aW9uIHNhdmVLZXkocG5hbWUpIHsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdrcGluLScgKyBwbmFtZSk7CiAgY29uc3QgYXBpS2V5ID0gaW5wdXQudmFsdWUudHJpbSgpOwogIGlmICghYXBpS2V5KSB7IHNob3dUb2FzdCgnRW50ZXIgQVBJIGtleScsICdlcnJvcicpOyByZXR1cm47IH0KICBjb25zdCBsYWJlbCA9IHBuYW1lICsgJ18nICsgRGF0ZS5ub3coKTsKICBpbnB1dC5kaXNhYmxlZCA9IHRydWU7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9rZXlzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwbmFtZSwgYXBpS2V5LCBsYWJlbCB9KSB9KTsKICAgIGlmIChyLm9rKSB7CiAgICAgIGF3YWl0IGFwaSgnL3Rlc3Qta2V5JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwbmFtZSwgaWQ6IHIuaWQgfSkgfSk7CiAgICAgIHNob3dUb2FzdCgnS2V5IHNhdmVkIGFuZCB0ZXN0ZWQnLCAnc3VjY2VzcycpOwogICAgfSBlbHNlIHsKICAgICAgc2hvd1RvYXN0KHIuZXJyb3IgfHwgJ0ZhaWxlZCB0byBzYXZlIGtleScsICdlcnJvcicpOwogICAgfQogIH0gY2F0Y2ggeyBzaG93VG9hc3QoJ0Vycm9yIHNhdmluZyBrZXknLCAnZXJyb3InKTsgfQogIHJlbmRlcktleXMoKTsKfQphc3luYyBmdW5jdGlvbiByZW5kZXJHYXRld2F5KCkgewogIGNvbnN0IGcgPSBhd2FpdCBhcGkoJy9nYXRld2F5LWtleXMnKTsKICBsZXQgcm93cyA9IGcubWFwKGsgPT4gJzx0ciBkYXRhLXdvcmQ9IicgKyBlc2Moay53b3JkKSArICciIGRhdGEtZW5hYmxlZD0iJyArIGsuZW5hYmxlZCArICciPjx0ZD4nICsgZXNjKGsud29yZCkgKyAnPC90ZD4nICsKICAgICc8dGQ+PHNwYW4gY2xhc3M9InRhZyAnICsgKGsuZW5hYmxlZD8nYWN0aXZlJzonZmFpbCcpICsgJyI+JyArIChrLmVuYWJsZWQ/J0FjdGl2ZSc6J0Rpc2FibGVkJykgKyAnPC9zcGFuPjwvdGQ+JyArCiAgICAnPHRkPicgKyAoay51c2FnZXx8MCkgKyAnPC90ZD4nICsKICAgICc8dGQgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5NGEzYjgiPicgKyAoay5jcmVhdGVkQXQgPyBuZXcgRGF0ZShrLmNyZWF0ZWRBdCkudG9Mb2NhbGVEYXRlU3RyaW5nKCkgOiAnJykgKyAnPC90ZD4nICsKICAgICc8dGQ+PGJ1dHRvbiBvbmNsaWNrPSJ0b2dnbGVHdyh0aGlzKSIgc3R5bGU9InBhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHgiPicgKyAoay5lbmFibGVkPydEaXNhYmxlJzonRW5hYmxlJykgKyAnPC9idXR0b24+JyArCiAgICAnPGJ1dHRvbiBjbGFzcz0iZGFuZ2VyIiBvbmNsaWNrPSJkZWxldGVHdyh0aGlzKSIgc3R5bGU9InBhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHgiPkRlbDwvYnV0dG9uPjwvdGQ+PC90cj4nKS5qb2luKCcnKTsKICBzZXRDb250ZW50KGAKICAgIDxoMj5HYXRld2F5IEtleXM8L2gyPgogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5DcmVhdGUgQVBJIGtleXMgZm9yIGV4dGVybmFsIGNsaWVudHMgdGhhdCBwcm94eSB0aHJvdWdoIHRoaXMgZ2F0ZXdheS4gRWFjaCBrZXkgaGFzIHVzYWdlIHRyYWNraW5nIGFuZCBjYW4gYmUgZW5hYmxlZC9kaXNhYmxlZCBpbmRlcGVuZGVudGx5LiBHZW5lcmF0ZSBhIHJhbmRvbSBrZXkgb3IgY3JlYXRlIGEgY3VzdG9tIHdvcmQtYmFzZWQgdG9rZW4uPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmb3JtLXJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JvdXAiPjxsYWJlbD5HYXRld2F5IEtleSAod29yZC90b2tlbik8L2xhYmVsPjxpbnB1dCBpZD0iZ3ctd29yZCIgcGxhY2Vob2xkZXI9Im15LWFwcC1rZXkiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJhZGRHdygpIj5BZGQgS2V5PC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9InNlY29uZGFyeSIgb25jbGljaz0iZ2VuR3dLZXkoKSI+R2VuZXJhdGUgS2V5PC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Xb3JkPC90aD48dGg+U3RhdHVzPC90aD48dGg+VXNhZ2U8L3RoPjx0aD5DcmVhdGVkPC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+CiAgICA8dGJvZHk+JHtyb3dzfTwvdGJvZHk+PC90YWJsZT4KICBgKTsKfQphc3luYyBmdW5jdGlvbiB0b2dnbGVHdyhlbCl7Y29uc3QgdHI9ZWwuY2xvc2VzdCgndHInKTtjb25zdCB3b3JkPXRyLmRhdGFzZXQud29yZDtjb25zdCBlbmFibGVkPXRyLmRhdGFzZXQuZW5hYmxlZD09PSd0cnVlJz9mYWxzZTp0cnVlO2F3YWl0IGFwaSgnL2dhdGV3YXkta2V5cycse21ldGhvZDonUEFUQ0gnLGJvZHk6SlNPTi5zdHJpbmdpZnkoe3dvcmQsZW5hYmxlZH0pfSk7IHJlbmRlckdhdGV3YXkoKTt9CmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUd3KGVsKXtjb25zdCB3b3JkPWVsLmNsb3Nlc3QoJ3RyJykuZGF0YXNldC53b3JkO2lmKCFjb25maXJtKCdEZWxldGUgIicrd29yZCsnIj8nKSlyZXR1cm47YXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyx7bWV0aG9kOidERUxFVEUnLGJvZHk6SlNPTi5zdHJpbmdpZnkoe3dvcmR9KX0pOyByZW5kZXJHYXRld2F5KCk7fQphc3luYyBmdW5jdGlvbiBhZGRHdygpewogIGNvbnN0IHdvcmQ9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2d3LXdvcmQnKS52YWx1ZTsKICBpZighd29yZCl7c2hvd1RvYXN0KCdXb3JkIHJlcXVpcmVkJywnZXJyb3InKTtyZXR1cm59CiAgYXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJyx7bWV0aG9kOidQT1NUJyxib2R5OkpTT04uc3RyaW5naWZ5KHt3b3JkfSl9KTsKICBzaG93VG9hc3QoJ0FkZGVkJywnc3VjY2VzcycpOyByZW5kZXJHYXRld2F5KCk7Cn0KYXN5bmMgZnVuY3Rpb24gZ2VuR3dLZXkoKSB7CiAgY29uc3QgY2hhcnMgPSAnYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5JzsKICBsZXQga2V5ID0gJyc7CiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzMjsgaSsrKSB7CiAgICBpZiAoaSA+IDAgJiYgaSAlIDggPT09IDApIGtleSArPSAnLSc7CiAgICBrZXkgKz0gY2hhcnMuY2hhckF0KE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNoYXJzLmxlbmd0aCkpOwogIH0KICBjb25zdCByID0gYXdhaXQgYXBpKCcvZ2F0ZXdheS1rZXlzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB3b3JkOiBrZXkgfSkgfSk7CiAgaWYgKHIub2spIHsgc2hvd1RvYXN0KCdLZXkgZ2VuZXJhdGVkIGFuZCBzYXZlZDogJyArIGtleSwgJ3N1Y2Nlc3MnKTsgcmVuZGVyR2F0ZXdheSgpOyB9CiAgZWxzZSB7IHNob3dUb2FzdCgnRmFpbGVkIHRvIHNhdmUga2V5JywgJ2Vycm9yJyk7IH0KfQphc3luYyBmdW5jdGlvbiByZW5kZXJTdHJhdGVneSgpIHsKICBjb25zdCBzID0gYXdhaXQgYXBpKCcvc3RyYXRlZ3knKTsKICBsZXQgaHRtbCA9ICc8aDI+Um91dGluZyBTdHJhdGVneTwvaDI+PGRpdiBjbGFzcz0icGFnZS1kZXNjIj5DaG9vc2UgaG93IHRoZSBnYXRld2F5IHNlbGVjdHMgYmV0d2VlbiBtdWx0aXBsZSBBUEkga2V5cyBmb3IgdGhlIHNhbWUgcHJvdmlkZXIuIFJvdW5kLXJvYmluIGN5Y2xlcyBldmVubHksIGxvd2VzdC1sYXRlbmN5IHBpY2tzIGZhc3Rlc3QsIGxlYXN0LWxvYWRlZCBwaWNrcyBsb3dlc3QgZmFpbHVyZSByYXRpby48L2Rpdj48ZGl2IGNsYXNzPSJjYXJkcyI+JzsKICBmb3IgKGNvbnN0IFtwcm92LCBzdHJhdF0gb2YgT2JqZWN0LmVudHJpZXMocykpIHsKICAgIGh0bWwgKz0gJzxkaXYgY2xhc3M9ImNhcmQiPjxoMyBzdHlsZT0iY29sb3I6IzM4YmRmODttYXJnaW4tYm90dG9tOjhweCI+JyArIGVzYyhwcm92KSArICc8L2gzPicgKwogICAgICAnPHAgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5NGEzYjgiPlN0cmF0ZWd5OiA8YiBzdHlsZT0iY29sb3I6I2UyZThmMCI+JyArIGVzYyhzdHJhdCkgKyAnPC9iPjwvcD48L2Rpdj4nOwogIH0KICBodG1sICs9ICc8L2Rpdj48aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+U2V0IFN0cmF0ZWd5PC9oMj48ZGl2IGNsYXNzPSJmb3JtLXJvdyI+JyArCiAgICAnPGRpdiBjbGFzcz0iZm9ybS1ncm91cCI+PGxhYmVsPlByb3ZpZGVyPC9sYWJlbD48c2VsZWN0IGlkPSJzdHItcHJvdmlkZXIiPicgKyBPYmplY3Qua2V5cyhQUk9WSURFUl9VUkxTKS5tYXAocD0+JzxvcHRpb24+JytwKyc8L29wdGlvbj4nKS5qb2luKCcnKSArICc8L3NlbGVjdD48L2Rpdj4nICsKICAgICc8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj48bGFiZWw+U3RyYXRlZ3k8L2xhYmVsPjxzZWxlY3QgaWQ9InN0ci1zdHJhdGVneSI+PG9wdGlvbj5yb3VuZC1yb2Jpbjwvb3B0aW9uPjxvcHRpb24+bG93ZXN0LWxhdGVuY3k8L29wdGlvbj48b3B0aW9uPmxlYXN0LWxvYWRlZDwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PicgKwogICAgJzxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9InVwZGF0ZVN0cigpIj5TZXQ8L2J1dHRvbj48L2Rpdj4nICsKICAgICc8aDI+UmF3PC9oMj48cHJlPicgKyBlc2MoSlNPTi5zdHJpbmdpZnkocywgbnVsbCwgMikpICsgJzwvcHJlPic7CiAgc2V0Q29udGVudChodG1sKTsKfQphc3luYyBmdW5jdGlvbiB1cGRhdGVTdHIoKSB7CiAgY29uc3QgcG5hbWUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RyLXByb3ZpZGVyJykudmFsdWU7CiAgY29uc3Qgc3RyYXRlZ3kgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RyLXN0cmF0ZWd5JykudmFsdWU7CiAgYXdhaXQgYXBpKCcvc3RyYXRlZ3knLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHBuYW1lLCBzdHJhdGVneSB9KSB9KTsKICBzaG93VG9hc3QoJ1VwZGF0ZWQnLCAnc3VjY2VzcycpOyByZW5kZXJTdHJhdGVneSgpOwp9CmFzeW5jIGZ1bmN0aW9uIHJlbmRlckFuYWx5dGljcygpIHsKICBjb25zdCBhID0gYXdhaXQgYXBpKCcvYW5hbHl0aWNzP2RheXM9MzAnKTsKICBpZighQXJyYXkuaXNBcnJheShhKXx8YS5sZW5ndGg9PT0wKXtzZXRDb250ZW50KCc8cD5ObyBhbmFseXRpY3MgZGF0YTwvcD4nKTtyZXR1cm59CiAgbGV0IHJvd3MgPSBhLm1hcChkID0+ICc8dHI+PHRkPicgKyAoZC5kYXRlfHwnw6LigqzigJ0nKSArICc8L3RkPjx0ZD4nICsgKGQucmVxdWVzdHN8fDApICsgJzwvdGQ+PHRkPicgKyAoZC5mYWlsdXJlc3x8MCkgKyAnPC90ZD4nICsKICAgICc8dGQ+JyArIChkLnN1Y2Nlc3Nlc3x8MCkgKyAnPC90ZD48dGQ+JyArICgoZC50b3RhbFByb21wdFRva2Vuc3x8MCkudG9Mb2NhbGVTdHJpbmcoKSkgKyAnPC90ZD4nICsKICAgICc8dGQ+JyArICgoZC50b3RhbENvbXBsZXRpb25Ub2tlbnN8fDApLnRvTG9jYWxlU3RyaW5nKCkpICsgJzwvdGQ+PHRkPiQnICsgKChkLnRvdGFsQ29zdHx8MCkudG9GaXhlZCg0KSkgKyAnPC90ZD48L3RyPicpLmpvaW4oJycpOwogIGxldCB0b3RhbFJlcT0wLHRvdGFsRmFpbD0wLHRvdGFsQ29zdD0wLHRvdGFsUHJvbXB0PTAsdG90YWxDb21wPTA7CiAgYS5mb3JFYWNoKGQ9Pnt0b3RhbFJlcSs9ZC5yZXF1ZXN0c3x8MDt0b3RhbEZhaWwrPWQuZmFpbHVyZXN8fDA7dG90YWxDb3N0Kz1kLnRvdGFsQ29zdHx8MDt0b3RhbFByb21wdCs9ZC50b3RhbFByb21wdFRva2Vuc3x8MDt0b3RhbENvbXArPWQudG90YWxDb21wbGV0aW9uVG9rZW5zfHwwO30pOwogIHNldENvbnRlbnQoYAogICAgPGgyPkFuYWx5dGljczwvaDI+CiAgICA8ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlZpZXcgcmVxdWVzdCBtZXRyaWNzIG92ZXIgdGhlIGxhc3QgMzAgZGF5czogdm9sdW1lLCBzdWNjZXNzL2ZhaWx1cmUgcmF0ZXMsIHRva2VuIHVzYWdlLCBhbmQgZXN0aW1hdGVkIGNvc3QgcGVyIHByb3ZpZGVyLiBVc2UgdGhlIEV4cG9ydCBDU1YgYnV0dG9uIGZvciBvZmZsaW5lIGFuYWx5c2lzLjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZHMiPgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iPiR7dG90YWxSZXF9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5SZXF1ZXN0cyAoMzBkKTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij4ke3RvdGFsRmFpbH08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiPkVycm9ycyAoMzBkKTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmRlNjhhIj4kJHt0b3RhbENvc3QudG9GaXhlZCg0KX08L2Rpdj48ZGl2IGNsYXNzPSJsYmwiPkNvc3QgKDMwZCk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIj4keyh0b3RhbFByb21wdCt0b3RhbENvbXApLnRvTG9jYWxlU3RyaW5nKCl9PC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Ub2tlbnMgKDMwZCk8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxMnB4Ij48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIG9uY2xpY2s9ImV4cG9ydEFuYWx5dGljcygpIj5FeHBvcnQgQ1NWPC9idXR0b24+PC9kaXY+CiAgICA8dGFibGU+PHRoZWFkPjx0cj48dGg+RGF0ZTwvdGg+PHRoPlJlcTwvdGg+PHRoPkVycjwvdGg+PHRoPlN1Y2Nlc3M8L3RoPjx0aD5Qcm9tcHQgVG9rPC90aD48dGg+Q29tcCBUb2s8L3RoPjx0aD5Db3N0PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PiR7cm93c308L3Rib2R5PjwvdGFibGU+CiAgYCk7Cn0KZnVuY3Rpb24gZXhwb3J0QW5hbHl0aWNzKCkgewogIHdpbmRvdy5vcGVuKCcvYWRtaW4vYXBpL2FuYWx5dGljcz9kYXlzPTMwJmZvcm1hdD1jc3YnLCAnX2JsYW5rJyk7Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyVXNhZ2UoKSB7CiAgY29uc3QgcmF3ID0gYXdhaXQgYXBpKCcva2V5LXVzYWdlJyk7CiAgY29uc3QgZGF0YSA9IHJhdy5wcm92aWRlcnMgfHwgcmF3OwogIGNvbnN0IHRvdGFscyA9IHJhdy50b3RhbHMgfHwgeyByZXF1ZXN0czogMCwgc3VjY2Vzc2VzOiAwLCBmYWlsdXJlczogMCwgcHJvbXB0VG9rZW5zOiAwLCBjb21wbGV0aW9uVG9rZW5zOiAwLCBjb3N0OiAwLCBwcm92aWRlcnM6IDAsIGtleXM6IDAgfTsKICBsZXQgaHRtbCA9ICc8aDI+VXNhZ2UgJmFtcDsgTGltaXRzPC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPk1vbml0b3IgdG9kYXlcJ3MgcmVxdWVzdCB2b2x1bWUsIHRva2VuIGNvbnN1bXB0aW9uLCBhbmQgZXN0aW1hdGVkIGNvc3QgcGVyIHByb3ZpZGVyLiBQcm9ncmVzcyBiYXJzIHNob3cgdXNhZ2UgYWdhaW5zdCBkYWlseSBxdW90YXMuIFJhdGUtbGltaXQgaGVhZGVycyBmcm9tIHVwc3RyZWFtIHByb3ZpZGVycyBhcmUgZGlzcGxheWVkIHBlciBrZXkuPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjIwcHgiPicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSg1NiwxODksMjQ4LC4wOCkscmdiYSg5OSwxMDIsMjQxLC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iPicgKyB0b3RhbHMucmVxdWVzdHMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5Ub3RhbCBSZXF1ZXN0cyBUb2RheTwvZGl2PjwvZGl2PicgKwogICAgJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcscmdiYSgzNCwxOTcsOTQsLjA4KSxyZ2JhKDIyLDE2Myw3NCwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+JyArIHRvdGFscy5zdWNjZXNzZXMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6Izg2ZWZhYyI+U3VjY2Vzc2VzPC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDIzOSw2OCw2OCwuMDgpLHJnYmEoMjIwLDM4LDM4LC4wNSkpIj48ZGl2IGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjojZmNhNWE1Ij4nICsgdG90YWxzLmZhaWx1cmVzICsgJzwvZGl2PjxkaXYgY2xhc3M9ImxibCIgc3R5bGU9ImNvbG9yOiNmY2E1YTUiPkZhaWx1cmVzPC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDU5LDEzMCwyNDYsLjA4KSxyZ2JhKDM3LDk5LDIzNSwuMDUpKSI+PGRpdiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6IzkzYzVmZCI+JyArICh0b3RhbHMucHJvbXB0VG9rZW5zICsgdG90YWxzLmNvbXBsZXRpb25Ub2tlbnMpLnRvTG9jYWxlU3RyaW5nKCkgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIiBzdHlsZT0iY29sb3I6IzkzYzVmZCI+VG90YWwgVG9rZW5zPC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyxyZ2JhKDI1MSwxOTEsMzYsLjA4KSxyZ2JhKDI0NSwxNTgsMTEsLjA1KSkiPjxkaXYgY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPiQnICsgdG90YWxzLmNvc3QudG9GaXhlZCg2KSArICc8L2Rpdj48ZGl2IGNsYXNzPSJsYmwiIHN0eWxlPSJjb2xvcjojZmRlNjhhIj5Ub3RhbCBDb3N0PC9kaXY+PC9kaXY+JyArCiAgICAnPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0ibnVtIj4nICsgdG90YWxzLmtleXMgKyAnPC9kaXY+PGRpdiBjbGFzcz0ibGJsIj5BY3RpdmUgS2V5czwvZGl2PjwvZGl2PicgKwogICAgJzwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMjgwcHgsMWZyKSkiPic7CiAgZm9yIChjb25zdCBbcG5hbWUsIHBkYXRhXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSkgewogICAgbGV0IHRvdFJlcSA9IDAsIHRvdFRvayA9IDAsIHRvdENvc3QgPSAwOwogICAgbGV0IHJsSHRtbCA9ICcnOwogICAgZm9yIChjb25zdCBrIG9mIHBkYXRhLmtleXMpIHsgCiAgICAgIHRvdFJlcSArPSBrLnVzYWdlLnJlcXVlc3RzOyB0b3RUb2sgKz0gay51c2FnZS5wcm9tcHRUb2tlbnMgKyBrLnVzYWdlLmNvbXBsZXRpb25Ub2tlbnM7IHRvdENvc3QgKz0gay51c2FnZS5jb3N0OwogICAgICBpZiAoay5yYXRlTGltaXQpIHsKICAgICAgICBjb25zdCBycmVtID0gay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LXJlbWFpbmluZy1yZXF1ZXN0cyddIHx8IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1yZW1haW5pbmcnXSB8fCAnPyc7CiAgICAgICAgY29uc3QgcmxpbSA9IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1saW1pdC1yZXF1ZXN0cyddIHx8IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1saW1pdCddIHx8ICc/JzsKICAgICAgICBjb25zdCB0cmVtID0gay5yYXRlTGltaXRbJ3gtcmF0ZWxpbWl0LXJlbWFpbmluZy10b2tlbnMnXSB8fCAnPyc7CiAgICAgICAgY29uc3QgdGxpbSA9IGsucmF0ZUxpbWl0Wyd4LXJhdGVsaW1pdC1saW1pdC10b2tlbnMnXSB8fCAnPyc7CiAgICAgICAgcmxIdG1sICs9ICc8cCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izg2ZWZhYzttYXJnaW4tdG9wOjRweCI+UmF0ZSBsaW1pdDogJyArIHJyZW0gKyAnLycgKyBybGltICsgJyByZXEsICcgKyB0cmVtICsgJy8nICsgdGxpbSArICcgdG9rPC9wPic7CiAgICAgIH0KICAgIH0KICAgIGh0bWwgKz0gJzxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjE2cHgiPjxoMyBzdHlsZT0iY29sb3I6IzM4YmRmODttYXJnaW4tYm90dG9tOjEycHgiPicgKyBlc2MocG5hbWUpICsgJzwvaDM+JyArCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6I2UyZThmMDttYXJnaW4tYm90dG9tOjRweCI+UmVxdWVzdHM6ICcgKyB0b3RSZXEgKyAnPC9wPicgKwogICAgICAnPHAgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5M2M1ZmQ7bWFyZ2luLWJvdHRvbTo0cHgiPlRva2VuczogJyArIHRvdFRvay50b0xvY2FsZVN0cmluZygpICsgJzwvcD4nICsKICAgICAgKHRvdENvc3QgPiAwID8gJzxwIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjojZmRlNjhhIj5Db3N0OiAkJyArIHRvdENvc3QudG9GaXhlZCg2KSArICc8L3A+JyA6ICcnKSArCiAgICAgIHJsSHRtbCArCiAgICAgICc8cCBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izc0ODhhOCI+JyArIHBkYXRhLmtleXMubGVuZ3RoICsgJyBrZXkocyk8L3A+PC9kaXY+JzsKICB9CiAgaWYgKGh0bWwgPT09ICc8ZGl2IGNsYXNzPSJjYXJkcyIgc3R5bGU9ImdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDI4MHB4LDFmcikpIj4nKSBodG1sICs9ICc8cCBzdHlsZT0iY29sb3I6Izk0YTNiOCI+Tm8gdXNhZ2UgZGF0YSB5ZXQ8L3A+JzsKICBodG1sICs9ICc8L2Rpdj4nOwogIHNldENvbnRlbnQoaHRtbCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHJlbmRlckhlYWx0aCgpIHsKICBzZXRDb250ZW50KCc8aDI+SGVhbHRoIENoZWNrPC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlByb2JlIGVhY2ggcHJvdmlkZXIga2V5IHRvIHZlcmlmeSBjb25uZWN0aXZpdHkgYW5kIGF1dGhlbnRpY2F0aW9uLiBTaG93cyBIVFRQIHN0YXR1cywgY2lyY3VpdC1icmVha2VyIHN0YXRlLCBhbmQgYW55IGVycm9yIG1lc3NhZ2VzIHJldHVybmVkIGJ5IHRoZSB1cHN0cmVhbSBBUEkuPC9kaXY+PHA+UnVubmluZyBoZWFsdGggY2hlY2tzLi4uPC9wPicpOwogIGNvbnN0IGggPSBhd2FpdCBhcGkoJy9oZWFsdGgtY2hlY2snKTsKICBsZXQgY2FyZHMgPSAnJzsKICBmb3IoY29uc3QgaXRlbSBvZiBoKSB7CiAgICBjb25zdCBvayA9IGl0ZW0uc3RhdHVzID09PSAnb2snID8gJ29rJyA6ICdmYWlsJzsKICAgIGNhcmRzICs9ICc8ZGl2IGNsYXNzPSJjYXJkIj48aDMgc3R5bGU9ImNvbG9yOiMzOGJkZjg7bWFyZ2luLWJvdHRvbTo2cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlciI+JyArIGxvZ28oaXRlbS5wcm92aWRlcikgKyBjYXAoaXRlbS5wcm92aWRlcikgKyAnIC0gJyArIGVzYyhpdGVtLm1vZGVsfHwnJykgKyAnPC9oMz4nICsKICAgICAgJzxwPjxzcGFuIGNsYXNzPSJ0YWcgJyArIG9rICsgJyI+JyArIGVzYyhpdGVtLnN0YXR1c3x8Jz8nKSArICc8L3NwYW4+PC9wPicgKwogICAgICAnPHAgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5NGEzYjgiPkhUVFA6ICcgKyAoaXRlbS5odHRwU3RhdHVzfHwnw6LigqzigJ0nKSArICcgfCBDQjogJyArIGVzYyhpdGVtLmNiU3RhdGV8fCfDouKCrOKAnScpICsgJzwvcD4nICsKICAgICAgKGl0ZW0uZXJyb3IgPyAnPHByZSBzdHlsZT0iZm9udC1zaXplOjExcHg7bWFyZ2luLXRvcDo0cHgiPicgKyBlc2MoaXRlbS5lcnJvcikgKyAnPC9wcmU+JyA6ICcnKSArICc8L2Rpdj4nOwogIH0KICBzZXRDb250ZW50KCc8aDI+SGVhbHRoIENoZWNrPC9oMj48ZGl2IGNsYXNzPSJwYWdlLWRlc2MiPlByb2JlIGVhY2ggcHJvdmlkZXIga2V5IHRvIHZlcmlmeSBjb25uZWN0aXZpdHkgYW5kIGF1dGhlbnRpY2F0aW9uLiBTaG93cyBIVFRQIHN0YXR1cywgY2lyY3VpdC1icmVha2VyIHN0YXRlLCBhbmQgYW55IGVycm9yIG1lc3NhZ2VzIHJldHVybmVkIGJ5IHRoZSB1cHN0cmVhbSBBUEkuPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiPicgKyAoY2FyZHMgfHwgJzxwPk5vIHJlc3VsdHM8L3A+JykgKyAnPC9kaXY+Jyk7Cn0KYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2V0dXAoKSB7CiAgc2V0Q29udGVudChgCiAgICA8aDI+U2V0dXAgR3VpZGU8L2gyPgogICAgPGRpdiBjbGFzcz0icGFnZS1kZXNjIj5TdGVwLWJ5LXN0ZXAgZ3VpZGUgZm9yIGNvbm5lY3RpbmcgY2xpZW50cyB0byB0aGUgZ2F0ZXdheS4gR2VuZXJhdGUgYSBHYXRld2F5IEtleSwgdGhlbiB1c2UgaXQgYXMgdGhlIEJlYXJlciB0b2tlbiB3aXRoIGFueSBPcGVuQUktY29tcGF0aWJsZSBjbGllbnQuIFN1cHBvcnRzIGNoYXQgY29tcGxldGlvbnMsIGVtYmVkZGluZ3MsIGFuZCBBbnRocm9waWMtc3R5bGUgbWVzc2FnZXMuPC9kaXY+CiAgICA8aDI+WW91ciBHYXRld2F5IFVSTDwvaDI+CiAgICA8cHJlIHN0eWxlPSJmb250LXNpemU6MTRweCI+UE9TVCBodHRwczovL2J1ZGRoaS1kd2FyLnlvdXItZG9tYWluLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnMKQXV0aG9yaXphdGlvbjogQmVhcmVyICZsdDt5b3VyLWdhdGV3YXkta2V5Jmd0OzwvcHJlPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5HZW5lcmF0ZSBhIEdhdGV3YXkgS2V5PC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5HbyB0byA8Yj5HYXRld2F5IEtleXM8L2I+IHRhYiBhbmQgY2xpY2sgPGI+R2VuZXJhdGUgS2V5PC9iPiB0byBjcmVhdGUgYSByYW5kb20gdG9rZW4sIG9yIGVudGVyIHlvdXIgb3duIHdvcmQuIFVzZSB0aGF0IGtleSBhcyB0aGUgQmVhcmVyIHRva2VuIGluIHlvdXIgYXBwcy48L3A+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPkV4YW1wbGU6IGNVUkw8L2gyPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjEzcHgiPmN1cmwgLVggUE9TVCBodHRwczovL2J1ZGRoaS1kd2FyLnlvdXItZG9tYWluLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnMgXFwKICAtSCAiQXV0aG9yaXphdGlvbjogQmVhcmVyIFlPVVJfR0FURVdBWV9LRVkiIFxcCiAgLUggIkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbiIgXFwKICAtZCAneyJtb2RlbCI6ImdwdC00byIsIm1lc3NhZ2VzIjpbeyJyb2xlIjoidXNlciIsImNvbnRlbnQiOiJoZWxsbyJ9XX0nPC9wcmU+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPkV4YW1wbGU6IEphdmFTY3JpcHQgKGZldGNoKTwvaDI+CiAgICA8cHJlIHN0eWxlPSJmb250LXNpemU6MTNweCI+Y29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKCJodHRwczovL2J1ZGRoaS1kd2FyLnlvdXItZG9tYWluLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnMiLCB7CiAgbWV0aG9kOiAiUE9TVCIsCiAgaGVhZGVyczogeyAiQXV0aG9yaXphdGlvbiI6ICJCZWFyZXIgWU9VUl9HQVRFV0FZX0tFWSIsICJDb250ZW50LVR5cGUiOiAiYXBwbGljYXRpb24vanNvbiIgfSwKICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG1vZGVsOiAiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0IiwgbWVzc2FnZXM6IFt7IHJvbGU6ICJ1c2VyIiwgY29udGVudDogImhpIiB9XSB9KQp9KTsKY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpOzwvcHJlPgoKICAgIDxoMiBzdHlsZT0ibWFyZ2luLXRvcDoyNHB4Ij5FeGFtcGxlOiBQeXRob248L2gyPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjEzcHgiPmltcG9ydCByZXF1ZXN0cwpyZXNwID0gcmVxdWVzdHMucG9zdCgKICAgICJodHRwczovL2J1ZGRoaS1kd2FyLnlvdXItZG9tYWluLndvcmtlcnMuZGV2L3YxL2NoYXQvY29tcGxldGlvbnMiLAogICAgaGVhZGVycz17IkF1dGhvcml6YXRpb24iOiAiQmVhcmVyIFlPVVJfR0FURVdBWV9LRVkifSwKICAgIGpzb249eyJtb2RlbCI6ICJncHQtNG8iLCAibWVzc2FnZXMiOiBbeyJyb2xlIjogInVzZXIiLCAiY29udGVudCI6ICJoZWxsbyJ9XX0KKQpwcmludChyZXNwLmpzb24oKSk8L3ByZT4KCiAgICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MjRweCI+V2ViaG9vayBOb3RpZmljYXRpb25zPC9oMj4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5TZXQgPGNvZGUgc3R5bGU9ImNvbG9yOiNmZGU2OGEiPldFQkhPT0tfVVJMPC9jb2RlPiBpbiB5b3VyIENsb3VkZmxhcmUgV29ya2VyIGVudmlyb25tZW50IHZhcmlhYmxlcyAoZS5nLiBTbGFjayB3ZWJob29rIFVSTCkuIFRoZSBnYXRld2F5IHdpbGwgUE9TVCBKU09OIGFsZXJ0cyBmb3IgYXV0aCBmYWlsdXJlcyBhbmQgY2lyY3VpdC1icmVha2VyIHN0YXRlIGNoYW5nZXMuPC9wPgogICAgPHByZSBzdHlsZT0iZm9udC1zaXplOjEzcHgiPkV4YW1wbGUgcGF5bG9hZDoKUE9TVCAmbHQ7V0VCSE9PS19VUkwmZ3Q7CnsiZXZlbnQiOiJhdXRoX2ZhaWx1cmUiLCJwcm92aWRlciI6Im9wZW5haSIsImtleUlkIjoic2stLi4uIiwic3RhdHVzIjo0MDF9PC9wcmU+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPkFETUlOX1BBU1NXT1JEIChFbnZpcm9ubWVudCBWYXJpYWJsZSk8L2gyPgogICAgPHAgc3R5bGU9ImZvbnQtc2l6ZToxNHB4O2NvbG9yOiM5NGEzYjgiPlNldCA8Y29kZSBzdHlsZT0iY29sb3I6I2ZkZTY4YSI+QURNSU5fUEFTU1dPUkQ8L2NvZGU+IGluIHlvdXIgQ2xvdWRmbGFyZSBXb3JrZXIgZW52IHZhcnMgdG8gb3ZlcnJpZGUgdGhlIGRlZmF1bHQgYWRtaW4gcGFzc3dvcmQgKDxjb2RlPjIyMDA8L2NvZGU+KS48L3A+CgogICAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPlN1cHBvcnRlZCBNb2RlbHM8L2gyPgogICAgPHAgc3R5bGU9ImZvbnQtc2l6ZToxNHB4O2NvbG9yOiM5NGEzYjgiPkZyZWUtdGllciBtb2RlbHM6IDxiPkdyb3E8L2I+IChsbGFtYS0zLjMtNzBiLXZlcnNhdGlsZSksIDxiPkdvb2dsZTwvYj4gKGdlbWluaS0yLjAtZmxhc2gpLCA8Yj5NaXN0cmFsPC9iPiAobWlzdHJhbC1zbWFsbC1sYXRlc3QpLCA8Yj5PcGVuUm91dGVyPC9iPiAoZnJlZSBtb2RlbHMpLjwvcD4KICAgIDxwIHN0eWxlPSJmb250LXNpemU6MTRweDtjb2xvcjojOTRhM2I4Ij5GaXJzdCBhZGQgeW91ciBwcm92aWRlciBBUEkga2V5cyBpbiB0aGUgPGI+QVBJIEtleXM8L2I+IHRhYiwgdGhlbiBnZW5lcmF0ZSBhIEdhdGV3YXkgS2V5IGluIHRoZSA8Yj5HYXRld2F5IEtleXM8L2I+IHRhYi48L3A+CiAgYCk7Cn0KPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=";

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
    return new Response("", { status: 302, headers: { Location: redirect, "Set-Cookie": "bfadmin=" + _ADMIN_PW + "; path=/; SameSite=Lax; HttpOnly; Secure", "Cache-Control": "no-cache" } });
  }
  await recordLoginAttempt(ip);
  const redirect = new URL(c.req.raw.url).searchParams.get("redirect") || "/admin";
  return new Response("", { status: 302, headers: { Location: redirect + "?error=1", "Cache-Control": "no-cache" } });
});

app.get("/admin/api/logout", async (c) => {
  return new Response("", { status: 302, headers: { "Set-Cookie": "bfadmin=; max-age=0; path=/; HttpOnly; Secure", Location: "/admin", "Cache-Control": "no-cache" } });
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
    _BF = env.BF; _WEBHOOK_URL = env.WEBHOOK_URL || ""; _ADMIN_PW = env.ADMIN_PASSWORD || "itsgood"; __MASTER_KEY = env.MASTER_KEY || "bf-master-kun-2026";
    return app.fetch(req, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    _BF = env.BF; _WEBHOOK_URL = env.WEBHOOK_URL || ""; _ADMIN_PW = env.ADMIN_PASSWORD || "itsgood"; __MASTER_KEY = env.MASTER_KEY || "bf-master-kun-2026";
    await handleCron();
  },
};



