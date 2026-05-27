const ADMIN_PASSWORD = "2200";const MASTER_KEY = "bf-master-kun-2026";const DAY_MS = 86400000;const EVICT_DAYS = 5;

interface KeyEntry { id: string; apiKey: string; label: string; addedAt: number; }
interface HealthEntry { status: "active" | "warming" | "dead" | "expired"; lastCheck: number; consecutiveFailDays: number; lastError: string; lastUsed: number; successCount: number; failCount: number; }
interface GatewayKey { word: string; provider: string; model: string; label: string; createdAt: number; enabled: boolean; usage: number; } interface EvictionLog { id: string; provider: string; keyId: string; reason: string; evictedAt: number; }

async function getKeys(provider: string): Promise<KeyEntry[]> {
  const raw = await BF.get("prov:" + provider + ":keys", "json");
  return (raw as any) || [];
}
async function setKeys(provider: string, keys: KeyEntry[]) {
  await BF.put("prov:" + provider + ":keys", JSON.stringify(keys));
}
async function getHealth(provider: string, keyId: string): Promise<HealthEntry> {
  const raw = await BF.get("prov:" + provider + ":health:" + keyId, "json");
  return (raw as any) || { status:"warming", lastCheck:0, consecutiveFailDays:0, lastError:"", lastUsed:0, successCount:0, failCount:0 };
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
function getToday() { return new Date().toISOString().slice(0,10); }
async function getStat(date: string): Promise<number> {
  const v = await BF.get("stat:req:" + date);
  return v ? parseInt(v) : 0;
}
async function logError(provider: string, keyId: string, error: string, message: string) {
  await BF.put("log:err:" + Date.now(), JSON.stringify({ provider, keyId, error, message, ts: Date.now() }));
}
async function logEviction(provider: string, keyId: string, reason: string) {
  await BF.put("log:evict:" + Date.now(), JSON.stringify({ provider, keyId, reason, evictedAt: Date.now() }));
}
async function getRecentLogs(): Promise<any[]> {
  const list = await BF.list({ prefix: "log:", limit: 100 });
  const out: any[] = [];
  for (const k of list.keys) {
    const v = await BF.get(k.name, "json");
    if (v) out.push(v as any);
  }
  return out.sort((a:any,b:any) => (b.ts||b.evictedAt||0)-(a.ts||a.evictedAt||0));
}
function checkAdmin(req: Request): boolean {
  const c = req.headers.get("Cookie")||"";
  return c.includes("bfadmin="+ADMIN_PASSWORD);
}
function getBearer(req: Request): string|null {
  const m = (req.headers.get("Authorization")||"").match(/^Bearer\s+(.+)$/i);
  return m?m[1]:null;
}async function handleProxy(req: Request): Promise<Response> {try{const key = getBearer(req);if(!key)return new Response(JSON.stringify({error:"missing auth"}),{status:401,headers:{"content-type":"application/json"}});if(key!==MASTER_KEY){const gw=await getGwKey(key);if(!gw||!gw.enabled)return new Response(JSON.stringify({error:"invalid gateway key"}),{status:403,headers:{"content-type":"application/json"}});}const body=await req.json() as any;const model=body.model||"";;const p=PROVIDERS.find((pr:any)=>pr.models.some((m:string)=>model.toLowerCase().includes(m.toLowerCase())||m.toLowerCase().includes(model.toLowerCase().split("/").pop()||"")));if(!p)return new Response(JSON.stringify({error:"unsupported model: "+model}),{status:400,headers:{"content-type":"application/json"}});const keys=await getKeys(p.name);if(!keys.length)return new Response(JSON.stringify({error:"no keys configured for "+p.name}),{status:502,headers:{"content-type":"application/json"}});let idx=await getRotation(p.name);let lastErr=null;for(let i=0;i<keys.length;i++){const ki=(idx+i)%keys.length;const ke=keys[ki];const h=await getHealth(p.name,ke.id);if(h.status==="dead"||h.status==="expired")continue;try{const targetUrl=p.baseUrl+(p.type==="openai"?"/chat/completions":"");const hdrs:any={"Content-Type":"application/json"};if(p.type==="openai"){hdrs["Authorization"]="Bearer "+ke.apiKey;}const resp=await fetch(targetUrl,{method:"POST",headers:hdrs,body:JSON.stringify(body)});if(resp.ok){await setRotation(p.name,(ki+1)%keys.length);h.status="active";h.successCount++;h.lastUsed=Date.now();h.lastCheck=Date.now();await setHealth(p.name,ke.id,h);await incrStat(getToday());return resp;}const txt=await resp.text();if(resp.status===429||resp.status===401||resp.status===403){h.failCount++;h.lastError=resp.status+": "+txt.slice(0,200);h.lastCheck=Date.now();if(resp.status===401||resp.status===403)h.consecutiveFailDays++;await setHealth(p.name,ke.id,h);await logError(p.name,ke.id,"auth",resp.status+": "+txt.slice(0,200));lastErr=resp;continue}lastErr=resp;continue}catch(e:any){h.failCount++;h.lastError=e.message;h.lastCheck=Date.now();await setHealth(p.name,ke.id,h);await logError(p.name,ke.id,"network",e.message);lastErr=e;continue}}const msg=lastErr instanceof Response?"upstream error: "+lastErr.status:"all keys failed: "+lastErr;return new Response(JSON.stringify({error:msg}),{status:502,headers:{"content-type":"application/json"}})}catch(e:any){return new Response(JSON.stringify({error:"gateway error: "+e.message}),{status:500,headers:{"content-type":"application/json"}})}}async function handleModels(): Promise<Response> {;const all:any[]=[];for(const p of PROVIDERS){all.push(...p.models.map((m:string)=>({id:m,provider:p.name,object:"model",created:Date.now(),owned_by:"bifrost"})));}return new Response(JSON.stringify({object:"list",data:all}),{headers:{"content-type":"application/json","access-control-allow-origin":"*"}});}

async function handleAdminApi(req: Request, path: string): Promise<Response> {if(!checkAdmin(req))return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{"content-type":"application/json"}});const url=new URL(req.url);;

