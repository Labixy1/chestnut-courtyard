import {
  DATA_KEYS, addMemoryEvents, appendButlerItem, backupStatus, exportCloudState, importCloudState,
  memoryAction, memoryContext, memoryState, mergeLocalState, permissions, readData, readState,
  resetDemoState, saveTask, seedDemoState, setMemoryAssist, setStewardMode, syncButlerState, tasks,
  updateTask, writeData, writeState
} from "./state.js";

const securityHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: securityHeaders});
const now = () => new Date().toISOString();
const LOGIN_ATTEMPT_LIMIT = 50;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
let accessKeysCache = {issuer: "", expires: 0, keys: []};

const providerConfig = (env, name) => {
  const configs = {
    openai: {key: env.OPENAI_API_KEY, base: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.COZY_OPENAI_MODEL || "gpt-5.6-luna"},
    deepseek: {key: env.DEEPSEEK_API_KEY, base: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1", model: env.COZY_DEEPSEEK_MODEL || "deepseek-v4-flash"},
    glm: {key: env.GLM_API_KEY, base: env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4", model: env.COZY_GLM_MODEL || "glm-4.7-flash"},
    qwen: {key: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY, base: env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", model: env.COZY_QWEN_MODEL || "qwen3.7-flash"},
    ark: {key: env.ARK_API_KEY, base: env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"},
    gemini: {key: env.GEMINI_API_KEY, base: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta", model: env.COZY_GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image"}
  };
  return configs[name];
};

function decodeJwtPart(part) {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0))));
}

function jwtBytes(part) {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

async function verifyAccess(request, env) {
  const syncKey = String(request.headers.get("x-cozy-sync-key") || "");
  if (syncKey && env.SYNC_SECRET && env.SESSION_SECRET) {
    const [provided, expected] = await Promise.all([hmac(env.SESSION_SECRET, syncKey), hmac(env.SESSION_SECRET, env.SYNC_SECRET)]);
    if (safeEqual(provided, expected)) return {allowed: true, email: "sync", sync: true};
  }
  if (env.ALLOW_UNAUTHENTICATED === "true") return {allowed: true, email: "preview"};
  if (env.AUTH_MODE === "passcode") {
    const cookie = String(request.headers.get("cookie") || "").split(";").map(item => item.trim()).find(item => item.startsWith("cozy_session="));
    if (!cookie || !env.SESSION_SECRET) return {allowed: false};
    const token = decodeURIComponent(cookie.slice("cozy_session=".length));
    const split = token.lastIndexOf(".");
    if (split < 1) return {allowed: false};
    const payload = token.slice(0, split);
    const signature = token.slice(split + 1);
    const expectedSignature = await hmac(env.SESSION_SECRET, payload);
    if (!safeEqual(signature, expectedSignature)) return {allowed: false};
    try {
      const session = decodeJwtPart(payload);
      return {allowed: session.sub === "owner" && Number(session.exp || 0) > Date.now(), email: "owner"};
    } catch (_error) { return {allowed: false}; }
  }
  const expected = String(env.OWNER_EMAIL || "").trim().toLowerCase();
  const headerEmail = String(request.headers.get("cf-access-authenticated-user-email") || "").trim().toLowerCase();
  const token = String(request.headers.get("cf-access-jwt-assertion") || "");
  if (!expected || headerEmail !== expected || !token) return {allowed: false};
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) return {allowed: true, email: headerEmail, legacy: true};
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {allowed: false};
    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);
    const issuer = `https://${String(env.CF_ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !audience.includes(env.CF_ACCESS_AUD) || Number(payload.exp || 0) * 1000 <= Date.now()) return {allowed: false};
    if (String(payload.email || "").toLowerCase() !== expected) return {allowed: false};
    if (accessKeysCache.issuer !== issuer || accessKeysCache.expires < Date.now()) {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
      if (!response.ok) return {allowed: false};
      const certs = await response.json();
      accessKeysCache = {issuer, expires: Date.now() + 60 * 60 * 1000, keys: certs.keys || []};
    }
    const jwk = accessKeysCache.keys.find(key => key.kid === header.kid);
    if (!jwk) return {allowed: false};
    const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, jwtBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return {allowed: valid, email: valid ? headerEmail : ""};
  } catch (_error) {
    return {allowed: false};
  }
}

const DEMO_AI_PATHS = new Set([
  "/api/assistant", "/api/assistant/start", "/api/room", "/api/parse",
  "/api/toolbox/import", "/api/toolbox/refresh-price", "/api/weekly/run",
  "/api/media/generate", "/api/media/task/refresh", "/api/memory/distill"
]);

async function demoActivation(env) {
  const saved = await readState(env, "demo:activation", {enabled: false, expires_at: 0});
  const active = Boolean(saved.enabled) && Number(saved.expires_at || 0) > Date.now();
  return {active, expires_at: active ? Number(saved.expires_at) : 0, updated_at: saved.updated_at || ""};
}

async function setDemoActivation(env, input) {
  if (!env.DEMO_ADMIN_PASSCODE || !env.SESSION_SECRET) throw new Error("演示版管理口令尚未配置");
  const [provided, expected] = await Promise.all([
    hmac(env.SESSION_SECRET, String(input.passcode || "")),
    hmac(env.SESSION_SECRET, env.DEMO_ADMIN_PASSCODE)
  ]);
  if (!safeEqual(provided, expected)) {
    const error = new Error("主人口令不正确");
    error.status = 401;
    throw error;
  }
  const enabled = Boolean(input.enabled);
  const hours = Math.min(Math.max(Number(input.hours || 8), 1), 24);
  const value = {enabled, expires_at: enabled ? Date.now() + hours * 60 * 60 * 1000 : 0, updated_at: now()};
  await writeState(env, "demo:activation", value);
  return {active: enabled, expires_at: value.expires_at, updated_at: value.updated_at};
}

async function requireDemoAi(env) {
  if (env.DEMO_MODE !== "true") return;
  if (!(await demoActivation(env)).active) {
    const error = new Error("阿栗尚未开放体验，请给主人确认后再试");
    error.status = 403;
    throw error;
  }
}

async function createFullBackup(env, reason = "manual") {
  if (!env.COZY_PRIVATE && !env.COZY_BACKUP) {
    const error = new Error("备份存储尚未绑定，当前只能使用 KV 主库");
    error.status = 503;
    throw error;
  }
  const snapshot = await exportCloudState(env);
  const stamp = now();
  const key = `full-snapshots/${stamp.slice(0, 10)}/${stamp.replace(/[:.]/g, "-")}-${reason}.json`;
  if (env.COZY_PRIVATE) {
    await env.COZY_PRIVATE.put(key, JSON.stringify(snapshot), {
      httpMetadata: {contentType: "application/json; charset=utf-8"},
      customMetadata: {reason, exportedAt: snapshot.exported_at}
    });
  } else {
    await env.COZY_BACKUP.put(key, JSON.stringify(snapshot));
  }
  const status = {ok: true, storage: env.COZY_PRIVATE ? "r2" : "backup-kv", last_full_backup_at: stamp, object_key: key, reason};
  await writeState(env, "backup:status", status);
  return status;
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function encodePayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  let binary = "";
  signed.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const loginPage = (message = "") => new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>回到栗壳小院</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2e9dc;color:#49392d;font-family:"PingFang SC","Microsoft YaHei",sans-serif}.login{width:min(360px,calc(100vw - 32px));padding:28px;background:rgba(255,252,246,.96);border:1px solid rgba(91,65,42,.14);border-radius:16px;box-shadow:0 22px 65px rgba(77,54,35,.18)}.mark{width:72px;height:72px;margin:0 auto 16px;border:3px solid #fff;border-radius:50%;background:#ead8be url('/assets/app/icon-192.png') center/cover no-repeat;box-shadow:0 5px 16px rgba(82,60,39,.16)}h1{font-size:21px;text-align:center;margin:0 0 6px}p{font-size:12px;line-height:1.7;text-align:center;color:#8b7563;margin:0 0 18px}.password-wrap{position:relative}input{width:100%;height:44px;border:1px solid rgba(91,65,42,.22);border-radius:10px;background:#fff;padding:0 46px 0 12px;font:14px inherit;outline:none}input:focus{border-color:#9a7655;box-shadow:0 0 0 3px rgba(154,118,85,.12)}.toggle-pass{position:absolute;right:3px;top:3px;width:38px;height:38px;display:grid;place-items:center;border:0;background:transparent;color:#876f5c;cursor:pointer;border-radius:8px}.toggle-pass:hover{background:#f5eee5}.toggle-pass:focus-visible{outline:2px solid #9a7655;outline-offset:0}.toggle-pass svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.eye-off{display:none}.toggle-pass.is-visible .eye-on{display:none}.toggle-pass.is-visible .eye-off{display:block}#submit{width:100%;height:42px;margin-top:10px;border:0;border-radius:10px;background:#765c45;color:#fff;font:14px inherit;cursor:pointer}#submit:disabled{opacity:.5}.error{display:block;width:100%;min-height:18px;margin-top:10px;color:#a04e43;font-size:11px;line-height:1.5;text-align:center;white-space:normal;word-break:normal;overflow-wrap:break-word}</style></head><body><main class="login"><div class="mark" role="img" aria-label="阿栗"></div><h1>栗壳小院</h1><p>这是主人的私人入口。阿栗会守住这里的数据。</p><form id="form"><div class="password-wrap"><input id="passcode" type="password" autocomplete="current-password" placeholder="输入小院口令" aria-label="小院口令" required><button class="toggle-pass" id="toggle-pass" type="button" aria-label="显示口令" title="显示口令"><svg class="eye-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.1 12s3.6-7 9.9-7 9.9 7 9.9 7-3.6 7-9.9 7-9.9-7-9.9-7Z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.1A9 9 0 0 1 12 5c6.3 0 9.9 7 9.9 7a15 15 0 0 1-2.1 3M6.6 6.6C3.7 8.5 2.1 12 2.1 12s3.6 7 9.9 7a9 9 0 0 0 4.1-.9"/></svg></button></div><button id="submit">回小院</button><div class="error" id="error">${String(message).replace(/[<>&]/g, "")}</div></form></main><script>const passcode=document.getElementById('passcode'),toggle=document.getElementById('toggle-pass');toggle.addEventListener('click',()=>{const visible=passcode.type==='text';passcode.type=visible?'password':'text';toggle.classList.toggle('is-visible',!visible);toggle.setAttribute('aria-label',visible?'显示口令':'隐藏口令');toggle.title=visible?'显示口令':'隐藏口令';passcode.focus();});document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();const button=document.getElementById('submit'),error=document.getElementById('error');button.disabled=true;error.textContent='阿栗正在确认…';try{const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passcode:passcode.value})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'口令不正确');location.replace('/');}catch(reason){error.textContent=reason.message;button.disabled=false;}});</script></body></html>`, {status: 401, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer"}});

async function login(request, env) {
  if (!env.OWNER_PASSCODE || !env.SESSION_SECRET) return json({ok: false, error: "主人登录密钥尚未配置"}, 503);
  const ip = String(request.headers.get("cf-connecting-ip") || "unknown").slice(0, 80);
  const attemptKey = `auth:attempt:${ip}`;
  const attempt = await readState(env, attemptKey, {count: 0, blocked_until: 0});
  const previousCount = Number(attempt.count || 0);
  if (previousCount >= LOGIN_ATTEMPT_LIMIT && Number(attempt.blocked_until || 0) > Date.now()) {
    return json({ok: false, error: "尝试次数过多，请在 15 分钟后再试"}, 429);
  }
  const input = await request.json();
  const inputHash = await hmac(env.SESSION_SECRET, String(input.passcode || ""));
  const expectedHash = await hmac(env.SESSION_SECRET, env.OWNER_PASSCODE);
  if (!safeEqual(inputHash, expectedHash)) {
    const count = previousCount + 1;
    const remaining = Math.max(0, LOGIN_ATTEMPT_LIMIT - count);
    await writeState(env, attemptKey, {count, blocked_until: count >= LOGIN_ATTEMPT_LIMIT ? Date.now() + LOGIN_BLOCK_MS : 0}, {expirationTtl: 15 * 60});
    return json({ok: false, error: remaining ? `口令不正确，还可尝试 ${remaining} 次` : "口令不正确，已达到 50 次上限，请在 15 分钟后再试", remaining_attempts: remaining}, 401);
  }
  await writeState(env, attemptKey, {count: 0, blocked_until: 0}, {expirationTtl: 60});
  const payload = encodePayload({sub: "owner", exp: Date.now() + 7 * 24 * 60 * 60 * 1000});
  const token = `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
  const headers = new Headers(securityHeaders);
  headers.set("set-cookie", `cozy_session=${encodeURIComponent(token)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`);
  return new Response(JSON.stringify({ok: true}), {status: 200, headers});
}

async function providerRequest(env, provider, path, body, method = "POST") {
  const config = providerConfig(env, provider);
  if (!config?.key) throw new Error(`${provider} API Key 尚未配置`);
  const headers = {"content-type": "application/json"};
  if (provider === "gemini") headers["x-goog-api-key"] = config.key;
  else headers.authorization = `Bearer ${config.key}`;
  const response = await fetch(config.base.replace(/\/$/, "") + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || payload?.message || `${provider} HTTP ${response.status}`);
  return payload;
}

function textProviders(env) {
  const configured = name => name === "workers-ai" ? Boolean(env.AI) : Boolean(providerConfig(env, name)?.key);
  const ordered = [String(env.COZY_TEXT_PROVIDER || "").toLowerCase(), String(env.COZY_TEXT_FALLBACK_PROVIDER || "").toLowerCase(), "deepseek", "openai", "glm", "qwen", "workers-ai"];
  return [...new Set(ordered.filter(name => name && configured(name)))];
}

function textProvider(env) {
  return textProviders(env)[0] || "";
}

async function callText(env, prompt, maxTokens = 1600, options = {}) {
  const providers = textProviders(env);
  if (!providers.length) throw new Error("还没有配置在线文本模型 API Key");
  const failures = [];
  for (const provider of providers) {
    let timeoutId;
    try {
      const timeoutMs=providerTimeoutMs(env,provider,options);
      const response=await Promise.race([
        callTextProvider(env,provider,prompt,maxTokens,options),
        new Promise((_,reject)=>{timeoutId=setTimeout(()=>reject(new Error(`${provider} 响应超时`)),timeoutMs);})
      ]);
      if(typeof options.validate==="function"&&!options.validate(response.text,response))throw new Error(`${provider} 返回内容未通过校验`);
      return response;
    } catch (error) {
      failures.push(`${provider}: ${String(error?.message || error)}`);
    } finally {
      if(timeoutId)clearTimeout(timeoutId);
    }
  }
  throw new Error(`文本模型均不可用：${failures.join("；")}`);
}

export function providerTimeoutMs(env,provider,options={}){
  const defaults=provider==="workers-ai"?45000:20000;
  const providerOverride=Number(options?.providerTimeouts?.[provider]);
  const requestOverride=Number(options?.timeoutMs);
  const configured=Number(env?.COZY_TEXT_PROVIDER_TIMEOUT_MS);
  const selected=providerOverride>0?providerOverride:requestOverride>0?requestOverride:configured>0?configured:defaults;
  return Math.max(5000,Math.min(120000,selected));
}

async function callTextProvider(env, provider, prompt, maxTokens = 1600, options = {}) {
  const temperature = Math.max(0, Math.min(1, Number(options.temperature ?? 0.4)));
  if (provider === "workers-ai") {
    const model = env.COZY_WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8";
    const payload = await env.AI.run(model, {messages: [{role: "user", content: prompt}], temperature, max_tokens: maxTokens});
    const text = payload?.response || payload?.result?.response || "";
    if (!text) throw new Error("Cloudflare AI 没有返回文字");
    return {text: String(text), provider: "workers-ai", model};
  }
  const config = providerConfig(env, provider);
  if (provider === "openai") {
    const payload = await providerRequest(env, provider, "/responses", {model: config.model, input: prompt, max_output_tokens: maxTokens});
    const text = payload.output_text || (payload.output || []).flatMap(item => item.content || []).map(part => part.text || "").join("\n");
    if (!text) throw new Error("OpenAI 没有返回文字");
    return {text, provider};
  }
  const body={model: config.model, messages: [{role: "user", content: prompt}], temperature, max_tokens: maxTokens};
  if(provider==="deepseek"&&options.thinking===false)body.thinking={type:"disabled"};
  const payload = await providerRequest(env, provider, "/chat/completions", body);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider} 没有返回文字`);
  return {text: String(text), provider};
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try { return JSON.parse(cleaned); } catch (_error) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("模型没有返回可用 JSON");
    return JSON.parse(match[0]);
  }
}

function orchardAnswerAligned(message, parsed) {
  const reply = String(parsed?.reply || "").trim();
  const focus = String(parsed?.answer_focus || "").trim();
  if (reply.length < 12 || focus.length < 4) return false;
  const ignored = new Set(["what", "why", "how", "which", "help", "about", "please"]);
  const anchors = [...new Set((String(message).match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []).map(value => value.toLowerCase()).filter(value => !ignored.has(value)))];
  const answer = `${focus}\n${reply}`.toLowerCase();
  if (anchors.length) return anchors.filter(anchor => answer.includes(anchor)).length >= Math.max(1, Math.ceil(anchors.length * 0.6));
  const compact = value => String(value || "").replace(/[什么怎么为何为什么是否是不是请问一下一个这个那个如何可以能够应该需要我你他她它的了呢吗呀啊和与及或在对把被让给从到里上下面中]/g, "").replace(/[^0-9a-z\u4e00-\u9fff]+/gi, "");
  const source = compact(message);
  if (source.length < 2) return true;
  const chunks = [...new Set([...(String(message).match(/[\u4e00-\u9fff]{2,10}/g) || [])].map(compact).filter(value => value.length >= 2))];
  return chunks.some(chunk => answer.replace(/\s+/g, "").includes(chunk)) || [...source].filter(char => answer.includes(char)).length / source.length >= 0.55;
}

function blackboardTaskProfile(question) {
  const text = String(question || "");
  if (/比较|对比|区别|差异|异同|各自.{0,8}(特点|优缺点)|哪一.{0,4}更/.test(text)) {
    return {type: "compare", label: "比较分析题", focus: "在同一维度下比较差异、原因、取舍与适用场景；不强求题目没有要求的上线方案或产品指标。"};
  }
  if (/复盘|反思|启示|总结|学到|迁移|成长/.test(text)) {
    return {type: "reflection", label: "反思迁移题", focus: "从材料或经历中提炼可复用原则，并说明证据、适用条件和可能例外；不强求虚构产品数据。"};
  }
  if (/什么是|是什么|是个什么|什么叫|为何|为什么|解释|如何理解|本质|含义|机制/.test(text)) {
    return {type: "explain", label: "概念解释题", focus: "用概念边界、形成机制、例子或反例证明理解；不强求题目没有要求的决策流程或量化指标。"};
  }
  return {type: "decision", label: "决策设计题", focus: "说明判断标准、方案机制、验证路径、风险边界或停止条件；题目未提供的具体产品数据不得作为扣分理由。"};
}

function blackboardScoreBands(max, descriptions) {
  const ranges = max === 30 ? [["excellent", 27, 30], ["solid", 20, 26], ["developing", 10, 19], ["weak", 1, 9], ["absent", 0, 0]]
    : [["excellent", 18, 20], ["solid", 13, 17], ["developing", 7, 12], ["weak", 1, 6], ["absent", 0, 0]];
  const labels = {excellent: "准确充分", solid: "基本扎实", developing: "部分成立", weak: "较为薄弱", absent: "尚未形成"};
  return ranges.map(([band, min, upper], index) => ({band, label: labels[band], min, max: upper, description: descriptions[index]}));
}

function buildFrozenRubric(points, question = "") {
  const values = (Array.isArray(points) ? points : []).map(value => String(value || "").trim()).filter(Boolean).slice(0, 6);
  const profile = blackboardTaskProfile(question);
  return [
    {id: "comprehension", criterion: "题意理解与核心判断", max: 20,
      scoring_scope: "只评价是否识别正确的对象、任务和范围，并形成相关、基本准确的核心判断。遗漏其他要点不在此项扣分；时效性事实没有可靠材料时只标待核验，不武断判错。",
      score_bands: blackboardScoreBands(20, ["对象、任务、范围和核心判断准确，无实质性概念或事实错误。", "主方向正确，仅有次要含糊或局部误差，不改变核心结论。", "答到部分任务，但范围、立场或概念有明显缺口。", "只有零散相关内容，核心判断偏题或存在关键误解。", "没有可识别的相关判断。"])},
    {id: "coverage", criterion: "任务完成与要点覆盖", max: 30,
      scoring_scope: "只评价题目明确子任务与必要分析角度覆盖了多少，以及是否分清主次。合理替代观点可与参考要点等价；已提出但没展开的问题留给推理项，不重复扣分。",
      score_bands: blackboardScoreBands(30, ["所有明确子任务和关键角度均覆盖，主次清楚。", "主要任务已完成，仅缺一个次要角度或主次略弱。", "覆盖部分关键角度，但至少一个主要子任务缺失。", "只有孤立相关点，尚未构成对任务的基本完成。", "没有覆盖任何可计分要点。"])},
    {id: "reasoning", criterion: "推理链条与证据支撑", max: 30,
      scoring_scope: "只评价答案已经提出的观点能否由原因、机制、比较、条件、事实、例子或推演支撑。完全缺失的要点只在覆盖项处理，不在本项再次扣分。",
      score_bands: blackboardScoreBands(30, ["主要观点有充分支撑，推理闭合且无明显跳步。", "主推理链成立，局部支撑、反证或连接仍可加强。", "有一些解释，但主要仍是结论罗列或存在明显跳步。", "以断言、循环论证、矛盾或不匹配的支撑为主。", "没有可评估的推理。"])},
    {id: "transfer", criterion: "边界意识与迁移应用", max: 20,
      scoring_scope: `按${profile.label}评价答案能否说明适用范围，并把理解用于恰当的例子、场景、取舍、验证、限制或反例。${profile.focus}`,
      score_bands: blackboardScoreBands(20, ["能按题型准确迁移，并说明关键适用条件、限制或反例。", "已有具体应用或边界，仅缺一个关键条件、反例或验证环节。", "提到应用或限制但较泛，尚不足以检验理解或指导判断。", "只有装饰性场景或口号，和核心结论连接很弱。", "没有显示适用范围或迁移能力的内容。"]) }
  ].map(item => ({...item, task_type: profile.type, task_focus: profile.focus, reference_points: values}));
}

function attachFrozenRubric(question) {
  const points = question.standard_points || question.standard || [];
  const idealAnswer = qualifyBlackboardIllustrativeNumbers(String(question.ideal_answer || "").trim(), {question:question.question,materials:question.materials});
  const profile = blackboardTaskProfile(question.question);
  const rubric = buildFrozenRubric(points, question.question);
  const fingerprint = stableQuestionFingerprint(`${question.date}|${question.question}|${points.join("|")}|${idealAnswer}|rubric:v3`);
  return {...question, standard: points, standard_points: points, ideal_answer: idealAnswer,
    ideal_answer_version: validBlackboardIdealAnswer(idealAnswer) ? 1 : 0, rubric, rubric_version: 3, task_type: profile.type,
    task_scoring_focus: profile.focus, reference_frozen_at: question.reference_frozen_at || now(), question_fingerprint: fingerprint, answer_independent: true};
}

function validBlackboardIdealAnswer(value) {
  const text = String(value || "").trim();
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return chinese >= 180 && ["判断：", "拆解：", "验证：", "边界：", "例子："].every(label => text.includes(label));
}

function validBlackboardPersonalizedRevision(value, originalAnswer) {
  const text=String(value||"").trim();
  const chinese=(text.match(/[\u4e00-\u9fff]/g)||[]).length;
  const normalize=item=>String(item||"").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,"");
  const sourceText=normalize(originalAnswer),revisionText=normalize(text);
  return chinese>=160&&["判断：","拆解：","验证：","边界：","例子："].every(label=>text.includes(label))&&blackboardTextMatchesQuestion(sourceText,revisionText);
}

function blackboardRevisionDistinctFromIdeal(revision,idealAnswer){
  const normalize=item=>String(item||"").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,"");
  const revisionText=normalize(revision),idealText=normalize(idealAnswer);
  if(idealText.length<80)return true;
  if(revisionText===idealText||revisionText.includes(idealText)||idealText.includes(revisionText))return false;
  const chunks=[];
  for(let index=0;index<Math.max(1,idealText.length-11);index+=6)chunks.push(idealText.slice(index,index+12));
  const overlap=chunks.filter(chunk=>revisionText.includes(chunk)).length;
  return !chunks.length||overlap/chunks.length<.72;
}

function blackboardTextMatchesQuestion(question,value){
  const questionText=String(question||"").toLowerCase(),answerText=String(value||"").toLowerCase();
  const latin=new Set((questionText.match(/[a-z][a-z0-9._-]{2,}/g)||[]).filter(item=>!["what","why","how","which"].includes(item)));
  const stop=new Set(["如何","怎样","什么","一个","如果","请你","说明","回答","设计","分析","问题","可以","应该","使用","处理","进行","通过","需要","用户","产品","任务","方案","效果","这个","原来"]),chinese=new Set();
  for(const segment of questionText.match(/[\u4e00-\u9fff]{2,}/g)||[]){for(let index=0;index<segment.length-1;index+=1)chinese.add(segment.slice(index,index+2));}
  stop.forEach(item=>chinese.delete(item));
  if([...latin].some(keyword=>answerText.includes(keyword)))return true;
  const matches=[...chinese].filter(keyword=>answerText.includes(keyword)).length;
  return (latin.size===0&&chinese.size===0)||matches>=Math.min(2,chinese.size);
}

function validBlackboardPlainLanguageCoaching(value,question=""){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const wants=String(value.what_the_question_wants||"").trim(),steps=Array.isArray(value.answer_steps)?value.answer_steps:[],remember=Array.isArray(value.remember)?value.remember:[],hook=String(value.memory_hook||"").trim();
  const generic=/^(?:具体问题具体分析|补充具体方案和指标|进一步完善|多思考多练习)[。！]?$|^(?:暂无|无)$/;
  return wants.length>=12&&wants.length<=220&&blackboardTextMatchesQuestion(question,wants)
    &&steps.length>=3&&steps.length<=5&&steps.every(item=>String(item).trim().length>=8&&String(item).trim().length<=180&&!generic.test(String(item).trim()))
    &&remember.length>=2&&remember.length<=5&&remember.every(item=>String(item).trim().length>=6&&String(item).trim().length<=120&&!generic.test(String(item).trim()))
    &&hook.length>=6&&hook.length<=80&&!generic.test(hook);
}

function normalizeBlackboardLearningOutputs(parsed,context={}){
  const coaching=parsed?.plain_language_coaching&&typeof parsed.plain_language_coaching==="object"&&!Array.isArray(parsed.plain_language_coaching)?parsed.plain_language_coaching:{};
  parsed.plain_language_coaching={
    what_the_question_wants:String(coaching.what_the_question_wants||"").trim(),
    answer_steps:(Array.isArray(coaching.answer_steps)?coaching.answer_steps:[]).map(item=>String(item).trim()).filter(Boolean).slice(0,5),
    remember:(Array.isArray(coaching.remember)?coaching.remember:[]).map(item=>String(item).trim()).filter(Boolean).slice(0,5),
    memory_hook:String(coaching.memory_hook||"").trim()
  };
  parsed.next_question=String(parsed?.next_question||"").trim();
  parsed.next_question_reference=(Array.isArray(parsed?.next_question_reference)?parsed.next_question_reference:[]).map(item=>String(item).trim()).filter(Boolean).slice(0,6);
  const nextContext={question:parsed.next_question,materials:[],reference:parsed.next_question_reference};
  parsed.next_question_ideal_answer=qualifyBlackboardIllustrativeNumbers(parsed?.next_question_ideal_answer||"",nextContext).trim();
  return parsed;
}

function validBlackboardNextPracticeOutline(parsed,context={}){
  const question=String(parsed?.next_question||"").trim(),reference=Array.isArray(parsed?.next_question_reference)?parsed.next_question_reference:[];
  const current=String(context?.question||"").replace(/\s+/g,""),next=question.replace(/\s+/g,"");
  return question.length>=12&&question.length<=260&&next!==current
    &&reference.length>=3&&reference.length<=6&&reference.every(item=>String(item).trim().length>=8&&String(item).trim().length<=160);
}

function validBlackboardNextPractice(parsed,context={}){
  if(!validBlackboardNextPracticeOutline(parsed,context))return false;
  const question=String(parsed?.next_question||"").trim(),reference=parsed.next_question_reference,ideal=String(parsed?.next_question_ideal_answer||"").trim();
  const answerContext={question,materials:[],reference};
  return validBlackboardIdealAnswer(ideal)&&blackboardTextMatchesQuestion(question,ideal)&&!blackboardHasUncalibratedNumbers(ideal,answerContext);
}

function blackboardHasUncalibratedNumbers(value, context = {}) {
  const source=JSON.stringify([context?.question||"",context?.materials||[]]);
  const metric=/(?:\d+(?:\.\d+)?\s*%|[><≥≤]\s*\d+(?:\.\d+)?|(?:超过|低于|高于|至少|不超过|超)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:次|天|年|个月|个|家|人))/g;
  return String(value||"").split(/\n+/).some(paragraph=>{
    if(/例子：|例如|假设|示例|待.{0,8}校准|根据.{0,12}(历史|基线|风险)|由.{0,12}(历史|基线)/.test(paragraph))return false;
    return [...paragraph.matchAll(metric)].some(match=>!source.includes(match[0]));
  });
}

