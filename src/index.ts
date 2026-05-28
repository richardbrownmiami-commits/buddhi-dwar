const ADMIN_PASSWORD = "2200";
const MASTER_KEY = "bf-master-kun-2026";
const DAY_MS = 86400000;
const EVICT_DAYS = 5;

interface KeyEntry { id: string; apiKey: string; label: string; addedAt: number; }
interface HealthEntry { status: "active" | "warming" | "dead" | "expired"; lastCheck: number; consecutiveFailDays: number; lastError: string; lastUsed: number; successCount: number; failCount: number; avgResponseTime: number; lastResponseTime: number; }
interface GatewayKey { word: string; provider: string; model: string; label: string; createdAt: number; enabled: boolean; usage: number; }
interface EvictionLog { id: string; provider: string; keyId: string; reason: string; evictedAt: number; }
interface ReqLog { model: string; provider: string; keyId: string; status: number; latencyMs: number; timestamp: number; }
interface DailyAnalytics { date: string; requests: number; successes: number; failures: number; totalLatencyMs: number; providerStats: Record<string, { requests: number; successes: number; failures: number; totalLatencyMs: number }>; }
type Strategy = "round-robin" | "lowest-latency" | "least-loaded";

async function getKeys(provider: string): Promise<KeyEntry[]> {
  const raw = await BF.get("prov:" + provider + ":keys", "json");
  return (raw as any) || [];
}
async function setKeys(provider: string, keys: KeyEntry[]) {
  await BF.put("prov:" + provider + ":keys", JSON.stringify(keys));
}
async function getHealth(provider: string, keyId: string): Promise<HealthEntry> {
  const raw = await BF.get("prov:" + provider + ":health:" + keyId, "json");
  return (raw as any) || { status: "warming", lastCheck: 0, consecutiveFailDays: 0, lastError: "", lastUsed: 0, successCount: 0, failCount: 0, avgResponseTime: 0, lastResponseTime: 0 };
}
async function setHealth(provider: string, keyId: string, h: HealthEntry) {
  await BF.put("prov:" + provider + ":health:" + keyId, JSON.stringify(h));
}
async function getRotation(provider: string): Promise<number> {
  const raw = await BF.get("prov:" + provider + ":rotation");
  return raw ? parseInt(raw) : 0;
}
async function setRotation(provider: string, idx: number) {
  await BF.put("prov:" + provider + ":rotation", idx.toString());
}
async function getStrategy(provider: string): Promise<Strategy> {
  const raw = await BF.get("prov:" + provider + ":strategy");
  return (raw as Strategy) || "round-robin";
}
async function setStrategy(provider: string, s: Strategy) {
  await BF.put("prov:" + provider + ":strategy", s);
}
async function getGwKey(word: string): Promise<GatewayKey | null> {
  const raw = await BF.get("gw:" + word, "json");
  return (raw as any) || null;
}
async function setGwKey(word: string, gk: GatewayKey) {
  await BF.put("gw:" + word, JSON.stringify(gk));
}
async function getAllGwKeys(): Promise<GatewayKey[]> {
  const list = await BF.list({ prefix: "gw:" });
  const out: GatewayKey[] = [];
  for (const k of list.keys) {
    const v = await BF.get(k.name, "json");
    if (v) out.push(v as any);
  }
  return out;
}
async function incrStat(date: string) {
  const k = "stat:req:" + date;
  const v = await BF.get(k);
  await BF.put(k, v ? (parseInt(v) + 1).toString() : "1");
}
function getToday() { return new Date().toISOString().slice(0, 10); }
async function getStat(date: string): Promise<number> {
  const v = await BF.get("stat:req:" + date);
  return v ? parseInt(v) : 0;
}
async function logError(provider: string, keyId: string, error: string, message: string) {
  await BF.put("log:err:" + Date.now(), JSON.stringify({ provider, keyId, error, message, ts: Date.now() }));
}
async function logEviction(provider: string, keyId: string, reason: string) {
  const entry = { provider, keyId, reason, evictedAt: Date.now() };
  await BF.put("log:evict:" + Date.now(), JSON.stringify(entry));
  await sendWebhook("eviction", entry);
}
async function getRecentLogs(): Promise<any[]> {
  const list = await BF.list({ prefix: "log:", limit: 100 });
  const out: any[] = [];
  for (const k of list.keys) {
    const v = await BF.get(k.name, "json");
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
  await BF.put(key, JSON.stringify(rl), { expirationTtl: 604800 });
}

async function updateAnalytics(rl: ReqLog) {
  const key = "analytics:" + getToday();
  const raw = await BF.get(key, "json");
  const a: DailyAnalytics = (raw as any) || { date: getToday(), requests: 0, successes: 0, failures: 0, totalLatencyMs: 0, providerStats: {} };
  a.requests++;
  if (rl.status >= 200 && rl.status < 400) a.successes++; else a.failures++;
  a.totalLatencyMs += rl.latencyMs;
  if (!a.providerStats[rl.provider]) a.providerStats[rl.provider] = { requests: 0, successes: 0, failures: 0, totalLatencyMs: 0 };
  a.providerStats[rl.provider].requests++;
  if (rl.status >= 200 && rl.status < 400) a.providerStats[rl.provider].successes++; else a.providerStats[rl.provider].failures++;
  a.providerStats[rl.provider].totalLatencyMs += rl.latencyMs;
  await BF.put(key, JSON.stringify(a));
}

async function sendWebhook(event: string, data: any) {
  try {
    const url = (typeof WEBHOOK_URL !== "undefined" ? WEBHOOK_URL : "") || "";
    if (!url) return;
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

interface Env { BF: KVNamespace; WEBHOOK_URL?: string; }

async function selectKey(provider: string, keys: KeyEntry[], strategy: Strategy): Promise<{ key: KeyEntry; index: number } | null> {
  if (!keys.length) return null;
  if (strategy === "round-robin") {
    const idx = await getRotation(provider);
    for (let i = 0; i < keys.length; i++) {
      const ki = (idx + i) % keys.length;
      const h = await getHealth(provider, keys[ki].id);
      if (h.status !== "dead" && h.status !== "expired") return { key: keys[ki], index: ki };
    }
    return null;
  }
  if (strategy === "lowest-latency") {
    let best: { key: KeyEntry; index: number; latency: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      const h = await getHealth(provider, keys[i].id);
      if (h.status === "dead" || h.status === "expired") continue;
      const lat = h.avgResponseTime || Infinity;
      if (!best || lat < best.latency) best = { key: keys[i], index: i, latency: lat };
    }
    return best ? { key: best.key, index: best.index } : null;
  }
  if (strategy === "least-loaded") {
    let best: { key: KeyEntry; index: number; ratio: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      const h = await getHealth(provider, keys[i].id);
      if (h.status === "dead" || h.status === "expired") continue;
      const total = h.successCount + h.failCount;
      const ratio = total > 0 ? h.failCount / total : 0;
      if (!best || ratio < best.ratio) best = { key: keys[i], index: i, ratio };
    }
    return best ? { key: best.key, index: best.index } : null;
  }
  return null;
}

async function handleProxy(req: Request): Promise<Response> {
  const start = Date.now();
  try {
    const key = getBearer(req);
    if (!key) return new Response(JSON.stringify({ error: "missing auth" }), { status: 401, headers: { "content-type": "application/json" } });
    if (key !== MASTER_KEY) {
      const gw = await getGwKey(key);
      if (!gw || !gw.enabled) return new Response(JSON.stringify({ error: "invalid gateway key" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const body = await req.json() as any;
    const model = body.model || "";
    const p = PROVIDERS.find((pr: any) => pr.models.some((m: string) => model.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(model.toLowerCase().split("/").pop() || "")));
    if (!p) return new Response(JSON.stringify({ error: "unsupported model: " + model }), { status: 400, headers: { "content-type": "application/json" } });
    const keys = await getKeys(p.name);
    if (!keys.length) return new Response(JSON.stringify({ error: "no keys configured for " + p.name }), { status: 502, headers: { "content-type": "application/json" } });
    const strategy = await getStrategy(p.name);
    const selected = await selectKey(p.name, keys, strategy);
    if (!selected) return new Response(JSON.stringify({ error: "no healthy keys for " + p.name }), { status: 502, headers: { "content-type": "application/json" } });
    const ke = selected.key;
    const h = await getHealth(p.name, ke.id);
    const isStream = body.stream === true;
    try {
      const targetUrl = p.baseUrl + (p.type === "openai" ? "/chat/completions" : "");
      const hdrs: any = { "Content-Type": "application/json" };
      if (p.type === "openai") hdrs["Authorization"] = "Bearer " + ke.apiKey;
      const resp = await fetch(targetUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
      const latency = Date.now() - start;
      const rl: ReqLog = { model, provider: p.name, keyId: ke.id, status: resp.status, latencyMs: latency, timestamp: Date.now() };
      await logRequest(rl);
      await updateAnalytics(rl);
      if (resp.ok) {
        await setRotation(p.name, (selected.index + 1) % keys.length);
        h.status = "active"; h.successCount++; h.lastUsed = Date.now(); h.lastCheck = Date.now();
        h.lastResponseTime = latency;
        h.avgResponseTime = h.avgResponseTime ? Math.round((h.avgResponseTime * (h.successCount - 1) + latency) / h.successCount) : latency;
        await setHealth(p.name, ke.id, h);
        await incrStat(getToday());
        if (isStream) {
          const { readable, writable } = new TransformStream();
          resp.body!.pipeTo(writable);
          return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" } });
        }
        return resp;
      }
      const txt = await resp.text();
      h.failCount++; h.lastError = resp.status + ": " + txt.slice(0, 200); h.lastCheck = Date.now();
      if (resp.status === 401 || resp.status === 403) h.consecutiveFailDays++;
      await setHealth(p.name, ke.id, h);
      await logError(p.name, ke.id, "auth", resp.status + ": " + txt.slice(0, 200));
      await sendWebhook("auth_failure", { provider: p.name, keyId: ke.id, status: resp.status });
      return new Response(JSON.stringify({ error: "upstream error: " + resp.status, detail: txt.slice(0, 300) }), { status: 502, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      const latency = Date.now() - start;
      const rl: ReqLog = { model, provider: p.name, keyId: ke.id, status: 0, latencyMs: latency, timestamp: Date.now() };
      await logRequest(rl); await updateAnalytics(rl);
      h.failCount++; h.lastError = e.message; h.lastCheck = Date.now();
      await setHealth(p.name, ke.id, h);
      await logError(p.name, ke.id, "network", e.message);
      return new Response(JSON.stringify({ error: "network error: " + e.message }), { status: 502, headers: { "content-type": "application/json" } });
    }
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
      await BF.delete("gw:" + body.word);
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
    const list = await BF.list({ prefix: "reqlog:" + date + ":", limit: 200 });
    const out: ReqLog[] = [];
    for (const k of list.keys) {
      const v = await BF.get(k.name, "json");
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
      const raw = await BF.get(key, "json");
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

  if (path === "/admin/api/send-webhook-test") {
    await sendWebhook("test", { message: "This is a test webhook from buddhi-dwar admin", timestamp: Date.now() });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
}