if(path==="/admin/api/providers"){if(req.method==="GET")return new Response(JSON.stringify(PROVIDERS),{headers:{"content-type":"application/json"}});}

if(path==="/admin/api/keys"){if(req.method==="GET"){const result:any={};for(const p of PROVIDERS){result[p.name]=await getKeys(p.name);}return new Response(JSON.stringify(result),{headers:{"content-type":"application/json"}});}if(req.method==="POST"){const body=await req.json() as any;const{pname,apiKey,label}=body;if(!pname||!apiKey)return new Response(JSON.stringify({error:"provider and apiKey required"}),{status:400,headers:{"content-type":"application/json"}});const keys=await getKeys(pname);const id=Date.now().toString(36);keys.push({id,apiKey,label:label||"key-"+keys.length,addedAt:Date.now()});await setKeys(pname,keys);return new Response(JSON.stringify({ok:true,id}),{headers:{"content-type":"application/json"}});}if(req.method==="DELETE"){const body=await req.json() as any;const{pname,id}=body;if(!pname||!id)return new Response(JSON.stringify({error:"provider and id required"}),{status:400,headers:{"content-type":"application/json"}});let keys=await getKeys(pname);keys=keys.filter((k:any)=>k.id!==id);await setKeys(pname,keys);await logEviction(pname,id,"manual_remove");return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}});}}

if(path==="/admin/api/gateway-keys"){if(req.method==="GET"){const gws=await getAllGwKeys();return new Response(JSON.stringify(gws),{headers:{"content-type":"application/json"}});}if(req.method==="POST"){const body=await req.json() as any;if(!body.word||!body.provider)return new Response(JSON.stringify({error:"word and provider required"}),{status:400,headers:{"content-type":"application/json"}});const gw:GatewayKey={word:body.word,provider:body.provider,model:body.model||"",label:body.label||body.word,createdAt:Date.now(),enabled:true,usage:0};await setGwKey(body.word,gw);return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}});}if(req.method==="DELETE"){const body=await req.json() as any;if(!body.word)return new Response(JSON.stringify({error:"word required"}),{status:400,headers:{"content-type":"application/json"}});await BF.delete("gw:"+body.word);return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}});}if(req.method==="PATCH"){const body=await req.json() as any;if(!body.word)return new Response(JSON.stringify({error:"word required"}),{status:400,headers:{"content-type":"application/json"}});const gw=await getGwKey(body.word);if(!gw)return new Response(JSON.stringify({error:"not found"}),{status:404,headers:{"content-type":"application/json"}});if(body.enabled!==undefined)gw.enabled=body.enabled;if(body.model)gw.model=body.model;if(body.label)gw.label=body.label;await setGwKey(body.word,gw);return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}});}}

if(path==="/admin/api/stats"){const today=getToday();const reqsToday=await getStat(today);let totalKeys=0;let activeKeys=0;let deadKeys=0;let warmingKeys=0;let expiredKeys=0;for(const p of PROVIDERS){const keys=await getKeys(p.name);totalKeys+=keys.length;for(const k of keys){const h=await getHealth(p.name,k.id);if(h.status==="active")activeKeys++;else if(h.status==="dead")deadKeys++;else if(h.status==="expired")expiredKeys++;else warmingKeys++;}}return new Response(JSON.stringify({requestsToday:reqsToday,totalKeys,activeKeys,deadKeys,warmingKeys,expiredKeys}),{headers:{"content-type":"application/json"}});}