function qualifyBlackboardIllustrativeNumbers(value, context = {}) {
  const source=JSON.stringify([context?.question||"",context?.materials||[]]);
  const metric=/(?:\d+(?:\.\d+)?\s*%|[><≥≤]\s*\d+(?:\.\d+)?|(?:超过|低于|高于|至少|不超过|超)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:次|天|年|个月|个|家|人))/g;
  const calibrated=/例子：|例如|假设|示例|待.{0,8}校准|根据.{0,12}(历史|基线|风险)|由.{0,12}(历史|基线)/;
  return String(value||"").split(/\n/).map(paragraph=>{
    if(calibrated.test(paragraph))return paragraph;
    const ungrounded=[...paragraph.matchAll(metric)].some(match=>!source.includes(match[0]));
    return ungrounded?`${paragraph}（本段数字仅为示例，实际需由历史基线、风险等级和合规要求校准。）`:paragraph;
  }).join("\n");
}

function blackboardHasUnsupportedSpecifics(value,context={}){
  const source=JSON.stringify([context?.question||"",context?.materials||[]]);
  const pattern=/ISO\s*27001|CNVD|CNNVD/i;
  return pattern.test(String(value||""))&&!pattern.test(source);
}

function sanitizeBlackboardUnsupportedSpecifics(value,context={}){
  const source=JSON.stringify([context?.question||"",context?.materials||[]]);
  if(/ISO\s*27001|CNVD|CNNVD/i.test(source))return value;
  if(Array.isArray(value))return value.map(item=>sanitizeBlackboardUnsupportedSpecifics(item,context));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==="evidence"?item:sanitizeBlackboardUnsupportedSpecifics(item,context)]));
  if(typeof value!=="string")return value;
  return value
    .replace(/ISO\s*27001\s*或\s*(?:拥有\s*)?CNVD\/CNNVD\s*技术支撑单位资质/gi,"与任务风险相匹配的企业安全资质和合规证明")
    .replace(/ISO\s*27001\s*或\s*CNVD(?:\/CNNVD)?\s*(?:证书|资质)?/gi,"企业安全资质、授权合同和历史合规记录")
    .replace(/ISO\s*27001/gi,"企业安全管理资质")
    .replace(/CNVD(?:\/CNNVD)?(?:\s*技术支撑单位)?(?:\s*证书|\s*资质)?/gi,"经核验的安全服务资质");
}

function stableQuestionFingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `q_${(hash >>> 0).toString(36)}`;
}

function normalizedRubric(context) {
  const supplied = Array.isArray(context?.rubric) ? context.rubric : [];
  const rubric = supplied.length ? supplied : buildFrozenRubric(context?.reference || [], context?.question || "");
  return rubric.slice(0, 6).map((item, index) => ({
    id: String(item?.id || `r${index + 1}`), criterion: String(item?.criterion || item?.requirement || "").trim(),
    max: Math.max(1, Number(item?.max || 0)), scoring_scope: String(item?.scoring_scope || ""),
    score_bands: Array.isArray(item?.score_bands) ? item.score_bands : []
  })).filter(item => item.criterion);
}

function blackboardScoreBand(awarded, max) {
  const score = Math.max(0, Number(awarded) || 0), ceiling = Math.max(1, Number(max) || 1);
  if (score === 0) return "absent";
  if (score / ceiling >= 0.9) return "excellent";
  if (score / ceiling >= 0.65) return "solid";
  if (score / ceiling >= 1 / 3) return "developing";
  return "weak";
}

function finalizeBlackboardGrade(parsed, context) {
  const rubric = normalizedRubric(context);
  const supplied = Array.isArray(parsed?.score_breakdown) ? parsed.score_breakdown : [];
  const byId = new Map(supplied.map((item, index) => [String(item?.rubric_id || item?.id || rubric[index]?.id || ""), item]));
  const scoreBreakdown = rubric.map((criterion, index) => {
    const row = byId.get(criterion.id) || supplied[index] || {};
    const awarded = Math.round(Math.max(0, Math.min(criterion.max, Number(row.awarded || 0))));
    return {rubric_id: criterion.id, criterion: criterion.criterion, max: criterion.max, awarded, band: blackboardScoreBand(awarded, criterion.max), evidence: String(row.evidence || ""), reason: String(row.reason || row.assessment || ""), teaching: String(row.teaching || row.action || "")};
  });
  const reference = Array.isArray(context?.reference) ? context.reference.map(String).filter(Boolean) : [];
  const suppliedMap = Array.isArray(parsed?.requirement_map) ? parsed.requirement_map : [];
  const requirementMap = reference.map((referencePoint, index) => {
    const row = suppliedMap[index] || {};
    return {reference_point: referencePoint, relation: String(row.relation || row.status || "not_covered").toLowerCase(), evidence: String(row.evidence || ""), assessment: String(row.assessment || ""), teaching: String(row.teaching || row.action || "")};
  });
  if(requirementMap.length){
    const credit=requirementMap.reduce((sum,item)=>sum+(["covered","equivalent"].includes(item.relation)?1:item.relation==="partial"?.75:0),0)/requirementMap.length;
    const coverageCeiling=credit<.25?9:credit<.5?19:credit<.9?26:30;
    const coverage=scoreBreakdown.find(item=>item.rubric_id==="coverage");
    if(coverage&&coverage.awarded>coverageCeiling){coverage.awarded=coverageCeiling;coverage.band=blackboardScoreBand(coverage.awarded,coverage.max);}
  }
  const strengths = (Array.isArray(parsed?.strengths) ? parsed.strengths : []).slice(0, 4).map(item => typeof item === "string" ? {evidence: "", why_good: item} : {evidence: String(item?.evidence || ""), why_good: String(item?.why_good || item?.reason || "")}).filter(item => item.evidence || item.why_good);
  const total = scoreBreakdown.reduce((sum, item) => sum + item.awarded, 0);
  const personalizedRevision=String(parsed?.personalized_revision||parsed?.minimal_revision||"").trim();
  return {...parsed, score_breakdown: scoreBreakdown, requirement_map: requirementMap, strengths,
    personalized_revision:personalizedRevision, minimal_revision:personalizedRevision,
    total_score: scoreBreakdown.reduce((sum,item)=>sum+item.awarded,0), grading_policy: "评分标准在作答前冻结；四项能力先按五档锚点定档、再在档内给分；任务覆盖分按 covered、partial、equivalent 的实际分布校准上限；同一缺陷只归一个维度；合理的替代论证正常得分。"};
}

function blackboardGradeQuoteInAnswer(answer,evidence){
  const normalize=value=>String(value||"").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,"");
  const source=normalize(answer),quote=normalize(evidence);
  return quote.length>=4&&source.includes(quote);
}

function blackboardBestSourceQuote(answer,hint){
  if(blackboardGradeQuoteInAnswer(answer,hint))return String(hint||"").trim();
  const normalize=value=>String(value||"").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,"");
  const hintText=normalize(hint);
  if(hintText.length<4)return "";
  const clauses=String(answer||"").split(/[。！？；;\n]+/).map(item=>item.trim()).filter(item=>normalize(item).length>=4);
  const pairs=value=>new Set(Array.from({length:Math.max(0,value.length-1)},(_,index)=>value.slice(index,index+2)));
  const latin=value=>new Set(value.match(/[a-z][a-z0-9._-]{2,}/g)||[]);
  const hintPairs=pairs(hintText),hintLatin=latin(hintText);
  let best="",bestScore=0;
  for(const clause of clauses){
    const candidate=normalize(clause),candidatePairs=pairs(candidate),candidateLatin=latin(candidate);
    const overlap=[...candidatePairs].filter(value=>hintPairs.has(value)).length;
    const latinOverlap=[...candidateLatin].filter(value=>hintLatin.has(value)).length;
    const score=overlap*2+latinOverlap*4;
    if(score>bestScore){best=clause;bestScore=score;}
  }
  return bestScore>=4?best:"";
}

function normalizeBlackboardGradeCandidate(parsed,message,context){
  let normalized=normalizeBlackboardLearningOutputs({...parsed},context);
  const revision=qualifyBlackboardIllustrativeNumbers(normalized?.personalized_revision||normalized?.minimal_revision||"",context);
  normalized.personalized_revision=revision;normalized.minimal_revision=revision;
  normalized=finalizeBlackboardGrade(normalized,context);
  for(const item of normalized.score_breakdown||[]){
    if(item.awarded&&!blackboardGradeQuoteInAnswer(message,item.evidence||""))item.evidence=blackboardBestSourceQuote(message,[item.evidence,item.reason,item.criterion].join(" "));
  }
  for(const item of normalized.requirement_map||[]){
    const relation=String(item.relation||"").toLowerCase();
    if(["not_covered","off_track"].includes(relation))item.evidence="";
    else if(!blackboardGradeQuoteInAnswer(message,item.evidence||""))item.evidence=blackboardBestSourceQuote(message,[item.evidence,item.assessment,item.reference_point].join(" "));
    const teaching=String(item.teaching||item.action||"").trim();
    const actionable=/访谈|测试|对照|记录|计算|设置|限定|验证|抽样|比较|回滚|停止|定义|追踪|分层|补写|补充|说明|观察|统计|阈值|样本|周期|决策|举例|区分|连接|解释|改为|提供|审核|审批|拒绝|暂停|撤销|开放|保留|提交|绑定|校验|导出|查看|选择|划分|建立|加入|增加|采用|执行|监控|复核|触发|限制|禁止|因为|所以|如果|意味着|可以|应该/;
    if(teaching.length<8||!actionable.test(teaching)){
      const point=String(item.reference_point||"这一参考点").trim();
      const lead=teaching.length>=4?`${teaching.replace(/[。；;]+$/,"")}；`:"";
      item.teaching=relation==="covered"||relation==="equivalent"
        ? `${lead}保留这条已成立的思路，再围绕“${point}”写清执行对象、检查证据和失败条件。`
        : relation==="partial"
          ? `${lead}沿着原答案已有部分，围绕“${point}”补写执行步骤、判断证据和失败条件。`
          : `${lead}新增“${point}”这一段：先写具体执行动作，再写可核验的输出，以及什么情况判失败。`;
    }
  }
  for(const item of normalized.strengths||[]){
    if(!blackboardGradeQuoteInAnswer(message,item.evidence||""))item.evidence=blackboardBestSourceQuote(message,[item.evidence,item.why_good].join(" "));
  }
  return sanitizeBlackboardUnsupportedSpecifics(normalized,{question:context?.question||"",materials:[...(context?.materials||[]),message]});
}

function blackboardGradeNeedsRetry(message, context, parsed, ignoreRevision=false, ignoreNextAnswer=false) {
  const scores = Array.isArray(parsed?.score_breakdown) ? parsed.score_breakdown : [];
  const rubric = normalizedRubric(context);
  if (!rubric.length || scores.length !== rubric.length) return true;
  const answer = String(message || "").replace(/\s+/g, "");
  const emptyAnswer = answer.length < 12 && /^(不会|好难|不知道|不懂|不会做|答不出|没思路|太难了|不会好难)+$/.test(answer.replace(/[，。！？,.!?~～…]/g, ""));
  const validPractice=ignoreNextAnswer?validBlackboardNextPracticeOutline(parsed,context):validBlackboardNextPractice(parsed,context);
  if(!validBlackboardPlainLanguageCoaching(parsed?.plain_language_coaching,context?.question||"")||!validPractice)return true;
  if (emptyAnswer) return false;
  if (scores.some((item, index) => {
    const awarded = Number(item?.awarded || 0), evidence = String(item?.evidence || ""), reason = String(item?.reason || ""), teaching = String(item?.teaching || "");
    const suppliedBand = String(item?.band || "");
    return String(item?.rubric_id || item?.id || rubric[index]?.id) !== rubric[index]?.id || String(item?.criterion || "") !== rubric[index]?.criterion || Number(item?.max || 0) !== rubric[index]?.max || awarded < 0 || awarded > rubric[index]?.max || (suppliedBand && suppliedBand !== blackboardScoreBand(awarded, rubric[index]?.max)) || !reason.trim() || !teaching.trim() || (awarded > 0 && !blackboardGradeQuoteInAnswer(message, evidence));
  })) return true;
  const awarded = scores.reduce((sum, item) => sum + Math.max(0, Number(item?.awarded) || 0), 0);
  const requirementMap=Array.isArray(parsed?.requirement_map)?parsed.requirement_map:[];
  const reference = Array.isArray(context?.reference) ? context.reference.map(String).filter(Boolean) : [];
  if(requirementMap.length!==reference.length)return true;
  const validStatuses=new Set(["covered","partial","equivalent","not_covered","off_track"]);
  const actionable=/访谈|测试|对照|记录|计算|设置|限定|验证|抽样|比较|回滚|停止|定义|追踪|分层|补写|补充|说明|观察|统计|阈值|样本|周期|决策|举例|区分|连接|解释|改为|提供|审核|审批|拒绝|暂停|撤销|开放|保留|提交|绑定|校验|导出|查看|选择|划分|建立|加入|增加|采用|执行|监控|复核|触发|限制|禁止/;
  if(requirementMap.some((item,index)=>{
    const status=String(item?.relation||item?.status||"").toLowerCase(),evidence=String(item?.evidence||""),action=String(item?.teaching||item?.action||"");
    if(String(item?.reference_point||item?.requirement||"").trim()!==reference[index]||!validStatuses.has(status)||String(item?.assessment||"").trim().length<8)return true;
    if(["not_covered","off_track"].includes(status)&&evidence.trim())return true;
    if(!["not_covered","off_track"].includes(status)&&!blackboardGradeQuoteInAnswer(message,evidence))return true;
    return action.trim().length<8||(!actionable.test(action)&&!/因为|所以|如果|意味着|可以|应该/.test(action));
  }))return true;
  const reasons = `${parsed?.score_summary || ""} ${scores.map(item => item?.reason || "").join(" ")} ${requirementMap.map(item=>`${item.assessment||""} ${item.teaching||item.action||""}`).join(" ")}`;
  const generalScenario = /假设|如何设计|你会如何|方案|机制|流程/.test(String(context?.question || ""));
  const wronglyRequiresProduct = /没有提供.{0,6}产品信息|缺乏.{0,6}产品信息|产品信息不足|无法评估/.test(reasons);
  const contradictions=[
    [/用户价值|用户需求|用户痛点/,/(没有|缺少|未提及)[^。！？；\n]{0,8}(用户价值|用户需求|用户痛点)/],
    [/付费意愿|愿意付费|支付意愿/,/(没有|缺少|未提及)[^。！？；\n]{0,8}(付费意愿|愿意付费|支付意愿)/],
    [/单位经济|毛利|收入.*成本|成本.*收入/,/(没有|缺少|未提及)[^。！？；\n]{0,8}(单位经济|毛利|成本收益)/],
    [/指标|成功率|转化率|留存|成本/,/(没有|缺少|未提及)[^。！？；\n]{0,6}(任何)?指标/]
  ];
  const reasonParts=[String(parsed?.score_summary||""),...scores.map(item=>String(item?.reason||"")),...requirementMap.flatMap(item=>[String(item?.assessment||""),String(item?.teaching||item?.action||"")])];
  if(contradictions.some(([present,denied])=>present.test(message)&&reasonParts.some(part=>denied.test(part))))return true;
  const direction=String(parsed?.direction||"").toLowerCase(),correction=String(parsed?.correction_path||"").trim();
  if(!["correct","partly_correct","misdirected"].includes(direction)||correction.length<12)return true;
  const strengths=Array.isArray(parsed?.strengths)?parsed.strengths:[];
  if(awarded>0&&(strengths.length===0||strengths.some(item=>{
    const evidence=typeof item==="string"?"":String(item?.evidence||"");
    const why=typeof item==="string"?String(item):String(item?.why_good||"");
    return !blackboardGradeQuoteInAnswer(message,evidence)||why.trim().length<8;
  })))return true;
  if(!ignoreRevision){
    const revision=String(parsed?.personalized_revision||parsed?.minimal_revision||"").trim();
    if(!validBlackboardPersonalizedRevision(revision,message))return true;
    if(!blackboardRevisionDistinctFromIdeal(revision,context?.ideal_answer||""))return true;
    if(blackboardHasUncalibratedNumbers(revision,context))return true;
  }
  if(/补充具体(方案|指标)|缺少具体(方案|指标)|不够具体|进一步完善/.test(String(parsed?.priority_fix||""))&&!actionable.test(String(parsed?.priority_fix||"")))return true;
  return (awarded === 0 && generalScenario)||wronglyRequiresProduct;
}

function blackboardGradeValidationSummary(message,context,parsed,ignoreRevision=false,ignoreNextAnswer=false){
  const rubric=normalizedRubric(context),scores=Array.isArray(parsed?.score_breakdown)?parsed.score_breakdown:[];
  const reference=Array.isArray(context?.reference)?context.reference.map(String).filter(Boolean):[];
  const requirements=Array.isArray(parsed?.requirement_map)?parsed.requirement_map:[];
  const strengths=Array.isArray(parsed?.strengths)?parsed.strengths:[];
  const actionable=/访谈|测试|对照|记录|计算|设置|限定|验证|抽样|比较|回滚|停止|定义|追踪|分层|补写|补充|说明|观察|统计|阈值|样本|周期|决策|举例|区分|连接|解释|改为|提供|审核|审批|拒绝|暂停|撤销|开放|保留|提交|绑定|校验|导出|查看|选择|划分|建立|加入|增加|采用|执行|监控|复核|触发|限制|禁止/;
  return{
    score_count:`${scores.length}/${rubric.length}`,
    score_rows:scores.map((item,index)=>({
      id_ok:String(item?.rubric_id||item?.id||rubric[index]?.id)===rubric[index]?.id,
      max_ok:Number(item?.max||0)===Number(rubric[index]?.max||0),
      awarded:Number(item?.awarded||0),
      evidence_ok:Number(item?.awarded||0)===0||blackboardGradeQuoteInAnswer(message,item?.evidence||""),
      reason_len:String(item?.reason||"").trim().length,
      teaching_len:String(item?.teaching||"").trim().length
    })),
    coaching_ok:validBlackboardPlainLanguageCoaching(parsed?.plain_language_coaching,context?.question||""),
    practice_ok:ignoreNextAnswer?validBlackboardNextPracticeOutline(parsed,context):validBlackboardNextPractice(parsed,context),
    requirement_count:`${requirements.length}/${reference.length}`,
    requirement_rows:requirements.map((item,index)=>{
      const relation=String(item?.relation||item?.status||"").toLowerCase(),evidence=String(item?.evidence||""),teaching=String(item?.teaching||item?.action||"");
      return{reference_ok:String(item?.reference_point||item?.requirement||"").trim()===reference[index],relation,evidence_ok:["not_covered","off_track"].includes(relation)?!evidence.trim():blackboardGradeQuoteInAnswer(message,evidence),assessment_len:String(item?.assessment||"").trim().length,teaching_len:teaching.trim().length,teaching_actionable:actionable.test(teaching)||/因为|所以|如果|意味着|可以|应该/.test(teaching)};
    }),
    direction:String(parsed?.direction||""),
    correction_len:String(parsed?.correction_path||"").trim().length,
    strength_rows:strengths.map(item=>({evidence_ok:blackboardGradeQuoteInAnswer(message,typeof item==="string"?"":item?.evidence||""),why_len:String(typeof item==="string"?item:item?.why_good||"").trim().length})),
    revision_ok:ignoreRevision||(!blackboardRevisionNeedsRepair(message,context,parsed)),
    priority:String(parsed?.priority_fix||"").trim().length
  };
}

function blackboardGradeValidationCodes(message,context,parsed,ignoreRevision=false,ignoreNextAnswer=false){
  const summary=blackboardGradeValidationSummary(message,context,parsed,ignoreRevision,ignoreNextAnswer),codes=[];
  if(summary.score_count.split("/")[0]!==summary.score_count.split("/")[1])codes.push("分数项数量");
  summary.score_rows.forEach((item,index)=>{
    if(!item.id_ok||!item.max_ok)codes.push(`评分维度${index+1}`);
    if(!item.evidence_ok)codes.push(`评分证据${index+1}`);
    if(item.reason_len<1)codes.push(`评分理由${index+1}`);
    if(item.teaching_len<1)codes.push(`提升建议${index+1}`);
  });
  if(!summary.coaching_ok)codes.push("大白话讲解");
  if(!summary.practice_ok)codes.push(ignoreNextAnswer?"下一题提纲":"下一题答案");
  if(summary.requirement_count.split("/")[0]!==summary.requirement_count.split("/")[1])codes.push("参考点数量");
  summary.requirement_rows.forEach((item,index)=>{
    if(!item.reference_ok||!["covered","partial","equivalent","not_covered","off_track"].includes(item.relation))codes.push(`参考点${index+1}`);
    if(!item.evidence_ok)codes.push(`参考证据${index+1}`);
    if(item.assessment_len<8)codes.push(`参考判断${index+1}`);
    if(item.teaching_len<8||!item.teaching_actionable)codes.push(`参考建议${index+1}`);
  });
  if(!["correct","partly_correct","misdirected"].includes(summary.direction))codes.push("方向判断");
  if(summary.correction_len<12)codes.push("纠正路径");
  summary.strength_rows.forEach((item,index)=>{if(!item.evidence_ok||item.why_len<8)codes.push(`答题优点${index+1}`);});
  if(!summary.revision_ok)codes.push("个性化答案");
  return [...new Set(codes)].join("、")||"语义一致性";
}

function blackboardRevisionNeedsRepair(message,context,parsed){
  const revision=String(parsed?.personalized_revision||parsed?.minimal_revision||"").trim();
  return !validBlackboardPersonalizedRevision(revision,message)
    ||!blackboardRevisionDistinctFromIdeal(revision,context?.ideal_answer||"")
    ||blackboardHasUncalibratedNumbers(revision,context);
}

async function repairBlackboardPersonalizedRevision(env,message,context,parsed){
  const strengths=Array.isArray(parsed?.strengths)?parsed.strengths:[];
  const scores=Array.isArray(parsed?.score_breakdown)?parsed.score_breakdown:[];
  const advice=scores.map(item=>({criterion:item?.criterion,reason:item?.reason,teaching:item?.teaching}));
  const prompt=`你只重写一份基于主人原答案的面试升级版，不评分，不生成参考答案，也看不到标准示范答案。
只返回 JSON：{"personalized_revision":"300到700字的完整中文回答"}。
必须严格使用“判断：”“拆解：”“验证：”“边界：”“例子：”五段；保留并明确使用主人原答案中成立的判断、机制或表达，再实质补齐建议指出的缺口。禁止写成万能模板，禁止虚构主人经历、客户、资质、项目数据或事实；需要数字只能明确写成待历史基线校准的示例。
题目：${String(context?.question||"").slice(0,3000)}
题目资料：${JSON.stringify(context?.materials||[]).slice(0,3000)}
主人原答案：${String(message||"").slice(0,5000)}
已确认优点：${JSON.stringify(strengths).slice(0,3000)}
需要补强：${JSON.stringify(advice).slice(0,5000)}`;
  let previous="",lastProvider="";
  for(let attempt=0;attempt<2;attempt+=1){
    const retryNote=previous?`\n上一版未通过质量校验。请保留主人原答案里成立的具体判断，并补齐五段，不要复制标准答案或虚构数字。上一版：${previous.slice(0,3500)}`:"";
    const generated=await callText(env,prompt+retryNote,1800,{temperature:.2,thinking:false,providerTimeouts:{deepseek:50000,openai:15000,"workers-ai":35000}});
    previous=generated.text;lastProvider=generated.provider;
    const repaired=extractJson(generated.text);
    const revision=qualifyBlackboardIllustrativeNumbers(repaired?.personalized_revision||"",context);
    const safeRevision=sanitizeBlackboardUnsupportedSpecifics(revision,{question:context?.question||"",materials:[...(context?.materials||[]),message]});
    if(validBlackboardPersonalizedRevision(safeRevision,message)
      &&blackboardRevisionDistinctFromIdeal(safeRevision,context?.ideal_answer||"")
      &&!blackboardHasUncalibratedNumbers(safeRevision,context)){
      return {parsed:{...parsed,personalized_revision:safeRevision,minimal_revision:safeRevision},provider:lastProvider};
    }
  }
  throw new Error("个性化升级版连续两次未通过质量校验");
}

async function generateBlackboardNextIdealAnswer(env,parsed,context){
  if(!validBlackboardNextPracticeOutline(parsed,context))throw new Error("下一步练习题或作答思路不完整");
  const question=String(parsed.next_question||"").trim(),reference=parsed.next_question_reference;
  const prompt=`你只为下一步练习写一份阿栗示范答案，不评分，不改题目。
只返回 JSON：{"next_question_ideal_answer":"260到500字的完整中文回答"}。
必须严格使用“判断：”“拆解：”“验证：”“边界：”“例子：”五段，直接回答练习题；不得虚构经历、客户或未经资料支持的数据。需要数字时只能明确写成待历史基线校准的示例。
练习题：${question.slice(0,2000)}
作答思路：${JSON.stringify(reference).slice(0,3000)}`;
  const answerContext={question,materials:[],reference};
  let previous="",lastProvider="";
  for(let attempt=0;attempt<2;attempt+=1){
    const retryNote=previous?`\n上一版没有形成可直接作答的五段完整答案。请逐段回答当前练习题，删除无依据数字。上一版：${previous.slice(0,3500)}`:"";
    const generated=await callText(env,prompt+retryNote,1800,{temperature:.2,thinking:false,providerTimeouts:{deepseek:50000,openai:15000,"workers-ai":35000}});
    previous=generated.text;lastProvider=generated.provider;
    const value=extractJson(generated.text)?.next_question_ideal_answer||"";
    const answer=sanitizeBlackboardUnsupportedSpecifics(qualifyBlackboardIllustrativeNumbers(value,answerContext),answerContext);
    if(validBlackboardIdealAnswer(answer)&&blackboardTextMatchesQuestion(question,answer)&&!blackboardHasUncalibratedNumbers(answer,answerContext))return {answer,provider:lastProvider};
  }
  throw new Error("下一步练习的阿栗答案连续两次未通过质量校验");
}

const BLACKBOARD_GRADING_FORMAT=`你正在执行 grade-blackboard-answer Skill，像批改政治大题一样给过程分并教会主人怎样答得更好。评分维度和参考答案已在作答前冻结，但参考要点只是高质量答案的锚点，不是关键词清单，也不是唯一答法；原答案采用另一条合理路径时必须正常给分。只返回 JSON：
{"score_breakdown":[{"rubric_id":"逐字复制 rubric id","criterion":"逐字复制 rubric criterion","max":"逐字复制 rubric max","awarded":"0到max的整数","band":"excellent/solid/developing/weak/absent，与分数档一致","evidence":"逐字引用原答案中支撑本项得分的短句；本项0分才留空","reason":"解释这段思考为什么成立、完成到什么程度或错在哪里","teaching":"沿着原答案思路，具体教它怎样补成更强论证，并给出可直接采用的表达"}],"score_summary":"一句话概括答案当前水平和最值得提升处","requirement_map":[{"reference_point":"逐字复制 reference 中的一条","relation":"covered/partial/equivalent/not_covered/off_track","evidence":"covered、partial、equivalent 时逐字引用原答案，其余留空","assessment":"说明与参考点的关系；equivalent 表示走了另一条同样合理的路径","teaching":"告诉主人如何利用、补充或纠正这一处"}],"strengths":[{"evidence":"原答案短引","why_good":"这处思考好在哪里、为什么有价值"}],"direction":"correct/partly_correct/misdirected","correction_path":"方向正确时说明升级路径；方向错误时解释错因并给出纠正顺序","priority_fix":"最优先提升的一件事，包含动作与判断标准","personalized_revision":"基于主人原答案有效观点写成的完整面试升级版","plain_language_coaching":{"what_the_question_wants":"不用术语说明这题到底要你回答什么","answer_steps":["三到五步，每一步说明先做什么以及为什么"],"remember":["两到五条真正需要记住的本题知识"],"memory_hook":"一句简短答题口诀"},"next_question":"一道针对当前薄弱点的新练习","next_question_reference":["三到六条作答思路"],"next_question_ideal_answer":"300到700字的阿栗完整答案，严格包含判断、拆解、验证、边界、例子五段"}。
score_breakdown 必须与 rubric 等长且顺序一致，requirement_map 必须与 reference 等长且顺序一致。先独立理解题意，再阅读主人答案。每一项必须先按 rubric.score_bands 选档，再在该档范围内给分，不得脱离档位凭感觉给整数。按 rubric.scoring_scope 分开计分，同一根因只能归入一个主要扣分维度：偏题、范围或核心概念错误归“题意理解与核心判断”；完全缺失的题目子任务归“任务完成与要点覆盖”；已经提出但没有解释或支撑的观点归“推理链条与证据支撑”；缺少按题型应有的适用条件、例子、场景、取舍、验证、限制或反例归“边界意识与迁移应用”。参考要点只用于校准覆盖，不按是否复现参考措辞给分，不按篇幅扣分。论证合理但未出现在 reference 中也必须给分，并在最接近的参考点标为 equivalent。时效性事实没有 materials 或可靠来源支撑时，标为待核验，不得武断判错。每一个正分项和 strengths 都必须引用主人原答案。方向错误时必须指出错误发生在哪个推理环节，再按顺序给纠正路径；方向正确时必须解释哪里想对了，并沿原思路教它补强。teaching 必须具体，禁止“补充具体方案和指标”“进一步完善”等套话。personalized_revision 必须是一份 300 到 700 字、可在面试中直接说出的完整回答，吸收原答案中成立的观点并实质补齐缺口，不能只在原文后追加一句；严格使用“判断：”“拆解：”“验证：”“边界：”“例子：”五段。plain_language_coaching 必须像当面教初学者：先翻译题意，再给可照着执行的答题步骤、真正要记住的知识和一句口诀，不能复述分数或写空泛鼓励。next_question 必须针对本次最薄弱处但不能原题重问；next_question_ideal_answer 必须真正回答这道新题，是一份使用“判断、拆解、验证、边界、例子”五段的完整面试回答，不能只列提纲。不得编造主人没有说过的经历、数据或项目成果；材料没有给出数据时，不得虚构客户、效果、准确率或硬阈值，需要数字只能明确写成“示例阈值，需由历史基线校准”。context.ideal_answer 是作答前冻结的独立示范回答，只用于校准质量和发现遗漏，不得复制它来冒充个性化改写，也不得修改它。`;

