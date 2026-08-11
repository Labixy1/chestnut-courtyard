import {
  DATA_KEYS, addMemoryEvents, appendButlerItem, backupStatus, exportCloudState, importCloudState,
  memoryAction, memoryContext, memoryState, mergeLocalState, permissions, readData, readState,
  resetDemoState, saveTask, seedDemoState, setStewardMode, syncButlerState, tasks,
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

async function callText(env, prompt, maxTokens = 1600) {
  const providers = textProviders(env);
  if (!providers.length) throw new Error("还没有配置在线文本模型 API Key");
  const failures = [];
  for (const provider of providers) {
    try {
      return await callTextProvider(env, provider, prompt, maxTokens);
    } catch (error) {
      failures.push(`${provider}: ${String(error?.message || error)}`);
    }
  }
  throw new Error(`文本模型均不可用：${failures.join("；")}`);
}

async function callTextProvider(env, provider, prompt, maxTokens = 1600) {
  if (provider === "workers-ai") {
    const model = env.COZY_WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8";
    const payload = await env.AI.run(model, {messages: [{role: "user", content: prompt}], temperature: 0.4, max_tokens: maxTokens});
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
  const payload = await providerRequest(env, provider, "/chat/completions", {
    model: config.model, messages: [{role: "user", content: prompt}], temperature: 0.4, max_tokens: maxTokens
  });
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
  const ignored = new Set(["what", "why", "how", "which", "help", "about"]);
  const anchors = [...new Set((String(message).match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []).map(value => value.toLowerCase()).filter(value => !ignored.has(value)))];
  const answer = `${focus}\n${reply}`.toLowerCase();
  return anchors.every(anchor => answer.includes(anchor));
}

function blackboardGradeNeedsRetry(message, context, parsed) {
  const scores = Array.isArray(parsed?.score_breakdown) ? parsed.score_breakdown : [];
  if (scores.length < 4) return true;
  const answer = String(message || "").replace(/\s+/g, "");
  const emptyAnswer = answer.length < 12 && /^(不会|好难|不知道|不懂|不会做|答不出|没思路|太难了|不会好难)+$/.test(answer.replace(/[，。！？,.!?~～…]/g, ""));
  if (emptyAnswer) return false;
  const awarded = scores.reduce((sum, item) => sum + Math.max(0, Number(item?.awarded) || 0), 0);
  const reasons = `${parsed?.score_summary || ""} ${(parsed?.diagnosis || []).join(" ")} ${scores.map(item => item?.reason || "").join(" ")}`;
  const generalScenario = /假设|如何设计|你会如何|方案|机制|流程/.test(String(context?.question || ""));
  const wronglyRequiresProduct = /没有提供.{0,6}产品信息|缺乏.{0,6}产品信息|产品信息不足|无法评估/.test(reasons);
  return awarded === 0 && (generalScenario || wronglyRequiresProduct);
}

function dateInShanghai(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", {timeZone: "Asia/Shanghai"});
}

function validCloudBlackboardQuestion(item, date) {
  if (!item || item.date !== date || String(item.question || "").trim().length < 18) return false;
  const points = Array.isArray(item.standard_points) ? item.standard_points.map(value => String(value).trim()).filter(Boolean) : [];
  if (points.length < 4 || points.some(value => value.length < 8)) return false;
  return !points.some(value => /^\d*\s*到?\s*\d*\s*条?\s*(参考答案)?要点[。.]?$/.test(value));
}

function fallbackCloudBlackboardQuestion(date, variant, reports) {
  const topics = [
    ["失败恢复设计", "一个 AI 助手执行多步骤任务时，怎样设计进度、重试、人工接管和结果核验，避免用户只看到无限等待？"],
    ["记忆边界设计", "如果你负责长期陪伴型 AI，怎样决定哪些内容可以自动记住、哪些需要确认、哪些必须封存或彻底遗忘？"],
    ["评测集设计", "准备上线一个 AI 搜索功能时，你会怎样设计正常、边界、对抗和失败样例，并用哪些指标决定是否上线？"],
    ["Agent 权限", "当 AI 可以修改用户数据时，你会怎样划分权限等级、确认时机、审计记录和失败回滚？"],
    ["原型验证", "只有三天验证一个 AI 产品想法时，你会做什么最小原型、选择哪些真实用户任务，并依据什么信号继续或停止？"],
    ["模型路由", "面对质量、速度和成本不同的多个模型，你会怎样按任务风险设计路由、兜底和降级提示？"],
    ["信息可信度", "一个资讯整理 AI 怎样区分事实、来源摘要和模型判断，并在来源冲突或全部失败时向用户表达？"],
    ["人工接管", "在客服 Agent 中，哪些信号应触发人工接管，怎样交接上下文，并如何衡量接管机制是否有效？"],
    ["多端同步", "一个同时在手机和电脑使用的个人 AI 产品，怎样处理离线修改、并发冲突、删除防复活和媒体文件同步？"],
    ["商业验证", "一个 AI 功能调用成本较高时，你会怎样验证用户价值、付费意愿和单位经济模型，而不是只看使用次数？"]
  ];
  const seed = [...`${date}|${variant}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const [title, question] = topics[seed % topics.length];
  const latest = (reports?.reports || [])[0];
  const source = [...(latest?.hot_items || []), ...(latest?.sections || []).flatMap(section => section.items || [])][0];
  return {
    id: `cloud-${date}-${variant || "daily"}`, date, title, type: "产品场景",
    types: ["产品场景", "方法设计", "边界判断"], question,
    materials: source?.title ? [`近期资讯：${String(source.title).slice(0, 160)}`] : [],
    standard: [
      "先明确目标用户、具体任务、成功标准和不可接受的风险。",
      "把方案拆成输入、执行、反馈、异常处理和人工接管环节。",
      "为关键环节设置可观察指标，并说明数据如何采集和比较。",
      "覆盖边界与失败情况，明确什么时候不应继续自动执行。",
      "先用小范围真实任务验证核心假设，再依据结果决定是否扩大。"
    ],
    provider: "deterministic-fallback"
  };
}

async function cloudBlackboardQuestion(env, variant = "") {
  const date = dateInShanghai();
  const cacheKey = `blackboard:question:${date}${variant ? `:${variant}` : ""}`;
  const cached = await readState(env, cacheKey, null);
  if (validCloudBlackboardQuestion(cached, date)) return cached;
  const [reports, local, memory] = await Promise.all([
    readData(env, "notice_reports"), readData(env, "local_state"), memoryContext(env)
  ]);
  const directions = Array.isArray(local?.values?.cozy_blackboard_directions) ? local.values.cozy_blackboard_directions.slice(0, 8) : [];
  const answers = Array.isArray(local?.values?.cozy_blackboard_answers) ? local.values.cozy_blackboard_answers.slice(0, 6) : [];
  const prompt = `你是栗壳小院的产品黑板出题人。生成一道今天的开放问答题，训练 AI 产品经理的真实判断力。
必须只返回 JSON：{"title":"10字内题名","question":"明确题目","types":["题型"],"materials":["最多2条具体资料"],"standard_points":["4到6条参考要点"]}。
题型要在基础理论、产品场景、模型能力、评测、Agent、记忆系统、安全权限、原型与工作流、时事判断之间轮换。主人留言的方向只是参考，不能长期垄断出题。标准要点需要可操作、可举例，但不得编造主人经历。
日期：${date}
出题方向留言：${JSON.stringify(directions)}
最近答案：${JSON.stringify(answers).slice(0, 5000)}
近期巡报：${JSON.stringify((reports.reports || []).slice(0, 2)).slice(0, 9000)}
相关记忆：${JSON.stringify(memory).slice(0, 5000)}`;
  const finalPrompt = prompt + (variant ? `\n这是同一天的换题请求（编号 ${variant}）。必须避开最近答案中已有题目的核心问题，换一个训练方向。` : "");
  let question;
  try {
    const result = await callText(env, finalPrompt, 1400);
    const parsed = extractJson(result.text);
    const points = Array.isArray(parsed.standard_points) ? parsed.standard_points.slice(0, 7).map(String) : [];
    question = {
      id: `cloud-${date}-${variant || "daily"}`, date, title: String(parsed.title || "今天的产品判断").slice(0, 40),
      type: String((parsed.types || ["产品场景"])[0] || "产品场景"),
      types: (parsed.types || ["产品场景"]).slice(0, 4), question: String(parsed.question || "").slice(0, 2000),
      materials: (parsed.materials || []).slice(0, 2).map(String),
      standard: points, standard_points: points, provider: result.provider
    };
    if (!validCloudBlackboardQuestion(question, date)) throw new Error("模型生成的题目结构不完整");
  } catch (_error) {
    question = fallbackCloudBlackboardQuestion(date, variant, reports);
    question.standard_points = question.standard;
  }
  await writeState(env, cacheKey, question, {expirationTtl: 60 * 60 * 24 * 45});
  return question;
}

function rssText(value) {
  return cleanHtml(String(value || "").replace(/<!\[CDATA\[|\]\]>/g, " "));
}

async function fetchNewsRss(query) {
  const endpoint = `https://news.google.com/rss/search?${new URLSearchParams({q: query, hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans"})}`;
  const response = await fetch(endpoint, {headers: {"user-agent": "ChestnutCourtyard/1.0"}});
  if (!response.ok) throw new Error(`资讯源返回 HTTP ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 18).map((match, index) => {
    const body = match[1];
    const field = tag => rssText(body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]);
    const sourceMatch = body.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    return {id: `${query.slice(0, 12)}-${index}`, title: field("title"), link: field("link"), published_at: field("pubDate"),
      media: rssText(sourceMatch?.[2] || "Google News"), source_url: sourceMatch?.[1] || "", summary: field("description")};
  }).filter(item => item.title && item.link);
}

async function runCloudReport(env, force = false) {
  const reportsData = await readData(env, "notice_reports");
  const butlerState = await readData(env, "butler_state");
  const watchTopics = (butlerState.watch_topics || []).map(item => String(item.text || item.title || "").trim()).filter(Boolean).slice(0, 8);
  const latest = (reportsData.reports || [])[0];
  if (!force && latest?.generated_at && Date.now() - Date.parse(latest.generated_at) < 46 * 60 * 60 * 1000) {
    return {...latest, unchanged: true, report_count: (reportsData.reports || []).length};
  }
  const queries = [
    '(OpenAI OR Anthropic OR Google Gemini OR Claude) AI when:3d',
    '(DeepSeek OR Kimi OR 通义千问 OR 豆包 OR Seedance OR Seedream) when:3d',
    '(AI 产品 原型 OR Agent 评测 OR 记忆系统 OR AI 工作流) when:7d',
    ...watchTopics.map(topic => `${topic.replace(/[()"']/g, " ").slice(0, 80)} when:7d`)
  ];
  const settled = await Promise.allSettled(queries.map(fetchNewsRss));
  const fulfilled = settled.filter(item => item.status === "fulfilled");
  if (!fulfilled.length) {
    const reasons = settled.map(item => item.status === "rejected" ? String(item.reason?.message || item.reason || "连接失败") : "").filter(Boolean);
    throw new Error(`资讯源全部连接失败：${[...new Set(reasons)].join("；").slice(0, 260)}`);
  }
  const articleKeys = item => {
    const keys = new Set();
    const title = String(item?.title || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
    if (title.length >= 8) keys.add(`title:${title}`);
    try {
      const parsed = new URL(String(item?.link || item?.url || ""));
      [...parsed.searchParams.keys()].forEach(key => { if (key.toLowerCase().startsWith("utm_") || ["from", "source", "ref", "spm"].includes(key.toLowerCase())) parsed.searchParams.delete(key); });
      parsed.hash = ""; parsed.pathname = parsed.pathname.replace(/\/$/, "");
      keys.add(`url:${parsed.toString()}`);
    } catch (_error) {}
    return keys;
  };
  const previousKeys = new Set();
  (reportsData.reports || []).forEach(report => [...(report.hot_items || []), ...(report.sections || []).flatMap(section => section.items || [])].forEach(item => articleKeys(item).forEach(key => previousKeys.add(key))));
  const pool = fulfilled.flatMap(item => item.value).filter(item => ![...articleKeys(item)].some(key => previousKeys.has(key))).slice(0, 45);
  if (!pool.length) {
    const reportCount=(reportsData.reports || []).length;
    const message=`已检查，暂无新资讯；保留 ${reportCount} 版巡报`;
    await writeState(env, "automation:status", {last_check: now(), jobs: {notice_report: {status: "completed", last_success: now(), unchanged: true, message}}});
    return {...(latest || {focus_title: "暂无新资讯"}), unchanged: true, report_count: reportCount};
  }
  const prompt = `你是阿栗，负责为 AI 产品经理整理一次“资讯巡报”。从候选中只挑真正重要、具体、多样的 7 到 11 条，不要为了凑数收录普通软文。
只返回 JSON：{"focus_title":"本期最重要变化","hot_items":[{"source_id":"候选id","category":"模型与技术","original_summary":"基于标题与已有摘要的忠实短摘要","ai_summary":"120到200字，说明具体变化、关键数字或能力、值得关注的结论"}],"sections":[{"name":"国内外动态","items":[同结构]},{"name":"产品相关动态","items":[同结构]},{"name":"主人关注","items":[同结构]}],"insights":["跨文章案例总结"],"advice":["给正在做AI产品的主人一个有深度且可执行的建议"]}。
热点速览只放行业级重要发布；国内外动态兼顾 OpenAI、Anthropic、Google 与国内 DeepSeek、Kimi、通义、豆包；产品相关动态只放评测、记忆、Agent、原型、工作流等真正能提升产品能力的案例。分类只用模型与技术、产品与实践、行业动态、学术研究。不得编造候选中没有的价格、指标和事实。
主人关注方向：${JSON.stringify(watchTopics)}。只有候选中确实有直接相关内容时才增加“主人关注”栏目；没有匹配内容就不要生成该栏目，不能拿普通 AI 新闻凑数。
候选：${JSON.stringify(pool).slice(0, 30000)}`;
  const result = await callText(env, prompt, 3600);
  const curated = extractJson(result.text);
  const byId = new Map(pool.map(item => [item.id, item]));
  const hydrate = raw => {
    const source = byId.get(String(raw?.source_id || ""));
    if (!source) return null;
    return {...source, category: String(raw.category || categoryForArticle(source.title)),
      original_summary: String(raw.original_summary || source.summary || source.title).slice(0, 600),
      summary: String(raw.original_summary || source.summary || source.title).slice(0, 600),
      ai_summary: String(raw.ai_summary || "").slice(0, 1200)};
  };
  const hotItems = (curated.hot_items || []).map(hydrate).filter(Boolean).slice(0, 4);
  const sections = (curated.sections || []).slice(0, 3).map(section => ({name: String(section.name || "动态"), items: (section.items || []).map(hydrate).filter(Boolean).slice(0, 5)})).filter(section => section.items.length);
  if (!hotItems.length && !sections.length) throw new Error("模型没有选出可用资讯");
  const report = {id: `report_${Date.now()}`, generated_at: now(), week_start: dateInShanghai(-6), week_end: dateInShanghai(),
    focus_title: String(curated.focus_title || hotItems[0]?.title || "近期 AI 进展").slice(0, 120), hot_items: hotItems, sections,
    insights: (curated.insights || []).slice(0, 5).map(String), advice: (curated.advice || []).slice(0, 5).map(String), provider: result.provider};
  const next = {version: 1, updated_at: now(), reports: [report, ...(reportsData.reports || []).filter(item => item.id !== report.id)].slice(0, 30)};
  await writeData(env, "notice_reports", next);
  await writeState(env, "automation:status", {last_check: now(), jobs: {notice_report: {status: "completed", last_success: now(), message: "新的资讯巡报已生成"}}});
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

async function storeRemoteMedia(env, task, url, extension) {
  if (!env.COZY_MEDIA) return [{url, temporary: true}];
  const response = await fetch(url);
  if (!response.ok) throw new Error(`生成文件下载失败（HTTP ${response.status}）`);
  const key = `generated/${task.kind}/${task.id}.${extension}`;
  await env.COZY_MEDIA.put(key, response.body, {httpMetadata: {contentType: response.headers.get("content-type") || undefined}});
  return [{key, url: `/api/media/file?id=${encodeURIComponent(key)}`}];
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
      payload = await providerRequest(env, "ark", "/images/generations", {
        model: input.model || env.COZY_SEEDREAM_MODEL || "doubao-seedream-4-0-250828",
        prompt: task.prompt, image: input.images || undefined, size: input.size || "2K",
        output_format: input.output_format || "png", response_format: "url", watermark: Boolean(input.watermark)
      });
    } else if (provider === "openai" || provider === "gpt-image") {
      payload = await providerRequest(env, "openai", "/images/generations", {
        model: input.model || env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2", prompt: task.prompt,
        size: input.size || "1536x1024", quality: input.quality || "high", output_format: input.output_format || "png", n: Number(input.count || 1)
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
    for (const item of (payload.data || []).slice(0, 4)) {
      if (item.url) outputs.push(...await storeRemoteMedia(env, task, item.url, input.output_format || "png"));
      else if (item.b64_json && env.COZY_MEDIA) {
        const bytes = Uint8Array.from(atob(item.b64_json), char => char.charCodeAt(0));
        const key = `generated/image/${task.id}-${outputs.length + 1}.${input.output_format || "png"}`;
        await env.COZY_MEDIA.put(key, bytes, {httpMetadata: {contentType: `image/${input.output_format || "png"}`}});
        outputs.push({key, url: `/api/media/file?id=${encodeURIComponent(key)}`});
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
      generate_audio: Boolean(input.generate_audio), ratio: input.ratio || "16:9", resolution: input.resolution || "720p",
      duration: Math.min(Math.max(Number(input.duration || 5), 3), 30), watermark: Boolean(input.watermark)
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
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
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
  const memory = await memoryContext(env);
  const courtyard = await readData(env, "butler_state");
  const completed = toolResults.filter(item => item.ok).map(item => item.summary);
  await addMemoryEvents(env, {source: "butler", type: "owner_command", layer: "short", weight: 2, content: message, summary: `交给阿栗：${message.slice(0, 120)}`});
  if (completed.length && !/[？?]|怎么|为什么|分析|解释|建议/.test(message)) {
    const failed = toolResults.filter(item => !item.ok).map(item => item.summary);
    return {reply: `已经完成：${completed.join("；")}。${failed.length ? `还有一项没有完成：${failed.join("；")}。` : ""}`, provider: "tools-only", tool_results: toolResults};
  }
  if (!textProvider(env)) {
    if (completed.length) return {reply: `已经完成：${completed.join("；")}。`, provider: "tools-only", tool_results: toolResults};
    throw new Error("阿栗的云端运行已就绪，但还没有配置文本模型 API Key");
  }
  const prompt = `你是栗壳小院的管家阿栗，一只守护私人小院的棕色小狗管家。你温和、清醒、行动优先，回复简洁但不敷衍。\n规则：\n1. 只把工具结果中 ok=true 的动作说成已经完成；失败要明确说明。\n2. 不得假装访问网页、知识库、文件或执行工具。\n3. 当前指令优先于历史偏好。普通回答只能使用非封存记忆，绝不猜测密阁内容。\n4. 回答主人问题时给出具体判断和下一步，不写空泛套话。\n\n主人当前消息：${message.slice(0, 6000)}\n页面上下文：${JSON.stringify(clientContext).slice(0, 5000)}\n非封存记忆：${JSON.stringify(memory).slice(0, 7000)}\n小院资料状态：${JSON.stringify({watch_topics: courtyard.watch_topics, sources: courtyard.sources, categories: courtyard.custom_categories}).slice(0, 3000)}\n已执行工具结果：${JSON.stringify(toolResults).slice(0, 6000)}\n请直接回复主人。`;
  try {
    const result = await callText(env, prompt);
    return {reply: result.text, provider: result.provider, tool_results: toolResults};
  } catch (error) {
    if (completed.length) return {reply: `已经完成：${completed.join("；")}。模型总结暂时没有返回，但执行结果已经保存。`, provider: "tools-only", tool_results: toolResults, model_error: String(error.message || error).slice(0, 200)};
    throw error;
  }
}

async function roomReply(env, room, message, context) {
  const roomPrompts = {
    heart_hollow: "这里是树洞。若 mode 是 oracle，请在主人完整倾诉后给一句像塔罗牌但不故弄玄虚的回应；若 mode 是 dialogue，就自然来回对话。不要强行围绕树，不急着安慰。",
    orchard: `这里是成长田的“问问阿栗”，这是一个认真解惑和学习的多轮对话，不是树洞、签语或成长鸡汤。
回答规则：
1. 当前“主人”消息是唯一主任务，必须准确回答它所问的对象和问题，不能擅自换题。
2. context.conversation 仅用于理解“它、这个、上面那个”等追问指代；若当前问题已经完整明确，以当前问题为准。旧对话不得盖过当前问题。
3. context.knowledge_topics 仅用于回答完成后决定归入哪个专题，不能用旧专题内容替代答案。相关非封存记忆也只能提供稳定偏好，和问题无关时必须忽略。
4. 先给明确结论，再用2到4个清晰要点解释原因、差异、步骤或适用场景；必要时给一个具体例子。不得只复述问题，不得只提问，不得泛泛安慰。
5. 用户问事实、产品或技术时，回答具体机制和边界；不确定、可能过时或未经联网核验的信息必须明确标注，不能编造。
6. 只有确实缺少关键条件、无法合理作答时，才在已经给出当前可答部分后追问最多一个问题。
7. 禁止田野隐喻、诗意散文、玄学签语和强制安排“几天内实验”。下一步没有实际帮助时留空。`,
    travel: "这里是旅行记录。帮助主人提炼具体旅行感悟，保留地点、事件和变化，不写旅游宣传语。",
    blackboard: "这里是产品黑板。围绕题目逐点评改，区分主人答案、标准答案和具体改进建议。"
  };
  const guide = roomPrompts[room] || "根据当前房间和上下文直接回应。";
  const formats = {
    blackboard: String(context?.intent || "grade_answer") === "question_helper"
      ? '只返回 JSON：{"reply":"80到180字、直接关联当前题目和用户追问的背景解释","material":"用户问：问题；阿栗补充：可独立阅读的答案摘要"}。可使用模型通用知识补足背景；最新归属、版本、价格和指标未联网核验时必须明确标注。不得泄露标准答案或代写方案。'
      : '只返回 JSON：{"score_breakdown":[{"criterion":"问题理解","max":25,"awarded":0到25的整数,"reason":"先引用原答案中的具体证据，再说明覆盖和缺失"},{"criterion":"方案完整","max":25,"awarded":0到25的整数,"reason":"先引用原答案中的具体证据，再说明覆盖和缺失"},{"criterion":"验证与指标","max":25,"awarded":0到25的整数,"reason":"先引用原答案中的具体证据，再说明覆盖和缺失"},{"criterion":"风险与回滚","max":25,"awarded":0到25的整数,"reason":"先引用原答案中的具体证据，再说明覆盖和缺失"}],"score_summary":"一句总评，不写总分","diagnosis":["逐点写已覆盖与遗漏"],"polished_answer":"按判断、拆解、验证、边界、例子五段输出的完整回答","standard_points":["4到7条互不重复、直接回答题目的参考要点"],"suggestions":["具体修改建议"],"thinking_directions":["思考方向"],"next_question":"下一步练习"}。评分对象是主人提交的答案，不是题目背景资料。必须根据原答案实际写出的观点给予部分分，不能因为答案简短就全部0分。题目若是“假设你负责某类产品”或要求设计通用机制，不得要求主人补充具体产品名称、公司资料或未在题目中给出的信息。只有“不会、好难、不知道”等没有任何观点的答案才四项全部0分；非空但答偏的答案也要引用其内容解释为什么低分。standard_points 必须去重，并覆盖题目要求的机制、执行、验证和风险闭环。polished_answer 严格使用“判断：”“拆解：1...2...3...”“验证：”“边界：”“例子：”并换行。',
    orchard: '只返回合法 JSON，不要 Markdown 代码围栏：{"reply":"直接回答当前问题的完整中文回复，通常180到500字；结论优先，分段或编号清楚，问题简单时可以更短","answer_focus":"20到50字概括本轮实际回答的问题，用于检查是否答偏","seed_summary":"本轮关注点的简短概括","key_insight":"一句可独立复习的核心判断","next_step":"一个确实有帮助的后续验证或学习动作，没有必要则留空","knowledge_topic":{"match_id":"能归入 context.knowledge_topics 中现有专题时必须填写其id，否则留空","title":"稳定且可扩展的专题名，不要把一次问题或单个产品机械建成一类","category":"优先复用现有分类，确实不同才新建","entities":["本轮实际涉及的产品、组织或概念"],"summary":"融合本轮正确答案与已有专题后的可复习摘要","knowledge_points":["3到7条具体事实、差异、方法或判断"],"comparison_rows":[{"item":"比较对象","traits":"主要特点","scenarios":"适用场景","considerations":"限制或注意点"}],"scenarios":["实际应用场景"],"conclusion":"专题当前结论"}}。reply 必须独立完整，即使后面的专题整理字段全部删掉也能直接解决用户问题。',
    heart_hollow: String(context?.mode || "oracle") === "dialogue"
      ? '只返回 JSON：{"reply":"自然的对话回应","mode":"dialogue","growth_signal":{"should_grow":true或false,"title":"不含原话和私密细节的成长主题","hint":"正在形成的判断或变化","nourishment":1到3}}。只有具体经历或可持续成长线索才生长；短促情绪、试音、重复句为 false。成长信号不得包含人物、公司、地点等私密细节。'
      : '只返回 JSON：{"reply":"18到45字、回应具体内容的一句签语","mode":"oracle","growth_signal":{"should_grow":true或false,"title":"不含原话和私密细节的成长主题","hint":"正在形成的判断或变化","nourishment":1到3}}。只有具体经历或可持续成长线索才生长；短促情绪、试音、重复句为 false。成长信号不得包含人物、公司、地点等私密细节。',
    travel: '只返回 JSON：{"summary":"120字内旅行感悟摘要","title":"简短名称"}'
  };
  const memory = await memoryContext(env);
  const answerMemory = room === "orchard" ? {note: "成长田回答阶段不注入全局记忆，避免其他模块内容干扰当前问题"} : memory;
  const roomPrompt = `${guide}\n${formats[room] || "请直接回应。"}\n不得编造主人没有说过的经历。\n房间：${room}\n当前主人问题（最高优先级）：${message.slice(0, 8000)}\n辅助上下文（只用于指代消解和归档）：${JSON.stringify(context).slice(0, 7000)}\n相关非封存记忆（无关内容必须忽略）：${JSON.stringify(answerMemory).slice(0, 5000)}`;
  let result = await callText(env, roomPrompt, room === "orchard" ? 2600 : 1800);
  let parsed;
  try { parsed = extractJson(result.text); } catch (_error) { parsed = {reply: result.text}; }
  if (room === "orchard" && !orchardAnswerAligned(message, parsed)) {
    result = await callText(env, `${roomPrompt}\n\n上一版输出没有准确对齐当前问题，禁止沿用其中无关内容。请重新阅读“当前主人问题”，确保 answer_focus 准确概括该问题，reply 明确提到问题中的产品、组织或概念并直接作答。上一版输出：${String(result.text).slice(0, 5000)}`, 2600);
    parsed = extractJson(result.text);
    if (!orchardAnswerAligned(message, parsed)) throw new Error("阿栗两次回答都没有对准当前问题，请换一种问法后重试");
  }
  if (room === "blackboard" && String(context?.intent || "grade_answer") === "grade_answer" && blackboardGradeNeedsRetry(message, context, parsed)) {
    result = await callText(env, `${roomPrompt}\n\n上一版评分错误地把题目背景不足当成主人没有作答，或对非空答案无证据地给了0分。请重新评分：逐项引用主人原答案中的具体词句，承认已覆盖内容，再扣除缺失项。通用假设题不得索要具体产品信息。上一版输出：${String(result.text).slice(0, 5000)}`, 2200);
    parsed = extractJson(result.text);
    if (blackboardGradeNeedsRetry(message, context, parsed)) throw new Error("评分结果仍缺少对原答案的有效依据，请稍后重新核分");
  }
  const reply = String(parsed.reply || parsed.summary || result.text);
  await addMemoryEvents(env, {
    source: room, type: "room_conversation", content: message, summary: reply.slice(0, 300),
    layer: room === "travel" || room === "orchard" ? "long" : "short", weight: 2,
    sensitivity: room === "heart_hollow" ? "sealed" : "personal"
  });
  return {reply, result: parsed, provider: result.provider};
}

async function runAssistantTask(env, taskId, message, context) {
  try {
    const result = await assistantReply(env, message, context);
    await updateTask(env, taskId, {status: "completed", message: result.reply.slice(0, 500), result});
  } catch (error) {
    await updateTask(env, taskId, {status: "failed", message: String(error.message || error).slice(0, 500)});
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
  const events = memory.events.slice(0, 120);
  if (!events.length) throw new Error("还没有足够的非封存记忆可整理");
  const status = {status: "running", last_run: now(), provider: textProvider(env), recent_runs: []};
  await writeState(env, "memory:distillation", status);
  try {
    let result = await callText(env, `请增量更新一份给私人AI助手使用的中文记忆档案。输入包含旧档案和新近非封存行为；保留仍有效的稳定偏好、长期目标、关注领域、合作方式，纠正冲突信息，不写逐条流水，不推断敏感身份。返回 JSON：{"summary":"...","sections":[{"title":"偏好与合作方式","text":"..."},{"title":"长期目标与成长方向","text":"..."},{"title":"知识关注","text":"..."}]}。\n旧档案：${JSON.stringify(memory.profile)}\n新近行为：${JSON.stringify(events)}`, 1800);
    let parsed;
    try { parsed = extractJson(result.text); }
    catch (_error) {
      result = await callText(env, `只修复下面输出的 JSON 语法和缺失闭合，不新增事实，不输出 Markdown：\n${String(result.text).slice(0, 14000)}`, 1800);
      parsed = extractJson(result.text);
    }
    const profile = {summary: String(parsed.summary || "").slice(0, 800), sections: (parsed.sections || []).slice(0, 8).map(item => ({title: String(item.title || "记忆").slice(0, 40), text: String(item.text || "").slice(0, 1800)})), generator: "ai_distillation", generated_at: now()};
    await writeState(env, "memory:profile", profile);
    await writeState(env, "memory:distillation", {...status, status: "completed", last_success: now(), last_error: "", provider: result.provider});
    return profile;
  } catch (error) {
    await writeState(env, "memory:distillation", {...status, status: "failed", last_error: String(error.message || error).slice(0, 500)});
    throw error;
  }
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
    if (request.method === "GET" && url.pathname === "/api/local-state") return json({ok: true, state: await readData(env, "local_state")});
    if (request.method === "GET" && url.pathname === "/api/permissions") return json({ok: true, permissions: await permissions(env)});
    if (request.method === "GET" && url.pathname === "/api/memory") return json({ok: true, memory: await memoryState(env, (await permissions(env)).steward_mode)});
    if (request.method === "GET" && url.pathname === "/api/memory/distillation") return json({ok: true, distillation: await readState(env, "memory:distillation", {status: "idle", recent_runs: []})});
    if (request.method === "GET" && url.pathname === "/api/tasks") return json({ok: true, tasks: await tasks(env)});
    if (request.method === "GET" && url.pathname === "/api/skills") return json({ok: true, skills: {tools: [
      {name: "网页解析", description: "读取网页、生成摘要并归档"}, {name: "栗夹归档", description: "保存长期资料"},
      {name: "关注方向", description: "调整后续资讯关注"}, {name: "媒体来源", description: "维护巡逻信息源"},
      {name: "工具箱", description: "从链接整理工具卡片"}, {name: "记忆整理", description: "维护非封存记忆档案"}
    ], skills: [
      "archive-travel", "coach-blackboard", "curate-news", "curate-photos", "generate-media", "imagegen-assets", "remove-background", "guide-orchard",
      "listen-tree-hollow", "manage-memory", "manage-toolbox", "run-automation"
    ].map(name => ({name, origin: "bundled", status: "installed", kind: "guide", permission: "normal"})),
    can_build: false, health: {ok: true, summary: "云端内置能力已连接"}}});
    if (request.method === "GET" && url.pathname === "/api/automation") return json({ok: true, automation: await readState(env, "automation:status", {last_check: "", jobs: {}})});
    if (request.method === "GET" && url.pathname === "/api/voice/status") return json({ok: true, active: false, ready: false, phase: "browser_only", transcript: ""});
    if (request.method === "GET" && url.pathname === "/api/blackboard/today") {
      await requireDemoAi(env);
      return json({ok: true, question: await cloudBlackboardQuestion(env, (url.searchParams.get("refresh") || "").slice(0, 32))});
    }
    if (request.method === "GET" && url.pathname === "/api/media/tasks") return json({ok: true, task: await loadGenerationTask(env, url.searchParams.get("id"))});
    if (request.method === "GET" && url.pathname === "/api/media/file") {
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
    if (DEMO_AI_PATHS.has(url.pathname)) await requireDemoAi(env);
    if (url.pathname === "/api/data") return json({ok: true, value: await writeData(env, String(input.key || ""), input.value)});
    if (url.pathname === "/api/events") return json({ok: true, items: await logEvents(env, input)});
    if (url.pathname === "/api/local-state") return json({ok: true, state: await mergeLocalState(env, input)});
    if (url.pathname === "/api/state/sync") return json({ok: true, state: await syncButlerState(env, input.state || input)});
    if (url.pathname === "/api/permissions") return json({ok: true, permissions: await setStewardMode(env, Boolean(input.steward_mode))});
    if (url.pathname === "/api/memory/event") return json({ok: true, item: (await addMemoryEvents(env, input.event || input))[0]});
    if (url.pathname === "/api/memory/sync") return json({ok: true, items: await addMemoryEvents(env, input.events || [])});
    if (url.pathname === "/api/memory/action") return json(await memoryAction(env, input));
    if (url.pathname === "/api/memory/distill") return json({ok: true, started: true, summary: "阿栗已整理记忆档案", profile: await distillMemory(env)});
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
      await writeState(env, "automation:status", {last_check: now(), jobs: {notice_report: {status: "running", message: "阿栗正在巡逻近期资讯"}}});
      const work = runCloudReport(env, Boolean(input.force)).catch(async error => {
        await writeState(env, "automation:status", {last_check: now(), jobs: {notice_report: {status: "failed", last_error: now(), message: String(error.message || error).slice(0, 300)}}});
      });
      ctx.waitUntil(work);
      return json({ok: true, accepted: true, status: "running"}, 202);
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
    await writeState(env, "automation:status", status);
    try {
      const report = await runCloudReport(env, false);
      status.jobs.notice_report = report.unchanged
        ? {status: "completed", last_success: now(), unchanged: true, message: `已检查，暂无新资讯；保留 ${report.report_count || 0} 版巡报`}
        : {status: "completed", last_success: now(), message: `巡报已准备：${report.focus_title}`};
    } catch (error) {
      status.jobs.notice_report = {status: "failed", last_error: now(), message: String(error.message || error).slice(0, 300)};
    }
    if (env.COZY_PRIVATE || env.COZY_BACKUP) {
      try { await createFullBackup(env, "scheduled"); }
      catch (_error) {}
    }
    await writeState(env, "automation:status", status);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
}

export default {fetch: handleRequest, scheduled};