if(path==="/admin/api/logs"){const logs=await getRecentLogs();return new Response(JSON.stringify(logs),{headers:{"content-type":"application/json"}});}

if(path==="/admin/api/test-key"){const body=await req.json() as any;const{pname,id}=body;if(!pname||!id)return new Response(JSON.stringify({error:"provider and id required"}),{status:400,headers:{"content-type":"application/json"}});const keys=await getKeys(pname);const ke=keys.find((k:any)=>k.id===id);if(!ke)return new Response(JSON.stringify({error:"key not found"}),{status:404,headers:{"content-type":"application/json"}});const p=PROVIDERS.find((pr:any)=>pr.name===pname);if(!p)return new Response(JSON.stringify({error:"provider not found"}),{status:404,headers:{"content-type":"application/json"}});try{const hdrs:any={"Content-Type":"application/json"};if(p.type==="openai")hdrs["Authorization"]="Bearer "+ke.apiKey;const testBody={model:p.models[0],messages:[{role:"user",content:"ping"}],max_tokens:1};const resp=await fetch(p.baseUrl+"/chat/completions",{method:"POST",headers:hdrs,body:JSON.stringify(testBody)});const h=await getHealth(pname,ke.id);if(resp.ok){h.status="active";h.lastCheck=Date.now();h.consecutiveFailDays=0;h.lastError="";await setHealth(pname,ke.id,h);return new Response(JSON.stringify({ok:true,status:resp.status}),{headers:{"content-type":"application/json"}});}else{const txt=await resp.text();h.lastError=resp.status+": "+txt.slice(0,200);h.lastCheck=Date.now();if(resp.status===401||resp.status===403)h.consecutiveFailDays++;await setHealth(pname,ke.id,h);return new Response(JSON.stringify({ok:false,status:resp.status,error:txt.slice(0,200)}),{headers:{"content-type":"application/json"}});}}catch(e:any){return new Response(JSON.stringify({ok:false,error:e.message}),{headers:{"content-type":"application/json"}});}}

return new Response(JSON.stringify({error:"not found"}),{status:404,headers:{"content-type":"application/json"}});}async function handleCron() {;for(const p of PROVIDERS){const keys=await getKeys(p.name);for(const ke of keys){const h=await getHealth(p.name,ke.id);if(h.status==="dead"||h.status==="expired")continue;try{const hdrs:any={"Content-Type":"application/json"};if(p.type==="openai")hdrs["Authorization"]="Bearer "+ke.apiKey;const testBody={model:p.models[0],messages:[{role:"user",content:"ping"}],max_tokens:1};const resp=await fetch(p.baseUrl+"/chat/completions",{method:"POST",headers:hdrs,body:JSON.stringify(testBody)});if(resp.ok){h.status="active";h.lastCheck=Date.now();h.consecutiveFailDays=0;h.lastError="";}else{h.failCount++;if(resp.status===401||resp.status===403){h.consecutiveFailDays++;h.lastError=resp.status+": auth failed";}else{h.lastError=resp.status+": upstream error";}if(h.consecutiveFailDays>=EVICT_DAYS){h.status="expired";await logEviction(p.name,ke.id,"5_day_eviction: "+h.lastError);}}await setHealth(p.name,ke.id,h);}catch(e:any){h.failCount++;h.lastError="network: "+e.message;h.consecutiveFailDays++;if(h.consecutiveFailDays>=EVICT_DAYS){h.status="expired";await logEviction(p.name,ke.id,"5_day_eviction: "+h.lastError);}await setHealth(p.name,ke.id,h);}}}}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/admin/login" && req.method === "POST") {
      const form = await req.formData();
      const pass = form.get("password");
      if (pass === ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ok:true}), {
          status: 200,
          headers: {"Set-Cookie": "bfadmin=" + ADMIN_PASSWORD + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400", "content-type":"application/json"}
        });
      }
      return new Response(JSON.stringify({error:"invalid password"}), {status:401, headers:{"content-type":"application/json"}});
    }

    if (path.startsWith("/admin/api/")) {
      return await handleAdminApi(req, path, env);
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      return await handleProxy(req, env);
    }

    if ((path === "/v1/models" || path === "/v1/models") && req.method === "GET") {
      return await handleModels();
    }

    return new Response(JSON.stringify({service:"bifrost", status:"ok", docs:"https://github.com/richardbrownmiami-commits/devforge-ai/tree/main/bifrost"}), {
      headers: {"content-type":"application/json", "access-control-allow-origin":"*"}
    });
  },

  async scheduled(event: any, env: Env, ctx: any) {
    await handleCron(env);
  },
};