const BLACKBOARD_GRADING_CORE_FORMAT=`你正在执行 grade-blackboard-answer Skill 的评分阶段。只完成评分、教学建议、大白话讲解和下一步练习题；不要在本阶段生成个性化完整回答或下一题完整答案。只返回 JSON：
{"score_breakdown":[{"rubric_id":"逐字复制 rubric id","criterion":"逐字复制 rubric criterion","max":"逐字复制 rubric max","awarded":"0到max整数","band":"excellent/solid/developing/weak/absent","evidence":"正分时逐字引用原答案短句，0分留空","reason":"25到80字说明为什么得分","teaching":"25到100字教主人怎样补强"}],"score_summary":"一句话概括","requirement_map":[{"reference_point":"逐字复制 reference 一条","relation":"covered/partial/equivalent/not_covered/off_track","evidence":"命中时逐字引用原答案，否则留空","assessment":"20到70字说明关系","teaching":"25到100字的具体补强动作"}],"strengths":[{"evidence":"原答案短引","why_good":"为什么有价值"}],"direction":"correct/partly_correct/misdirected","correction_path":"升级或纠正顺序","priority_fix":"最优先提升的一件事","plain_language_coaching":{"what_the_question_wants":"不用术语说明题目要什么","answer_steps":["三到五步"],"remember":["两到五条记忆点"],"memory_hook":"一句口诀"},"next_question":"针对最薄弱处的新练习","next_question_reference":["三到六条作答思路"]}。
score_breakdown 必须与 rubric 等长且顺序一致，requirement_map 必须与 reference 等长且顺序一致。每项先按 score_bands 选档再给分，同一缺陷只归一个主要维度；合理替代论证标 equivalent 并正常给分。每个正分项和 strengths 必须逐字引用主人原答案。teaching 必须给可直接采用的动作或表达，禁止套话。plain_language_coaching 要真正教会初学者；next_question 不能复述原题。context.ideal_answer 只用于校准，不得修改。`;

const BLACKBOARD_REFERENCE_FORMAT=`你正在独立准备一道黑板题的完整示范回答。此请求不会包含主人本次答案，必须先于批改完成。只返回 JSON：{"ideal_answer":"350到700字的完整中文回答"}。ideal_answer 必须真正回答 context.question，而不是列评分提纲；严格使用“判断：”“拆解：”“验证：”“边界：”“例子：”五段。每段都要针对本题，给出具体机制、动作、判断标准或例子。不得编造主人经历、公司数据或资料中没有的最新事实；材料没有数字时，不得虚构准确率、提升幅度或硬阈值，需要演示数字只能明确标为待基线校准的示例。`;

function dateInShanghai(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", {timeZone: "Asia/Shanghai"});
}

const BLACKBOARD_ARCHIVE_CATEGORIES = ["AI 产品与用户体验", "Agent 与系统设计", "模型与技术理解", "评测、质量与安全", "商业化与落地"];

function inferBlackboardArchiveCategory(item) {
  const title = String(item?.title || "").toLowerCase();
  const text = [title, item?.question, ...(Array.isArray(item?.types) ? item.types : [])].join(" ").toLowerCase();
  if (/评测|harness|指标|数据集|测试|幻觉|安全|风险|质量|基准|回滚|可信度/.test(text)) return "评测、质量与安全";
  if (/agent|智能体|蜂群|多智能体|mcp|skill|权限|工作流|记忆|架构|编排|接管|同步|恢复/.test(text)) return "Agent 与系统设计";
  if (/模型|llm|moe|token|上下文|推理|多模态|rag|向量|微调|提示词|路由/.test(text)) return "模型与技术理解";
  if (/商业|成本|价格|定价|roi|收入|增长|运营|市场|付费|毛利/.test(text)) return "商业化与落地";
  return "AI 产品与用户体验";
}

function blackboardArchiveCategory(item) {
  const explicit = String(item?.archive_category || item?.archiveCategory || "").trim();
  return BLACKBOARD_ARCHIVE_CATEGORIES.includes(explicit) ? explicit : inferBlackboardArchiveCategory(item);
}

function blackboardQuestionCompact(value) {
  return String(value || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

function blackboardQuestionSimilarity(left, right) {
  const a = blackboardQuestionCompact(left), b = blackboardQuestionCompact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.72) return 0.95;
  const grams = text => new Set(Array.from({length: Math.max(0, text.length - 1)}, (_, index) => text.slice(index, index + 2)));
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  ga.forEach(value => { if (gb.has(value)) shared += 1; });
  return shared / (ga.size + gb.size - shared);
}

function blackboardQuestionTopicAnchors(value) {
  const text = String(value?.question || value || "").toLowerCase();
  const anchors = ["评测集", "评测", "测试用例", "污染", "客服", "蜂群", "多智能体", "记忆", "权限", "模型路由", "资讯可信", "搜索", "原型", "付费", "商业化", "定价", "多端同步", "人工接管", "失败恢复", "灰度", "回滚"].filter(keyword => text.includes(keyword));
  const common = new Set(["agent", "model", "product", "user", "openai", "llm"]);
  (text.match(/[a-z][a-z0-9._-]{3,}/g) || []).forEach(token => { if (!common.has(token)) anchors.push(token); });
  return new Set(anchors);
}

function blackboardQuestionIsDuplicate(item, history) {
  const question = String(item?.question || item || "");
  const anchors = blackboardQuestionTopicAnchors(question);
  return (history || []).some(previous => {
    if (blackboardQuestionSimilarity(question, previous?.question || previous) >= 0.72) return true;
    const previousAnchors = blackboardQuestionTopicAnchors(previous), shared = [...anchors].filter(anchor => previousAnchors.has(anchor));
    return shared.some(anchor => /^[a-z]/.test(anchor)) || shared.length >= 2;
  });
}

function blackboardQuestionHistory(local) {
  const answers = Array.isArray(local?.values?.cozy_blackboard_answers) ? local.values.cozy_blackboard_answers : [];
  return answers.map(item => ({title: String(item?.title || ""), question: String(item?.question || ""), types: Array.isArray(item?.types) ? item.types.slice(0, 4) : [], archive_category: blackboardArchiveCategory(item), date: String(item?.date || ""), answered: Boolean(item?.answer)})).filter(item => item.question);
}

function nextBlackboardArchiveCategory(history, seed) {
  const counts = Object.fromEntries(BLACKBOARD_ARCHIVE_CATEGORIES.map(name => [name, 0]));
  history.forEach(item => { counts[blackboardArchiveCategory(item)] += 1; });
  const last = history[0] ? blackboardArchiveCategory(history[0]) : "";
  const candidates = BLACKBOARD_ARCHIVE_CATEGORIES.filter(name => name !== last);
  const minimum = Math.min(...candidates.map(name => counts[name]));
  const leastUsed = candidates.filter(name => counts[name] === minimum);
  return leastUsed[Math.abs(Number(seed) || 0) % leastUsed.length];
}

function validCloudBlackboardQuestion(item, date) {
  if (!item || item.date !== date || String(item.question || "").trim().length < 18) return false;
  if (Number(item.alignment_version || 0) < 6) return false;
  const points = Array.isArray(item.standard_points) ? item.standard_points.map(value => String(value).trim()).filter(Boolean) : [];
  if (points.length < 4 || points.some(value => value.length < 8)) return false;
  const rubric = Array.isArray(item.rubric) ? item.rubric : [];
  if (Number(item.rubric_version || 0) < 3 || rubric.length !== 4 || rubric.reduce((sum, row) => sum + Number(row?.max || 0), 0) !== 100) return false;
  if (rubric.map(row => String(row?.id || "")).join("|") !== "comprehension|coverage|reasoning|transfer" || rubric.some(row => !Array.isArray(row?.score_bands) || row.score_bands.length !== 5)) return false;
  if (!item.answer_independent || !item.reference_frozen_at || !item.question_fingerprint) return false;
  if (!BLACKBOARD_ARCHIVE_CATEGORIES.includes(String(item.archive_category || ""))) return false;
  if (Number(item.ideal_answer_version || 0) < 1 || !validBlackboardIdealAnswer(item.ideal_answer)) return false;
  const idealContext={question:item.question,materials:item.materials,reference:points};
  if (blackboardHasUncalibratedNumbers(item.ideal_answer, idealContext)) return false;
  if (blackboardHasUnsupportedSpecifics([item.ideal_answer,...points].join("\n"),idealContext)) return false;
  return !points.some(value => /^\d*\s*到?\s*\d*\s*条?\s*(参考答案)?要点[。.]?$/.test(value));
}

function dueOrchardReview(local, date) {
  const queue = Array.isArray(local?.values?.cozy_orchard_review_queue) ? local.values.cozy_orchard_review_queue : [];
  return queue.filter(item => item && item.status !== "retired" && String(item.dueOn || "") <= date)
    .sort((a, b) => String(a.dueOn || "").localeCompare(String(b.dueOn || "")) || Number(a.reviewCount || 0) - Number(b.reviewCount || 0))[0] || null;
}

function orchardReviewQuestion(date, variant, review) {
  const topic = review?.topic && typeof review.topic === "object" ? review.topic : review || {};
  const title = String(topic.title || "成长田专题").slice(0, 50);
  const points = Array.isArray(topic.knowledgePoints) ? topic.knowledgePoints.map(String).filter(value => value.trim().length >= 8).slice(0, 4) : [];
  const standard = [
    `准确说明“${title}”要解决的核心问题或概念边界。`,
    ...points,
    topic.conclusion ? `说明专题当前结论：${String(topic.conclusion).slice(0, 180)}` : "给出一个适用场景，并说明为什么适用。",
    "指出至少一个限制、反例或仍需验证的条件。"
  ].filter((value, index, list) => value && list.indexOf(value) === index).slice(0, 6);
  while (standard.length < 4) standard.push(["给出一个具体例子来验证理解。", "说明如何把这个知识用于真实产品判断。", "区分事实、推断和个人选择。"][(standard.length - 1) % 3]);
  const topicSummary=String(topic.summary||topic.conclusion||standard[0]||"").slice(0,500);
  const topicDetails=(points.length?points:standard.slice(1,4)).map((point,index)=>`${index+1}. ${point}`).join(" ");
  const idealAnswer=`判断：复习“${title}”时，核心不是背诵专题原文，而是能说明它解决什么问题、为什么成立，以及在什么情况下不能直接套用。根据现有专题记录，当前核心判断是：${topicSummary}\n拆解：${topicDetails} 这些要点需要形成因果关系：先界定对象和问题，再说明方法或差异，最后解释为什么会影响实际决策，而不是只罗列名词。\n验证：可以选择一个与“${title}”直接相关的真实产品任务，把上述方法用于比较两个方案，并写清采用前后的可观察变化；如果无法提出可验证差异，就说明理解仍停留在记忆层。\n边界：专题摘要只代表当前阶段结论。遇到场景、数据、成本或风险条件变化时，需要重新核验；不能把单个案例外推为所有产品都适用的规律。\n例子：面对一个新的相关方案时，先用专题中的核心概念解释它解决的任务，再按关键方法逐项比较，最后指出一个不适用条件。能完成这三步，才说明知识已经可以迁移。`;
  return attachFrozenRubric({
    id: `orchard-review-${String(review.id || topic.id || variant || date)}`, date, title: `${title}复习`,
    type: "成长田复习", types: ["成长田复习", "间隔复习", "理解迁移"],
    archive_category: inferBlackboardArchiveCategory({title, question: topicSummary, types: ["成长田复习", "理解迁移"]}),
    question: `回顾成长田专题“${title}”：请用自己的话说明它的核心概念或问题、关键方法或差异、一个适用场景，以及至少一个限制或反例。不要照抄专题摘要。`,
    materials: topic.summary ? [`专题摘要：${String(topic.summary).slice(0, 260)}`] : [],
    standard_points: standard, ideal_answer:idealAnswer, provider: "orchard-review", alignment_version: 6,
    review_queue_id: String(review.id || ""), related_orchard: {topic_id: String(topic.id || ""), title}
  });
}

function fallbackCloudBlackboardQuestion(date, variant, reports, history = [], targetCategory = "") {
  const topics = [
    {
      title:"失败恢复设计",
      question:"一个 AI 助手执行多步骤任务时，怎样设计进度、重试、人工接管和结果核验，避免用户只看到无限等待？",
      standard:["用可恢复状态机展示当前步骤、已完成结果和剩余工作。","按可重试、需确认和不可恢复三类错误设计不同处理，不盲目重复执行。","为有副作用的步骤设置幂等键、检查点和回滚记录，避免重复扣费或重复写入。","人工接管时交接目标、上下文、已执行动作、失败原因和待确认事项。","完成后核验最终结果而非只核验接口成功，并追踪恢复成功率与重复执行率。"],
      ideal:`判断：多步骤 Agent 的可信度不来自“永不失败”，而来自用户始终知道做到哪一步、失败后能否安全续跑，以及最终结果是否被验证。\n拆解：1. 把任务建成状态机，至少区分待执行、执行中、等待确认、可重试失败、需人工处理和已完成，并在界面显示当前步骤、已产出内容和剩余步骤。2. 错误按性质处理：超时和限流指数退避重试；参数缺失请求用户补充；权限不足停止并解释；支付、删除、发送等有副作用动作不得自动重放。3. 每一步保存输入摘要、幂等键、检查点和工具回执，重试从失败步骤继续。4. 转人工时一次性交接目标、上下文、已完成动作、失败原因和建议下一步。\n验证：用真实多步骤任务统计端到端完成率、失败后恢复成功率、平均恢复时长、重复执行率和人工接管后解决率；严重副作用必须为零。\n边界：涉及付款、不可逆删除、对外发送或高风险决策时，即使技术上可重试，也必须先由用户确认；无法确认最终状态时应标记“结果未知”，不能谎报完成。\n例子：报销 Agent 在上传发票成功、提交审批超时后，应先查询审批单是否已经创建；确认不存在才使用同一幂等键重提，仍失败则把发票、表单和错误回执交给人工，而不是整单从头再跑。`
    },
    {
      title:"记忆边界设计",
      question:"如果你负责长期陪伴型 AI，怎样决定哪些内容可以自动记住、哪些需要确认、哪些必须封存或彻底遗忘？",
      standard:["按任务价值、敏感度、稳定性和可撤回性判断是否记忆，而不是把所有对话都长期保存。","区分短期上下文、可编辑偏好、长期事实和封存私密内容，并限定各自使用范围。","涉及身份、健康、关系、财务等敏感信息必须显式确认，封存内容不得跨场景调用。","提供查看、纠正、删除、暂停记忆和解释本轮使用了什么记忆的入口。","用误记率、纠正率、删除残留和跨场景误用测试记忆系统。"],
      ideal:`判断：长期陪伴型 AI 不应追求“记得越多越好”，而应只记对未来确有帮助、相对稳定、用户可理解且可撤回的内容。记忆权限必须小于聊天权限。\n拆解：1. 分四层保存：当前会话只做短期上下文；表达方式、学习节奏等偏好可自动形成候选；姓名、长期目标等稳定事实需用户确认后进入长期记忆；健康、关系、财务和私密经历默认封存，只能在原场景使用。2. 每条记忆保存来源、形成时间、置信度、适用范围和过期规则，模型不得把一次情绪推断成永久人格。3. 新记忆先显示“我准备记住什么”，冲突时保留版本并请用户选择。4. 提供记忆列表、单条纠正、彻底删除、暂停记忆和本轮引用说明。\n验证：构造误记、过时、相互冲突、删除后重现和跨房间调用用例，观察误记率、纠正成功率、删除残留率及不相关记忆引用率。\n边界：法律身份、医疗结论、财务能力和亲密关系判断不能由模型自行推断；用户要求遗忘后，主存储、索引和备份都要按规则处理，不能只在界面隐藏。\n例子：用户说“今天不想听建议”只影响当次对话；连续多次明确要求“先给结论再解释”可以形成待确认偏好；树洞中的具体私事即使有助于解释情绪，也不能自动拿到学习或工作问答里。`
    },
    {
      title:"评测集设计",
      question:"准备上线一个 AI 搜索功能时，你会怎样设计正常、边界、对抗和失败样例，并用哪些指标决定是否上线？",
      standard:["从真实用户任务分层抽样，覆盖事实检索、比较、时效性和多轮追问等正常场景。","单独建立模糊问题、无答案、来源冲突、长尾语言和上下文不足等边界样例。","加入提示注入、恶意网页、隐私泄露和虚假引用等对抗样例。","同时评价答案正确性、引用可追溯性、任务完成率、延迟、成本和严重事故。","冻结回归集并按风险设上线阈值，严重安全问题一票否决且灰度后继续监控。"],
      ideal:`判断：AI 搜索是否上线不能只看“回答像不像”，而要证明它在真实任务中比现状更有效，并且引用、时效和安全风险可控。\n拆解：1. 从搜索日志和访谈中按任务分层抽样，建立事实查询、方案比较、最新动态、多轮追问等正常集。2. 建边界集覆盖问题含糊、网页无答案、来源互相冲突、冷门语言、超长材料和上下文不足。3. 建对抗集测试网页提示注入、伪造权威来源、隐私诱导和虚假引用。4. 每条样例冻结问题、可接受答案范围、必需来源、禁止错误和人工判分规则；模型或提示词变化后跑同一回归集。\n验证：核心指标包括任务完成率、事实正确率、引用支持率、无答案时的克制率、P95 延迟和单次成本；高风险领域单列。上线门槛可以设为核心任务显著优于旧方案，引用支持率达到预设线，严重隐私泄露和伪造引用为零。\n边界：平均分不能掩盖严重事故；没有可靠答案时，正确行为是说明不确定并给核验路径，而不是强行生成。\n例子：对“本周某模型是否降价”这类题，既检查结论，也逐条核对发布日期、官方价格页和引用是否真的支持答案；若引用指向首页而非具体公告，应判为失败。`
    },
    {
      title:"Agent 权限",
      question:"当 AI 可以修改用户数据时，你会怎样划分权限等级、确认时机、审计记录和失败回滚？",
      standard:["按只读、可撤销写入、对外影响和不可逆高风险四级划分动作权限。","确认应发生在用户仍能理解影响的最后安全节点，并展示对象、范围和后果。","最小授权且短期有效，工具调用不能继承无关权限或绕过业务规则。","审计记录要包含发起者、模型判断、参数摘要、工具回执和最终状态。","用幂等、版本、软删除、补偿动作和人工恢复处理失败，未知状态不得宣称成功。"],
      ideal:`判断：Agent 权限设计的核心不是“能不能调用工具”，而是让授权范围与动作风险匹配，并保证任何写操作都可追踪、可停止、尽量可恢复。\n拆解：1. 一级为读取和草稿，可自动执行；二级为可撤销写入，如改标签、建待办，可执行后提示并提供撤销；三级为对外发送、共享或批量修改，必须在执行前展示对象、范围和影响并确认；四级为付款、永久删除、改权限等不可逆动作，需强确认或禁止自动执行。2. 授权采用最小范围和短时令牌，任务结束立即失效。3. 确认放在参数已完整、尚未产生副作用的最后节点，不能一开始用一句“允许所有操作”代替。4. 审计保存用户指令、模型计划、实际参数、工具回执、时间和最终状态。\n验证：测试越权调用、参数被模型偷偷扩大、重复提交、执行中断和回滚失败；观察未授权动作拦截率、撤销成功率和未知状态占比。\n边界：外部系统不支持回滚时，只能使用补偿动作或转人工；接口超时但结果未知时先查询状态，不能直接重试。\n例子：AI 批量删除照片时，应先生成待删除清单并说明数量，确认后先移入回收站；每张照片记录版本和回执，部分失败只重试失败项，并允许用户一键恢复。`
    },
    {
      title:"原型验证",
      question:"只有三天验证一个 AI 产品想法时，你会做什么最小原型、选择哪些真实用户任务，并依据什么信号继续或停止？",
      standard:["把最大未知假设改写成可证伪问题，而不是三天内做完整产品。","用人工服务、现成模型和轻界面组成最小闭环，只实现用户可完成的核心任务。","选择真实目标用户的高频或高痛任务，并保留当前方案作为对照。","同时观察任务成功、时间节省、重复使用意愿、人工成本和严重失败。","预先定义继续、调整和停止阈值，避免看到几个好评就扩大投入。"],
      ideal:`判断：三天的目标不是证明产品一定成功，而是用最低成本证伪最关键的产品假设。我会优先验证“目标用户是否愿意把一个真实任务交给它，以及结果是否明显优于现有方式”。\n拆解：第 1 天访谈 5 到 8 名目标用户，从真实记录中挑一个高频、高痛且结果可判断的任务，写清当前耗时和失败点；用表单或聊天界面加现成模型，复杂步骤由人工在后台补齐。第 2 天让用户带自己的材料完成任务，研究者只观察不教学，同时保留他们原来的做法作为对照。第 3 天复测修改后的关键环节，并核算每单人工介入与模型成本。\n验证：记录独立完成率、相对当前方案节省的时间、关键错误数、用户是否主动再次使用、愿意付出的价格或替代成本，以及每单人工分钟数。预先规定：核心任务多数能独立完成、无严重错误、确有重复使用信号且人工成本可下降才继续；否则调整场景或停止。\n边界：不把“用户觉得很酷”当需求，也不在三天内做登录、社区或复杂后台；涉及隐私、高风险决策时只用脱敏材料。\n例子：验证简历诊断时，不先做完整求职平台，而让真实求职者上传一版简历，交付针对目标岗位的修改清单，再比较修改前后的面试官可读性和用户是否愿意再次使用。`
    },
    {
      title:"模型路由",
      question:"面对质量、速度和成本不同的多个模型，你会怎样按任务风险设计路由、兜底和降级提示？",
      standard:["先按任务复杂度、时效要求、错误代价和数据敏感度分层，而不是固定一个主模型。","低风险简单任务走快而便宜的模型，高风险或复杂推理走强模型并增加核验。","路由依据应可观察并可回放，关键任务设置质量门槛而非只看接口成功。","兜底要区分同模型重试、切换供应商、规则降级和人工接管，防止级联失败。","通过影子流量和分层指标评估质量、延迟、成本及切换损失，并向用户明确降级。"],
      ideal:`判断：模型路由不是“主模型坏了换备用”，而是先判断任务需要什么质量、速度和风险控制，再选择满足底线且总成本最低的路径。\n拆解：1. 任务入口提取复杂度、实时性、上下文长度、是否调用工具、错误代价和数据敏感度。改写文案等低风险任务走快速模型；多约束分析走强模型；付款、医疗或权限修改即使模型很强也要增加规则校验与人工确认。2. 每条路由有质量门槛、超时和预算，记录为什么选这个模型。3. 失败先判断原因：限流可短重试，供应商故障切另一模型，输出质量不足升级强模型，关键任务仍不可靠则转人工。4. 降级时保留已完成部分并告诉用户缺失能力。\n验证：先用影子流量在同一任务集对比正确率、任务完成率、P95 延迟、单次成本、升级率和切换后的质量损失，再小流量灰度。\n边界：不能把敏感数据发给不满足合规要求的备用模型，也不能在上下文或工具能力不兼容时盲切；低价模型连续重试可能比一次强模型更贵。\n例子：会议摘要默认走快模型；检测到多语言、超长录音或要求提取决策冲突时升级强模型；若强模型超时，先返回已验证的结构化纪要，并标明“风险判断尚未完成”，而不是静默给一份低质量结果。`
    },
    {
      title:"信息可信度",
      question:"一个资讯整理 AI 怎样区分事实、来源摘要和模型判断，并在来源冲突或全部失败时向用户表达？",
      standard:["数据结构和界面明确区分原文事实、忠实摘要、中文翻译和模型分析。","每个事实保留具体文章链接、发布时间、发布者和抓取时间，不能用官网首页冒充来源。","跨来源去重但保留不同立场，冲突时并列证据并解释尚未确认之处。","模型推断必须用显式措辞标注，并禁止无来源的数字、因果和结论。","单源失败局部降级，全部失败时保留旧版并明确更新时间，不能把缓存伪装成最新。"],
      ideal:`判断：资讯 AI 的可信度来自证据链透明，而不是把所有内容都写得像确定事实。产品必须让用户一眼分清“来源说了什么”和“模型怎么看”。\n拆解：1. 每条卡片分四层：英文或中文原文摘要保持来源立场；中文翻译只做忠实转换；AI 总结解释影响但明确推断；阅读笔记只属于用户。2. 事实字段绑定具体文章 URL、媒体、作者或发布组织、发布日期和抓取时间，官网首页不能替代文章链接。3. 多源报道先按事件去重，再保留关键差异；官方公告、当事方回应和媒体推测使用不同可信等级。4. 模型写“这意味着”时必须能指回证据，不能补造价格、指标或发布日期。\n验证：抽样核对标题、数字、引用和立场，统计引用可达率、事实支持率、错误合并率及冲突识别率；对回应、辟谣和传闻做专项测试。\n边界：部分来源失败只影响对应卡片，不能拖垮整版；全部失败时显示“上次成功更新于某时”，继续展示旧版但不得标成今天更新。\n例子：一家厂商否认涨价时，事实层写“厂商否认涨价传闻”，AI 分析可以说“价格策略仍需观察”，但绝不能总结成“该产品即将涨价”。`
    },
    {
      title:"人工接管",
      question:"在客服 Agent 中，哪些信号应触发人工接管，怎样交接上下文，并如何衡量接管机制是否有效？",
      standard:["从用户明确要求、模型低置信、连续失败、情绪升级和高风险意图五类信号触发接管。","不同风险采用不同阈值，不能只用统一轮次或关键词规则。","交接包包含用户目标、关键事实、已尝试方案、工具结果、失败原因和待决问题。","转人工前向用户说明原因和等待状态，人工接入后避免要求用户重新复述。","衡量正确接管率、漏接率、误接率、接管后解决率、等待时间和重复陈述率。"],
      ideal:`判断：人工接管不是 Agent 失败后的兜底按钮，而是服务流程中的正式能力。触发要同时考虑风险和解决概率，交接目标是让人工接手后直接继续，而不是让用户从头再说。\n拆解：1. 五类信号触发接管：用户明确要求人工；模型连续两次无法推进；工具返回权限或未知状态；检测到投诉、威胁或情绪升级；涉及退款、账户安全、医疗等高风险事项。2. 低风险咨询可允许一次澄清，高风险动作首次不确定就接管，不用统一轮次。3. 交接包自动整理用户目标、订单或账户对象、已确认事实、模型已尝试动作、工具回执、失败原因和仍需人工决定的问题。4. 转接前告诉用户原因、预计等待和已保存内容，人工界面突出待决项。\n验证：统计正确接管率、应接未接率、误接率、平均等待时长、人工接入后一次解决率和用户重复陈述率，并抽查严重漏接。\n边界：情绪识别只能作为辅助信号，不能因表达方式直接拒绝服务；模型不得为了降低接管率继续处理超出权限的事项。\n例子：用户说“已经扣款但订单没生成”，Agent 查询两边状态仍不一致时，应立即冻结重复扣款风险，带上支付流水、查询结果和失败步骤转人工，而不是再次发起支付。`
    },
    {
      title:"多端同步",
      question:"一个同时在手机和电脑使用的个人 AI 产品，怎样处理离线修改、并发冲突、删除防复活和媒体文件同步？",
      standard:["以云端版本化记录为主，每次修改携带记录版本、设备标识和操作时间。","文本按字段或操作日志合并，无法安全自动合并的冲突保留双版本并让用户选择。","删除使用带版本的墓碑并同步到所有设备，确认窗口结束后再物理清理。","媒体文件内容寻址、分片重试并与元数据分开同步，上传完成前不能发布失效引用。","覆盖离线多日、时钟偏差、重复提交、同项并改和删除后旧设备上线等测试。"],
      ideal:`判断：多端同步不能用“最后一次上传覆盖全部”解决，因为离线设备、时钟偏差和删除操作会造成数据丢失或复活。应以云端为主，但每条记录都要版本化并保留可合并的操作信息。\n拆解：1. 每次写入携带记录版本、设备 ID、操作 ID 和基于哪个版本修改，服务端用操作 ID 保证幂等。2. 不同字段的并发修改可自动合并；同一字段冲突保留两个版本，展示差异让用户选择，不能静默覆盖。3. 删除写成带版本的墓碑并同步到所有设备；旧设备上线时看到墓碑就停止上传旧记录，超过保留期且设备确认后再物理清理。4. 图片和音视频用内容哈希去重、分片上传和断点续传，元数据先标“上传中”，文件校验完成后再生成可引用地址。\n验证：模拟手机离线三天、两端同时改标题、电脑删除而手机继续编辑、重复提交和设备时钟错误，检查丢失率、冲突解决率、删除复活率及媒体完整率。\n边界：涉及隐私数据时本地和传输都要加密；自动合并不得改变用户原意，无法判定时宁可暴露冲突。\n例子：电脑删除一条旅行记录后，离线手机又修改了描述。手机上线时服务端不能直接复活记录，而应提示“该记录已在电脑删除，是否恢复为新版本”，并保留原墓碑审计。`
    },
    {
      title:"商业验证",
      question:"一个 AI 功能调用成本较高时，你会怎样验证用户价值、付费意愿和单位经济模型，而不是只看使用次数？",
      standard:["先验证功能是否改善高价值真实任务，并与当前替代方案比较结果和时间。","用真实价格、额度或付费门槛测试支付行为，不能只问用户愿不愿付费。","按用户与任务分层计算收入、模型调用、人工、基础设施和获客成本。","观察重复使用、付费转化、贡献毛利和质量风险，识别高使用低价值的假繁荣。","预先定义继续、优化路由、限额和停止条件，并通过降级模型或缓存验证成本弹性。"],
      ideal:`判断：高调用成本功能是否成立，要依次验证价值、支付和单位经济，三者缺一不可。使用次数只能说明被点过，不能证明解决了重要问题，更不能证明可持续。\n拆解：1. 选一个用户愿意投入时间或金钱的真实任务，与当前人工或旧工具对照，测结果质量、完成时间和失败代价。2. 在价值成立后设置真实价格、免费额度或按次购买，让用户做支付选择，而不是只做意愿访谈。3. 按用户和任务分层核算单次收入减去模型、检索、存储、人工审核、退款和获客分摊后的贡献毛利，找出最耗成本的长尾请求。4. 通过模型路由、缓存、上下文裁剪和次数限制测试成本能否下降且质量不破线。\n验证：核心看任务成功率、重复使用率、真实付费转化、客单价、单次完全成本和贡献毛利；同时监控严重质量事故。预先设继续、优化和停止线，例如价值指标达标但毛利为负就先优化成本，不立即放量。\n边界：不能用免费期高频掩盖付费后流失，也不能为了毛利把高风险任务降级到不可靠模型。\n例子：AI 商务报告功能应比较用户自己完成与 AI 辅助后的时间和返工率，再用真实月度额度测试付费；若重度用户每份报告的模型成本超过收入，就按任务复杂度路由，而不是简单提高所有人的价格。`
    }
  ];
  const seed = [...`${date}|${variant}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const unused = topics.filter(topic => !blackboardQuestionIsDuplicate(topic, history));
  const categoryMatches = unused.filter(topic => inferBlackboardArchiveCategory(topic) === targetCategory);
  const pool = categoryMatches.length ? categoryMatches : unused;
  if (!pool.length) throw new Error("没有可用的不重复备用题目");
  let selected = pool[seed % pool.length];
  let {title, question, standard, ideal: idealAnswer} = selected;
  const latest = (reports?.reports || [])[0];
  const source = [...(latest?.hot_items || []), ...(latest?.sections || []).flatMap(section => section.items || [])][0];
  const useNews=Boolean(source?.title)&&seed%3===0&&targetCategory==="AI 产品与用户体验"&&!blackboardQuestionIsDuplicate({question:`结合资讯“${String(source.title).trim()}”`},history);
  let materials=[];
  if(useNews){
    const sourceTitle=String(source.title).trim();
    const sourceSummary=ensureChineseAiSummary(source.ai_summary || source.summary,source,source.category || "AI 产品").slice(0,220);
    title="资讯判断";
    question=`结合资讯“${sourceTitle}”，如果你负责一款 AI 产品，会怎样判断这项变化是否值得接入？请从用户任务、能力变化、成本与限制、验证指标和上线边界回答。`;
    materials=[`资讯原题：${sourceTitle}`];
    if(sourceSummary)materials.push(`中文摘要：${sourceSummary}`);
    standard=[
      `明确“${sourceTitle}”可能改变的目标用户和具体任务，不只复述发布内容。`,
      "把新旧方案在任务质量、时延、成本、稳定性和合规要求上做同任务对照。",
      "用真实样本、影子流量或小范围灰度验证，并预先定义通过指标和观察周期。",
      "识别供应商依赖、能力缺口、数据边界和切换失败后的降级方案。",
      "根据验证结果给出接入、限定场景试用或暂缓的明确决策，而不是默认追新。"
    ];
    idealAnswer=/Daybreak|Cyber|网络安全|漏洞/i.test(`${sourceTitle} ${sourceSummary}`)
      ? `判断：我不会因为“${sourceTitle}”已在 AWS 可用就直接接入。它降低的是获取和部署门槛，是否值得用仍取决于授权安全研究任务是否真实存在、专业能力是否优于现有方案，以及滥用和数据风险能否被控制。\n拆解：先限定目标用户为经过授权的内部安全团队或研究人员，再把任务拆成漏洞线索筛查、复现辅助、报告整理等可审计环节。对每一环节比较新旧方案的有效发现、误报、耗时、人工复核成本和敏感数据处理方式；同时审查 AWS 区域、日志、权限、模型版本变化、供应商依赖与故障回退。\n验证：用脱敏且有已知结论的授权样本做盲测，按任务分别记录有效发现率、严重误报、复核时间、P95 时延和单次完全成本。通过线必须在测试前按历史基线和风险等级确定，先影子运行，再限定研究环境灰度。\n边界：模型不得自主扫描未授权目标、执行不可逆利用或绕过审批；涉及生产系统、敏感漏洞和外部发送时必须人工确认并保留审计。数据合规、隔离环境或可用回退任一不成立，就暂缓接入。\n例子：可以选择一组已获授权且结论已知的漏洞验证任务，让新旧模型分别提出验证步骤和证据，研究员只在隔离环境执行。只有新模型减少无效步骤、没有增加高风险误报，并且故障时能回到现有流程，才开放给限定团队。`
      : `判断：我不会因为“${sourceTitle}”已经发布就直接接入，而会先确认它是否能改善我们最重要的用户任务，并且收益足以覆盖迁移成本和新增风险。\n拆解：1. 先锁定受影响的用户与任务，写清当前方案的质量、时延、成本和失败点。2. 把资讯中的能力变化翻译成可验证假设，例如是否减少人工步骤、提高复杂任务成功率或降低单次成本；没有资料支持的部分标为待验证。3. 用同一批真实样本让新旧方案并行，先走影子流量，再做小范围灰度。4. 同时评估接口稳定性、数据合规、供应商锁定、模型版本变化和故障时的降级路径。\n验证：按任务分层观察完成率、关键错误率、P95 时延、单次完全成本、人工接管率和用户重复使用信号；预先设置通过线和至少一个完整业务周期，避免只看演示样例。\n边界：如果它只在少数样例更好、关键任务质量不稳定、敏感数据无法合规处理，或故障时没有可接受的替代方案，就只做限定场景试用或暂缓接入。\n例子：选择一项高价值复杂任务和一项低风险简单任务做同样本盲测；只有前者显著改善且成本、延迟和风险仍在预算内，才把新能力限定路由到该场景，而不是全量替换。`;
  }
  return attachFrozenRubric({
    id: `cloud-${date}-${variant || "daily"}`, date, title, type: "产品场景",
    types: ["产品场景", "方法设计", "边界判断"], question,
    archive_category: useNews ? "AI 产品与用户体验" : inferBlackboardArchiveCategory(selected),
    materials,
    standard, ideal_answer: idealAnswer,
    provider: "deterministic-fallback", source_title: useNews?source.title:"", alignment_version: 6,
    related_notice:useNews?{id:String(source.id||''),title:String(source.title),url:String(source.link||source.url||''),report_id:String(latest?.id||'')}:null
  });
}

async function cloudBlackboardQuestion(env, variant = "") {
  const date = dateInShanghai();
  const local = await readData(env, "local_state");
  const history = blackboardQuestionHistory(local);
  const dueReview = dueOrchardReview(local, date);
  const reviewSuffix = dueReview ? `:review:${String(dueReview.id || dueReview.topic?.id || "topic").slice(0, 80)}` : "";
  const cacheKey = `blackboard:question:v14:${date}${variant ? `:${variant}` : ""}${reviewSuffix}`;
  const cached = await readState(env, cacheKey, null);
  const cachedHistory = variant ? history : history.filter(item => item.date !== date);
  if (validCloudBlackboardQuestion(cached, date) && !blackboardQuestionIsDuplicate(cached, cachedHistory)) return cached;
  if (dueReview && !variant) {
    const question = orchardReviewQuestion(date, variant, dueReview);
    if (!blackboardQuestionIsDuplicate(question, history)) {
      await writeState(env, cacheKey, question, {expirationTtl: 60 * 60 * 24 * 45});
      return question;
    }
  }
  const [reports, memory] = await Promise.all([
    readData(env, "notice_reports"), memoryContext(env, "blackboard_question")
  ]);
  const directions = Array.isArray(local?.values?.cozy_blackboard_directions) ? local.values.cozy_blackboard_directions.slice(0, 8) : [];
  const recentQuestions = history.slice(0, 8);
  const latest=(reports.reports||[])[0];
  const candidateSource=[...(latest?.hot_items||[]),...(latest?.sections||[]).flatMap(section=>section.items||[])][0]||null;
  const questionSeed=[...`${date}|${variant}`].reduce((sum,char)=>sum+char.charCodeAt(0),0);
  const targetCategory=nextBlackboardArchiveCategory(history,questionSeed);
  const primarySource=candidateSource&&questionSeed%3===0&&targetCategory==="AI 产品与用户体验"?candidateSource:null;
  const prompt = `你是栗壳小院的产品黑板出题人。生成一道今天的开放问答题，训练 AI 产品经理的真实判断力。你必须在看到主人本次答案之前，独立写好并冻结完整示范回答。
必须只返回 JSON：{"title":"10字内题名","archive_category":"指定主分类","question":"明确题目","types":["题型"],"materials":["最多2条具体资料"],"standard_points":["4到6条只针对本题的评分参考要点"],"ideal_answer":"350到700字、可直接用于面试的完整回答"}。
有指定资讯时，题目必须直接讨论该资讯，question 中必须完整引用它的原标题；materials 也只能解释同一篇资讯，不能把通用题目与随机资讯拼在一起。题型可在产品场景、模型能力、评测、Agent、安全权限、时事判断之间轮换。标准要点需要可操作、可举例，但不得编造主人经历。
standard_points 只能是本题特有的判断点，禁止复用“明确用户、拆解流程、设置指标、覆盖边界、小范围验证”这类适用于所有题的万能五点。ideal_answer 必须真正回答 question，不能只是提纲；严格使用“判断：”“拆解：”“验证：”“边界：”“例子：”五段，给出具体机制、动作、指标或例子，不编造主人经历和不存在的事实。材料没有数据时，不得虚构客户、准确率、提升幅度或硬阈值；需要数字只能明确写成待历史基线校准的示例。
日期：${date}
本题必须属于主分类“${targetCategory}”，不得改成最近题目的延伸练习。
出题方向留言：${JSON.stringify(directions)}
最近已做题目（只用于避重和分类轮换，不含答案、批改或下一步练习）：${JSON.stringify(recentQuestions).slice(0, 5000)}
指定资讯：${primarySource?JSON.stringify(primarySource).slice(0,5000):"本题不关联资讯，请独立生成通用产品题，不得虚构或强行引用新闻。"}
相关记忆：${JSON.stringify(memory).slice(0, 5000)}`;
  const finalPrompt = prompt + (variant ? `\n这是同一天的换题请求（编号 ${variant}）。必须避开所有最近已做题目的核心问题，换一个训练方向；绝不能采用任何旧记录里的下一步练习。` : "");
  let question;
  for (let attempt = 0; attempt < 2 && !question; attempt += 1) {
    try {
      const repair = attempt ? "\n上一版与历史题目重复或结构不完整。请彻底更换问题对象和核心任务，不得只替换行业名词。" : "";
      const result = await callText(env, finalPrompt + repair, 3200, {temperature:0.35,thinking:false});
      const parsed = extractJson(result.text);
      const points = Array.isArray(parsed.standard_points) ? parsed.standard_points.slice(0, 7).map(String) : [];
      const candidate = attachFrozenRubric({
        id: `cloud-${date}-${variant || "daily"}`, date, title: String(parsed.title || "今天的产品判断").slice(0, 40),
        type: String((parsed.types || ["产品场景"])[0] || "产品场景"), archive_category: targetCategory,
        types: (parsed.types || ["产品场景"]).slice(0, 4), question: String(parsed.question || "").slice(0, 2000),
        materials: (parsed.materials || []).slice(0, 2).map(String),
        standard: points, standard_points: points, ideal_answer:String(parsed.ideal_answer||""), provider: result.provider, alignment_version: 6,
        related_notice:primarySource?{id:String(primarySource.id||''),title:String(primarySource.title),url:String(primarySource.link||primarySource.url||''),report_id:String(latest?.id||'')}:null
      });
      if(primarySource?.title&&!candidate.question.includes(String(primarySource.title)))throw new Error("每日题与指定资讯不一致");
      if (!validCloudBlackboardQuestion(candidate, date)) throw new Error("模型生成的题目结构不完整");
      if (blackboardQuestionIsDuplicate(candidate, history)) throw new Error("模型生成了做过的题目");
      question = candidate;
    } catch (_error) {}
  }
  if (!question) question = fallbackCloudBlackboardQuestion(date, variant, reports, history, targetCategory);
  await writeState(env, cacheKey, question, {expirationTtl: 60 * 60 * 24 * 45});
  return question;
}

function rssText(value) {
  return cleanHtml(String(value || "").replace(/<!\[CDATA\[|\]\]>/g, " "));
}

function ensureChineseAiSummary(value, source, category) {
  const text = String(value || "").trim();
  if(/自动中文整理暂时没有可靠完成|阿栗先保留来源|避免把英文原文误当成中文总结|可以打开原文核对详情/.test(text))return "";
  return (text.match(/[\u4e00-\u9fff]/g) || []).length >= 20 ? text.slice(0, 1200) : "";
}

function noticeTextIsChinese(value,minChinese=8){
  const text=String(value||'').trim();
  const chinese=(text.match(/[\u4e00-\u9fff]/g)||[]).length;
  const latin=(text.match(/[A-Za-z]/g)||[]).length;
  return chinese>=minChinese&&chinese>=latin*.25;
}

function parseNewsFeed(xml, source) {
  const blocks = [...String(xml || "").matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0, 24);
  return blocks.map((match, index) => {
    const body = match[2];
    const field = tag => rssText(body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]);
    const sourceMatch = body.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    const atomLink = body.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || "";
    const link = field("link") || rssText(atomLink);
    return {
      id: `${source.id}-${index}`, title: field("title"), link,
      published_at: field("pubDate") || field("published") || field("updated"),
      media: rssText(source.name || sourceMatch?.[2]),
      source_url: source.url,
      publisher_name: rssText(sourceMatch?.[2]),
      publisher_url: sourceMatch?.[1] || "",
      summary: (field("description") || field("summary") || field("content")).slice(0,1600)
    };
  }).filter(item => item.title && item.link);
}

async function fetchNewsFeedJson(source){
  const endpoint=new URL("https://api.rss2json.com/v1/api.json");
  endpoint.searchParams.set("rss_url",source.url);
  const response=await fetch(endpoint,{headers:{"user-agent":"ChestnutCourtyard/1.0",accept:"application/json"},signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error(`RSS 代理返回 HTTP ${response.status}`);
  const payload=await response.json();
  if(payload?.status!=="ok")throw new Error(String(payload?.message||"RSS 代理没有返回资讯"));
  const items=(payload.items||[]).slice(0,24).map((item,index)=>{
    const suffix=String(item.title||'').match(/\s+-\s+([^–—-]{2,40})$/)?.[1]||'';
    return {id:`${source.id}-proxy-${index}`,title:rssText(item.title),link:String(item.link||''),published_at:item.pubDate||item.published||'',media:suffix||source.name,source_url:source.url,summary:rssText(item.description||item.content||item.title)};
  }).filter(item=>item.title&&item.link);
  if(!items.length)throw new Error(`${source.name} 的 RSS 代理没有返回可解析资讯`);
  return items;
}

async function fetchNewsFeed(source) {
  const response = await fetch(source.url, {
    headers: {"user-agent": "ChestnutCourtyard/1.0", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml"},
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`${source.name} 返回 HTTP ${response.status}`);
  const xml = await response.text();
  const items = parseNewsFeed(xml, source);
  if (!items.length) throw new Error(`${source.name} 没有返回可解析资讯`);
  return items;
}

async function fetchNewsRss(query) {
  const host=String(query).match(/site:([^\s)]+)/)?.[1]?.replace(/^www\./,'')||'';
  const knownNames={"36kr.com":"36氪","qbitai.com":"量子位","jiqizhixin.com":"机器之心","infoq.cn":"InfoQ 中文"};
  const items=await fetchNewsFeed({
    id: `google-${Math.abs([...query].reduce((sum, char) => sum + char.charCodeAt(0), 0))}`,
    name: knownNames[host]||"Google News",
    url: `https://news.google.com/rss/search?${new URLSearchParams({q: query, hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans"})}`
  });
  return items.map(item=>{
    const original=String(item.link||'');
    const publisher=String(item.publisher_url||'');
    try{
      const parsed=new URL(publisher);
      if(/^https?:$/.test(parsed.protocol)&&!/(^|\.)news\.google\.com$/i.test(parsed.hostname))return {...item,link:parsed.toString(),publisher_url:parsed.toString(),google_news_url:original,link_kind:"source_homepage"};
    }catch(_error){}
    return {...item,link:"",google_news_url:original,link_kind:"unavailable"};
  }).filter(item=>item.link);
}

