import assert from "node:assert/strict";
import {handleRequest} from "../cloudflare/worker.js";

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, type) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
}

const kv = new MemoryKV();
const baseEnv = {
  COZY_STATE: kv,
  ALLOW_UNAUTHENTICATED: "true",
  PUBLIC_READ_ONLY: "false"
};
const pendingTasks = [];
const request = (path, body, env = baseEnv) => handleRequest(new Request(`https://owner.example${path}`, body === undefined ? {} : {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)
}), env, {waitUntil: promise => pendingTasks.push(promise)});
const payload = async response => ({status: response.status, body: await response.json()});

let result = await payload(await request("/api/status"));
assert.equal(result.status, 200);
assert.equal(result.body.access, "preview");
assert.equal(result.body.storage.kv, true);

result = await payload(await request("/api/providers"));
assert.equal(result.body.providers.image.nano_banana.model, "gemini-2.5-flash-image");
assert.deepEqual(result.body.providers.text_route, []);

result = await payload(await request("/api/data?key=estate_state"));
assert.equal(result.body.level, "新来的住客");

result = await payload(await request("/api/local-state", {values: {cozy_orchard_seeds: [{text: "学习评测集"}]}}));
assert.equal(result.body.state.values.cozy_orchard_seeds[0].text, "学习评测集");

result = await payload(await request("/api/memory/event", {event: {id: "m1", source: "orchard", content: "关注 AI 评测集", summary: "想学习 AI 评测集", weight: 2}}));
assert.equal(result.body.item.id, "m1");
result = await payload(await request("/api/memory"));
assert.equal(result.body.memory.cards[0].category_id, "growth");
assert.equal(result.body.memory.cards[0].status, "active");

result = await payload(await request("/api/assistant", {message: "新增一个分类：AI评测"}));
assert.equal(result.status, 200);
assert.match(result.body.reply, /已经完成/);
assert.equal(result.body.tool_results[0].ok, true);
result = await payload(await request("/api/state"));
assert.deepEqual(result.body.state.custom_categories, ["AI评测"]);

