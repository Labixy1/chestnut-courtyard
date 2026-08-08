import {
  DATA_KEYS, addMemoryEvents, appendButlerItem, memoryAction, memoryContext, memoryState,
  mergeLocalState, permissions, readData, readState, saveTask, setStewardMode,
  syncButlerState, tasks, updateTask, writeData, writeState
} from "./state.js";

const securityHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: securityHeaders});
const now = () => new Date().toISOString();
let accessKeysCache = {issuer: "", expires: 0, keys: []};

const providerConfig = (env, name) => {
  const configs = {
    openai: {key: env.OPENAI_API_KEY, base: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.COZY_OPENAI_MODEL || "gpt-5-mini"},
    deepseek: {key: env.DEEPSEEK_API_KEY, base: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1", model: env.COZY_DEEPSEEK_MODEL || "deepseek-chat"},
    glm: {key: env.GLM_API_KEY, base: env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4", model: env.COZY_GLM_MODEL || "glm-4.7-flash"},
    qwen: {key: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY, base: env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", model: env.COZY_QWEN_MODEL || "qwen3.7-flash"},
    ark: {key: env.ARK_API_KEY, base: env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"}
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
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2e9dc;color:#49392d;font-family:"PingFang SC","Microsoft YaHei",sans-serif}.login{width:min(360px,calc(100vw - 32px));padding:28px;background:rgba(255,252,246,.96);border:1px solid rgba(91,65,42,.14);border-radius:16px;box-shadow:0 22px 65px rgba(77,54,35,.18)}.mark{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;background:#ead8be url('/assets/estate/butler_dog.png') center/cover no-repeat}h1{font-size:21px;text-align:center;margin:0 0 6px}p{font-size:12px;line-height:1.7;text-align:center;color:#8b7563;margin:0 0 18px}input{width:100%;height:44px;border:1px solid rgba(91,65,42,.22);border-radius:10px;background:#fff;padding:0 12px;font:14px inherit;outline:none}input:focus{border-color:#9a7655;box-shadow:0 0 0 3px rgba(154,118,85,.12)}button{width:100%;height:42px;margin-top:10px;border:0;border-radius:10px;background:#765c45;color:#fff;font:14px inherit;cursor:pointer}button:disabled{opacity:.5}.error{min-height:18px;margin-top:10px;color:#a04e43;font-size:11px;text-align:center}</style></head><body><main class="login"><div class="mark"></div><h1>栗壳小院</h1><p>这是主人的私人入口。阿栗会守住这里的数据。</p><form id="form"><input id="passcode" type="password" autocomplete="current-password" placeholder="输入小院口令" aria-label="小院口令" required><button id="submit">回小院</button><div class="error" id="error">${String(message).replace(/[<>&]/g, "")}</div></form></main><script>document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();const button=document.getElementById('submit'),error=document.getElementById('error');button.disabled=true;error.textContent='阿栗正在确认…';try{const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passcode:document.getElementById('passcode').value})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'口令不正确');location.replace('/');}catch(reason){error.textContent=reason.message;button.disabled=false;}});</script></body></html>`, {status: 401, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer"}});

async function login(request, env) {
  if (!env.OWNER_PASSCODE || !env.SESSION_SECRET) return json({ok: false, error: "主人登录密钥尚未配置"}, 503);
  const ip = String(request.headers.get("cf-connecting-ip") || "unknown").slice(0, 80);
  const attemptKey = `auth:attempt:${ip}`;
  const attempt = await readState(env, attemptKey, {count: 0, blocked_until: 0});
  if (Number(attempt.blocked_until || 0) > Date.now()) return json({ok: false, error: "尝试次数过多，请稍后再试"}, 429);
  const input = await request.json();
  const inputHash = await hmac(env.SESSION_SECRET, String(input.passcode || ""));
  const expectedHash = await hmac(env.SESSION_SECRET, env.OWNER_PASSCODE);
  if (!safeEqual(inputHash, expectedHash)) {
    const count = Number(attempt.count || 0) + 1;
    await writeState(env, attemptKey, {count, blocked_until: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0}, {expirationTtl: 15 * 60});
    return json({ok: false, error: "口令不正确"}, 401);
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
  const response = await fetch(config.base.replace(/\/$/, "") + path, {
    method,
    headers: {authorization: `Bearer ${config.key}`, "content-type": "application/json"},
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || payload?.message || `${provider} HTTP ${response.status}`);
  return payload;
}

function textProvider(env) {
  const preferred = String(env.COZY_TEXT_PROVIDER || "").toLowerCase();
  if (preferred && providerConfig(env, preferred)?.key) return preferred;
  return ["openai", "deepseek", "glm", "qwen"].find(name => providerConfig(env, name)?.key) || (env.AI ? "workers-ai" : "");
}

async function callText(env, prompt, maxTokens = 1600) {
  const provider = textProvider(env);
  if (!provider) throw new Error("还没有配置在线文本模型 API Key");
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
        model: input.model || env.COZY_SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628",
        prompt: task.prompt, image: input.images || undefined, size: input.size || "2K",
        output_format: input.output_format || "png", response_format: "url", watermark: Boolean(input.watermark)
      });
    } else if (provider === "openai" || provider === "gpt-image") {
      payload = await providerRequest(env, "openai", "/images/generations", {
        model: input.model || env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2", prompt: task.prompt,
        size: input.size || "1536x1024", quality: input.quality || "high", output_format: input.output_format || "png", n: Number(input.count || 1)
      });
    } else throw new Error("图片 provider 只支持 seedream 或 openai");
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
      model: input.model || env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-260128", content,
      generate_audio: Boolean(input.generate_audio), ratio: input.ratio || "16:9", resolution: input.resolution || "720p",
      duration: Math.min(Math.max(Number(input.duration || 5), 3), 30), watermark: Boolean(input.watermark)
    });
    task = {...task, status: "queued", remote_id: payload.id, model: input.model || env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-260128"};
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
  const response = await fetch(url.toString(), {redirect: "follow", headers: {"user-agent": "Mozilla/5.0 (compatible; ChestnutCourtyard/1.0)", accept: "text/html,application/xhtml+xml"}});
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
    orchard: "这里是成长田。先直接解答困惑，再提炼可以继续生长的知识专题与下一步行动；不要把一切解释成情绪。",
    travel: "这里是旅行记录。帮助主人提炼具体旅行感悟，保留地点、事件和变化，不写旅游宣传语。",
    blackboard: "这里是产品黑板。围绕题目逐点评改，区分主人答案、标准答案和具体改进建议。"
  };
  const guide = roomPrompts[room] || "根据当前房间和上下文直接回应。";
  const result = await callText(env, `${guide}\n房间：${room}\n主人：${message.slice(0, 8000)}\n上下文：${JSON.stringify(context).slice(0, 6000)}`, 1400);
  await addMemoryEvents(env, {
    source: room, type: "room_conversation", content: message, summary: result.text.slice(0, 300),
    layer: room === "travel" || room === "orchard" ? "long" : "short", weight: 2,
    sensitivity: room === "heart_hollow" ? "sealed" : "personal"
  });
  return {reply: result.text, provider: result.provider};
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
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return "rain";
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

async function distillMemory(env) {
  const memory = await memoryState(env, false);
  const events = memory.events.slice(0, 120);
  if (!events.length) throw new Error("还没有足够的非封存记忆可整理");
  const status = {status: "running", last_run: now(), provider: textProvider(env), recent_runs: []};
  await writeState(env, "memory:distillation", status);
  const result = await callText(env, `请根据以下非封存行为，生成一份给私人AI助手使用的中文记忆档案。只保留稳定偏好、长期目标、关注领域、合作方式；不要写逐条流水，不要推断敏感身份。返回 JSON：{"summary":"...","sections":[{"title":"偏好与合作方式","text":"..."},{"title":"长期目标与成长方向","text":"..."},{"title":"知识关注","text":"..."}]}。\n行为：${JSON.stringify(events)}`, 1200);
  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("模型没有返回可用的记忆档案");
  const parsed = JSON.parse(match[0]);
  const profile = {summary: String(parsed.summary || "").slice(0, 800), sections: (parsed.sections || []).slice(0, 8).map(item => ({title: String(item.title || "记忆").slice(0, 40), text: String(item.text || "").slice(0, 1800)})), generator: "ai_distillation", generated_at: now()};
  await writeState(env, "memory:profile", profile);
  await writeState(env, "memory:distillation", {...status, status: "completed", last_success: now(), provider: result.provider});
  return profile;
}

export async function handleRequest(request, env, ctx = {}) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, {status: 204});
  if (request.method === "GET" && url.pathname === "/assets/estate/butler_dog.png" && env.ASSETS) return env.ASSETS.fetch(request);
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
  if (env.PUBLIC_READ_ONLY === "true" && request.method !== "GET") return json({ok: false, error: "公网预览仅供浏览，数据不会写入"}, 403);
  try {
    if (request.method === "GET" && url.pathname === "/api/status") {
      const access = env.ALLOW_UNAUTHENTICATED === "true" ? "preview" : "owner";
      return json({ok: true, service: "cloud", provider: textProvider(env) || "none", tools: 8, steward_mode: (await permissions(env)).steward_mode, access, storage: {kv: Boolean(env.COZY_STATE), private_r2: Boolean(env.COZY_PRIVATE), media_r2: Boolean(env.COZY_MEDIA)}});
    }
    if (request.method === "GET" && url.pathname === "/api/providers") return json({ok: true, providers: {
      text: Object.fromEntries(["openai", "deepseek", "glm", "qwen"].map(name => [name, {configured: Boolean(providerConfig(env, name)?.key), model: providerConfig(env, name)?.model}])),
      workers_ai: {configured: Boolean(env.AI), model: env.COZY_WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8"},
      image: {seedream: {configured: Boolean(env.ARK_API_KEY), model: env.COZY_SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628"}, openai: {configured: Boolean(env.OPENAI_API_KEY), model: env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2"}},
      video: {seedance: {configured: Boolean(env.ARK_API_KEY), model: env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-260128"}}
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
    ], health: {summary: "云端内置能力已连接"}}});
    if (request.method === "GET" && url.pathname === "/api/automation") return json({ok: true, automation: await readState(env, "automation:status", {last_check: "", jobs: {}})});
    if (request.method === "GET" && url.pathname === "/api/voice/status") return json({ok: true, active: false, ready: false, phase: "browser_only", transcript: ""});
    if (request.method === "GET" && url.pathname === "/api/blackboard/today") return json({ok: true, question: {id: "cloud-starter", type: "产品场景", title: "今天的产品判断", question: "当用户反馈一个功能不好用时，你会如何判断应该修交互、补能力，还是调整预期？", materials: [], standard: ["复述真实任务与阻塞点", "区分频率、影响和替代路径", "用最小验证确认根因", "定义修改后的验收信号"]}});
    if (request.method === "GET" && url.pathname === "/api/media/tasks") return json({ok: true, task: await loadGenerationTask(env, url.searchParams.get("id"))});
    if (request.method === "GET" && url.pathname === "/api/media/file") {
      if (!env.COZY_MEDIA) return new Response("Media storage is not enabled", {status: 503});
      const object = await env.COZY_MEDIA.get(url.searchParams.get("id") || "");
      if (!object) return new Response("Not found", {status: 404});
      const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("cache-control", "private, max-age=3600");
      return new Response(object.body, {headers});
    }
    if (request.method !== "POST") return json({ok: false, error: "接口不存在"}, 404);
    const input = await request.json();
    if (url.pathname === "/api/data") return json({ok: true, value: await writeData(env, String(input.key || ""), input.value)});
    if (url.pathname === "/api/events") return json({ok: true, items: await logEvents(env, input)});
    if (url.pathname === "/api/local-state") return json({ok: true, state: await mergeLocalState(env, input.values || input)});
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
      const item = await parseUrl(env, String(input.url || ""), String(input.instruction || ""));
      const tool = {...item, id: `tool_${crypto.randomUUID().slice(0, 10)}`, type: "toolbox", purpose: item.ai_summary || item.summary, key_capabilities: [], usage_example: "从原文案例开始试用"};
      const state = await appendButlerItem(env, "toolbox", tool);
      return json({ok: true, summary: `已加入工具箱：${tool.title}`, item: tool, state});
    }
    if (url.pathname === "/api/weekly/run") return json({ok: false, error: "主人版周报抓取将在下一阶段接入定时来源巡检"}, 501);
    if (url.pathname === "/api/voice/start" || url.pathname === "/api/voice/stop") return json({ok: false, error: "云端使用浏览器语音识别，不启用本机语音服务"}, 501);
    if (url.pathname === "/api/media/generate") {
      const task = input.kind === "video" ? await createVideo(env, input) : await generateImage(env, input);
      return json({ok: true, task}, input.kind === "video" ? 202 : 200);
    }
    if (url.pathname === "/api/media/task/refresh") return json({ok: true, task: await refreshVideo(env, input.id)});
    return json({ok: false, error: "接口不存在"}, 404);
  } catch (error) {
    return json({ok: false, error: String(error.message || error).slice(0, 600)}, 500);
  }
}

export async function scheduled(_event, env, ctx) {
  const job = (async () => {
    const status = {last_check: now(), jobs: {weather: {status: "cached_for_two_hours"}, memory: {status: "available"}}};
    await writeState(env, "automation:status", status);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
}

export default {fetch: handleRequest, scheduled};