const DIRECT_NEWS_FEEDS = [
  {id: "ithome", name: "IT之家", url: "https://www.ithome.com/rss/"},
  {id: "geekpark", name: "极客公园", url: "https://www.geekpark.net/rss"},
  {id: "modelscope-swift", name: "ModelScope ms-swift", url: "https://github.com/modelscope/ms-swift/releases.atom"},
  {id: "openai", name: "OpenAI News", url: "https://openai.com/news/rss.xml"},
  {id: "cloudflare", name: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", aliases: ["cloudflare", "cloudflare blog"]},
  {id: "google-ai", name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/"},
  {id: "deepmind", name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml"},
  {id: "verge-ai", name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
  {id: "techcrunch-ai", name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/"},
  {id: "mit-tech-review-ai", name: "MIT Technology Review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/"},
  {id: "github-ai", name: "GitHub AI & ML", url: "https://github.blog/ai-and-ml/feed/"},
  {id: "aws-ml", name: "AWS Machine Learning", url: "https://aws.amazon.com/blogs/machine-learning/feed/"},
  {id: "arxiv-ai", name: "arXiv cs.AI", url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI&start=0&max_results=10&sortBy=submittedDate&sortOrder=descending"}
];

const PROXIED_NEWS_FEEDS=[
  {id:"qbitai",name:"量子位",url:"https://www.qbitai.com/feed/"}
];

async function fetch36KrNewsflashes(){
  const response=await fetch("https://gateway.36kr.com/api/mis/nav/newsflash/flow",{
    method:"POST",
    headers:{"content-type":"application/json","user-agent":"Mozilla/5.0 ChestnutCourtyard/1.0","accept":"application/json, text/plain, */*","origin":"https://36kr.com","referer":"https://36kr.com/"},
    body:JSON.stringify({partner_id:"web",param:{platformId:1,siteId:1,pageSize:20,pageEvent:0,pageCallback:""}}),
    signal:AbortSignal.timeout(7000)
  });
  if(!response.ok)throw new Error(`36氪 返回 HTTP ${response.status}`);
  const payload=await response.json();
  const rows=Array.isArray(payload?.data?.itemList)?payload.data.itemList:Array.isArray(payload?.data?.items)?payload.data.items:[];
  const items=rows.map(row=>{
    let material=row?.templateMaterial||row?.material||{};
    if(typeof material==='string'){try{material=JSON.parse(material);}catch(_error){material={};}}
    const routeId=String(row?.route||'').match(/[?&]itemId=(\d+)/)?.[1]||'';
    const id=String(row?.itemId||material.itemId||routeId||'');
    const title=rssText(material.widgetTitle||material.title||row?.title||'');
    const summary=rssText(material.widgetContent||material.summary||material.content||row?.summary||'').slice(0,1600);
    return {id:`36kr-${id}`,title,link:id?`https://36kr.com/newsflashes/${id}`:"",published_at:material.publishTime?new Date(Number(material.publishTime)).toISOString():"",media:"36氪",source_url:"https://36kr.com/",summary};
  }).filter(item=>item.title&&item.link);
  if(!items.length)throw new Error(`36氪 没有返回可解析资讯（返回 ${rows.length} 条）`);
  return items;
}

const CHINESE_TECH_MEDIA_QUERIES = [
  'site:36kr.com (AI OR 人工智能 OR 大模型) when:14d',
  'site:qbitai.com (AI OR 大模型 OR 智能体) when:14d',
  'site:jiqizhixin.com (AI OR 大模型 OR 智能体) when:14d',
  'site:infoq.cn (AI OR 大模型 OR 智能体) when:14d'
];

const NOTICE_TOPIC_GROUPS = [
  {id:"cloudflare",role:"brand",request:/cloudflare|云盾/i,aliases:["cloudflare","cloudflare blog"]},
  {id:"openai",role:"brand",request:/openai|chatgpt/i,aliases:["openai","chatgpt"]},
  {id:"anthropic",role:"brand",request:/anthropic|claude/i,aliases:["anthropic","claude"]},
  {id:"google",role:"brand",request:/google|谷歌|gemini/i,aliases:["google","谷歌","gemini","deepmind"]},
  {id:"deepseek",role:"brand",request:/deepseek|深度求索/i,aliases:["deepseek","深度求索"]},
  {id:"doubao",role:"brand",request:/豆包|字节|seedream|seedance/i,aliases:["豆包","字节","seedream","seedance","volcengine"]},
  {id:"qwen",role:"brand",request:/通义|千问|qwen/i,aliases:["通义","千问","qwen"]},
  {id:"kimi",role:"brand",request:/kimi|月之暗面/i,aliases:["kimi","月之暗面","moonshot"]},
  {id:"wallet",role:"topic",request:/钱包|wallet|余额|充值|计费|预付费|credits?|billing|prepaid|payment/i,aliases:["钱包","wallet","wallets","余额","充值","计费","credits","credit","billing","prepaid","payment","payments"]},
  {id:"agent",role:"topic",request:/智能体|agent|mcp|工作流/i,aliases:["智能体","agent","agents","mcp","工作流","workflow"]},
  {id:"evaluation",role:"topic",request:/评测|评估|evaluation|benchmark|evals?/i,aliases:["评测","评估","evaluation","benchmark","eval","evals"]},
  {id:"memory",role:"topic",request:/记忆|memory|上下文/i,aliases:["记忆","memory","上下文","context"]},
  {id:"multimodal",role:"topic",request:/多模态|图像|视频|语音|multimodal|image|video|voice/i,aliases:["多模态","图像","视频","语音","multimodal","image","video","voice"]},
  {id:"product",role:"topic",request:/产品|用户|商业化|product|pricing/i,aliases:["产品","用户","商业化","product","pricing"]}
];

const NOTICE_REQUEST_GENERIC_WORDS = new Set([
  "about","after","again","feature","follow","following","later","latest","look","new","news","please","the","this","update","updates"
]);
const NOTICE_REQUEST_GENERIC_CJK = new Set([
  "帮我","后面","关注","一下","以后","最近","最新","新增","增加","功能","方面","相关","内容","资讯","动态","消息","更新","看看","查找","找到","一下子","这个","那个"
]);

function noticeItemKeyCloud(item){
  const raw=String(item?.link||item?.url||'').trim();
  try{
    const parsed=new URL(raw);
    [...parsed.searchParams.keys()].forEach(key=>{if(key.toLowerCase().startsWith('utm_')||['from','source','ref','spm'].includes(key.toLowerCase()))parsed.searchParams.delete(key);});
    parsed.hash='';parsed.pathname=parsed.pathname.replace(/\/$/,'');
    if(/^https?:$/.test(parsed.protocol))return `url:${parsed.toString().toLowerCase()}`;
  }catch(_error){}
  const title=String(item?.title||'').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,'');
  return title?`title:${title}`:'';
}

function noticeRequestGroups(text){
  const value=String(text||'');
  const groups=NOTICE_TOPIC_GROUPS.filter(group=>group.request.test(value)).map(group=>({...group}));
  const covered=new Set(groups.flatMap(group=>group.aliases.map(alias=>alias.toLowerCase())));
  const latin=[...value.toLowerCase().matchAll(/[a-z][a-z0-9._-]{2,}/g)].map(match=>match[0]);
  for(const token of latin){
    if(NOTICE_REQUEST_GENERIC_WORDS.has(token)||covered.has(token)||groups.some(group=>group.aliases.some(alias=>alias.includes(token)||token.includes(alias))))continue;
    groups.push({id:`term:${token}`,role:"topic",aliases:[token]});
  }
  if(typeof Intl?.Segmenter==='function'){
    const segments=new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(value);
    for(const segment of segments){
      const token=String(segment.segment||'').trim();
      if(!segment.isWordLike||!/^[\u4e00-\u9fff]{2,8}$/.test(token)||NOTICE_REQUEST_GENERIC_CJK.has(token)||covered.has(token)||groups.some(group=>group.aliases.includes(token)))continue;
      groups.push({id:`term:${token}`,role:"topic",aliases:[token]});
    }
  }
  return groups.slice(0,8);
}

function noticeRequestMatchScore(text,item){
  const groups=noticeRequestGroups(text);
  if(!groups.length)return 0;
  const haystack=[item?.title,item?.summary,item?.source_summary,item?.original_summary,item?.translation_zh,item?.ai_summary,item?.media,item?.source_url,item?.link,item?.url]
    .map(value=>String(value||'').toLowerCase()).join(' ');
  const matched=groups.filter(group=>group.aliases.some(alias=>haystack.includes(alias.toLowerCase())));
  const brands=groups.filter(group=>group.role==='brand');
  const topics=groups.filter(group=>group.role!=='brand');
  if(brands.length&&!brands.every(group=>matched.some(item=>item.id===group.id)))return 0;
  const matchedTopics=topics.filter(group=>matched.some(item=>item.id===group.id));
  if(topics.length&&matchedTopics.length<(brands.length?1:Math.min(2,topics.length)))return 0;
  if(!matched.length)return 0;
  let score=matched.reduce((sum,group)=>sum+(group.role==='brand'?30:18),0);
  const title=String(item?.title||'').toLowerCase();
  score+=matched.reduce((sum,group)=>sum+(group.aliases.some(alias=>title.includes(alias.toLowerCase()))?8:0),0);
  const published=Date.parse(item?.published_at||item?.published||item?.date||'');
  if(Number.isFinite(published))score+=Math.max(0,Math.min(8,8-Math.floor((Date.now()-published)/(7*24*60*60*1000))));
  return score;
}

function noticeFoundItem(item){
  return {
    id:String(item?.id||`notice_${crypto.randomUUID().slice(0,8)}`),
    title:String(item?.title||'').slice(0,300),
    summary:String(item?.summary||item?.source_summary||'').slice(0,1600),
    source_summary:String(item?.source_summary||item?.summary||'').slice(0,1600),
    translation_zh:String(item?.translation_zh||'').slice(0,1200),
    ai_summary:String(item?.ai_summary||item?.main_takeaway||'').slice(0,1600),
    ai_summary_version:Number(item?.ai_summary_version||0),
    product_tip:String(item?.product_tip||'').slice(0,700),
    media:String(item?.media||item?.publisher_name||'').slice(0,120),
    published_at:String(item?.published_at||item?.published||item?.date||'').slice(0,80),
    category:String(item?.category||item?.notice_tag||categoryForArticle(item?.title||'')).slice(0,80),
    link:String(item?.link||item?.url||'').slice(0,1200),
    source_url:String(item?.source_url||'').slice(0,1200)
  };
}

function matchNoticeRequestItems(text,pool,limit=3,excludedKeys=new Set()){
  const seen=new Set(excludedKeys),scored=[];
  for(const item of pool||[]){
    if(!item?.title||!exactArticleLink(item))continue;
    const key=noticeItemKeyCloud(item);
    if(!key||seen.has(key))continue;
    const score=noticeRequestMatchScore(text,item);
    if(score>0){seen.add(key);scored.push({score,item});}
  }
  return scored.sort((left,right)=>right.score-left.score).slice(0,limit).map(value=>noticeFoundItem(value.item));
}

function cloudNoticeRequestIdentity(request,index=0){
  if(request?.id||request?.task_id)return String(request.id||request.task_id);
  const value=[request?.date||'',request?.text||'',index].join('|');
  let hash=2166136261;
  for(const char of value){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return `notice_request_${(hash>>>0).toString(36)}`;
}

function cloudNoticeRequestSyncId(request){
  if(request?.id)return `id:${request.id}`;
  if(request?.key)return `key:${request.key}`;
  if(request?.url)return `url:${request.url}`;
  if(request?.link)return `link:${request.link}`;
  if(request?.source_url)return `source_url:${request.source_url}`;
  if(request?.date||request?.title)return `dated:${String(request.date||'')}|${String(request.title||'')}`;
  return '';
}

const NOTICE_FOLLOWUP_R2_KEY='system/notice-followups.json';

function cloudNoticeRequestContentKey(request){
  return `${String(request?.date||'')}|${String(request?.text||'').trim().toLowerCase().replace(/\s+/g,' ')}`;
}

function mergeCloudNoticeRequests(primary,fallback){
  const merged=(Array.isArray(primary)?primary:[]).map(item=>({...item}));
  for(const incoming of Array.isArray(fallback)?fallback:[]){
    const id=String(incoming?.id||incoming?.task_id||'');
    const contentKey=cloudNoticeRequestContentKey(incoming);
    const index=merged.findIndex(item=>(id&&String(item?.id||item?.task_id||'')===id)||(contentKey!=='|'&&cloudNoticeRequestContentKey(item)===contentKey));
    const current=index>=0?merged[index]:{};
    const items=[];const itemKeys=new Set();
    [...(incoming?.found_items||[]),...(current?.found_items||[])].forEach(item=>{const key=noticeItemKeyCloud(item);if(key&&!itemKeys.has(key)){itemKeys.add(key);items.push(item);}});
    const next={...current,...incoming,found_items:items.slice(0,6),found_item_keys:Array.from(new Set([...(current?.found_item_keys||[]),...(incoming?.found_item_keys||[]),...itemKeys])).slice(-80),found_count:Math.max(Number(current?.found_count||0),Number(incoming?.found_count||0),items.length)};
    delete next.found_items_seen_at;
    if(index>=0)merged[index]=next;else merged.unshift(next);
  }
  return merged.slice(0,40);
}

async function readNoticeFollowupFallback(env){
  if(!env.COZY_MEDIA)return [];
  try{
    const object=await env.COZY_MEDIA.get(NOTICE_FOLLOWUP_R2_KEY);
    if(!object)return [];
    const value=typeof object.json==='function'?await object.json():JSON.parse(await object.text());
    return Array.isArray(value?.requests)?value.requests:[];
  }catch(_error){return [];}
}

async function persistNoticeFollowupFallback(env,upserts){
  if(!env.COZY_MEDIA||!upserts.length)return false;
  const requests=mergeCloudNoticeRequests(await readNoticeFollowupFallback(env),upserts);
  await env.COZY_MEDIA.put(NOTICE_FOLLOWUP_R2_KEY,JSON.stringify({version:1,updated_at:now(),requests}),{
    httpMetadata:{contentType:'application/json; charset=utf-8'},customMetadata:{kind:'notice_followups'}
  });
  return true;
}

async function readLocalStateWithNoticeFallback(env){
  const state=await readData(env,'local_state');
  const fallback=await readNoticeFollowupFallback(env);
  if(!fallback.length)return state;
  const values=state.values&&typeof state.values==='object'?state.values:{};
  return {...state,values:{...values,cozy_notice_requests:mergeCloudNoticeRequests(values.cozy_notice_requests,fallback)}};
}

async function enrichNoticeFoundItems(env,items){
  if(!items.length)return items;
  try{
    const repaired=await repairReportLanguages(env,{hot_items:items,sections:[]});
    return repaired.report.hot_items||items;
  }catch(_error){return items;}
}

async function resolveCloudNoticeRequests(env,pool){
  const local=await readLocalStateWithNoticeFallback(env);
  const requests=Array.isArray(local?.values?.cozy_notice_requests)?local.values.cozy_notice_requests:[];
  const pending=[];
  requests.forEach((request,index)=>{
    const kind=String(request?.kind||'');
    if(!['watch_topic','media_source'].includes(kind))return;
    const text=String(request?.text||'').trim();
    if(!text||!noticeRequestGroups(text).length)return;
    const delivered=new Set([...(request.found_item_keys||[]),...(request.found_items||[]).map(noticeItemKeyCloud)].filter(Boolean));
    const found=matchNoticeRequestItems(text,pool,3,delivered);
    if(found.length)pending.push({request,index,found,delivered});
  });
  if(!pending.length)return {matched_requests:0,found_items:0,matches:[],persisted:true};
  const uniqueFound=[];const uniqueKeys=new Set();
  pending.flatMap(item=>item.found).forEach(item=>{const key=noticeItemKeyCloud(item);if(key&&!uniqueKeys.has(key)){uniqueKeys.add(key);uniqueFound.push(item);}});
  const enriched=await enrichNoticeFoundItems(env,uniqueFound.slice(0,9));
  const enrichedByKey=new Map(enriched.map(item=>[noticeItemKeyCloud(item),item]));
  const upserts=[];const deleted=[];const matches=[];
  for(const value of pending){
    const original=value.request;
    const id=cloudNoticeRequestIdentity(original,value.index);
    const existingPending=Array.isArray(original.found_items)?original.found_items:[];
    const matchedFound=value.found.map(item=>enrichedByKey.get(noticeItemKeyCloud(item))||item);
    const nextFound=[...existingPending,...matchedFound].slice(0,6);
    const foundKeys=Array.from(new Set([...(original.found_item_keys||[]),...nextFound.map(noticeItemKeyCloud)].filter(Boolean))).slice(-80);
    const updatedAt=now();
    const next={...original,id,found_items:nextFound,found_item_keys:foundKeys,found_count:Number(original.found_count||0)+value.found.length,found_at:updatedAt,updatedAt};
    delete next.found_items_seen_at;
    upserts.push(next);
    matches.push({request_id:id,request_text:String(original.text||'未命名留言').slice(0,500),items:matchedFound});
    const oldId=cloudNoticeRequestSyncId(original),newId=`id:${id}`;
    if(oldId&&oldId!==newId)deleted.push(oldId);
  }
  const result={matched_requests:upserts.length,found_items:pending.reduce((sum,item)=>sum+item.found.length,0),matches};
  try{
    await mergeLocalState(env,{changes:{cozy_notice_requests:{type:"array",upserts,deleted,revive:upserts.map(item=>`id:${item.id}`)}}});
    return {...result,persisted:true};
  }catch(error){
    if(!noticeKvWriteLimitExceeded(error))throw error;
    let fallbackPersisted=false;
    try{fallbackPersisted=await persistNoticeFollowupFallback(env,upserts);}catch(_fallbackError){}
    return {...result,persisted:fallbackPersisted,persisted_to:fallbackPersisted?'r2':'response',kv_persisted:false,storage_error:"KV_DAILY_WRITE_LIMIT"};
  }
}

function buildCloudNewsSourceJobs(butlerState={}){
  const customFeeds=(butlerState.sources||[])
    .filter(item=>item&&item.enabled!==false&&item.feed)
    .map((item,index)=>({id:`custom-${index}`,name:String(item.name||item.title||'自定义信源'),url:String(item.feed),aliases:[item.name,item.title].filter(Boolean)}))
    .slice(0,12);
  return [
    ...DIRECT_NEWS_FEEDS.map(source=>({...source,load:()=>fetchNewsFeed(source)})),
    ...customFeeds.map(source=>({...source,load:()=>fetchNewsFeed(source)})),
    ...PROXIED_NEWS_FEEDS.map(source=>({...source,load:()=>fetchNewsFeedJson(source)})),
    {id:"36kr",name:"36氪",url:"https://36kr.com/",aliases:["36kr","36氪"],load:()=>fetch36KrNewsflashes()}
  ];
}

function noticeRequestMentionsSource(text,source){
  const value=String(text||'').toLowerCase();
  const sourceWords=[source?.id,source?.name,source?.url,...(source?.aliases||[])].filter(Boolean).map(item=>String(item).toLowerCase());
  let host='';
  try{host=new URL(String(source?.url||'')).hostname.replace(/^www\./,'').split('.')[0];}catch(_error){}
  if(host)sourceWords.push(host);
  return sourceWords.some(word=>word.length>=3&&value.includes(word));
}

async function findNoticeItemsForRequest(env,text){
  const [reports,butlerState,sourceCache]=await Promise.all([
    readData(env,"notice_reports"),readData(env,"butler_state"),readState(env,"notice:source-cache",{groups:[]})
  ]);
  const basePool=[
    ...(reports.reports||[]).slice(0,8).flatMap(report=>reportItems(report)),
    ...(sourceCache.groups||[]).filter(Array.isArray).flat()
  ];
  const jobs=buildCloudNewsSourceJobs(butlerState);
  const targeted=jobs.filter(source=>noticeRequestMentionsSource(text,source));
  const cachedMatches=matchNoticeRequestItems(text,basePool,3);
  const selected=targeted.length?targeted:(cachedMatches.length<3?jobs.slice(0,18):[]);
  let livePool=[];
  if(selected.length){
    const settled=await Promise.allSettled(selected.map(source=>source.load()));
    livePool=settled.filter(result=>result.status==='fulfilled').flatMap(result=>result.value);
  }
  const matches=matchNoticeRequestItems(text,[...livePool,...basePool],3);
  return enrichNoticeFoundItems(env,matches);
}

function interleaveNewsGroups(groups,limit=80){
  const output=[];
  const maxLength=Math.max(0,...groups.map(group=>group.length));
  for(let index=0;index<maxLength&&output.length<limit;index+=1){
    for(const group of groups){
      if(group[index])output.push(group[index]);
      if(output.length>=limit)break;
    }
  }
  return output;
}

function newsRegion(item){
  const value=`${item?.media||''} ${item?.source_url||''} ${item?.link||item?.url||''} ${item?.title||''}`.toLowerCase();
  if(/36氪|量子位|机器之心|infoq 中文|it之家|极客公园|modelscope|deepseek|kimi|月之暗面|通义|千问|qwen|豆包|字节|seedream|seedance|火山引擎|阿里云|百度|腾讯|华为|智谱|百川|零一万物|阶跃星辰|minimax|qbitai\.com|36kr\.com|jiqizhixin\.com|infoq\.cn|ithome\.com|geekpark\.net|modelscope\.cn|aliyun\.com|volcengine\.com|moonshot\.cn/.test(value))return "domestic";
  if(/openai|anthropic|claude|google|deepmind|gemini|cloudflare|the verge|techcrunch|mit technology|github|aws|arxiv|microsoft|meta ai|hugging face|openai\.com|anthropic\.com|google\.com|deepmind\.google|cloudflare\.com|theverge\.com|techcrunch\.com|technologyreview\.com|github\.blog|aws\.amazon\.com|arxiv\.org/.test(value))return "international";
  return "other";
}

function newsSourceKey(item){
  try{
    const parsed=new URL(String(item?.link||item?.url||''));
    if(/^https?:$/.test(parsed.protocol))return parsed.hostname.replace(/^www\./,'').toLowerCase();
  }catch(_error){}
  return String(item?.media||item?.source_url||'未知来源').trim().toLowerCase();
}

function balancedNewsSelection(pool,limit=9){
  const buckets={domestic:[],international:[],other:[]};
  pool.forEach(item=>buckets[newsRegion(item)].push(item));
  const output=[],sourceCounts=new Map();
  const take=item=>{
    const source=newsSourceKey(item);
    if((sourceCounts.get(source)||0)>=2)return false;
    output.push(item);sourceCounts.set(source,(sourceCounts.get(source)||0)+1);return true;
  };
  const takeQuota=(bucket,quota)=>{
    let added=0;
    for(const item of bucket){if(output.length>=limit||added>=quota)break;if(take(item))added+=1;}
  };
  takeQuota(buckets.domestic,Math.min(2,buckets.domestic.length));
  takeQuota(buckets.international,Math.min(2,buckets.international.length));
  let index=0;
  while(output.length<limit&&(index<buckets.domestic.length||index<buckets.international.length)){
    for(const bucket of [buckets.domestic,buckets.international]){
      const item=bucket[index];
      if(item&&!output.includes(item))take(item);
      if(output.length>=limit)break;
    }
    index+=1;
  }
  [...buckets.other,...buckets.domestic,...buckets.international].forEach(item=>{if(output.length<limit&&!output.includes(item))take(item);});
  return output;
}

function reportItems(report){
  return [...(report?.hot_items||[]),...(report?.sections||[]).flatMap(section=>section.items||[])];
}

function lowSignalNewsItem(item){
  const title=String(item?.title||'').replace(/\s+-\s+[^–—-]{2,50}$/,'').trim();
  if(title.length<8)return true;
  if(/^(错误码|帮助文档|首页|登录|注册|搜索结果|产品文档)|提示词指南$|服务条款|隐私政策/.test(title))return true;
  const normalize=value=>String(value||'').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,'');
  const summary=normalize(item?.summary),normalizedTitle=normalize(title);
  return !summary||summary===normalizedTitle||(summary.length<=normalizedTitle.length+6&&(summary.includes(normalizedTitle)||normalizedTitle.includes(summary)));
}

function aiRelevantNewsItem(item){
  if(newsRegion(item)!=='domestic')return true;
  const text=`${item?.title||''} ${item?.summary||''}`;
  return /\bAI\b|人工智能|大模型|模型|智能体|Agent|LLM|多模态|生成式|机器学习|深度学习|Qwen|通义|千问|DeepSeek|Kimi|豆包|Gemini|GPT|Claude|Copilot|MCP|RAG|推理|算力|芯片|机器人|自动驾驶/i.test(text);
}

function exactArticleLink(item){
  if(item?.link_kind==="source_homepage"||item?.link_kind==="unavailable")return false;
  try{
    const parsed=new URL(String(item?.link||item?.url||''));
    if(!/^https?:$/.test(parsed.protocol)||/(^|\.)news\.google\.com$/i.test(parsed.hostname))return false;
    const path=parsed.pathname.replace(/\/+$/,'')||'/';
    if(new Set(['/','/news','/technology/ai','/category/artificial-intelligence','/topic/artificial-intelligence','/ai-and-ml']).has(path))return false;
    if(/\.(?:rss|xml|atom)$/i.test(path))return false;
    const sourceRaw=String(item?.source_url||item?.publisher_url||'');
    if(sourceRaw){
      const source=new URL(sourceRaw);
      const sourcePath=source.pathname.replace(/\/+$/,'')||'/';
      if(parsed.origin===source.origin&&path===sourcePath&&!/\.(?:rss|xml|atom)$/i.test(path))return false;
    }
    return true;
  }catch(_error){return false;}
}

function misleadingNoticeSummary(source,summary){
  const title=String(source?.title||'');
  const text=String(summary||'');
  if(!/(回应|澄清|辟谣|否认)/.test(title))return false;
  return /(这意味着|因此|由此可见).{0,30}(将|会|开始|已经).{0,20}(收费|收取费用|涨价|停服|停止|取消|关闭)/.test(text);
}

function noticeTextSimilarity(left,right){
  const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,'');
  const a=normalize(left),b=normalize(right);
  if(!a||!b)return 0;
  if(a===b)return 1;
  const grams=value=>new Set([...Array(Math.max(0,value.length-1))].map((_item,index)=>value.slice(index,index+2)));
  const aGrams=grams(a),bGrams=grams(b);
  if(!aGrams.size||!bGrams.size)return 0;
  let shared=0;
  aGrams.forEach(value=>{if(bGrams.has(value))shared+=1;});
  return shared/new Set([...aGrams,...bGrams]).size;
}

function reportItemLanguageState(item){
  const original=String(item?.source_summary||item?.original_summary||item?.summary||'');
  const originalChinese=noticeTextIsChinese(original,8);
  const translation=String(item?.translation_zh||'').replace(/\s+/g,'').trim();
  const translationValid=noticeTextIsChinese(translation,4);
  const needsTranslation=!originalChinese&&!translationValid;
  const ai=String(item?.ai_summary||'');
  const normalizedAi=ai.replace(/\s+/g,'').trim();
  const summaryValid=Boolean(ensureChineseAiSummary(ai,item,item?.category||''));
  const needsSummary=Number(item?.ai_summary_version||0)<2||!summaryValid||(translationValid&&noticeTextSimilarity(translation,normalizedAi)>=0.55);
  return {original,originalChinese,translationValid,summaryValid,needsTranslation,needsSummary};
}

function reportItemNeedsLanguageRepair(item){
  const state=reportItemLanguageState(item);
  return state.needsTranslation||state.needsSummary;
}

function ensureChineseProductTip(value,source={}){
  const text=String(value||'').replace(/\s+/g,' ').trim();
  const chinese=(text.match(/[\u4e00-\u9fff]/g)||[]).length;
  if(chinese<18)return '';
  const compared=[source?.ai_summary,source?.translation_zh,source?.summary].filter(Boolean);
  if(compared.some(item=>noticeTextSimilarity(item,text)>=.72))return '';
  return text.slice(0,700);
}

async function repairReportLanguages(env,report){
  const items=reportItems(report).filter(reportItemNeedsLanguageRepair).slice(0,9);
  if(!items.length)return {report,repaired:false};
  const input=items.map((item,index)=>({id:String(index),title:item.title||'',summary:item.source_summary||item.original_summary||item.summary||'',media:item.media||''}));
  const fieldText=(text,field)=>{
    try{
      const parsed=extractJson(text);
      return String(parsed?.[field]||parsed?.items?.[0]?.[field]||'').trim();
    }catch(_error){
      return String(text||'').replace(/^```(?:json)?\s*|\s*```$/gi,'').replace(new RegExp(`^(?:${field}|中文翻译|AI总结|AI 总结)\\s*[：:]\\s*`),'').trim();
    }
  };
  // One item per request is more reliable for the small Workers AI model than
  // asking it to preserve several ids in one JSON array.
  const configuredTimeout=Number(env.COZY_NEWS_AI_TIMEOUT_MS);
  const repairTimeout=Math.max(5000,configuredTimeout||14000);
  const generate=(prompt,tokens,validate)=>{
    if(configuredTimeout>0&&configuredTimeout<500)return Promise.reject(new Error("测试要求立即使用来源兜底"));
    return callText(env,prompt,tokens,{validate,thinking:false,providerTimeouts:{deepseek:repairTimeout,openai:repairTimeout,glm:repairTimeout,qwen:repairTimeout,"workers-ai":Math.min(repairTimeout,12000)}});
  };
  const jobs=input.flatMap((value,index)=>{
    const state=reportItemLanguageState(items[index]);
    const context=JSON.stringify({title:value.title,source_summary:value.summary,media:value.media,translation_zh:items[index].translation_zh||''}).slice(0,5000);
    const result=[];
    if(state.needsTranslation)result.push(generate(`你是忠实翻译员。把下面英文摘要忠实翻译为简体中文，保留产品名、模型名和数字，不增加分析或建议。只返回翻译正文，不要 JSON、标题或解释。资料：${context}`,500,text=>noticeTextIsChinese(fieldText(text,'translation_zh'),4)).then(response=>({index,field:'translation_zh',value:fieldText(response.text,'translation_zh'),provider:response.provider})));
    if(state.needsSummary)result.push(generate(`你是中文资讯编辑。根据下面资料写一段 80 到 180 字的 AI 总结，必须与“中文翻译”职责不同：先说明核心变化，再说明适用对象或场景，最后给出值得关注的结论或边界。可以做谨慎推断，但必须使用“这意味着”“值得关注的是”或“仍需验证”等措辞标明，不得逐句翻译或换词复述，不得编造具体数据。只返回总结正文，不要 JSON、标题或解释。资料：${context}`,700,text=>Boolean(ensureChineseAiSummary(fieldText(text,'ai_summary'),items[index],items[index]?.category||''))).then(response=>({index,field:'ai_summary',value:fieldText(response.text,'ai_summary'),provider:response.provider})));
    return result;
  });
  const settled=await Promise.allSettled(jobs);
  const generated=settled.filter(item=>item.status==='fulfilled').map(item=>item.value);
  const translations=new Map(generated.filter(item=>item.field==='translation_zh').map(item=>[String(item.index),item.value]));
  const summaries=new Map(generated.filter(item=>item.field==='ai_summary').map(item=>[String(item.index),item.value]));
  const replacements=new Map();
  items.forEach((item,index)=>{
    const id=String(index);
    const state=reportItemLanguageState(item);
    let translation=state.originalChinese?'':String(translations.get(id)||(state.translationValid?item.translation_zh:'')||'').slice(0,1200);
    let aiSummary=String(summaries.get(id)||(state.summaryValid?item.ai_summary:'')||'').slice(0,1600);
    const validTranslation=state.originalChinese||noticeTextIsChinese(translation,4);
    const validSummary=(aiSummary.match(/[\u4e00-\u9fff]/g)||[]).length>=30
      &&!/自动中文整理暂时没有可靠完成|阿栗先保留来源|避免把英文原文误当成中文总结|可以打开原文核对详情/.test(aiSummary)
      &&(!translation||noticeTextSimilarity(translation,aiSummary)<0.55);
    if(!validTranslation)translation='';
    if(!validSummary)aiSummary=state.summaryValid?String(item.ai_summary||'').slice(0,1600):'';
    replacements.set(item,{...item,translation_zh:translation,ai_summary:aiSummary,ai_summary_version:aiSummary?2:0});
  });
  const replace=item=>replacements.get(item)||item;
  return {report:{...report,hot_items:(report.hot_items||[]).map(replace),sections:(report.sections||[]).map(section=>({...section,items:(section.items||[]).map(replace)})),language_repaired_at:now(),provider:generated.find(item=>item.provider)?.provider||report.provider},repaired:generated.length>0};
}

function productTipCandidate(item){
  if(ensureChineseProductTip(item?.product_tip,item))return false;
  const text=`${item?.category||''} ${item?.title||''} ${item?.summary||''} ${item?.ai_summary||''}`;
  return /产品与实践|产品|用户|需求|工作流|Agent|智能体|SDK|部署|广告|商业化|定价|成本|评测|交互|医疗|健康|Copilot|Office|平台|生态/i.test(text);
}

async function enrichReportProductTips(env,report){
  const configuredTimeout=Number(env.COZY_NEWS_AI_TIMEOUT_MS);
  if(configuredTimeout>0&&configuredTimeout<500)return report;
  const candidates=reportItems(report).filter(productTipCandidate).slice(0,3);
  if(!candidates.length)return report;
  const input=candidates.map((item,index)=>({id:String(index),title:item.title,category:item.category,source_summary:item.source_summary||item.summary,ai_summary:item.ai_summary}));
  const prompt=`你是资深 AI 产品经理。只根据给定资讯，为确实能形成产品实践启发的条目写“产品经理关注点”。只返回 JSON：{"items":[{"id":"原id","product_tip":"60到120字简体中文；没有明确启发则空字符串"}]}。
关注点必须落到需求、目标用户、任务闭环、指标、评测、成本、交互、风险或落地步骤中的至少一项，并说明产品经理具体要观察或验证什么；不能复述新闻，不能写“关注行业趋势、持续学习”等套话，不能编造资料没有的数据。资讯：${JSON.stringify(input).slice(0,12000)}`;
  const parse=text=>{try{const value=extractJson(text);return Array.isArray(value?.items)?value.items:[];}catch(_error){return [];}};
  const validate=text=>parse(text).some(row=>{
    const item=candidates[Number(row?.id)];
    return item&&Boolean(ensureChineseProductTip(row?.product_tip,item));
  });
  const timeout=Math.max(5000,configuredTimeout||12000);
  const generated=await callText(env,prompt,1600,{temperature:.2,thinking:false,validate,providerTimeouts:{deepseek:timeout,openai:timeout,glm:timeout,qwen:timeout,"workers-ai":Math.min(timeout,10000)}});
  const tips=new Map(parse(generated.text).map(row=>[String(row?.id||''),String(row?.product_tip||'')]));
  const replacements=new Map();
  candidates.forEach((item,index)=>{
    const tip=ensureChineseProductTip(tips.get(String(index)),item);
    if(tip)replacements.set(item,{...item,product_tip:tip});
  });
  if(!replacements.size)return report;
  const replace=item=>replacements.get(item)||item;
  return {...report,hot_items:(report.hot_items||[]).map(replace),sections:(report.sections||[]).map(section=>({...section,items:(section.items||[]).map(replace)})),product_tips_generated_at:now()};
}

function noticeKvWriteLimitExceeded(error){
  return /KV put\(\) limit exceeded|daily write limit|write quota/i.test(String(error?.message||error||''));
}

async function writeNoticeStatus(env,value){
  try{await writeState(env,"automation:status",value);return true;}
  catch(_error){return false;}
}

async function updateNoticeProgress(env,message,extra={}){
  return writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"running",message,...extra}}});
}

