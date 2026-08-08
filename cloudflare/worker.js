const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"},
});

const providerConfig = (env, name) => {
  const configs = {
    openai: {key: env.OPENAI_API_KEY, base: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.COZY_OPENAI_MODEL || "gpt-5-mini"},
    deepseek: {key: env.DEEPSEEK_API_KEY, base: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1", model: env.COZY_DEEPSEEK_MODEL || "deepseek-chat"},
    glm: {key: env.GLM_API_KEY, base: env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4", model: env.COZY_GLM_MODEL || "glm-4.7-flash"},
    qwen: {key: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY, base: env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", model: env.COZY_QWEN_MODEL || "qwen3.7-flash"},
    ark: {key: env.ARK_API_KEY, base: env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"},
  };
  return configs[name];
};

const ownerAllowed = (request, env) => {
  if (env.ALLOW_UNAUTHENTICATED === "true") return true;
  const expected = String(env.OWNER_EMAIL || "").toLowerCase();
  const actual = String(request.headers.get("cf-access-authenticated-user-email") || "").toLowerCase();
  return Boolean(expected && actual && expected === actual);
};

async function providerRequest(env, provider, path, body, method = "POST") {
  const config = providerConfig(env, provider);
  if (!config?.key) throw new Error(`${provider} API Key 尚未配置`);
  const response = await fetch(config.base.replace(/\/$/, "") + path, {
    method,
    headers: {authorization: `Bearer ${config.key}`, "content-type": "application/json"},
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || payload?.message || `${provider} HTTP ${response.status}`);
  return payload;
}

function textProvider(env) {
  const preferred = String(env.COZY_TEXT_PROVIDER || "").toLowerCase();
  if (preferred && providerConfig(env, preferred)?.key) return preferred;
  return ["openai", "deepseek", "glm", "qwen"].find(name => providerConfig(env, name)?.key) || "";
}

async function callText(env, prompt) {
  const provider = textProvider(env);
  if (!provider) throw new Error("没有配置在线文本模型");
  const config = providerConfig(env, provider);
  if (provider === "openai") {
    const payload = await providerRequest(env, provider, "/responses", {model: config.model, input: prompt, max_output_tokens: 1200});
    const text = payload.output_text || (payload.output || []).flatMap(item => item.content || []).map(part => part.text || "").join("\n");
    if (!text) throw new Error("OpenAI 没有返回文字");
    return {text, provider};
  }
  const payload = await providerRequest(env, provider, "/chat/completions", {
    model: config.model, messages: [{role: "user", content: prompt}], temperature: 0.5, max_tokens: 1200,
  });
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider} 没有返回文字`);
  return {text: String(text), provider};
}

const taskKey = id => `generation:${id}`;

async function saveTask(env, task) {
  if (!env.COZY_STATE) throw new Error("COZY_STATE KV 尚未绑定");
  task.updated_at = new Date().toISOString();
  await env.COZY_STATE.put(taskKey(task.id), JSON.stringify(task), {expirationTtl: 60 * 60 * 24 * 180});
  return task;
}

async function loadTask(env, id) {
  if (!env.COZY_STATE) throw new Error("COZY_STATE KV 尚未绑定");
  const task = await env.COZY_STATE.get(taskKey(id), "json");
  if (!task) throw new Error("没有找到这个生成任务");
  return task;
}

async function storeRemoteMedia(env, task, url, extension) {
  if (!env.COZY_MEDIA) return [{url}];
  const response = await fetch(url);
  if (!response.ok) throw new Error(`生成文件下载失败（HTTP ${response.status}）`);
  const key = `generated/${task.kind}/${task.id}.${extension}`;
  await env.COZY_MEDIA.put(key, response.body, {httpMetadata: {contentType: response.headers.get("content-type") || undefined}});
  return [{key, url: `/api/media/file?id=${encodeURIComponent(key)}`}];
}

async function generateImage(env, input) {
  const provider = String(input.provider || "seedream").toLowerCase();
  const id = `gen_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
  let task = {id, kind: "image", provider, prompt: String(input.prompt || "").slice(0, 4000), status: "running", created_at: new Date().toISOString(), outputs: []};
  if (!task.prompt) throw new Error("图片提示词不能为空");
  await saveTask(env, task);
  try {
    let payload;
    if (provider === "seedream" || provider === "ark") {
      payload = await providerRequest(env, "ark", "/images/generations", {
        model: input.model || env.COZY_SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628",
        prompt: task.prompt, image: input.images || undefined, size: input.size || "2K",
        output_format: input.output_format || "png", response_format: "url", watermark: Boolean(input.watermark),
      });
    } else if (provider === "openai" || provider === "gpt-image") {
      payload = await providerRequest(env, "openai", "/images/generations", {
        model: input.model || env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2", prompt: task.prompt,
        size: input.size || "1536x1024", quality: input.quality || "high", output_format: input.output_format || "png", n: Number(input.count || 1),
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
    return await saveTask(env, task);
  } catch (error) {
    await saveTask(env, {...task, status: "failed", error: error.message});
    throw error;
  }
}

async function createVideo(env, input) {
  const id = `gen_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
  let task = {id, kind: "video", provider: "seedance", prompt: String(input.prompt || "").slice(0, 4000), status: "running", created_at: new Date().toISOString(), outputs: []};
  if (!task.prompt) throw new Error("视频提示词不能为空");
  await saveTask(env, task);
  try {
    const content = [{type: "text", text: task.prompt}, ...(input.images || []).map(url => ({type: "image_url", image_url: {url}, role: "reference_image"}))];
    const payload = await providerRequest(env, "ark", "/contents/generations/tasks", {
      model: input.model || env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-260128", content,
      generate_audio: Boolean(input.generate_audio), ratio: input.ratio || "16:9", resolution: input.resolution || "720p",
      duration: Math.min(Math.max(Number(input.duration || 5), 3), 30), watermark: Boolean(input.watermark),
    });
    task = {...task, status: "queued", remote_id: payload.id, model: input.model || env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-260128"};
    return await saveTask(env, task);
  } catch (error) {
    await saveTask(env, {...task, status: "failed", error: error.message});
    throw error;
  }
}

async function refreshVideo(env, id) {
  let task = await loadTask(env, id);
  if (task.kind !== "video" || !task.remote_id) throw new Error("这不是可查询的视频任务");
  if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
  const payload = await providerRequest(env, "ark", `/contents/generations/tasks/${encodeURIComponent(task.remote_id)}`, null, "GET");
  const videoUrl = payload.content?.video_url || payload.video_url || "";
  const outputs = payload.status === "succeeded" && videoUrl ? await storeRemoteMedia(env, task, videoUrl, "mp4") : task.outputs;
  task = {...task, status: payload.status || "unknown", outputs, usage: payload.usage || {}, error: payload.error || ""};
  return await saveTask(env, task);
}

async function logEvents(env, input) {
  if (!env.COZY_PRIVATE) throw new Error("COZY_PRIVATE R2 尚未绑定");
  const items = (Array.isArray(input.events) ? input.events : [input.event || input]).slice(0, 100);
  const saved = [];
  for (const raw of items) {
    const now = new Date().toISOString();
    const item = {id: String(raw.id || `evt_${crypto.randomUUID()}`), ts: String(raw.ts || now), received_at: now,
      context: String(raw.context || raw.ctx || "unknown").slice(0, 60), action: String(raw.action || raw.act || "event").slice(0, 100),
      page: String(raw.page || "").slice(0, 300), status: String(raw.status || "").slice(0, 40), task_id: String(raw.task_id || "").slice(0, 100),
      sensitivity: raw.sensitivity === "sealed" ? "sealed" : "personal", detail: raw.detail && typeof raw.detail === "object" ? raw.detail : {}};
    const key = `ledger/${now.slice(0, 10)}/${now.replaceAll(":", "-")}-${item.id}.json`;
    await env.COZY_PRIVATE.put(key, JSON.stringify(item), {httpMetadata: {contentType: "application/json"}});
    saved.push(item);
  }
  return saved;
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    if (!env.ASSETS) return new Response("Static assets are not configured", {status: 503});
    return env.ASSETS.fetch(request);
  }
  if (!ownerAllowed(request, env)) return json({ok: false, error: "需要通过 Cloudflare Access 主人验证"}, 403);
  if (env.PUBLIC_READ_ONLY === "true" && request.method !== "GET") {
    return json({ok: false, error: "公网预览仅供浏览，写入功能请使用本地小院"}, 403);
  }
  try {
    if (request.method === "GET" && url.pathname === "/api/status") return json({ok: true, service: "cloud", provider: textProvider(env) || "none", steward_mode: false});
    if (request.method === "GET" && url.pathname === "/api/providers") return json({ok: true, providers: {
      text: Object.fromEntries(["openai", "deepseek", "glm", "qwen"].map(name => [name, {configured: Boolean(providerConfig(env, name)?.key), model: providerConfig(env, name)?.model}])),
      image: {seedream: {configured: Boolean(env.ARK_API_KEY), model: env.COZY_SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628"}, openai: {configured: Boolean(env.OPENAI_API_KEY), model: env.COZY_OPENAI_IMAGE_MODEL || "gpt-image-2"}},
      video: {seedance: {configured: Boolean(env.ARK_API_KEY), model: env.COZY_SEEDANCE_MODEL || "doubao-seedance-2-0-260128"}},
    }});
    if (request.method === "GET" && url.pathname === "/api/media/tasks") return json({ok: true, task: await loadTask(env, url.searchParams.get("id"))});
    if (request.method === "GET" && url.pathname === "/api/media/file") {
      const object = await env.COZY_MEDIA.get(url.searchParams.get("id") || "");
      if (!object) return new Response("Not found", {status: 404});
      const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("cache-control", "private, max-age=3600");
      return new Response(object.body, {headers});
    }
    if (request.method !== "POST") return json({ok: false, error: "接口不存在"}, 404);
    const input = await request.json();
    if (url.pathname === "/api/events") return json({ok: true, items: await logEvents(env, input)});
    if (url.pathname === "/api/assistant") {
      const message = String(input.message || "").trim(); if (!message) throw new Error("留言不能为空");
      const result = await callText(env, `你是栗壳小院的管家阿栗。直接回答主人，不得假装调用不存在的工具。主人：${message.slice(0, 6000)}`);
      return json({ok: true, reply: result.text, provider: result.provider, tool_results: []});
    }
    if (url.pathname === "/api/media/generate") {
      const task = input.kind === "video" ? await createVideo(env, input) : await generateImage(env, input);
      return json({ok: true, task}, input.kind === "video" ? 202 : 200);
    }
    if (url.pathname === "/api/media/task/refresh") return json({ok: true, task: await refreshVideo(env, input.id)});
    return json({ok: false, error: "接口不存在"}, 404);
  } catch (error) {
    return json({ok: false, error: String(error.message || error).slice(0, 500)}, 500);
  }
}

export async function scheduled(_event, env) {
  if (!env.COZY_STATE) return;
  const now = new Date().toISOString();
  await env.COZY_STATE.put("automation:last_tick", JSON.stringify({time: now, distill: "paused_pending_memory_design"}));
}

export default {fetch: handleRequest, scheduled};