const aiEnv = {
  ...baseEnv,
  AI: {run: async (_model, input) => {
    const prompt = input.messages?.[0]?.content || "";
    if (prompt.includes("产品黑板出题人")) return {response: JSON.stringify({
      title: "评测边界", question: "如何为一个会调用工具的 Agent 构建评测集？", types: ["AI评测"],
      materials: ["关注任务成功率与副作用"], standard_points: ["分层定义任务", "覆盖失败路径", "记录工具副作用", "设置回归集"]
    })};
    if (prompt.includes("产品黑板") && prompt.includes("standard_points")) return {response: JSON.stringify({
      score: "78/100，方向正确", diagnosis: ["缺少失败路径"], polished_answer: "先分层，再覆盖副作用。",
      standard_points: ["分层定义任务", "覆盖失败路径", "记录副作用", "建立回归集"], suggestions: ["补充越权样本"],
      thinking_directions: ["如何衡量错误调用成本"], next_question: "设计一个越权用例"
    })};
    if (prompt.includes("资讯巡报")) {
      const id = prompt.match(/\"id\":\"([^\"]+)/)?.[1] || "candidate-0";
      const item = {source_id: id, category: "模型与技术", original_summary: "模型发布了新的能力更新。", ai_summary: "本次更新改变了模型能力边界，产品设计需要重新验证关键任务、成本和稳定性，并更新评测基线。"};
      return {response: JSON.stringify({focus_title: "模型能力边界更新", hot_items: [item], sections: [], insights: ["旧评测基线需要重跑"], advice: ["先挑三个高频任务做前后对比，再决定是否迁移。"]})};
    }
    return {response: "测试回复"};
  }}
};

result = await payload(await request("/api/blackboard/today", undefined, aiEnv));
assert.equal(result.status, 200);
assert.equal(result.body.question.type, "AI评测");
assert.equal(result.body.question.standard_points.length, 4);
result = await payload(await request("/api/room", {room: "blackboard", message: "我会先看任务成功率", context: {question: "如何构建评测集？"}}, aiEnv));
assert.equal(result.body.result.standard_points.length, 4);

const nativeFetch = globalThis.fetch;
const fallbackEnv = {
  ...baseEnv,
  COZY_TEXT_PROVIDER: "deepseek", COZY_TEXT_FALLBACK_PROVIDER: "openai",
  DEEPSEEK_API_KEY: "test-deepseek", OPENAI_API_KEY: "test-openai",
  COZY_DEEPSEEK_MODEL: "deepseek-v4-flash", COZY_OPENAI_MODEL: "gpt-5.6-luna"
};
globalThis.fetch = async (url, options) => {
  if (String(url).includes("api.deepseek.com")) return new Response(JSON.stringify({error: {message: "simulated primary failure"}}), {status: 503, headers: {"content-type": "application/json"}});
  if (String(url).includes("api.openai.com/v1/responses")) return new Response(JSON.stringify({output_text: "云端兜底成功"}), {status: 200, headers: {"content-type": "application/json"}});
  return nativeFetch(url, options);
};
result = await payload(await request("/api/room", {room: "orchard", message: "验证模型兜底", context: {}}, fallbackEnv));
assert.equal(result.status, 200);
assert.equal(result.body.provider, "openai");
assert.match(result.body.reply, /云端兜底成功/);
result = await payload(await request("/api/providers", undefined, fallbackEnv));
assert.deepEqual(result.body.providers.text_route, ["deepseek", "openai"]);

globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://news.google.com/rss/search")) return new Response(`<?xml version="1.0"?><rss><channel><item><title>OpenAI 发布重要模型更新</title><link>https://news.example/model</link><pubDate>Fri, 08 Aug 2026 00:00:00 GMT</pubDate><description>模型能力与价格更新</description><source url="https://news.example">测试媒体</source></item></channel></rss>`, {status: 200});
  return nativeFetch(url, options);
};
result = await payload(await request("/api/weekly/run", {force: true}, aiEnv));
assert.equal(result.status, 202);
assert.equal(result.body.status, "running");
await Promise.all(pendingTasks.splice(0));
globalThis.fetch = nativeFetch;
assert.equal((await payload(await request("/api/data?key=notice_reports", undefined, aiEnv))).body.reports.length, 1);
assert.equal((await payload(await request("/api/automation", undefined, aiEnv))).body.automation.jobs.notice_report.status, "completed");

const blocked = await payload(await handleRequest(new Request("https://owner.example/api/status"), {
  COZY_STATE: new MemoryKV(), ALLOW_UNAUTHENTICATED: "false", OWNER_EMAIL: "owner@example.com",
  CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "aud"
}));
assert.equal(blocked.status, 401);

const privateEnv = {
  COZY_STATE: new MemoryKV(), ALLOW_UNAUTHENTICATED: "false", AUTH_MODE: "passcode",
  OWNER_PASSCODE: "栗壳-test", SESSION_SECRET: "test-session-secret-with-enough-entropy"
};
result = await payload(await handleRequest(new Request("https://owner.example/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.1"},
  body: JSON.stringify({passcode: "wrong"})
}), privateEnv));
assert.equal(result.status, 401);
const loginResponse = await handleRequest(new Request("https://owner.example/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.1"},
  body: JSON.stringify({passcode: "栗壳-test"})
}), privateEnv);
assert.equal(loginResponse.status, 200);
const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
result = await payload(await handleRequest(new Request("https://owner.example/api/status", {headers: {cookie}}), privateEnv));
assert.equal(result.status, 200);
assert.equal(result.body.access, "owner");

const readOnly = await payload(await request("/api/local-state", {values: {x: 1}}, {...baseEnv, PUBLIC_READ_ONLY: "true"}));
assert.equal(readOnly.status, 403);

console.log("cloud worker test ok: auth; KV; memory; model fallback; blackboard AI; grading; scheduled report path; read-only guard");