async function runCloudReport(env, force = false) {
  const reportsData = await readData(env, "notice_reports");
  const butlerState = await readData(env, "butler_state");
  const watchTopics = (butlerState.watch_topics || []).map(item => String(item.text || item.title || "").trim()).filter(Boolean).slice(0, 8);
  const latest = (reportsData.reports || [])[0];
  if (!force && latest?.generated_at && Date.now() - Date.parse(latest.generated_at) < 46 * 60 * 60 * 1000) {
    let noticeFollowups={matched_requests:0,found_items:0};
    try{noticeFollowups=await resolveCloudNoticeRequests(env,reportItems(latest));}catch(_error){}
    return {...latest, unchanged: true, report_count: (reportsData.reports || []).length, notice_followups:noticeFollowups};
  }
  const sourceJobs=buildCloudNewsSourceJobs(butlerState);
  const settled = await Promise.allSettled(sourceJobs.map(source=>source.load()));
  const sourceResults=settled.map((result,index)=>({...sourceJobs[index],result}));
  const fulfilled = sourceResults.filter(item => item.result.status === "fulfilled");
  const failedSources=sourceResults.filter(item=>item.result.status==='rejected').map(item=>({id:item.id,name:item.name,error:String(item.result.reason?.message||item.result.reason||'连接失败').slice(0,120)}));
  const liveGroups=fulfilled.map(item=>item.result.value).filter(group=>group.length);
  await updateNoticeProgress(env,`已连接 ${fulfilled.length} 个信源，${failedSources.length} 个失败已跳过`,{source_status:{succeeded:fulfilled.length,failed:failedSources.length}});
  const sourceCache=await readState(env,"notice:source-cache",{groups:[]});
  const exactLinkItem=exactArticleLink;
  const cachedGroups=(sourceCache.groups||[]).filter(Array.isArray).map(group=>group.filter(exactLinkItem)).filter(group=>group.length);
  if(liveGroups.length){
    try{await writeState(env,"notice:source-cache",{updated_at:now(),groups:liveGroups.slice(0,24).map(group=>group.slice(0,12))},{expirationTtl:7*24*60*60});}
    catch(_error){}
  }
  const latestGroup=latest?reportItems(latest).filter(exactLinkItem):[];
  const usingSourceFallback=!liveGroups.length;
  const sourceGroups=liveGroups.length?[...liveGroups,...cachedGroups]:cachedGroups.length?cachedGroups:latestGroup.length?[latestGroup]:[];
  if (!sourceGroups.length) {
    if(force&&latest&&reportItems(latest).some(reportItemNeedsLanguageRepair)){
      const repaired=await repairReportLanguages(env,latest);
      if(repaired.repaired){
        const next={...reportsData,updated_at:now(),reports:[repaired.report,...(reportsData.reports||[]).slice(1)]};
        await writeData(env,"notice_reports",next);
        const message=`已补全本期中文翻译与 AI 总结；保留 ${next.reports.length} 版巡报`;
        await writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"completed",last_success:now(),repaired:true,message}}});
        return {...repaired.report,unchanged:true,repaired:true,report_count:next.reports.length};
      }
    }
    const reasons = failedSources.map(item=>`${item.name}：${item.error}`);
    throw new Error(`资讯源全部连接失败：${[...new Set(reasons)].join("；").slice(0, 260)}`);
  }
  const followupPool=interleaveNewsGroups(sourceGroups,240);
  const articleKeys = item => {
    const keys = new Set();
    const title = String(item?.title || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
    if (title.length >= 8) keys.add(`title:${title}`);
    try {
      const parsed = new URL(String(item?.link || item?.url || ""));
      [...parsed.searchParams.keys()].forEach(key => { if (key.toLowerCase().startsWith("utm_") || ["from", "source", "ref", "spm"].includes(key.toLowerCase())) parsed.searchParams.delete(key); });
      parsed.hash = ""; parsed.pathname = parsed.pathname.replace(/\/$/, "");
      if(item?.link_kind!=="source_homepage")keys.add(`url:${parsed.toString()}`);
    } catch (_error) {}
    return keys;
  };
  const previousKeys = new Set();
  (reportsData.reports || []).forEach(report => [...(report.hot_items || []), ...(report.sections || []).flatMap(section => section.items || [])].forEach(item => articleKeys(item).forEach(key => previousKeys.add(key))));
  const currentKeys=new Set();
  const pool=interleaveNewsGroups(sourceGroups,80).filter(item=>{
    if(!exactLinkItem(item)||lowSignalNewsItem(item)||!aiRelevantNewsItem(item))return false;
    const keys=[...articleKeys(item)];
    if(keys.some(key=>previousKeys.has(key)||currentKeys.has(key)))return false;
    keys.forEach(key=>currentKeys.add(key));
    return true;
  }).slice(0,60);
  const poolCoverage={domestic:pool.filter(item=>newsRegion(item)==='domestic').length,international:pool.filter(item=>newsRegion(item)==='international').length,other:pool.filter(item=>newsRegion(item)==='other').length};
  await updateNoticeProgress(env,`已筛出 ${pool.length} 条候选，正在整理国内外重点`,{source_status:{succeeded:fulfilled.length,failed:failedSources.length},candidate_coverage:poolCoverage});
  if (!pool.length) {
    let noticeFollowups={matched_requests:0,found_items:0};
    try{noticeFollowups=await resolveCloudNoticeRequests(env,followupPool);}catch(_error){}
    if(force&&latest&&reportItems(latest).some(reportItemNeedsLanguageRepair)){
      const repaired=await repairReportLanguages(env,latest);
      if(repaired.repaired){
        const next={...reportsData,updated_at:now(),reports:[repaired.report,...(reportsData.reports||[]).slice(1)]};
        await writeData(env,"notice_reports",next);
        const message=`已补全本期中文翻译与 AI 总结；保留 ${next.reports.length} 版巡报`;
        await writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"completed",last_success:now(),repaired:true,message}}});
        return {...repaired.report,unchanged:true,repaired:true,report_count:next.reports.length,notice_followups:noticeFollowups};
      }
    }
    const reportCount=(reportsData.reports || []).length;
    const message=usingSourceFallback?`资讯源暂时不可用，已保留 ${reportCount} 版巡报，稍后自动重试`:`已检查，暂无新资讯；保留 ${reportCount} 版巡报`;
    await writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"completed",last_success:now(),unchanged:true,degraded:usingSourceFallback,message}}});
    return {...(latest || {focus_title: "暂无新资讯"}), unchanged: true, degraded:usingSourceFallback, report_count: reportCount,notice_followups:noticeFollowups};
  }
  const prompt = `你是阿栗，负责为 AI 产品经理整理一次“资讯巡报”。从候选中只挑真正重要、具体、多样的 7 到 11 条，不要为了凑数收录普通软文。
只返回 JSON：{"focus_title":"本期最重要变化","hot_items":[{"source_id":"候选id","category":"模型与技术","translation_zh":"原摘要非中文时给忠实中文翻译，原摘要是中文时留空","ai_summary":"120到200字中文总结，说明具体变化、关键数字或能力、值得关注的结论","product_tip":"仅在该资讯能形成明确产品实践启发时，写60到120字中文产品经理关注点，否则留空"}],"sections":[{"name":"国内外动态","items":[同结构]},{"name":"产品相关动态","items":[同结构]},{"name":"主人关注","items":[同结构]}],"insights":["跨文章案例总结"],"advice":["给正在做AI产品的主人一个有深度且可执行的建议"]}。
热点速览只放行业级重要发布；候选足够时，整版必须至少选择 2 条国内资讯和 2 条海外资讯，覆盖至少 4 个不同来源，单一来源最多 2 条。国内优先 DeepSeek、Kimi、通义、豆包等产品和 36氪、量子位、机器之心、InfoQ 中文的有效报道；海外兼顾 OpenAI、Anthropic、Google 的重要发布、热门国际科技消息，以及真正有产品实践价值的海外产品案例、GitHub 开源实践、AWS 工程案例和 arXiv 研究。产品相关动态只放评测、记忆、Agent、原型、工作流等真正能提升产品能力的案例。product_tip 不是新闻复述：必须指出产品经理在需求、用户、指标、评测、成本、交互、风险或落地实践中应注意什么；没有明确启发就留空，禁止每条硬加。所有 ai_summary 和 product_tip 必须使用简体中文。分类只用模型与技术、产品与实践、行业动态、学术研究。不得编造候选中没有的价格、指标和事实。标题含“回应、澄清、辟谣、否认”时必须保留原文立场，绝不能把被回应的传言写成已确认事实；信息不足就明确写“原文未确认”，不要推断收费、涨价、停服等结论。
主人关注方向：${JSON.stringify(watchTopics)}。只有候选中确实有直接相关内容时才增加“主人关注”栏目；没有匹配内容就不要生成该栏目，不能拿普通 AI 新闻凑数。
候选：${JSON.stringify(pool).slice(0, 30000)}`;
  let result = {provider: "source-fallback"};
  let curated;
  try {
    const configuredTimeout=Number(env.COZY_NEWS_AI_TIMEOUT_MS);
    if(configuredTimeout>0&&configuredTimeout<500)throw new Error("测试要求立即使用来源兜底");
    const curationTimeout = Math.max(5000, configuredTimeout || 16000);
    result = await callText(env,prompt,3600,{temperature:.25,thinking:false,providerTimeouts:{deepseek:curationTimeout,openai:curationTimeout,glm:curationTimeout,qwen:curationTimeout,"workers-ai":Math.min(curationTimeout,12000)}});
    curated = extractJson(result.text);
    const selectedRaw=[...(curated.hot_items||[]),...(curated.sections||[]).flatMap(section=>section.items||[])];
    if(selectedRaw.length<Math.min(7,pool.length))throw new Error("模型选择的有效资讯数量不足");
    const selectedIds=selectedRaw.map(item=>String(item?.source_id||'')).filter(Boolean);
    if(new Set(selectedIds).size!==selectedIds.length)throw new Error("模型重复选择了同一条资讯");
    const poolById=new Map(pool.map(item=>[String(item.id),item]));
    if(selectedRaw.some(item=>!poolById.has(String(item?.source_id||''))))throw new Error("模型选择了候选之外的资讯");
    const sourceKey=newsSourceKey;
    const availableSources=new Set(pool.map(sourceKey));
    const selectedCounts=new Map();
    const selectedRegions=new Map();
    selectedRaw.forEach(item=>{
      const selectedSource=poolById.get(String(item?.source_id||''));
      if(misleadingNoticeSummary(selectedSource,item?.ai_summary))throw new Error("模型把回应或澄清错误写成了事实");
      const key=sourceKey(selectedSource);
      selectedCounts.set(key,(selectedCounts.get(key)||0)+1);
      const region=newsRegion(selectedSource);
      selectedRegions.set(region,(selectedRegions.get(region)||0)+1);
    });
    if(availableSources.size>=4&&(selectedCounts.size<4||Math.max(0,...selectedCounts.values())>2))throw new Error("模型选择的资讯来源不够多样");
    const requiredDomestic=Math.min(2,pool.filter(item=>newsRegion(item)==='domestic').length);
    const requiredInternational=Math.min(2,pool.filter(item=>newsRegion(item)==='international').length);
    if((selectedRegions.get("domestic")||0)<requiredDomestic||(selectedRegions.get("international")||0)<requiredInternational)throw new Error("模型选择的资讯没有达到国内外最低覆盖");
  } catch (_error) {
    const selected = balancedNewsSelection(pool,9);
    const shape = item => ({
      source_id: item.id,
      category: categoryForArticle(item.title),
      original_summary: item.summary || '',
      translation_zh: '',
      ai_summary: '',
      product_tip: ''
    });
    curated = {
      focus_title: selected[0]?.title || "近期 AI 进展",
      hot_items: selected.slice(0, 4).map(shape),
      sections: selected.length > 4 ? [{name: "近期动态", items: selected.slice(4).map(shape)}] : [],
      insights: ["本期先按来源原始信息归档，后续可继续补充深度判断。"],
      advice: ["先核对与你当前产品最相关的变化，再决定是否调整评测、模型或工作流。"]
    };
  }
  const byId = new Map(pool.map(item => [item.id, item]));
  const hydrate = raw => {
    const source = byId.get(String(raw?.source_id || ""));
    if (!source) return null;
    const category = String(raw.category || categoryForArticle(source.title));
    const sourceSummary = String(source.summary || '').slice(0, 1200);
    const normalize=value=>String(value||'').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,'');
    if(!sourceSummary||normalize(sourceSummary)===normalize(source.title)||!exactArticleLink(source))return null;
    const translation=noticeTextIsChinese(sourceSummary,8)?'':noticeTextIsChinese(raw.translation_zh,4)?String(raw.translation_zh).slice(0,1200):'';
    const aiSummary=result.provider==="source-fallback"?'':ensureChineseAiSummary(raw.ai_summary,source,category);
    const productTip=result.provider==="source-fallback"?'':ensureChineseProductTip(raw.product_tip,{...source,translation_zh:translation,ai_summary:aiSummary});
    return {...source, category,
      source_summary: sourceSummary,
      original_summary: sourceSummary,
      summary: sourceSummary,
      translation_zh: translation,
      ai_summary: aiSummary,
      product_tip: productTip,
      ai_summary_version: aiSummary&&result.provider!=="source-fallback"&&(!translation||noticeTextSimilarity(translation,aiSummary)<0.55)?2:0};
  };
  const hotItems = (curated.hot_items || []).map(hydrate).filter(Boolean).slice(0, 4);
  const sections = (curated.sections || []).slice(0, 3).map(section => ({name: String(section.name || "动态"), items: (section.items || []).map(hydrate).filter(Boolean).slice(0, 5)})).filter(section => section.items.length);
  if (!hotItems.length && !sections.length) throw new Error("模型没有选出可用资讯");
  const selectedItems=[...hotItems,...sections.flatMap(section=>section.items||[])];
  const coverage={domestic:selectedItems.filter(item=>newsRegion(item)==='domestic').length,international:selectedItems.filter(item=>newsRegion(item)==='international').length,other:selectedItems.filter(item=>newsRegion(item)==='other').length};
  let report = {id: `report_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, generated_at: now(), week_start: dateInShanghai(-6), week_end: dateInShanghai(), degraded:usingSourceFallback,
    source_status:{succeeded:fulfilled.length,failed:failedSources.length,failed_sources:failedSources,used_cache:usingSourceFallback},coverage,
    focus_title: String(curated.focus_title || hotItems[0]?.title || "近期 AI 进展").slice(0, 120), hot_items: hotItems, sections,
    insights: (curated.insights || []).slice(0, 5).map(String), advice: (curated.advice || []).slice(0, 5).map(String), provider: result.provider};
  if(reportItems(report).some(reportItemNeedsLanguageRepair)){
    try{
      const repaired=await repairReportLanguages(env,report);
      if(repaired.repaired)report=repaired.report;
    }catch(_error){
      const clean=item=>{const state=reportItemLanguageState(item);const aiSummary=ensureChineseAiSummary(item.ai_summary,item,item.category);return {...item,translation_zh:state.originalChinese?'':state.translationValid?String(item.translation_zh||''):'',ai_summary:aiSummary,product_tip:ensureChineseProductTip(item.product_tip,{...item,ai_summary:aiSummary}),ai_summary_version:0};};
      report={...report,hot_items:(report.hot_items||[]).map(clean),sections:(report.sections||[]).map(section=>({...section,items:(section.items||[]).map(clean)}))};
    }
  }
  try{report=await enrichReportProductTips(env,report);}catch(_error){}
  let noticeFollowups={matched_requests:0,found_items:0};
  try{noticeFollowups=await resolveCloudNoticeRequests(env,[...reportItems(report),...followupPool]);}catch(_error){}
  report={...report,notice_followups:noticeFollowups};
  const next = {version: 1, updated_at: now(), reports: [report, ...(reportsData.reports || []).filter(item => item.id !== report.id)].slice(0, 30)};
  try{
    await writeData(env,"notice_reports",next);
  }catch(error){
    if(!noticeKvWriteLimitExceeded(error)||!latest)throw error;
    return {...latest,unchanged:true,storage_degraded:true,storage_error:"KV_DAILY_WRITE_LIMIT",report_count:(reportsData.reports||[]).length,
      coverage:report.coverage,source_status:report.source_status,notice_followups:noticeFollowups};
  }
  const completionMessage=usingSourceFallback
    ? `实时信源暂时不可用，已用缓存资料生成巡报；国内 ${coverage.domestic} 条、海外 ${coverage.international} 条`
    : `新的资讯巡报已生成：国内 ${coverage.domestic} 条、海外 ${coverage.international} 条；${failedSources.length} 个失败信源已跳过`;
  await writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"completed",last_success:now(),degraded:usingSourceFallback,message:completionMessage}}});
  return report;
}

const taskKey = id => `generation:${id}`;
async function saveGenerationTask(env, task) {
  task.updated_at = now();
  await writeState(env, taskKey(task.id), task, {expirationTtl: 60 * 60 * 24 * 180});
  return task;
}
async function loadGenerationTask(env, id) {
  const task = await readState(env, taskKey(id), null);
  if (!task) throw new Error("没有找到这个生成任务");
  return task;
}

function mediaStorageLimit(env) {
  const configured = Number(env.COZY_MEDIA_LIMIT_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 9_000_000_000;
}

function mediaMaxFileBytes(env) {
  const configured = Number(env.COZY_MEDIA_MAX_FILE_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 100_000_000;
}

async function mediaStorageUsage(env) {
  const limit_bytes = mediaStorageLimit(env);
  if (!env.COZY_MEDIA) return {enabled: false, used_bytes: 0, limit_bytes, remaining_bytes: limit_bytes, object_count: 0};
  let used_bytes = 0, object_count = 0, cursor;
  do {
    const page = await env.COZY_MEDIA.list({limit: 1000, ...(cursor ? {cursor} : {})});
    for (const object of page.objects || []) {
      used_bytes += Number(object.size || 0);
      object_count += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return {enabled: true, used_bytes, limit_bytes, remaining_bytes: Math.max(0, limit_bytes - used_bytes), object_count};
}

async function ensureMediaCapacity(env, incomingBytes) {
  const bytes = Number(incomingBytes || 0);
  if (bytes > mediaMaxFileBytes(env)) throw new Error("生成文件超过 100MB，请缩短视频或降低分辨率");
  const usage = await mediaStorageUsage(env);
  if (usage.used_bytes + bytes > usage.limit_bytes) {
    throw new Error("R2 媒体空间已接近 10GB 上限，请先清理旧素材再生成");
  }
  return usage;
}

function mediaExtension(contentType, fallback = "bin") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("png")) return "png";
  if (type.includes("mp4")) return "mp4";
  const value = String(fallback || "bin").toLowerCase().replace(/^\./, "");
  return value === "jpeg" ? "jpg" : value;
}

function mediaContentType(extension) {
  if (extension === "jpg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "mp4") return "video/mp4";
  return "application/octet-stream";
}

const UPLOAD_IMAGE_TYPES = Object.freeze({
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"
});
const UPLOAD_MEDIA_FOLDERS = Object.freeze({
  photo_wall: "photos", travel: "travel", tree_hollow: "heart"
});

function mediaUploadError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hasImageSignature(bytes, contentType) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value,index) => bytes[index] === value);
  if (contentType === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0,4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8,12)) === "WEBP";
  if (contentType === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0,6)));
  return false;
}

function decodeUploadedImage(dataUrl) {
  const matched = String(dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!matched) throw mediaUploadError("目前支持 JPG、PNG、WebP 或 GIF 图片");
  const contentType = matched[1].toLowerCase();
  let bytes;
  try {
    const encoded = matched[2].replace(/\s+/g, "");
    if (!encoded || encoded.length % 4 === 1) throw new Error("invalid base64");
    bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  } catch (_error) {
    throw mediaUploadError("图片数据无法读取");
  }
  if (!bytes.byteLength) throw mediaUploadError("图片数据无法读取");
  if (bytes.byteLength > 10 * 1024 * 1024) throw mediaUploadError("单张图片需要小于 10MB", 413);
  if (!hasImageSignature(bytes, contentType)) throw mediaUploadError("图片格式与文件内容不一致");
  return {bytes, contentType, extension: UPLOAD_IMAGE_TYPES[contentType]};
}

async function uploadMediaToR2(env, input) {
  if (env.DEMO_MODE === "true") throw mediaUploadError("演示版不保存主人照片", 403);
  if (!env.COZY_MEDIA) throw mediaUploadError("私人 R2 媒体空间尚未绑定", 503);
  const kind = String(input.kind || "photo_wall").trim();
  if (!UPLOAD_MEDIA_FOLDERS[kind]) throw mediaUploadError("不支持的素材归档位置");
  const {bytes, contentType, extension} = decodeUploadedImage(input.data_url);
  await ensureMediaCapacity(env, bytes.byteLength);

  const [estate, localState] = await Promise.all([readData(env, "estate_state"), readData(env, "local_state")]);
  const values = localState.values && typeof localState.values === "object" ? localState.values : (localState.values = {});
  const id = `media_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const date = dateInShanghai();
  const key = `uploads/${UPLOAD_MEDIA_FOLDERS[kind]}/${date.replaceAll("-", "")}-${id.slice(6)}.${extension}`;
  const file = `/api/media/file?id=${encodeURIComponent(key)}`;
  const title = String(input.title || input.name || "一张照片").replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "一张照片";
  const note = String(input.note || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  const item = {id, file, storage_key: key, title, note, date, created_at: now()};
  let writeEstate = false, writeLocal = false;

  if (kind === "photo_wall") {
    const photos = Array.isArray(estate.wall_photos) ? estate.wall_photos : [];
    item.type = "life";
    item.position = {x: 14 + (photos.length * 13) % 68, y: 50 + (photos.length * 7) % 23, rotate: (photos.length * 5) % 15 - 7};
    estate.wall_photos = [...photos, item].slice(-80);
    writeEstate = true;
  } else if (kind === "travel") {
    const tripId = String(input.trip_id || "").trim();
    const localTrips = Array.isArray(values.cozy_trips) ? values.cozy_trips : [];
    let trip = localTrips.find(entry => String(entry?.id || "") === tripId);
    if (trip) {
      trip.photos = [...(Array.isArray(trip.photos) ? trip.photos : []), file].slice(-12);
      if (!trip.file) trip.file = file;
      trip.updatedAt = now();
      values.cozy_trips = localTrips;
      writeLocal = true;
    } else {
      const history = Array.isArray(estate.travel?.history) ? estate.travel.history : [];
      trip = history.find(entry => String(entry?.id || "") === tripId);
      if (!trip) throw mediaUploadError("没有找到要放入照片的旅程", 404);
      trip.photos = [...(Array.isArray(trip.photos) ? trip.photos : []), file].slice(-12);
      if (!trip.file) trip.file = file;
      trip.updatedAt = now();
      estate.travel = {...(estate.travel || {}), history};
      writeEstate = true;
    }
    item.trip_id = tripId;
  } else {
    const replaceId = String(input.replace_id || "");
    const buried = (Array.isArray(values.cozy_hollow_buried_media) ? values.cozy_hollow_buried_media : [])
      .filter(entry => !replaceId || String(entry?.id || "") !== replaceId);
    Object.assign(item, {kind: "image", summary: note || title, source: "heart_hollow", status: "ready"});
    values.cozy_hollow_buried_media = [item, ...buried].slice(0, 40);
    writeLocal = true;
  }

  await env.COZY_MEDIA.put(key, bytes, {
    httpMetadata: {contentType},
    customMetadata: {kind, mediaId: id}
  });
  try {
    if (writeEstate) await writeData(env, "estate_state", estate);
    if (writeLocal) {
      localState.version = Math.max(2, Number(localState.version || 1));
      localState.updated_at = now();
      await writeData(env, "local_state", localState);
    }
  } catch (error) {
    try { await env.COZY_MEDIA.delete(key); } catch (_cleanupError) {}
    throw error;
  }
  return {item, estate_state: estate, local_state: localState, storage: await mediaStorageUsage(env)};
}

function travelPhotoFiles(trip) {
  if (!trip || typeof trip !== "object") return [];
  return (Array.isArray(trip.photos) && trip.photos.length ? trip.photos : [trip.file]).map(String).filter(Boolean);
}

function travelR2Key(file) {
  try {
    const key = new URL(String(file || ""), "https://cozy.invalid").searchParams.get("id") || "";
    return key.startsWith("uploads/travel/") ? key : "";
  } catch (_error) {
    return "";
  }
}

async function deleteTravelPhoto(env, input) {
  const tripId = String(input.trip_id || "").trim(), file = String(input.file || "").trim();
  if (!tripId || !file) throw mediaUploadError("缺少旅程或照片信息");
  const [estate, local] = await Promise.all([readData(env, "estate_state"), readData(env, "local_state")]);
  const localTrips = Array.isArray(local?.values?.cozy_trips) ? local.values.cozy_trips : [];
  const estateTrips = Array.isArray(estate?.travel?.history) ? estate.travel.history : [];
  const localTrip = localTrips.find(item => String(item?.id || "") === tripId);
  const estateTrip = estateTrips.find(item => String(item?.id || "") === tripId);
  const targets = [localTrip, estateTrip].filter(Boolean);
  if (!targets.length) throw mediaUploadError("没有找到这段旅程", 404);
  if (!targets.some(trip => travelPhotoFiles(trip).includes(file))) throw mediaUploadError("这张照片不属于该旅程", 404);

  const updateTrip = trip => {
    const photos = travelPhotoFiles(trip).filter(value => value !== file);
    return {...trip, photos, file: photos[0] || "", updatedAt: now()};
  };
  let nextEstate = estate;
  if (estateTrip) {
    nextEstate = {...estate, travel: {...(estate.travel || {}), history: estateTrips.map(item => item === estateTrip ? updateTrip(item) : item)}};
    await writeData(env, "estate_state", nextEstate);
  }
  const nextLocal = localTrip
    ? await mergeLocalState(env, {changes: {cozy_trips: {type: "array", upserts: [updateTrip(localTrip)], deleted: []}}})
    : local;
  const key = travelR2Key(file);
  if (key && env.COZY_MEDIA) await env.COZY_MEDIA.delete(key);
  return {estate_state: nextEstate, local_state: nextLocal, deleted_file_count: key ? 1 : 0};
}

async function deleteTravelTrip(env, input) {
  const tripId = String(input.trip_id || "").trim();
  if (!tripId) throw mediaUploadError("缺少旅程信息");
  const [estate, local] = await Promise.all([readData(env, "estate_state"), readData(env, "local_state")]);
  const values = local?.values || {};
  const localTrips = Array.isArray(values.cozy_trips) ? values.cozy_trips : [];
  const estateTrips = Array.isArray(estate?.travel?.history) ? estate.travel.history : [];
  const removedTrips = [...localTrips, ...estateTrips].filter(item => String(item?.id || "") === tripId);
  if (!removedTrips.length) throw mediaUploadError("没有找到这段旅程", 404);

  const keys = [...new Set(removedTrips.flatMap(travelPhotoFiles).map(travelR2Key).filter(Boolean))];
  const remainingTrips = [...localTrips, ...estateTrips].filter(item => String(item?.id || "") !== tripId);
  const retainedKeys = new Set(remainingTrips.flatMap(travelPhotoFiles).map(travelR2Key).filter(Boolean));
  const deletableKeys = keys.filter(key => !retainedKeys.has(key));
  const nextEstate = {...estate, travel: {...(estate.travel || {}), history: estateTrips.filter(item => String(item?.id || "") !== tripId)}};
  if (estateTrips.length !== nextEstate.travel.history.length) await writeData(env, "estate_state", nextEstate);
  const nextLocal = await mergeLocalState(env, {changes: {
    cozy_trips: {type: "array", upserts: [], deleted: [`id:${tripId}`]},
    cozy_trip_reflections: {type: "object", upserts: {}, deleted: [tripId]},
    cozy_photo_albums: {type: "array", upserts: [], deleted: [`id:travel_${tripId}`]}
  }});
  if (env.COZY_MEDIA) for (const key of deletableKeys) await env.COZY_MEDIA.delete(key);
  return {estate_state: nextEstate, local_state: nextLocal, deleted_file_count: deletableKeys.length};
}

async function storeRemoteMedia(env, task, url, extension) {
  if (!env.COZY_MEDIA) return [{url, temporary: true}];
  const response = await fetch(url);
  if (!response.ok) throw new Error(`生成文件下载失败（HTTP ${response.status}）`);
  const bytes = await response.arrayBuffer();
  await ensureMediaCapacity(env, bytes.byteLength);
  const contentType = response.headers.get("content-type") || "";
  const actualExtension = mediaExtension(contentType, extension);
  const key = `generated/${task.kind}/${task.id}.${actualExtension}`;
  await env.COZY_MEDIA.put(key, bytes, {httpMetadata: {contentType: contentType || mediaContentType(actualExtension)}});
  return [{key, url: `/api/media/file?id=${encodeURIComponent(key)}`, size: bytes.byteLength}];
}

async function generateImage(env, input) {
  const provider = String(input.provider || "seedream").toLowerCase();
  const id = `gen_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
  let task = {id, kind: "image", provider, prompt: String(input.prompt || "").slice(0, 4000), status: "running", created_at: now(), outputs: []};
  if (!task.prompt) throw new Error("图片提示词不能为空");
  await saveGenerationTask(env, task);
  try {
    let payload;
    if (provider === "seedream" || provider === "ark") {
      const outputFormat = input.output_format || env.COZY_SEEDREAM_DEFAULT_FORMAT || "jpeg";
      payload = await providerRequest(env, "ark", "/images/generations", {
        model: input.model || env.COZY_SEEDREAM_MODEL || "doubao-seedream-4-0-250828",
        prompt: task.prompt, image: input.images || undefined, size: input.size || env.COZY_SEEDREAM_DEFAULT_SIZE || "1K",
        output_format: outputFormat, response_format: "url", watermark: Boolean(input.watermark)
      });
    } else if (provider === "openai" || provider === "gpt-image") {
      payload = await providerRequest(env, "openai", "/images/generations", {
        model: input.model || env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2", prompt: task.prompt,
        size: input.size || env.COZY_OPENAI_IMAGE_DEFAULT_SIZE || "1024x1024",
        quality: input.quality || env.COZY_OPENAI_IMAGE_DEFAULT_QUALITY || "medium",
        output_format: input.output_format || env.COZY_OPENAI_IMAGE_DEFAULT_FORMAT || "webp",
        n: Math.min(Math.max(Number(input.count || 1), 1), 4)
      });
    } else if (["gemini", "nano-banana", "nano_banana"].includes(provider)) {
      const model = input.model || env.COZY_GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
      const gemini = await providerRequest(env, "gemini", `/models/${encodeURIComponent(model)}:generateContent`, {
        contents: [{role: "user", parts: [{text: task.prompt}]}],
        generationConfig: {responseModalities: ["TEXT", "IMAGE"]}
      });
      payload = {model, data: (gemini.candidates || []).flatMap(candidate => candidate.content?.parts || []).map(part => {
        const inline = part.inlineData || part.inline_data || {};
        return inline.data ? {b64_json: inline.data, mime_type: inline.mimeType || inline.mime_type} : null;
      }).filter(Boolean), usage: gemini.usageMetadata || {}};
    } else throw new Error("图片 provider 只支持 seedream、openai 或 gemini");
    const outputs = [];
    const defaultFormat = provider === "openai" || provider === "gpt-image"
      ? env.COZY_OPENAI_IMAGE_DEFAULT_FORMAT || "webp"
      : env.COZY_SEEDREAM_DEFAULT_FORMAT || "jpeg";
    for (const item of (payload.data || []).slice(0, 4)) {
      if (item.url) outputs.push(...await storeRemoteMedia(env, task, item.url, input.output_format || defaultFormat));
      else if (item.b64_json && env.COZY_MEDIA) {
        const bytes = Uint8Array.from(atob(item.b64_json), char => char.charCodeAt(0));
        await ensureMediaCapacity(env, bytes.byteLength);
        const extension = mediaExtension(item.mime_type, input.output_format || defaultFormat);
        const key = `generated/image/${task.id}-${outputs.length + 1}.${extension}`;
        await env.COZY_MEDIA.put(key, bytes, {httpMetadata: {contentType: item.mime_type || mediaContentType(extension)}});
        outputs.push({key, url: `/api/media/file?id=${encodeURIComponent(key)}`, size: bytes.byteLength});
      }
    }
    task = {...task, status: "succeeded", model: payload.model || input.model, outputs, usage: payload.usage || {}};
    return saveGenerationTask(env, task);
  } catch (error) {
    await saveGenerationTask(env, {...task, status: "failed", error: error.message});
    throw error;
  }
}

async function createVideo(env, input) {
  const id = `gen_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
  let task = {id, kind: "video", provider: "seedance", prompt: String(input.prompt || "").slice(0, 4000), status: "running", created_at: now(), outputs: []};
  if (!task.prompt) throw new Error("视频提示词不能为空");
  await saveGenerationTask(env, task);
  try {
    const content = [{type: "text", text: task.prompt}, ...(input.images || []).map(url => ({type: "image_url", image_url: {url}, role: "reference_image"}))];
    const payload = await providerRequest(env, "ark", "/contents/generations/tasks", {
      model: input.model || env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-mini-260615", content,
      generate_audio: Boolean(input.generate_audio), ratio: input.ratio || "16:9",
      resolution: input.resolution || env.COZY_VIDEO_DEFAULT_RESOLUTION || "480p",
      duration: Math.min(Math.max(Number(input.duration || env.COZY_VIDEO_DEFAULT_DURATION || 5), 3), 30), watermark: Boolean(input.watermark)
    });
    task = {...task, status: "queued", remote_id: payload.id, model: input.model || env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-mini-260615"};
    return saveGenerationTask(env, task);
  } catch (error) {
    await saveGenerationTask(env, {...task, status: "failed", error: error.message});
    throw error;
  }
}

async function refreshVideo(env, id) {
  let task = await loadGenerationTask(env, id);
  if (task.kind !== "video" || !task.remote_id) throw new Error("这不是可查询的视频任务");
  if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
  const payload = await providerRequest(env, "ark", `/contents/generations/tasks/${encodeURIComponent(task.remote_id)}`, null, "GET");
  const videoUrl = payload.content?.video_url || payload.video_url || "";
  const outputs = payload.status === "succeeded" && videoUrl ? await storeRemoteMedia(env, task, videoUrl, "mp4") : task.outputs;
  task = {...task, status: payload.status || "unknown", outputs, usage: payload.usage || {}, error: payload.error || ""};
  return saveGenerationTask(env, task);
}

function cleanHtml(value) {
  let text = String(value || "");
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&amp;/gi, "&");
  }
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function embeddedDocumentText(html, limit = 160000) {
  const values = [];
  const seen = new Set();
  const pattern = /\\"insert\\":\\"((?:\\\\.|[^\\"])*)\\"/g;
  let size = 0;
  for (const match of String(html || "").matchAll(pattern)) {
    let value = "";
    try { value = JSON.parse(`"${match[1]}"`); } catch (_error) { continue; }
    value = String(value).replace(/\s+/g, " ").trim();
    if (!value || value === "*" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    size += value.length + 1;
    if (size >= limit) break;
  }
  return values.join("\n").slice(0, limit);
}

function priceContext(text, tool) {
  const model = String(tool?.model || "").trim();
  const canonical = model.replace(/-\d{6}$/, "");
  const dotted = canonical.replace(/-(\d+)-(\d+)(?=-|$)/, "-$1.$2");
  const terms = [...new Set([model, canonical, dotted].filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!terms.length) terms.push(String(tool?.title || "").replace(/\s+API$/i, "").trim());
  const source = String(text || "");
  const lower = source.toLowerCase();
  const windows = [];
  const seen = new Set();
  for (const term of terms) {
    const needle = term.toLowerCase();
    let start = 0;
    while (needle && windows.length < 6) {
      const index = lower.indexOf(needle, start);
      if (index < 0) break;
      const left = Math.max(0, index - 520);
      const right = Math.min(source.length, index + needle.length + 650);
      const marker = `${Math.floor(left / 300)}:${Math.floor(right / 300)}`;
      if (!seen.has(marker)) { seen.add(marker); windows.push(source.slice(left, right)); }
      start = index + needle.length;
    }
  }
  return (windows.length ? windows.join("\n--- 当前模型相邻价格区 ---\n") : source.slice(0, 8000)).slice(0, 12000);
}

function metaValue(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["']`, "i")
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return cleanHtml(match[1]);
    }
  }
  return "";
}

function safeExternalUrl(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 http 或 https 链接");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host) || host === "::1") throw new Error("不能解析本机或内网地址");
  return url;
}

function categoryForArticle(text) {
  if (/论文|research|paper|arxiv|学术|science/i.test(text)) return "学术研究";
  if (/产品|原型|工作流|效率|评测|记忆|agent|mcp|skill/i.test(text)) return "产品与实践";
  if (/融资|公司|行业|市场|政策/i.test(text)) return "行业动态";
  return "模型与技术";
}

async function parseUrl(env, value, instruction = "") {
  const url = safeExternalUrl(value);
  const response = await fetch(url.toString(), {redirect: "follow", headers: {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", accept: "text/html,application/xhtml+xml"}});
  if (!response.ok) throw new Error(`网页读取失败（HTTP ${response.status}）`);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html") && !type.includes("text/plain")) throw new Error("这个链接不是可解析的网页正文");
  const html = (await response.text()).slice(0, 500000);
  const title = metaValue(html, ["og:title", "twitter:title"]) || cleanHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || url.hostname;
  const original = metaValue(html, ["description", "og:description", "twitter:description"]);
  const articleText = cleanHtml(html).slice(0, 12000);
  let aiSummary = "";
  if (textProvider(env) && articleText) {
    const result = await callText(env, `请用中文总结这篇文章，不超过200字。保留具体事实，结构自然包含核心内容、关键变化或能力、值得关注的结论，不要写泛泛的PM影响。\n标题：${title}\n用户指令：${String(instruction).slice(0, 500)}\n正文：${articleText}`, 700);
    aiSummary = result.text.trim();
  }
  const published = metaValue(html, ["article:published_time", "date", "datePublished"]);
  return {
    id: `link_${crypto.randomUUID().slice(0, 12)}`, title: title.slice(0, 240), url: response.url || url.toString(),
    media: url.hostname.replace(/^www\./, ""), published: published.slice(0, 40),
    category: categoryForArticle(`${title} ${original} ${articleText.slice(0, 1000)}`),
    summary: (original || articleText.slice(0, 360)).slice(0, 600), ai_summary: aiSummary.slice(0, 1200),
    archived_at: now()
  };
}

async function importToolCard(env, value, instruction = "", source = {}) {
  let page;
  try { page = await parseUrl(env, value, instruction); }
  catch (error) {
    if (!source?.title || (!source?.summary && !source?.ai_summary)) throw error;
    const url = safeExternalUrl(value);
    page = {
      title: String(source.title).slice(0, 240), url: url.toString(), source_url: url.toString(),
      media: String(source.media || url.hostname).slice(0, 120), category: String(source.category || ""),
      summary: String(source.summary || "").slice(0, 1200), ai_summary: String(source.ai_summary || "").slice(0, 1600)
    };
  }
  const categories = new Set(["写代码", "学术", "图像与视频", "产品与原型", "办公与中文", "本地与协议", "模型与技术", "其他"]);
  let parsed = {};
  if (textProvider(env)) {
    const result = await callText(env, `你是工具箱整理员。判断资讯中是否出现了可以直接使用的产品、模型、API、软件或开源项目，并整理成一张工具卡。不要把文章标题当工具名。只返回 JSON：{"is_tool":true,"title":"真实工具名","category":"写代码/学术/图像与视频/产品与原型/办公与中文/本地与协议/模型与技术/其他","purpose":"一句用途","key_capabilities":["3到6项"],"use_cases":["2到4项"],"example":"一个具体使用例子","official_url":"明确知道时填写，否则留空"}。如果文章没有可直接使用的工具，返回 {"is_tool":false,"reason":"原因"}。不得编造能力。\n用户要求：${String(instruction).slice(0, 500)}\n标题：${page.title}\n原摘要：${page.summary || ""}\nAI摘要：${page.ai_summary || ""}\n来源：${page.url}`, 1200);
    parsed = extractJson(result.text);
    if (parsed.is_tool === false) throw new Error(String(parsed.reason || "这篇资讯里没有识别到可直接使用的工具"));
  }
  let officialUrl = "";
  try { if (parsed.official_url) officialUrl = safeExternalUrl(parsed.official_url).toString(); }
  catch (_error) {}
  const title = String(parsed.title || page.title || "").trim().slice(0, 120);
  if (!title) throw new Error("没有识别到明确的工具名称");
  const toolText = `${title} ${parsed.purpose || ""} ${(parsed.key_capabilities || []).join(" ")}`;
  let category = categories.has(String(parsed.category || "")) ? String(parsed.category) : "其他";
  if (category === "其他") {
    if (/图像|图片|视频|生图|video|image/i.test(toolText)) category = "图像与视频";
    else if (/代码|编程|开发|code/i.test(toolText)) category = "写代码";
    else if (/论文|科研|学术|research|paper/i.test(toolText)) category = "学术";
    else if (/原型|产品|工作流|agent/i.test(toolText)) category = "产品与原型";
    else if (/文档|表格|办公|office/i.test(toolText)) category = "办公与中文";
    else if (/本地|协议|mcp/i.test(toolText)) category = "本地与协议";
  }
  return {
    id: `tool_${crypto.randomUUID().slice(0, 10)}`, type: "toolbox", title,
    category,
    purpose: String(parsed.purpose || page.ai_summary || page.summary || "").slice(0, 1000),
    key_capabilities: (Array.isArray(parsed.key_capabilities) ? parsed.key_capabilities : []).filter(Boolean).slice(0, 6).map(String),
    use_cases: (Array.isArray(parsed.use_cases) ? parsed.use_cases : []).filter(Boolean).slice(0, 4).map(String),
    example: String(parsed.example || "").slice(0, 800), url: officialUrl || page.url,
    source_url: page.url, media: page.media || "", added_at: now(), source: "notice_import"
  };
}

async function refreshToolPriceCloud(env, rawTool) {
  const tool = rawTool && typeof rawTool === "object" ? rawTool : {};
  const title = String(tool.title || "").trim();
  const source = tool.price_url || tool.pricing?.source_url || tool.source_url;
  if (!title || !source) throw new Error("这个工具还没有可核验的官方价格页");
  const url = safeExternalUrl(source);
  let response;
  let html = "";
  const dynamicDoc = url.hostname.toLowerCase().endsWith("volcengine.com");
  for (let attempt = 0; attempt < (dynamicDoc ? 4 : 1); attempt += 1) {
    response = await fetch(url.toString(), {redirect: "follow", headers: {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", accept: "text/html,application/xhtml+xml"}});
    if (!response.ok) throw new Error(`官方价格页读取失败（HTTP ${response.status}）`);
    html = (await response.text()).slice(0, 1200000);
    if (!dynamicDoc || html.length >= 100000 || html.includes('\\"insert\\"')) break;
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 700 + attempt * 600));
  }
  const embeddedText = embeddedDocumentText(html);
  const pageText = priceContext(embeddedText.length >= 80 ? embeddedText : cleanHtml(html), tool);
  const result = await callText(env, `只根据下面官方价格页核验“${title}”的当前价格。不得猜测，不得混入同页其他模型。正文已截取到当前模型附近，只采用紧跟当前模型名的价格，不采用片段边缘处其他模型的价格。当前日期 ${dateInShanghai()}。只返回 JSON：{"summary":"一句价格概括","currency":"CNY/USD/其他","items":[{"label":"计费项或规格","value":"价格数值、范围或折扣","unit":"计费单位"}],"status":"current/estimate/unavailable","note":"优惠期限或动态计费说明"}。页面没有明确价格时标 unavailable。\n当前模型：${tool.model || ""}\n官方页：${url}\n正文：${pageText}`, 1200);
  const parsed = extractJson(result.text);
  const items = (Array.isArray(parsed.items) ? parsed.items : []).filter(item => item?.label && item?.value).slice(0, 8).map(item => ({label: String(item.label).slice(0, 100), value: String(item.value).slice(0, 160), unit: String(item.unit || "").slice(0, 100)}));
  if (String(parsed.status || "") === "unavailable" || !items.length) throw new Error("官方页面里没有解析到这个模型的明确价格，已保留原价格");
  const sourceNumbers = new Set([...pageText.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g)].map(match => Number(match[0])));
  const returnedNumbers = [...items.flatMap(item => [...item.value.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g)].map(match => Number(match[0])))];
  if (returnedNumbers.some(value => !sourceNumbers.has(value))) throw new Error("价格核验结果包含官方截取片段中不存在的数字，已保留原价格");
  const pricing = {summary: String(parsed.summary || "").slice(0, 300), currency: String(parsed.currency || "").slice(0, 20), items, status: String(parsed.status || "current"), note: String(parsed.note || "").slice(0, 300), checked_at: dateInShanghai(), source_url: url.toString()};
  return {...tool, type: "toolbox", pricing, price_url: url.toString(), source: "price_refresh"};
}

function extractUrls(text) {
  return (String(text || "").match(/https?:\/\/[^\s，。；、)）]+/g) || []).map(url => url.replace(/[.,，。；;]+$/, "")).slice(0, 5);
}

async function executeCloudTools(env, message) {
  const results = [];
  const urls = extractUrls(message);
  const addResult = (tool, summary, data) => results.push({ok: true, tool, summary, data});
  const failResult = (tool, error) => results.push({ok: false, tool, summary: String(error.message || error).slice(0, 240)});
  const categoryMatch = message.match(/(?:新增|创建|加一个).{0,8}(?:分类|文件夹)[：:]?\s*([^，。；\n]{2,16})/);
  if (categoryMatch) {
    const name = categoryMatch[1].replace(/(?:这个|类别|分类|文件夹).*$/, "").trim();
    try {
      const state = await readData(env, "butler_state");
      const categories = Array.from(new Set([...(state.custom_categories || []), name]));
      await syncButlerState(env, {custom_categories: categories});
      addResult("create_notice_category", `已新增分类“${name}”`, {name});
    } catch (error) { failResult("create_notice_category", error); }
  }
  if (urls.length && /媒体|来源|信息源|以后.*找|巡逻来源/.test(message)) {
    for (const value of urls) {
      try {
        const url = safeExternalUrl(value);
        const source = {id: `source_${crypto.randomUUID().slice(0, 8)}`, name: url.hostname.replace(/^www\./, ""), url: url.toString(), enabled: true, added_at: now()};
        await appendButlerItem(env, "sources", source);
        addResult("add_media_source", `已把 ${source.name} 加入巡逻来源`, source);
      } catch (error) { failResult("add_media_source", error); }
    }
  }
  if (/以后|明天|下周|关注|想看|总结方向/.test(message)) {
    try {
      const topic = {id: `topic_${crypto.randomUUID().slice(0, 8)}`, text: message.replace(/https?:\/\/\S+/g, "").trim().slice(0, 240), added_at: now()};
      if (topic.text) {
        await appendButlerItem(env, "watch_topics", topic);
        addResult("add_watch_topic", "已更新阿栗的资讯关注方向", topic);
      }
    } catch (error) { failResult("add_watch_topic", error); }
  }
  if (urls.length && !/媒体|来源|信息源|以后.*找|巡逻来源/.test(message)) {
    for (const value of urls) {
      try {
        const item = await parseUrl(env, value, message);
        if (/工具箱|工具|skill|应用/i.test(message)) {
          const tool = {...item, id: `tool_${crypto.randomUUID().slice(0, 10)}`, type: "toolbox", purpose: item.ai_summary || item.summary, key_capabilities: [], usage_example: "从原文案例开始试用"};
          await appendButlerItem(env, "toolbox", tool);
          addResult("add_tool_from_link", `已解析并加入工具箱：${tool.title}`, tool);
        } else {
          await appendButlerItem(env, "chest", item);
          addResult("archive_link", `已解析并收入栗夹：${item.title}`, item);
        }
      } catch (error) { failResult("parse_link", error); }
    }
  }
  return results;
}

async function assistantReply(env, message, clientContext = {}) {
  const toolResults = await executeCloudTools(env, message);
  let foundItems=[];
  let noticeLookup={checked:false,found:0};
  if(toolResults.some(item=>item.ok&&item.tool==="add_watch_topic")||/(?:查|找|看看|关注).{0,12}(?:资讯|动态|消息|更新)/.test(message)){
    try{
      foundItems=await findNoticeItemsForRequest(env,message);
      noticeLookup={checked:true,found:foundItems.length};
      if(foundItems.length)toolResults.push({ok:true,tool:"find_notice_updates",summary:`已找到 ${foundItems.length} 条与留言直接相关的新内容`,data:foundItems});
    }catch(error){noticeLookup={checked:true,found:0,error:String(error.message||error).slice(0,200)};}
  }
  const memory = await memoryContext(env, "butler", {
    query: message,
    recentIds: Array.isArray(clientContext?.recent_memory_ids) ? clientContext.recent_memory_ids : []
  });
  const courtyard = await readData(env, "butler_state");
  const completed = toolResults.filter(item => item.ok).map(item => item.summary);
  try {
    await addMemoryEvents(env, {source: "butler", type: "owner_command", layer: "short", weight: 2, content: message, summary: `交给阿栗：${message.slice(0, 120)}`});
  } catch (error) {
    if (!noticeKvWriteLimitExceeded(error)) throw error;
  }
  if (completed.length && !/[？?]|怎么|为什么|分析|解释|建议/.test(message)) {
    const failed = toolResults.filter(item => !item.ok).map(item => item.summary);
    return {reply: `已经完成：${completed.join("；")}。${failed.length ? `还有一项没有完成：${failed.join("；")}。` : ""}`, provider: "tools-only", tool_results: toolResults,found_items:foundItems,notice_lookup:noticeLookup};
  }
  if (!textProvider(env)) {
    if (completed.length) return {reply: `已经完成：${completed.join("；")}。`, provider: "tools-only", tool_results: toolResults,found_items:foundItems,notice_lookup:noticeLookup};
    throw new Error("阿栗的云端运行已就绪，但还没有配置文本模型 API Key");
  }
  const prompt = `你是栗壳小院的管家阿栗，一只守护私人小院的棕色小狗管家。你温和、清醒、行动优先，回复简洁但不敷衍。\n规则：\n1. 只把工具结果中 ok=true 的动作说成已经完成；失败要明确说明。\n2. 不得假装访问网页、知识库、文件或执行工具。\n3. 当前指令优先于历史偏好。管家默认只使用学习、工作方式和通用沟通偏好，不读取树洞内容，也不主动提起旅行。\n4. 回答主人问题时给出具体判断和下一步，不写空泛套话。\n5. 记忆最多使用两条，也可以完全不用；不要反复告诉主人“你一直怎样”。\n\n主人当前消息：${message.slice(0, 6000)}\n页面上下文：${JSON.stringify(clientContext).slice(0, 5000)}\n本轮相关记忆：${JSON.stringify(memory).slice(0, 7000)}\n小院资料状态：${JSON.stringify({watch_topics: courtyard.watch_topics, sources: courtyard.sources, categories: courtyard.custom_categories}).slice(0, 3000)}\n已执行工具结果：${JSON.stringify(toolResults).slice(0, 6000)}\n请直接回复主人。`;
  try {
    const result = await callText(env, prompt);
    return {reply: result.text, provider: result.provider, tool_results: toolResults,found_items:foundItems,notice_lookup:noticeLookup};
  } catch (error) {
    if (completed.length) return {reply: `已经完成：${completed.join("；")}。模型总结暂时没有返回，但执行结果已经保存。`, provider: "tools-only", tool_results: toolResults,found_items:foundItems,notice_lookup:noticeLookup, model_error: String(error.message || error).slice(0, 200)};
    throw error;
  }
}

const COMPANION_DIALOGUE_GUIDE = `陪伴对话规则：
1. 先回应眼前这句话，记忆只是可选背景，不要为了显得记得而主动翻旧账。
2. 从 listen、clarify、reframe、suggest、lighten、challenge 中选择此刻最有帮助的一种，避开 recent_reply_styles 最近两种。
3. 最多照见一个具体细节，不复述整段话；最多问一个真正有用的问题，也可以完全不问。
4. 可以给看法、具体办法、自然幽默或温和反驳，不把每段对话都变成安慰。
5. 最多使用两条高度相关记忆，也可以不用；不得用单次经历定义主人。`;
const COMPANION_STYLES = new Set(["listen", "clarify", "reframe", "suggest", "lighten", "challenge", "oracle", "archive"]);
const normalizedCompanionText = value => String(value || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
const travelCompanionIsDistinct = value => {
  const summary = normalizedCompanionText(value?.summary);
  const reply = normalizedCompanionText(value?.reply);
  return summary.length >= 4 && reply.length >= 4 && summary !== reply && !summary.includes(reply) && !reply.includes(summary);
};
const travelSummaryHasEnoughDetail = (value, message) => {
  const summary = normalizedCompanionText(value?.summary), source = normalizedCompanionText(message);
  return summary.length >= 8 && !(source.length >= 55 && summary.length < 45);
};

async function roomReply(env, room, message, context) {
  const decisionAudit = room === "orchard" && (String(context?.intent || "") === "decision_audit" || /我(?:现在)?(?:倾向|决定|打算)|要不要|是否应该|值不值得/.test(message));
  const blackboardIntent=room==="blackboard"?String(context?.intent||"grade_answer"):"";
  const stagedBlackboardGrade=blackboardIntent==="grade_answer"&&textProvider(env)==="deepseek";
  const roomPrompts = {
    heart_hollow: `这里是树洞。若 mode 是 oracle，请在主人完整倾诉后给一句像塔罗牌但不故弄玄虚的回应；若 mode 是 dialogue，就自然来回对话。不要强行围绕树，不急着安慰。\n${COMPANION_DIALOGUE_GUIDE}`,
    orchard: `这里是成长田的“问问阿栗”，这是一个认真解惑和学习的多轮对话，不是树洞、签语或成长鸡汤。
回答规则：
1. 当前“主人”消息是唯一主任务，必须准确回答它所问的对象和问题，不能擅自换题。
2. context.conversation 仅用于理解“它、这个、上面那个”等追问指代；若当前问题已经完整明确，以当前问题为准。旧对话不得盖过当前问题。
3. context.knowledge_topics 仅用于回答完成后决定归入哪个专题，不能用旧专题内容替代答案。相关非封存记忆也只能提供稳定偏好，和问题无关时必须忽略。
4. 先给明确结论，再用2到4个清晰要点解释原因、差异、步骤或适用场景；必要时给一个具体例子。不得只复述问题，不得只提问，不得泛泛安慰。
5. 用户问事实、产品或技术时，回答具体机制和边界；不确定、可能过时或未经联网核验的信息必须明确标注，不能编造。
6. 只有确实缺少关键条件、无法合理作答时，才在已经给出当前可答部分后追问最多一个问题。
7. 学习偏好只允许调整解释结构、例子密度和表达方式，不能改变事实结论，不能隐藏相反观点，也不能把过去偏好强加给当前问题。
8. 禁止田野隐喻、诗意散文、玄学签语和强制安排“几天内实验”。下一步没有实际帮助时留空。
${decisionAudit ? `9. 本轮触发“决策审查”：第一阶段必须用最强反方立场，寻找遗漏事实、乐观假设、不可逆成本、机会成本、最坏结果和认知偏差；第二阶段给出最强支持理由；第三阶段只比较最有分量的证据，明确哪方更强、最大未知变量和结论反转条件。禁止为了显得平衡而包装成五五开。` : ""}`,
    travel: `这里是旅行记录。帮助主人提炼具体旅行感悟，不写旅游宣传语。先识别主人原话里的地点、发生的具体事情、当时的真实感受，以及由此产生的认识或变化；只写主人确实说过的内容，缺失部分留空，绝不脑补。归档摘要必须能脱离聊天单独显示在旅行卡片上，陪伴回应则补充一个不同的新角度，两者不得复述。\n${COMPANION_DIALOGUE_GUIDE}`,
    blackboard: "这里是产品黑板。围绕题目逐点评改，区分主人答案、标准答案和具体改进建议。"
  };
  const guide = roomPrompts[room] || "根据当前房间和上下文直接回应。";
  const formats = {
    blackboard: blackboardIntent === "question_helper"
      ? '只返回 JSON：{"reply":"80到180字、直接关联当前题目和用户追问的背景解释","material":"用户问：问题；阿栗补充：可独立阅读的答案摘要"}。可使用模型通用知识补足背景；最新归属、版本、价格和指标未联网核验时必须明确标注。不得泄露标准答案或代写方案。'
      : blackboardIntent === "reference_answer" ? BLACKBOARD_REFERENCE_FORMAT : stagedBlackboardGrade?BLACKBOARD_GRADING_CORE_FORMAT:BLACKBOARD_GRADING_FORMAT,
    orchard: '只返回合法 JSON，不要 Markdown 代码围栏：{"reply":"直接回答当前问题的完整中文回复，通常180到500字；结论优先，分段或编号清楚，问题简单时可以更短","answer_focus":"20到50字概括本轮实际回答的问题，用于检查是否答偏","seed_summary":"本轮关注点的简短概括","key_insight":"一句可独立复习的核心判断","next_step":"一个确实有帮助的后续验证或学习动作，没有必要则留空","knowledge_topic":{"match_id":"能归入 context.knowledge_topics 中现有专题时必须填写其id，否则留空","title":"稳定且可扩展的专题名，不要把一次问题或单个产品机械建成一类","category":"优先复用现有分类，确实不同才新建","entities":["本轮实际涉及的产品、组织或概念"],"summary":"融合本轮正确答案与已有专题后的可复习摘要","knowledge_points":["3到7条具体事实、差异、方法或判断"],"comparison_rows":[{"item":"比较对象","traits":"主要特点","scenarios":"适用场景","considerations":"限制或注意点"}],"scenarios":["实际应用场景"],"conclusion":"专题当前结论"}}。reply 必须独立完整，即使后面的专题整理字段全部删掉也能直接解决用户问题。',
    heart_hollow: String(context?.mode || "oracle") === "dialogue"
      ? '只返回 JSON：{"reply":"自然、有内容的对话回应","mode":"dialogue","response_style":"listen/clarify/reframe/suggest/lighten/challenge 六选一","growth_signal":{"should_grow":true或false,"title":"不含原话和私密细节的成长主题","hint":"正在形成的判断或变化","nourishment":1到3}}。回应一个具体细节后向前推进，不复述整段话。可以表达判断或自然幽默；不必每轮安慰或追问。只有具体经历或可持续成长线索才生长；短促情绪、试音、重复句为 false。成长信号不得包含人物、公司、地点等私密细节。'
      : '只返回 JSON：{"reply":"18到45字、回应具体内容的一句签语","mode":"oracle","response_style":"oracle","growth_signal":{"should_grow":true或false,"title":"不含原话和私密细节的成长主题","hint":"正在形成的判断或变化","nourishment":1到3}}。只有具体经历或可持续成长线索才生长；短促情绪、试音、重复句为 false。成长信号不得包含人物、公司、地点等私密细节。',
    travel: String(context?.intent || "") === "summarize_trip_description"
      ? '只返回 JSON：{"summary":"忠于原话、80字内的旅行描述","title":"简短名称","reply":"","response_style":"archive"}。只整理事实，不添加感悟或虚构经历。'
      : '只返回 JSON：{"summary":"忠于原话、60到120字且可独立显示在旅行卡片上的感悟摘要","title":"简短名称","reply":"针对这段感悟的自然陪伴回应","response_style":"listen/clarify/reframe/suggest/lighten/challenge 六选一"}。summary 按“地点或场景、发生的事、具体感受、认识或变化”的顺序组织，但只使用当前主人原话中实际出现的信息，缺什么就省略什么；不得写万能感悟、鸡汤或旅游宣传语，房间记忆不得改写摘要。reply 负责陪伴，必须接住原话中的一个具体细节，再补充一个有内容的新角度；主人谈方法时就指出该方法真正解决了什么或补一条可执行判断标准，禁止只说“需要考虑各种情况”“很有意义”“继续保持”等泛话。reply 不得复述 summary，不必每次追问。'
  };
  const recentIds = Array.isArray(context?.recent_memory_ids) ? context.recent_memory_ids : [];
  const memoryPurpose = room === "orchard" ? "learning_support" : room === "heart_hollow" ? "heart_companion" : room === "travel" ? "travel_companion" : room === "blackboard" ? "blackboard_question" : "general";
  const memory = room === "blackboard" && ["grade_answer","reference_answer"].includes(blackboardIntent)
    ? {enabled: false, selected_memory_ids: [], note: blackboardIntent==="reference_answer"?"独立示范回答不读取个人记忆或主人答案":"公平评分不读取个人记忆"}
    : await memoryContext(env, memoryPurpose, {query: message, recentIds, roomId: String(context?.trip_id || "")});
  const answerMemory = memory;
  const roomPrompt = `${guide}\n${formats[room] || "请直接回应。"}\n不得编造主人没有说过的经历。\n房间：${room}\n当前主人问题（最高优先级）：${message.slice(0, 8000)}\n辅助上下文（只用于指代消解和归档）：${JSON.stringify(context).slice(0, 7000)}\n房间限定记忆（最多两条，可以完全不用；不得为了展示记忆而提起过去）：${JSON.stringify(answerMemory).slice(0, 5000)}`;
  const roomTokens=room === "orchard" ? 2600 : blackboardIntent==="grade_answer" ? stagedBlackboardGrade?3600:6500 : blackboardIntent==="reference_answer" ? 3200 : 1800;
  const generationOptions = blackboardIntent === "grade_answer"
    ? {temperature:0.1,thinking:false,providerTimeouts:{deepseek:70000,openai:20000,"workers-ai":45000}}
    : blackboardIntent === "reference_answer" ? {temperature:0.2,thinking:false} : {temperature: 0.35};
  let result = await callText(env, roomPrompt, roomTokens, generationOptions);
  let parsed;
  try { parsed = extractJson(result.text); } catch (_error) { parsed = {reply: result.text}; }
  if(blackboardIntent==="grade_answer"){
    parsed=normalizeBlackboardGradeCandidate(parsed,message,context);
  }
  if (room === "heart_hollow" && !COMPANION_STYLES.has(String(parsed.response_style || ""))) {
    parsed.response_style = String(context?.mode || "oracle") === "oracle" ? "oracle" : "listen";
  }
  if (room === "travel" && String(context?.intent || "") !== "summarize_trip_description" && (!travelCompanionIsDistinct(parsed) || !travelSummaryHasEnoughDetail(parsed, message))) {
    result = await callText(env, `${roomPrompt}\n\n上一版的归档摘要过短、遗漏了主人说的具体事情，或者把摘要和陪伴回应写成了同一件事。请重写：summary 先交代发生的具体事情，再保留感受和认识，信息足够时写满60字左右；reply 必须接住一个具体细节并向前推进，不能复述 summary。上一版：${String(result.text).slice(0, 3000)}`, roomTokens, generationOptions);
    parsed = extractJson(result.text);
    if (!travelSummaryHasEnoughDetail(parsed, message)) parsed.summary = String(message).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!travelCompanionIsDistinct(parsed)) {
      parsed.reply = "这段感受我先照原样替你收好，不急着把它包装成某种人生结论。";
      parsed.response_style = "listen";
    }
  }
  if (room === "orchard" && !orchardAnswerAligned(message, parsed)) {
    result = await callText(env, `${roomPrompt}\n\n上一版输出没有准确对齐当前问题，禁止沿用其中无关内容。请重新阅读“当前主人问题”，确保 answer_focus 准确概括该问题，reply 明确提到问题中的产品、组织或概念并直接作答。上一版输出：${String(result.text).slice(0, 5000)}`, 2600, generationOptions);
    parsed = extractJson(result.text);
    if (!orchardAnswerAligned(message, parsed)) throw new Error("阿栗两次回答都没有对准当前问题，请换一种问法后重试");
  }
  if (blackboardIntent === "reference_answer" && (!validBlackboardIdealAnswer(parsed?.ideal_answer)||blackboardHasUncalibratedNumbers(parsed?.ideal_answer,context))) {
    result=await callText(env,`${roomPrompt}\n\n上一版只是提纲、没有完整回答题目，或使用了资料中不存在的硬数字。请重新写一份 350 到 700 字的面试示范回答，必须包含判断、拆解、验证、边界、例子五段，并且每段都直接针对当前题目；删除无依据的百分比、次数和期限，确需举例时明确写成待历史基线校准的示例。上一版：${String(result.text).slice(0,4000)}`,3200,generationOptions);
    parsed=extractJson(result.text);
    parsed.ideal_answer=qualifyBlackboardIllustrativeNumbers(parsed?.ideal_answer||"",context);
    if(!validBlackboardIdealAnswer(parsed?.ideal_answer)||blackboardHasUncalibratedNumbers(parsed?.ideal_answer,context))throw new Error("模型两次都没有生成合格的完整示范回答");
  }
  if (blackboardIntent === "grade_answer") {
    if(stagedBlackboardGrade){
      for(let retryIndex=0;retryIndex<2&&blackboardGradeNeedsRetry(message,context,parsed,true,true);retryIndex+=1){
        console.warn("blackboard-grade-core-invalid",JSON.stringify({attempt:retryIndex+1,...blackboardGradeValidationSummary(message,context,parsed,true,true)}));
        result=await callText(env,`${roomPrompt}\n\n上一版评分阶段未通过校验。仍只返回前述短 JSON，不要生成个性化完整回答或下一题完整答案。逐项复制 rubric 和 reference；每个正分项引用原答案；补齐具体 teaching、大白话步骤和下一步练习。这是第 ${retryIndex+1} 次修复。上一版：${String(result.text).slice(0,3500)}`,3600,generationOptions);
        parsed=normalizeBlackboardGradeCandidate(extractJson(result.text),message,context);
      }
      if(blackboardGradeNeedsRetry(message,context,parsed,true,true)){
        console.warn("blackboard-grade-core-invalid",JSON.stringify({attempt:3,...blackboardGradeValidationSummary(message,context,parsed,true,true)}));
        throw new Error(`评分与教学建议连续三次未通过质量校验：${blackboardGradeValidationCodes(message,context,parsed,true,true)}`);
      }
      const [revision,nextAnswer]=await Promise.all([
        repairBlackboardPersonalizedRevision(env,message,context,parsed),
        generateBlackboardNextIdealAnswer(env,parsed,context)
      ]);
      parsed=revision.parsed;
      parsed.next_question_ideal_answer=nextAnswer.answer;
      result.provider=revision.provider||nextAnswer.provider||result.provider;
    }else{
      if(blackboardRevisionNeedsRepair(message,context,parsed)&&!blackboardGradeNeedsRetry(message,context,parsed,true)){
        try{const repaired=await repairBlackboardPersonalizedRevision(env,message,context,parsed);parsed=repaired.parsed;result.provider=repaired.provider||result.provider;}catch(_error){}
      }
      for(let retryIndex=0;retryIndex<2&&blackboardGradeNeedsRetry(message,context,parsed);retryIndex+=1){
        result = await callText(env, `${roomPrompt}\n\n上一版批改未通过证据或教学质量校验。重新执行：逐项复制 rubric 的 id、criterion 和 max；每个正分项都引用原答案并解释为什么有价值；参考点关系只能使用 covered、partial、equivalent、not_covered、off_track，合理替代论证必须标 equivalent 并正常给分；direction 和 correction_path 必须完整；每个 teaching 都要写出可直接采用的补强或纠正步骤；personalized_revision 必须保留主人原答案中成立的表达和思路，写成包含判断、拆解、验证、边界、例子的完整面试回答，禁止复制 context.ideal_answer；plain_language_coaching 必须完整解释题目要什么、三到五步怎么答、两到五条记什么以及一句口诀；next_question 必须针对薄弱点且不是原题复述，next_question_ideal_answer 必须用判断、拆解、验证、边界、例子五段完整回答新题；删除材料中不存在的精确客户、比例、次数、期限和效果数字，确需示例时明确写“示例阈值，需由历史基线校准”。这是第 ${retryIndex+1} 次定向修复。上一版输出：${String(result.text).slice(0, 5000)}`, 6500, generationOptions);
        parsed = extractJson(result.text);
        parsed=normalizeBlackboardGradeCandidate(parsed,message,context);
        if(blackboardRevisionNeedsRepair(message,context,parsed)&&!blackboardGradeNeedsRetry(message,context,parsed,true)){
          try{const repaired=await repairBlackboardPersonalizedRevision(env,message,context,parsed);parsed=repaired.parsed;result.provider=repaired.provider||result.provider;}catch(_error){}
        }
      }
    }
    if (blackboardGradeNeedsRetry(message, context, parsed)) throw new Error("评分结果连续三次未通过证据与教学质量校验，请稍后重新核分");
  }
  if (blackboardIntent === "grade_answer") parsed = finalizeBlackboardGrade(parsed, context);
  const reply = String(parsed.reply || parsed.summary || result.text);
  let memoryEvent = null;
  const shouldCommit = (room !== "travel" || Boolean(context?.commit)) && blackboardIntent!=="reference_answer";
  if (shouldCommit) {
    const eventContent = String(context?.current_text || context?.latest_entry || message);
    const eventSummary = room === "heart_hollow" ? "树洞对话已封存"
      : room === "travel" ? `旅行感悟：${String(parsed.summary || eventContent).slice(0, 260)}`
      : reply.slice(0, 300);
    [memoryEvent] = await addMemoryEvents(env, {
      id: String(context?.memory_event_id || `mem_${crypto.randomUUID()}`),
      source: room, type: room === "travel" ? "travel_reflection" : "room_conversation",
      content: eventContent, summary: eventSummary,
      layer: room === "travel" || room === "orchard" ? "long" : "short", weight: 2,
      scope: room === "heart_hollow" ? "heart_only" : room === "travel" ? "travel_only" : "record_only",
      room_id: String(context?.trip_id || ""),
      sensitivity: room === "heart_hollow" ? "sealed" : "personal"
    });
  }
  return {
    reply, result: parsed, provider: result.provider, memory_event: memoryEvent,
    memory_usage: {purpose: memoryPurpose, selected_ids: memory.selected_memory_ids || []}
  };
}

async function runAssistantTask(env, taskId, message, context) {
  try {
    const result = await assistantReply(env, message, context);
    const foundItems=Array.isArray(result.found_items)?result.found_items:[];
    const kind=extractUrls(message).length?(/工具箱|加入工具|学术|Claude Science/i.test(message)?"toolbox":"link"):(/资讯|关注|明天|下周|总结|方向|动态|消息|更新/.test(message)?"watch_topic":"task");
    const updatedAt=now();
    const request={
      id:taskId,task_id:taskId,text:message,mode:String(context?.mode||"text"),kind,date:dateInShanghai(),
      reply:String(result.reply||'').slice(0,2000),found_items:foundItems,
      found_item_keys:foundItems.map(noticeItemKeyCloud).filter(Boolean),found_count:foundItems.length,
      found_at:foundItems.length?updatedAt:"",updatedAt
    };
    try {
      await mergeLocalState(env,{changes:{cozy_notice_requests:{type:"array",upserts:[request],deleted:[],revive:[`id:${taskId}`]}}});
    } catch (error) {
      if (!noticeKvWriteLimitExceeded(error) || !await persistNoticeFollowupFallback(env,[request])) throw error;
      result.storage_degraded=true;
      result.storage_fallback="r2";
    }
    await updateTask(env, taskId, {status: "completed", message: result.reply.slice(0, 500), result});
  } catch (error) {
    try {
      await updateTask(env, taskId, {status: "failed", message: String(error.message || error).slice(0, 500)});
    } catch (taskError) {
      console.error("assistant-task-status-persist-failed", String(taskError?.message || taskError));
    }
  }
}

async function logEvents(env, input) {
  const items = (Array.isArray(input.events) ? input.events : [input.event || input]).slice(0, 100).map(raw => ({
    id: String(raw.id || `evt_${crypto.randomUUID()}`).slice(0, 120), ts: String(raw.ts || now()), received_at: now(),
    context: String(raw.context || raw.ctx || "unknown").slice(0, 60), action: String(raw.action || raw.act || "event").slice(0, 100),
    page: String(raw.page || "").slice(0, 300), status: String(raw.status || "").slice(0, 40), task_id: String(raw.task_id || "").slice(0, 100),
    sensitivity: raw.sensitivity === "sealed" ? "sealed" : "personal", detail: raw.detail && typeof raw.detail === "object" ? raw.detail : {}
  }));
  if (env.COZY_PRIVATE) {
    await Promise.all(items.map(item => {
      const key = `ledger/${item.ts.slice(0, 10)}/${item.ts.replaceAll(":", "-")}-${item.id}.json`;
      return env.COZY_PRIVATE.put(key, JSON.stringify(item), {httpMetadata: {contentType: "application/json"}});
    }));
  } else {
    const existing = await readState(env, "ledger:events", []);
    await writeState(env, "ledger:events", [...items, ...existing.filter(old => !items.some(item => item.id === old.id))].slice(0, 1000));
  }
  return items;
}

function weatherScene(code, localTime) {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([45, 48].includes(code)) return "fog";
  if ([95, 96, 99].includes(code)) return "thunder";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([2, 3].includes(code)) return "overcast";
  const hour = Number(String(localTime || "").slice(11, 13));
  return hour >= 5 && hour < 10 ? "morning" : "sunny";
}

function weatherLabel(code) {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "下雪";
  if ([45, 48].includes(code)) return "有雾";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "下雨";
  if ([95, 96, 99].includes(code)) return "雷雨";
  if ([2, 3].includes(code)) return "阴天";
  return code === 1 ? "晴间多云" : "晴天";
}

async function currentWeather(request, env, force = false) {
  const cached = await readState(env, "weather:current", null);
  if (!force && cached && Date.now() - Date.parse(cached.updated_at || 0) < 2 * 60 * 60 * 1000) return {...cached, ok: true, cached: true};
  const cf = request.cf || {};
  const latitude = Number(cf.latitude || 30.2741);
  const longitude = Number(cf.longitude || 120.1551);
  const city = String(cf.city || "杭州");
  try {
    const query = new URLSearchParams({latitude: String(latitude), longitude: String(longitude), current: "weather_code,temperature_2m,is_day", timezone: "auto"});
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const code = Number(current.weather_code || 0);
    const localTime = String(current.time || now());
    const payload = {
      ok: true, cached: false, stale: false, updated_at: now(),
      location: {city, region: String(cf.region || ""), country: String(cf.country || ""), latitude, longitude, timezone: data.timezone || cf.timezone || "Asia/Shanghai"},
      current: {weather_code: code, condition: weatherLabel(code), temperature: current.temperature_2m, temperature_unit: data.current_units?.temperature_2m || "°C", local_time: localTime, is_day: Boolean(current.is_day), scene: weatherScene(code, localTime), timezone: data.timezone || "auto"}
    };
    await writeState(env, "weather:current", payload);
    return payload;
  } catch (error) {
    if (cached) return {...cached, ok: true, cached: true, stale: true, error: String(error.message || error)};
    const localTime = now();
    return {ok: true, fallback: true, location: {city: "杭州", latitude, longitude}, current: {weather_code: 0, condition: "晴天", temperature: null, temperature_unit: "°C", local_time: localTime, is_day: true, scene: weatherScene(0, localTime), timezone: "Asia/Shanghai"}, updated_at: localTime};
  }
}

async function transcribeVoice(request, env) {
  const incoming = await request.formData();
  const file = incoming.get("file");
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("没有收到录音");
  if (file.size > 12 * 1024 * 1024) throw new Error("录音太长，请分段说");
  const audio = await file.arrayBuffer();
  const config = providerConfig(env, "openai");
  let openAiError = "";
  if (config?.key) {
    const form = new FormData();
    form.append("model", env.COZY_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
    form.append("language", "zh");
    form.append("file", new File([audio], file.name || "voice.webm", {type: file.type || "audio/webm"}));
    const response = await fetch(`${String(config.base).replace(/\/+$/, "")}/audio/transcriptions`, {method: "POST", headers: {authorization: `Bearer ${config.key}`}, body: form});
    const data = await response.json().catch(() => ({}));
    if (response.ok) return {ok: true, transcript: String(data.text || "").trim(), provider: "openai"};
    openAiError = data.error?.message || `OpenAI HTTP ${response.status}`;
  }
  if (env.AI) {
    const data = await env.AI.run(env.COZY_TRANSCRIBE_FALLBACK_MODEL || "@cf/openai/whisper", {audio: [...new Uint8Array(audio)]});
    return {ok: true, transcript: String(data?.text || "").trim(), provider: "workers-ai"};
  }
  throw new Error(openAiError || "语音转文字服务尚未配置");
}

async function distillMemory(env) {
  const memory = await memoryState(env, false);
  const cards = memory.cards.filter(item => item.status === "active" && item.sensitivity !== "sealed").slice(0, 120);
  if (!cards.length) throw new Error("还没有经过确认或重复验证的记忆可整理");
  const previousStatus = await readState(env, "memory:distillation", {status: "idle", recent_runs: []});
  const runId = `distill_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const snapshotKey = `memory:profile:snapshot:${runId}`;
  await writeState(env, snapshotKey, {profile: memory.profile || null, saved_at: now()}, {expirationTtl: 60 * 60 * 24 * 90});
  const status = {status: "running", run_id: runId, last_run: now(), provider: textProvider(env), recent_runs: previousStatus.recent_runs || []};
  await writeState(env, "memory:distillation", status);
  try {
    let result = await callText(env, `请增量更新一份给私人 AI 助手使用的中文记忆档案。只能使用下列 status=active 的卡片；候选线索和树洞封存原文没有提供给你，也不得推测。记忆只描述稳定的学习偏好、习惯、长期目标和关注领域，不得把单次行为写成人格结论。返回 JSON：{"summary":"...","sections":[{"title":"偏好与合作方式","text":"...","source_card_ids":["card id"]},{"title":"长期目标与成长方向","text":"...","source_card_ids":["card id"]},{"title":"知识关注","text":"...","source_card_ids":["card id"]}]}。每个非空 section 必须引用至少一个输入 card id。\n旧档案：${JSON.stringify(memory.profile)}\n已确认卡片：${JSON.stringify(cards)}`, 2000, {temperature: 0.1});
    let parsed;
    try { parsed = extractJson(result.text); }
    catch (_error) {
      result = await callText(env, `只修复下面输出的 JSON 语法和缺失闭合，不新增事实，不输出 Markdown：\n${String(result.text).slice(0, 14000)}`, 1800, {temperature: 0});
      parsed = extractJson(result.text);
    }
    const allowedIds = new Set(cards.map(item => item.id));
    const sections = (Array.isArray(parsed.sections) ? parsed.sections : []).slice(0, 8).map(item => ({
      title: String(item.title || "记忆").slice(0, 40), text: String(item.text || "").slice(0, 1800),
      source_card_ids: (Array.isArray(item.source_card_ids) ? item.source_card_ids : []).map(String).filter(id => allowedIds.has(id))
    })).filter(item => item.text && item.source_card_ids.length);
    if (!sections.length || String(parsed.summary || "").trim().length < 8) throw new Error("AI 整理结果缺少可核验的记忆卡片引用，原档案已保留");
    const sourceCardIds = [...new Set(sections.flatMap(item => item.source_card_ids))];
    const profile = {summary: String(parsed.summary || "").slice(0, 800), sections, source_card_ids: sourceCardIds, source_count: sourceCardIds.length, generator: "ai_distillation", generated_at: now()};
    await writeState(env, "memory:profile", profile);
    const run = {id: runId, completed_at: now(), provider: result.provider, snapshot_key: snapshotKey, source_card_ids: sourceCardIds};
    await writeState(env, "memory:distillation", {...status, status: "completed", last_success: now(), last_error: "", provider: result.provider, recent_runs: [run, ...(status.recent_runs || []).filter(item => item.id !== runId)].slice(0, 12)});
    return profile;
  } catch (error) {
    await writeState(env, "memory:distillation", {...status, status: "failed", last_error: String(error.message || error).slice(0, 500)});
    throw error;
  }
}

async function undoMemoryDistillation(env, runId) {
  const status = await readState(env, "memory:distillation", {status: "idle", recent_runs: []});
  const run = (status.recent_runs || []).find(item => item.id === runId);
  if (!run) throw new Error("没有找到这次记忆整理记录");
  const snapshot = await readState(env, run.snapshot_key || `memory:profile:snapshot:${runId}`, null);
  if (!snapshot || typeof snapshot !== "object" || !Object.prototype.hasOwnProperty.call(snapshot, "profile")) throw new Error("这次整理的回退快照已经过期");
  const profile = snapshot.profile;
  await writeState(env, "memory:profile", profile);
  const restored = {...status, status: "restored", restored_run_id: runId, restored_at: now(), last_error: ""};
  await writeState(env, "memory:distillation", restored);
  return {ok: true, profile, distillation: restored};
}

export async function handleRequest(request, env, ctx = {}) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, {status: 204});
  if (request.method === "GET" && url.pathname === "/assets/app/icon-192.png" && env.ASSETS) return env.ASSETS.fetch(request);
  if (request.method === "POST" && url.pathname === "/api/auth/login") return login(request, env);
  const identity = await verifyAccess(request, env);
  if (!identity.allowed) {
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) return loginPage();
    return json({ok: false, error: env.AUTH_MODE === "passcode" ? "需要先输入小院口令" : "需要通过 Cloudflare Access 主人验证"}, 401);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const headers = new Headers(securityHeaders);
    headers.set("set-cookie", "cozy_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
    return new Response(JSON.stringify({ok: true}), {headers});
  }
  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    if (!env.ASSETS) return new Response("Static assets are not configured", {status: 503});
    return env.ASSETS.fetch(request);
  }
  if (env.PUBLIC_READ_ONLY === "true" && env.DEMO_MODE !== "true" && request.method !== "GET") return json({ok: false, error: "公网预览仅供浏览，数据不会写入"}, 403);
  try {
    if (request.method === "GET" && url.pathname === "/api/demo/status") {
      return json({ok: true, demo: env.DEMO_MODE === "true", activation: await demoActivation(env)});
    }
    if (request.method === "GET" && url.pathname === "/api/sync/export") {
      if (!identity.sync && identity.email !== "owner") return json({ok: false, error: "只有主人可以导出云端数据"}, 403);
      return json(await exportCloudState(env));
    }
    if (request.method === "GET" && url.pathname === "/api/backup/status") return json({ok: true, backup: await backupStatus(env)});
    if (request.method === "GET" && url.pathname === "/api/status") {
      const access = env.ALLOW_UNAUTHENTICATED === "true" ? "preview" : "owner";
      return json({ok: true, service: "cloud", provider: textProvider(env) || "none", text_route: textProviders(env), tools: 8, steward_mode: (await permissions(env)).steward_mode, access, demo: env.DEMO_MODE === "true" ? await demoActivation(env) : null, backup: await backupStatus(env), storage: {kv: Boolean(env.COZY_STATE), backup_kv: Boolean(env.COZY_BACKUP), private_r2: Boolean(env.COZY_PRIVATE), media_r2: Boolean(env.COZY_MEDIA)}});
    }
    if (request.method === "GET" && url.pathname === "/api/providers") return json({ok: true, providers: {
      text: Object.fromEntries(["openai", "deepseek", "glm", "qwen"].map(name => [name, {configured: Boolean(providerConfig(env, name)?.key), model: providerConfig(env, name)?.model}])),
      text_route: textProviders(env),
      workers_ai: {configured: Boolean(env.AI), model: env.COZY_WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8"},
      image: {seedream: {configured: Boolean(env.ARK_API_KEY), model: env.COZY_SEEDREAM_MODEL || "doubao-seedream-4-0-250828"}, openai: {configured: Boolean(env.OPENAI_API_KEY), model: env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2"}, nano_banana: {configured: Boolean(env.GEMINI_API_KEY), model: env.COZY_GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image"}},
      video: {seedance: {configured: Boolean(env.ARK_API_KEY), model: env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-mini-260615"}}
    }});
    if (request.method === "GET" && url.pathname === "/api/data") {
      const key = String(url.searchParams.get("key") || "");
      if (!DATA_KEYS.has(key)) return json({ok: false, error: "数据区域不存在"}, 404);
      return json(await readData(env, key));
    }
    if (request.method === "GET" && url.pathname === "/api/weather") return json(await currentWeather(request, env, url.searchParams.get("refresh") === "1"));
    if (request.method === "GET" && url.pathname === "/api/state") return json({ok: true, state: await readData(env, "butler_state")});
    if (request.method === "GET" && url.pathname === "/api/local-state") return json({ok: true, state: await readLocalStateWithNoticeFallback(env)});
    if (request.method === "GET" && url.pathname === "/api/permissions") return json({ok: true, permissions: await permissions(env)});
    if (request.method === "GET" && url.pathname === "/api/memory") return json({ok: true, memory: await memoryState(env, identity.email === "owner" && env.DEMO_MODE !== "true")});
    if (request.method === "GET" && url.pathname === "/api/memory/distillation") return json({ok: true, distillation: await readState(env, "memory:distillation", {status: "idle", recent_runs: []})});
    if (request.method === "GET" && url.pathname === "/api/tasks") return json({ok: true, tasks: await tasks(env)});
    if (request.method === "GET" && url.pathname === "/api/skills") return json({ok: true, skills: {tools: [
      {name: "网页解析", description: "读取网页、生成摘要并归档"}, {name: "栗夹归档", description: "保存长期资料"},
      {name: "关注方向", description: "调整后续资讯关注"}, {name: "媒体来源", description: "维护巡逻信息源"},
      {name: "工具箱", description: "从链接整理工具卡片"}, {name: "记忆整理", description: "维护非封存记忆档案"}
    ], skills: [
      "archive-travel", "coach-blackboard", "companion-dialogue", "grade-blackboard-answer", "curate-news", "curate-photos", "generate-media", "imagegen-assets", "remove-background", "guide-orchard",
      "listen-tree-hollow", "manage-memory", "manage-toolbox", "run-automation"
    ].map(name => ({name, origin: "bundled", status: "installed", kind: "guide", permission: "normal"})),
    can_build: false, health: {ok: true, summary: "云端内置能力已连接"}}});
    if (request.method === "GET" && url.pathname === "/api/automation") {
      const automation = await readState(env, "automation:status", {last_check: "", jobs: {}});
      const notice = automation.jobs?.notice_report;
      if (notice?.status === "running" && Date.now() - Date.parse(automation.last_check || "") > 8 * 60 * 1000) {
        automation.jobs.notice_report = {status: "failed", last_error: now(), message: "上次更新超时，请重新获取资讯"};
      }
      return json({ok: true, automation});
    }
    if (request.method === "GET" && url.pathname === "/api/voice/status") return json({ok: true, active: false, ready: false, phase: "browser_only", transcript: ""});
    if (request.method === "GET" && url.pathname === "/api/blackboard/today") {
      await requireDemoAi(env);
      return json({ok: true, question: await cloudBlackboardQuestion(env, (url.searchParams.get("refresh") || "").slice(0, 32))});
    }
    if (request.method === "GET" && url.pathname === "/api/media/storage") return json({ok: true, storage: await mediaStorageUsage(env)});
    if (request.method === "GET" && url.pathname === "/api/media/tasks") return json({ok: true, task: await loadGenerationTask(env, url.searchParams.get("id"))});
    if (request.method === "GET" && url.pathname === "/api/media/file") {
      if (identity.email === "preview" || env.DEMO_MODE === "true") return json({ok: false, error: "只有主人版可以读取私人媒体"}, 403);
      if (!env.COZY_MEDIA) return new Response("Media storage is not enabled", {status: 503});
      const object = await env.COZY_MEDIA.get(url.searchParams.get("id") || "");
      if (!object) return new Response("Not found", {status: 404});
      const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("cache-control", "private, max-age=3600");
      return new Response(object.body, {headers});
    }
    if (request.method !== "POST") return json({ok: false, error: "接口不存在"}, 404);
    if (url.pathname === "/api/voice/transcribe") {
      if (env.DEMO_MODE === "true") await requireDemoAi(env);
      return json(await transcribeVoice(request, env));
    }
    const input = await request.json();
    if (url.pathname === "/api/demo/activation") {
      if (env.DEMO_MODE !== "true") return json({ok: false, error: "当前不是演示环境"}, 404);
      return json({ok: true, activation: await setDemoActivation(env, input)});
    }
    if (url.pathname === "/api/demo/reset") {
      if (env.DEMO_MODE !== "true") return json({ok: false, error: "当前不是演示环境"}, 404);
      return json(await resetDemoState(env));
    }
    if (url.pathname === "/api/demo/seed") {
      if (env.DEMO_MODE !== "true") return json({ok: false, error: "当前不是演示环境"}, 404);
      return json(await seedDemoState(env));
    }
    if (url.pathname === "/api/sync/import") {
      if (!identity.sync && identity.email !== "owner") return json({ok: false, error: "只有主人可以导入云端数据"}, 403);
      return json(await importCloudState(env, input));
    }
    if (url.pathname === "/api/backup/run") {
      if (!identity.sync && identity.email !== "owner") return json({ok: false, error: "只有主人可以创建备份"}, 403);
      return json({ok: true, backup: await createFullBackup(env, "manual")});
    }
    if (url.pathname === "/api/media/upload") {
      if (identity.email === "preview" || env.DEMO_MODE === "true") return json({ok: false, error: "只有主人版可以永久保存照片"}, 403);
      return json({ok: true, ...await uploadMediaToR2(env, input)});
    }
    if (url.pathname === "/api/travel/photo/delete") {
      if (identity.email === "preview" || env.DEMO_MODE === "true") return json({ok: false, error: "只有主人版可以删除旅行照片"}, 403);
      return json({ok: true, ...await deleteTravelPhoto(env, input)});
    }
    if (url.pathname === "/api/travel/delete") {
      if (identity.email === "preview" || env.DEMO_MODE === "true") return json({ok: false, error: "只有主人版可以删除旅程"}, 403);
      return json({ok: true, ...await deleteTravelTrip(env, input)});
    }
    if (DEMO_AI_PATHS.has(url.pathname)) await requireDemoAi(env);
    if (url.pathname === "/api/data") return json({ok: true, value: await writeData(env, String(input.key || ""), input.value)});
    if (url.pathname === "/api/events") return json({ok: true, items: await logEvents(env, input)});
    if (url.pathname === "/api/local-state") return json({ok: true, state: await mergeLocalState(env, input)});
    if (url.pathname === "/api/state/sync") return json({ok: true, state: await syncButlerState(env, input.state || input)});
    if (url.pathname === "/api/permissions") {
      let value = await permissions(env);
      if (Object.prototype.hasOwnProperty.call(input, "memory_assist_enabled")) value = await setMemoryAssist(env, Boolean(input.memory_assist_enabled));
      if (Object.prototype.hasOwnProperty.call(input, "steward_mode")) value = await setStewardMode(env, Boolean(input.steward_mode));
      return json({ok: true, permissions: value});
    }
    if (url.pathname === "/api/memory/event") return json({ok: true, item: (await addMemoryEvents(env, input.event || input))[0]});
    if (url.pathname === "/api/memory/sync") return json({ok: true, items: await addMemoryEvents(env, input.events || [])});
    if (url.pathname === "/api/memory/action") return json(await memoryAction(env, input));
    if (url.pathname === "/api/memory/distill") return json({ok: true, started: true, summary: "阿栗已整理记忆档案", profile: await distillMemory(env)});
    if (url.pathname === "/api/memory/distill/undo") return json(await undoMemoryDistillation(env, String(input.run_id || "")));
    if (url.pathname === "/api/tasks/undo") return json({ok: false, error: "公网版不能直接回滚代码文件；系统修改需要在部署环境执行并重新发布"}, 501);
    if (url.pathname === "/api/assistant") {
      const message = String(input.message || "").trim(); if (!message) throw new Error("留言不能为空");
      const result = await assistantReply(env, message, input.context || {});
      return json({ok: true, ...result});
    }
    if (url.pathname === "/api/assistant/start") {
      const message = String(input.message || "").trim(); if (!message) throw new Error("留言不能为空");
      const task = await saveTask(env, {id: `task_${crypto.randomUUID().slice(0, 12)}`, kind: "notice_request", title: message.slice(0, 100), instruction: message, source: "noticeboard", status: "running", message: "阿栗正在读取公告板、栗夹和记忆档案", started_at: now()});
      const pending = runAssistantTask(env, task.id, message, input.context || {});
      if (ctx.waitUntil) ctx.waitUntil(pending); else await pending;
      return json({ok: true, task, task_id: task.id}, 202);
    }
    if (url.pathname === "/api/room") {
      const message = String(input.message || "").trim(); if (!message) throw new Error("内容不能为空");
      return json({ok: true, ...await roomReply(env, String(input.room || ""), message, input.context || {})});
    }
    if (url.pathname === "/api/parse") {
      const item = await parseUrl(env, String(input.url || ""), String(input.instruction || ""));
      const state = await appendButlerItem(env, "chest", item);
      return json({ok: true, item, state, provider: textProvider(env) || "extractor"});
    }
    if (url.pathname === "/api/toolbox/import") {
      const tool = await importToolCard(env, String(input.url || ""), String(input.instruction || ""), input.source || {});
      const state = await appendButlerItem(env, "toolbox", tool);
      return json({ok: true, summary: `已加入工具箱：${tool.title}`, item: tool, state});
    }
    if (url.pathname === "/api/toolbox/refresh-price") {
      let tool;
      try { tool = await refreshToolPriceCloud(env, input.tool); }
      catch (_error) {
        const original = input.tool && typeof input.tool === "object" ? input.tool : {};
        const source = original.price_url || original.pricing?.source_url || "";
        tool = {...original, type: "toolbox", pricing: {summary: "", currency: "", items: [], checked_at: "", source_url: source, status: "unavailable", note: ""}};
      }
      const state = await appendButlerItem(env, "toolbox", tool);
      return json({ok: true, item: tool, state});
    }
    if (url.pathname === "/api/weekly/run") {
      await writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"running",message:"阿栗正在巡逻近期资讯"}}});
      try {
        const report=await runCloudReport(env,Boolean(input.force));
        return json({ok:true,accepted:false,status:"completed",report});
      } catch(error) {
        await writeNoticeStatus(env,{last_check:now(),jobs:{notice_report:{status:"failed",last_error:now(),message:String(error.message||error).slice(0,300)}}});
        throw error;
      }
    }
    if (url.pathname === "/api/voice/start" || url.pathname === "/api/voice/stop") return json({ok: false, error: "云端使用浏览器语音识别，不启用本机语音服务"}, 501);
    if (url.pathname === "/api/media/generate") {
      const task = input.kind === "video" ? await createVideo(env, input) : await generateImage(env, input);
      return json({ok: true, task}, input.kind === "video" ? 202 : 200);
    }
    if (url.pathname === "/api/media/task/refresh") return json({ok: true, task: await refreshVideo(env, input.id)});
    return json({ok: false, error: "接口不存在"}, 404);
  } catch (error) {
    return json({ok: false, error: String(error.message || error).slice(0, 600)}, Number(error.status || 500));
  }
}

export async function scheduled(_event, env, ctx) {
  const job = (async () => {
    const status = {last_check: now(), jobs: {weather: {status: "cached_for_two_hours"}, memory: {status: "available"}, notice_report: {status: "running", message: "阿栗正在巡逻近期资讯"}}};
    await writeNoticeStatus(env,status);
    try {
      const report = await runCloudReport(env, false);
      status.jobs.notice_report = report.unchanged
        ? {status: "completed", last_success: now(), unchanged: true, degraded:Boolean(report.degraded), message: report.degraded?`资讯源暂时不可用，已保留 ${report.report_count || 0} 版巡报，稍后自动重试`:`已检查，暂无新资讯；保留 ${report.report_count || 0} 版巡报`}
        : {status: "completed", last_success: now(), message: `巡报已准备：${report.focus_title}`};
    } catch (error) {
      status.jobs.notice_report = {status: "failed", last_error: now(), message: String(error.message || error).slice(0, 300)};
    }
    if (env.COZY_PRIVATE || env.COZY_BACKUP) {
      try { await createFullBackup(env, "scheduled"); }
      catch (_error) {}
    }
    await writeNoticeStatus(env,status);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
}

export default {fetch: handleRequest, scheduled};
