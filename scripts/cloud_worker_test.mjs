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

result = await payload(await request("/api/local-state", {values: {cozy_orchard_seeds: [{text: "学习评测集"}], cozy_blackboard_starred: ["question-key"]}}));
assert.equal(result.body.state.values.cozy_orchard_seeds[0].text, "学习评测集");
assert.deepEqual(result.body.state.values.cozy_blackboard_starred, ["question-key"]);

// Two devices can append independently without replacing each other's records.
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-a", place: "杭州", updatedAt: "2026-08-10T08:00:00+08:00"}
], deleted: []}}}));
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-b", place: "上海", updatedAt: "2026-08-10T08:01:00+08:00"}
], deleted: []}}}));
assert.deepEqual(result.body.state.values.cozy_trips.map(item => item.id).sort(), ["trip-a", "trip-b"]);

// Same-record conflicts prefer the newest timestamp, and tombstones block stale resurrection.
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-a", place: "旧杭州", updatedAt: "2026-08-10T07:59:00+08:00"}
], deleted: []}}}));
assert.equal(result.body.state.values.cozy_trips.find(item => item.id === "trip-a").place, "杭州");
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-a", place: "杭州西湖", updatedAt: "2026-08-10T08:02:00+08:00"}
], deleted: []}}}));
assert.equal(result.body.state.values.cozy_trips.find(item => item.id === "trip-a").place, "杭州西湖");
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [], deleted: ["id:trip-a"]}}}));
assert.equal(result.body.state.values.cozy_trips.some(item => item.id === "trip-a"), false);
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-a", place: "离线旧副本", updatedAt: "2026-08-10T08:02:00+08:00"}
], deleted: []}}}));
assert.equal(result.body.state.values.cozy_trips.some(item => item.id === "trip-a"), false);
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-a", place: "无时间戳旧副本"}
], deleted: []}}}));
assert.equal(result.body.state.values.cozy_trips.some(item => item.id === "trip-a"), false);
result = await payload(await request("/api/local-state", {changes: {cozy_trips: {type: "array", upserts: [
  {id: "trip-a", place: "主人重新创建"}
], deleted: [], revive: ["id:trip-a"]}}}));
assert.equal(result.body.state.values.cozy_trips.find(item => item.id === "trip-a").place, "主人重新创建");

// Object maps use the same union and deletion behavior.
result = await payload(await request("/api/local-state", {changes: {cozy_trip_reflections: {type: "object", upserts: {
  first: {summary: "第一段", updatedAt: "2026-08-10T08:00:00+08:00"}
}, deleted: []}}}));
result = await payload(await request("/api/local-state", {changes: {cozy_trip_reflections: {type: "object", upserts: {
  second: {summary: "第二段", updatedAt: "2026-08-10T08:01:00+08:00"}
}, deleted: []}}}));
assert.deepEqual(Object.keys(result.body.state.values.cozy_trip_reflections).sort(), ["first", "second"]);
result = await payload(await request("/api/local-state", {changes: {cozy_trip_reflections: {type: "object", upserts: {}, deleted: ["first"]}}}));
assert.deepEqual(Object.keys(result.body.state.values.cozy_trip_reflections), ["second"]);
result = await payload(await request("/api/local-state", {changes: {cozy_trip_reflections: {type: "object", upserts: {
  first: {summary: "无时间戳旧副本"}
}, deleted: []}}}));
assert.deepEqual(Object.keys(result.body.state.values.cozy_trip_reflections), ["second"]);
result = await payload(await request("/api/local-state", {changes: {cozy_trip_reflections: {type: "object", upserts: {
  first: {summary: "主人重新创建"}
}, deleted: [], revive: ["first"]}}}));
assert.equal(result.body.state.values.cozy_trip_reflections.first.summary, "主人重新创建");

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

let latestOrchardPrompt = "";
const aiEnv = {
  ...baseEnv,
  AI: {run: async (_model, input) => {
    const prompt = input.messages?.[0]?.content || "";
    if (prompt.includes("产品黑板出题人")) return {response: JSON.stringify({
      title: "评测边界", question: "如何为一个会调用工具的 Agent 构建评测集？", types: ["AI评测"],
      materials: ["关注任务成功率与副作用"], standard_points: ["按风险分层定义真实任务", "覆盖超时和越权等失败路径", "记录每次工具调用产生的副作用", "建立固定回归集并设置通过阈值"]
    })};
    if (prompt.includes("产品黑板") && prompt.includes("standard_points")) return {response: JSON.stringify({
      score_breakdown: [
        {criterion: "问题理解", max: 25, awarded: 20, reason: "原答案提到任务成功率，理解了评测目标"},
        {criterion: "方案完整", max: 25, awarded: 18, reason: "原答案有分层思路，但缺少失败路径"},
        {criterion: "验证与指标", max: 25, awarded: 20, reason: "原答案明确提出任务成功率"},
        {criterion: "风险与回滚", max: 25, awarded: 10, reason: "尚未覆盖回滚"}
      ], score_summary: "方向正确，但需要补足失败路径", diagnosis: ["缺少失败路径"], polished_answer: "先分层，再覆盖副作用。",
      standard_points: ["分层定义任务", "覆盖失败路径", "记录副作用", "建立回归集"], suggestions: ["补充越权样本"],
      thinking_directions: ["如何衡量错误调用成本"], next_question: "设计一个越权用例"
    })};
    if (prompt.includes("成长田的“问问阿栗”")) {
      latestOrchardPrompt = prompt;
      return {response: JSON.stringify({
        reply: "OpenJiuwen 是一个围绕智能体技术与开源协作形成的项目或社区。判断它的具体组织属性时，应以其当前官网和官方仓库说明为准；未联网核验前，不应把它直接说成某家公司。",
        answer_focus: "解释 OpenJiuwen 的组织属性",
        seed_summary: "OpenJiuwen 背景",
        key_insight: "组织归属应以当前官方资料为准",
        next_step: "查看官网 About 页面和官方仓库组织说明",
        knowledge_topic: {match_id: "", title: "AI 智能体开源生态", category: "AI 技术与产品", entities: ["OpenJiuwen"], summary: "关注智能体开源项目的定位、维护主体与生态。", knowledge_points: ["区分项目、社区、基金会与公司主体"], comparison_rows: [], scenarios: [], conclusion: "先核验官方主体再判断归属"}
      })};
    }
    if (prompt.includes("资讯巡报")) {
      const id = prompt.match(/\"id\":\"([^\"]+)/)?.[1] || "candidate-0";
      const item = {source_id: id, category: "模型与技术", translation_zh: "该模型以更低价格增加了新的推理能力。", ai_summary: "本次更新改变了模型能力边界，产品设计需要重新验证关键任务、成本和稳定性，并更新评测基线。"};
      return {response: JSON.stringify({focus_title: "模型能力边界更新", hot_items: [item], sections: [], insights: ["旧评测基线需要重跑"], advice: ["先挑三个高频任务做前后对比，再决定是否迁移。"]})};
    }
    if (prompt.includes("忠实翻译员")) return {response: JSON.stringify({items: [{id: "0", translation_zh: "这是忠实的中文翻译。"}]})};
    if (prompt.includes("资讯编辑")) return {response: JSON.stringify({items: [{id: "0", ai_summary: "这篇文章介绍了具体能力更新、适用场景和限制，并给出了值得核验的产品结论。"}]})};
    if (prompt.includes("工具箱整理员")) return {response: JSON.stringify({
      is_tool: true, title: "Google Vids", category: "图像与视频", purpose: "使用 AI 生成和编辑视频。",
      key_capabilities: ["文本生成视频", "个人数字分身", "视频编辑"], use_cases: ["制作产品演示", "生成培训视频"],
      example: "输入产品介绍，生成一段带数字分身讲解的视频。", official_url: "https://workspace.google.com/products/vids/"
    })};
    return {response: "测试回复"};
  }}
};

result = await payload(await request("/api/blackboard/today", undefined, aiEnv));
assert.equal(result.status, 200);
assert.equal(result.body.question.type, "AI评测");
assert.equal(result.body.question.standard_points.length, 4);
const invalidQuestionEnv = {...baseEnv, COZY_STATE: new MemoryKV(), AI: {run: async () => ({response: JSON.stringify({
  title: "空壳题", question: "如果模型只返回格式要求，你会怎样处理这个无效题目并确保用户拿到当天可回答的新题？", types: ["产品场景"],
  materials: [], standard_points: ["4到7条参考答案要点"]
})})}};
result = await payload(await request("/api/blackboard/today", undefined, invalidQuestionEnv));
assert.equal(result.status, 200);
assert.equal(result.body.question.provider, "deterministic-fallback");
assert.ok(result.body.question.standard_points.length >= 4);
assert.equal(result.body.question.standard_points.some(item => /参考答案要点/.test(item)), false);
result = await payload(await request("/api/room", {room: "blackboard", message: "我会先看任务成功率", context: {question: "如何构建评测集？"}}, aiEnv));
assert.equal(result.body.result.standard_points.length, 4);

let blackboardRetryAttempts = 0;
const blackboardRetryEnv = {...baseEnv, AI: {run: async () => {
  blackboardRetryAttempts += 1;
  if (blackboardRetryAttempts === 1) return {response: JSON.stringify({
    score_breakdown: ["问题理解", "方案完整", "验证与指标", "风险与回滚"].map(criterion => ({criterion, max: 25, awarded: 0, reason: "没有具体产品信息，无法评估"})),
    score_summary: "产品信息不足", diagnosis: ["缺乏产品信息"], polished_answer: "产品信息不足", standard_points: []
  })};
  return {response: JSON.stringify({
    score_breakdown: [
      {criterion: "问题理解", max: 25, awarded: 18, reason: "原答案提出不同类别的攻击问题，覆盖了外部红队评测的核心方向"},
      {criterion: "方案完整", max: 25, awarded: 12, reason: "覆盖源码、数据与伦理测试，但缺少执行角色、漏洞分级和修复复测流程"},
      {criterion: "验证与指标", max: 25, awarded: 8, reason: "提出探测泄露与严重幻觉，但没有通过阈值、复现率和周期指标"},
      {criterion: "风险与回滚", max: 25, awarded: 5, reason: "识别数据泄露和误导风险，但没有处置、回滚与披露机制"}
    ], score_summary: "方向正确，已覆盖三类红队测试，但安全闭环仍不完整", diagnosis: ["已覆盖源码、数据与伦理测试", "缺少分级、修复和复测"], polished_answer: "判断：需要建立独立红队评测闭环。", standard_points: ["定义威胁模型", "独立红队测试", "漏洞分级", "修复复测"]
  })};
}}};
result = await payload(await request("/api/room", {room: "blackboard", message: "准备不同类别的攻击问题，探测源码、数据泄露和伦理误导", context: {intent: "grade_answer", question: "假设你负责一款 AI 产品，如何设计外部评测机制？"}}, blackboardRetryEnv));
assert.equal(result.status, 200);
assert.equal(blackboardRetryAttempts, 2);
assert.equal(result.body.result.score_breakdown.reduce((sum, item) => sum + item.awarded, 0), 43);
result = await payload(await request("/api/room", {room: "orchard", message: "OpenJiuwen 是个什么组织？", context: {
  conversation: [{role: "owner", text: "Cursor 和 Trae 有什么区别？"}, {role: "butler", text: "它们都是 AI 编程助手。"}],
  knowledge_topics: [{id: "topic_cursor", title: "AI 编程助手", summary: "比较 Cursor 与 Trae"}]
}}, aiEnv));
assert.equal(result.status, 200);
assert.match(result.body.reply, /OpenJiuwen/);
assert.equal(result.body.result.answer_focus, "解释 OpenJiuwen 的组织属性");
assert.match(latestOrchardPrompt, /当前“主人”消息是唯一主任务/);
assert.match(latestOrchardPrompt, /旧对话不得盖过当前问题/);
assert.match(latestOrchardPrompt, /当前主人问题（最高优先级）：OpenJiuwen 是个什么组织/);
assert.match(latestOrchardPrompt, /不能用旧专题内容替代答案/);
assert.doesNotMatch(latestOrchardPrompt, /想学习 AI 评测集/);
assert.match(latestOrchardPrompt, /成长田回答阶段不注入全局记忆/);

let alignmentAttempts = 0;
const alignmentEnv = {...baseEnv, AI: {run: async () => {
  alignmentAttempts += 1;
  if (alignmentAttempts === 1) return {response: JSON.stringify({reply: "这是一个不错的方向，可以继续观察。", answer_focus: "讨论学习方向", knowledge_topic: {title: "学习方向"}})};
  return {response: JSON.stringify({reply: "Cursor 是一款面向开发者的 AI 编程工具，核心能力包括理解代码库、生成和修改代码。", answer_focus: "解释 Cursor 是什么", seed_summary: "Cursor 定位", key_insight: "Cursor 属于 AI 编程工具", next_step: "", knowledge_topic: {match_id: "", title: "AI 编程助手", category: "AI 技术与产品", entities: ["Cursor"], summary: "AI 编程工具的能力与边界", knowledge_points: ["理解代码库", "生成和修改代码"]}})};
}}};
result = await payload(await request("/api/room", {room: "orchard", message: "Cursor 是什么？", context: {}}, alignmentEnv));
assert.equal(result.status, 200);
assert.equal(alignmentAttempts, 2);
assert.match(result.body.reply, /Cursor/);

const nativeFetch = globalThis.fetch;
const isDirectNewsFeed = value => ["openai.com/news/rss.xml", "blog.google/technology/ai/rss/", "deepmind.google/blog/rss.xml", "theverge.com/rss/ai-artificial-intelligence"].some(part => String(value).includes(part));
const newsXml = (title = "OpenAI 发布重要模型更新", link = "https://news.example/model", summary = "模型能力与价格更新") => `<?xml version="1.0"?><rss><channel><item><title>${title}</title><link>${link}</link><pubDate>Fri, 08 Aug 2026 00:00:00 GMT</pubDate><description>${summary}</description><source url="https://news.example">测试媒体</source></item></channel></rss>`;
const fallbackEnv = {
  ...baseEnv,
  COZY_TEXT_PROVIDER: "deepseek", COZY_TEXT_FALLBACK_PROVIDER: "openai",
  DEEPSEEK_API_KEY: "test-deepseek", OPENAI_API_KEY: "test-openai",
  COZY_DEEPSEEK_MODEL: "deepseek-v4-flash", COZY_OPENAI_MODEL: "gpt-5.6-luna"
};
globalThis.fetch = async (url, options) => {
  if (String(url).includes("api.deepseek.com")) return new Response(JSON.stringify({error: {message: "simulated primary failure"}}), {status: 503, headers: {"content-type": "application/json"}});
  if (String(url).includes("api.openai.com/v1/responses")) return new Response(JSON.stringify({output_text: JSON.stringify({reply: "云端兜底成功，当前问题已由备用模型直接回答。", answer_focus: "验证模型兜底是否成功", seed_summary: "模型兜底", key_insight: "主模型失败时切换备用模型", next_step: "", knowledge_topic: {match_id: "", title: "AI 模型调用稳定性", category: "AI 技术与产品", entities: [], summary: "验证主备模型切换。", knowledge_points: ["主模型失败后调用备用模型"]}})}), {status: 200, headers: {"content-type": "application/json"}});
  return nativeFetch(url, options);
};
result = await payload(await request("/api/room", {room: "orchard", message: "验证模型兜底", context: {}}, fallbackEnv));
assert.equal(result.status, 200);
assert.equal(result.body.provider, "openai");
assert.match(result.body.reply, /云端兜底成功/);
result = await payload(await request("/api/providers", undefined, fallbackEnv));
assert.deepEqual(result.body.providers.text_route, ["deepseek", "openai"]);

await kv.put("automation:status", JSON.stringify({last_check: new Date(Date.now() - 3 * 60 * 1000).toISOString(), jobs: {notice_report: {status: "running", message: "阿栗正在巡逻近期资讯"}}}));
result = await payload(await request("/api/automation", undefined, aiEnv));
assert.equal(result.body.automation.jobs.notice_report.status, "failed");
assert.match(result.body.automation.jobs.notice_report.message, /更新超时/);

globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://news.google.com/rss/search")) return new Response(newsXml("OpenAI launches an important model update", "https://news.example/model", "The model adds new reasoning capabilities at a lower price."), {status: 200});
  if (isDirectNewsFeed(url)) return new Response("unavailable", {status: 503});
  return nativeFetch(url, options);
};
result = await payload(await request("/api/weekly/run", {force: true}, aiEnv));
assert.equal(result.status, 202);
assert.equal(result.body.status, "running");
await Promise.all(pendingTasks.splice(0));
globalThis.fetch = nativeFetch;
const firstNoticeReport = (await payload(await request("/api/data?key=notice_reports", undefined, aiEnv))).body.reports[0];
assert.equal(firstNoticeReport.title, undefined);
assert.equal(firstNoticeReport.hot_items[0].title, "OpenAI launches an important model update");
assert.equal(firstNoticeReport.hot_items[0].summary, "The model adds new reasoning capabilities at a lower price.");
assert.equal(firstNoticeReport.hot_items[0].source_summary, "The model adds new reasoning capabilities at a lower price.");
assert.match(firstNoticeReport.hot_items[0].ai_summary, /[\u4e00-\u9fff]/);
assert.equal((await payload(await request("/api/data?key=notice_reports", undefined, aiEnv))).body.reports.length, 1);
result = await payload(await request("/api/blackboard/today?refresh=aligned-news", undefined, aiEnv));
assert.equal(result.status, 200);
assert.equal(result.body.question.alignment_version, 3);
assert.match(result.body.question.question, /OpenAI launches an important model update/);
assert.match(result.body.question.materials.join(" "), /OpenAI launches an important model update/);
assert.doesNotMatch(result.body.question.question, /如何为一个会调用工具的 Agent 构建评测集/);
assert.equal((await payload(await request("/api/automation", undefined, aiEnv))).body.automation.jobs.notice_report.status, "completed");

globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://news.google.com/rss/search")) return new Response(newsXml("OpenAI launches an important model update", "https://news.example/model", "The model adds new reasoning capabilities at a lower price."), {status: 200});
  if (isDirectNewsFeed(url)) return new Response("unavailable", {status: 503});
  return nativeFetch(url, options);
};
result = await payload(await request("/api/weekly/run", {force: true}, aiEnv));
await Promise.all(pendingTasks.splice(0));
globalThis.fetch = nativeFetch;
const unchangedAutomation = (await payload(await request("/api/automation", undefined, aiEnv))).body.automation.jobs.notice_report;
assert.equal(unchangedAutomation.status, "completed");
assert.equal(unchangedAutomation.unchanged, true);
assert.match(unchangedAutomation.message, /暂无新资讯；保留 1 版巡报/);
assert.equal((await payload(await request("/api/data?key=notice_reports", undefined, aiEnv))).body.reports.length, 1);

globalThis.fetch = async () => new Response("upstream unavailable", {status: 503});
result = await payload(await request("/api/weekly/run", {force: true}, aiEnv));
assert.equal(result.status, 202);
await Promise.all(pendingTasks.splice(0));
assert.equal((await payload(await request("/api/automation", undefined, aiEnv))).body.automation.jobs.notice_report.status, "failed");
const repairEnv = {...aiEnv, COZY_STATE: new MemoryKV()};
await payload(await request("/api/data", {key: "notice_reports", value: {version: 1, reports: [{id: "needs-repair", generated_at: new Date().toISOString(), hot_items: [{title: "English source", summary: "An English source summary.", ai_summary: "自动中文整理暂时没有可靠完成，先保留来源。", media: "Test"}], sections: []}]}}, repairEnv));
result = await payload(await request("/api/weekly/run", {force: true}, repairEnv));
await Promise.all(pendingTasks.splice(0));
const repairedReport = (await payload(await request("/api/data?key=notice_reports", undefined, repairEnv))).body.reports[0];
assert.equal(repairedReport.hot_items[0].translation_zh, "这是忠实的中文翻译。");
assert.doesNotMatch(repairedReport.hot_items[0].ai_summary, /暂时没有可靠完成/);
assert.notEqual(repairedReport.hot_items[0].translation_zh, repairedReport.hot_items[0].ai_summary);
assert.equal((await payload(await request("/api/automation", undefined, repairEnv))).body.automation.jobs.notice_report.status, "completed");
globalThis.fetch = async url => {
  if (String(url).includes("openai.com/news/rss.xml")) return new Response(newsXml("OpenAI 发布第二项重要更新", "https://news.example/model-2"), {status: 200});
  return new Response("upstream unavailable", {status: 503});
};
result = await payload(await request("/api/weekly/run", {force: true}, aiEnv));
await Promise.all(pendingTasks.splice(0));
assert.equal((await payload(await request("/api/automation", undefined, aiEnv))).body.automation.jobs.notice_report.status, "completed");
assert.equal((await payload(await request("/api/data?key=notice_reports", undefined, aiEnv))).body.reports.length, 2);

const slowCurationEnv = {...baseEnv, COZY_STATE: new MemoryKV(), COZY_NEWS_AI_TIMEOUT_MS: "10", AI: {run: async () => new Promise(() => {})}};
globalThis.fetch = async url => {
  if (String(url).includes("openai.com/news/rss.xml")) return new Response(newsXml("模型整理超时时仍可归档", "https://news.example/source-fallback", "&lt;a href=&quot;https://news.example&quot;&gt;模型能力与价格更新&lt;/a&gt;"), {status: 200});
  return new Response("upstream unavailable", {status: 503});
};
result = await payload(await request("/api/weekly/run", {force: true}, slowCurationEnv));
await Promise.all(pendingTasks.splice(0));
assert.equal((await payload(await request("/api/automation", undefined, slowCurationEnv))).body.automation.jobs.notice_report.status, "completed");
const sourceFallbackReport = (await payload(await request("/api/data?key=notice_reports", undefined, slowCurationEnv))).body.reports[0];
assert.equal(sourceFallbackReport.provider, "source-fallback");
assert.match(sourceFallbackReport.hot_items[0].ai_summary, /模型能力与价格更新/);
assert.ok((sourceFallbackReport.hot_items[0].ai_summary.match(/[\u4e00-\u9fff]/g) || []).length >= 8);
assert.doesNotMatch(sourceFallbackReport.hot_items[0].summary, /&lt;|href=|<a/);
globalThis.fetch = nativeFetch;

globalThis.fetch = async url => new Response("blocked", {status: 403});
const toolSource = {title: "Create, edit and star in videos with two Google Vids updates", summary: "Google Vids adds Gemini Omni and personal avatars.", ai_summary: "Google Vids 支持 AI 视频生成与数字分身。", media: "Google"};
result = await payload(await request("/api/toolbox/import", {url: "https://blog.google/vids-update", source: toolSource, instruction: "加入工具箱"}, aiEnv));
assert.equal(result.status, 200);
assert.equal(result.body.item.title, "Google Vids");
assert.equal(result.body.item.key_capabilities.length, 3);
result = await payload(await request("/api/toolbox/import", {url: "https://blog.google/vids-update", source: toolSource, instruction: "加入工具箱"}, aiEnv));
assert.equal(result.status, 200);
assert.equal(result.body.state.toolbox.filter(item => item.source_url === "https://blog.google/vids-update").length, 1);
globalThis.fetch = nativeFetch;

const blocked = await payload(await handleRequest(new Request("https://owner.example/api/status"), {
  COZY_STATE: new MemoryKV(), ALLOW_UNAUTHENTICATED: "false", OWNER_EMAIL: "owner@example.com",
  CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "aud"
}));
assert.equal(blocked.status, 401);

const privateEnv = {
  COZY_STATE: new MemoryKV(), ALLOW_UNAUTHENTICATED: "false", AUTH_MODE: "passcode",
  OWNER_PASSCODE: "栗壳-test", SESSION_SECRET: "test-session-secret-with-enough-entropy",
  ASSETS: {fetch: async request => new Response("dog-icon", {headers: {"content-type": "image/png", "x-test-path": new URL(request.url).pathname}})}
};
const loginPage = await handleRequest(new Request("https://owner.example/"), privateEnv);
const loginHtml = await loginPage.text();
assert.equal(loginPage.status, 401);
assert.match(loginHtml, /id="toggle-pass"/);
assert.match(loginHtml, /passcode\.type=visible\?'password':'text'/);
assert.match(loginHtml, /assets\/app\/icon-192\.png/);
const publicLoginIcon = await handleRequest(new Request("https://owner.example/assets/app/icon-192.png"), privateEnv);
assert.equal(publicLoginIcon.status, 200);
assert.equal(publicLoginIcon.headers.get("content-type"), "image/png");
assert.equal(publicLoginIcon.headers.get("x-test-path"), "/assets/app/icon-192.png");
const protectedAsset = await handleRequest(new Request("https://owner.example/assets/estate/panorama.webp"), privateEnv);
assert.equal(protectedAsset.status, 401);
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
const realDateNow = Date.now;
Date.now = () => realDateNow() + 8 * 24 * 60 * 60 * 1000;
result = await payload(await handleRequest(new Request("https://owner.example/api/status", {headers: {cookie}}), privateEnv));
assert.equal(result.status, 401);
Date.now = realDateNow;
result = await payload(await handleRequest(new Request("https://owner.example/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.1"},
  body: JSON.stringify({passcode: "wrong"})
}), privateEnv));
assert.equal(result.body.remaining_attempts, 49);
await handleRequest(new Request("https://owner.example/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.1"},
  body: JSON.stringify({passcode: "栗壳-test"})
}), privateEnv);
result = await payload(await handleRequest(new Request("https://owner.example/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.1"},
  body: JSON.stringify({passcode: "wrong"})
}), privateEnv));
assert.equal(result.body.remaining_attempts, 49);

const limitEnv = {
  COZY_STATE: new MemoryKV(), ALLOW_UNAUTHENTICATED: "false", AUTH_MODE: "passcode",
  OWNER_PASSCODE: "栗壳-test", SESSION_SECRET: "test-session-secret-with-enough-entropy"
};
for (let attempt = 1; attempt <= 50; attempt += 1) {
  result = await payload(await handleRequest(new Request("https://owner.example/api/auth/login", {
    method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.50"},
    body: JSON.stringify({passcode: "wrong"})
  }), limitEnv));
  assert.equal(result.status, 401);
  assert.equal(result.body.remaining_attempts, 50 - attempt);
}
result = await payload(await handleRequest(new Request("https://owner.example/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", "cf-connecting-ip": "127.0.0.50"},
  body: JSON.stringify({passcode: "wrong"})
}), limitEnv));
assert.equal(result.status, 429);
assert.match(result.body.error, /15 分钟/);

const readOnly = await payload(await request("/api/local-state", {values: {x: 1}}, {...baseEnv, PUBLIC_READ_ONLY: "true"}));
assert.equal(readOnly.status, 403);

const demoKv = new MemoryKV();
const demoEnv = {
  ...aiEnv, COZY_STATE: demoKv, DEMO_MODE: "true", PUBLIC_READ_ONLY: "false",
  DEMO_ADMIN_PASSCODE: "demo-owner", SESSION_SECRET: "demo-session-secret"
};
result = await payload(await request("/api/demo/status", undefined, demoEnv));
assert.equal(result.body.activation.active, false);
result = await payload(await request("/api/blackboard/today", undefined, demoEnv));
assert.equal(result.status, 403);
result = await payload(await request("/api/demo/seed", {}, demoEnv));
assert.equal(result.status, 200);
result = await payload(await request("/api/data?key=estate_state", undefined, demoEnv));
assert.equal(result.body.level, "刚认识小院");
result = await payload(await request("/api/demo/reset", {}, demoEnv));
assert.equal(result.status, 200);
result = await payload(await request("/api/data?key=estate_state", undefined, demoEnv));
assert.equal(result.body.level, "新来的住客");
result = await payload(await request("/api/demo/activation", {passcode: "wrong", enabled: true}, demoEnv));
assert.equal(result.status, 401);
result = await payload(await request("/api/demo/activation", {passcode: "demo-owner", enabled: true}, demoEnv));
assert.equal(result.body.activation.active, true);
result = await payload(await request("/api/blackboard/today", undefined, demoEnv));
assert.equal(result.status, 200);
result = await payload(await request("/api/demo/activation", {passcode: "demo-owner", enabled: false}, demoEnv));
assert.equal(result.body.activation.active, false);
result = await payload(await request("/api/room", {room: "orchard", message: "测试"}, demoEnv));
assert.equal(result.status, 403);

const syncEnv = {...baseEnv, ALLOW_UNAUTHENTICATED: "false", AUTH_MODE: "passcode", SYNC_SECRET: "sync-secret", SESSION_SECRET: "sync-session", OWNER_PASSCODE: "owner"};
const syncRequest = (path, body) => handleRequest(new Request(`https://owner.example${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: {"content-type": "application/json", "x-cozy-sync-key": "sync-secret"},
  body: body === undefined ? undefined : JSON.stringify(body)
}), syncEnv);
result = await payload(await syncRequest("/api/sync/import", {data: {estate_state: {xp: 9, streak: 0, level: "云端住客", travel: {history: []}, wall_photos: []}}}));
assert.equal(result.status, 200);
result = await payload(await syncRequest("/api/sync/export"));
assert.equal(result.body.data.estate_state.level, "云端住客");
result = await payload(await syncRequest("/api/backup/status"));
assert.equal(result.body.backup.storage, "kv-only");
const backupKv = new MemoryKV();
const backedSyncEnv = {...syncEnv, COZY_BACKUP: backupKv};
const backedRequest = (path, body) => handleRequest(new Request(`https://owner.example${path}`, {
  method: body === undefined ? "GET" : "POST", headers: {"content-type": "application/json", "x-cozy-sync-key": "sync-secret"},
  body: body === undefined ? undefined : JSON.stringify(body)
}), backedSyncEnv);
result = await payload(await backedRequest("/api/sync/import", {data: {estate_state: {xp: 10, streak: 0, level: "已备份", travel: {history: []}, wall_photos: []}}}));
assert.equal(result.status, 200);
assert.ok([...backupKv.values.keys()].some(key => key.startsWith("state-versions/estate_state/")));
result = await payload(await backedRequest("/api/backup/run", {}));
assert.equal(result.body.backup.storage, "backup-kv");
assert.ok([...backupKv.values.keys()].some(key => key.startsWith("full-snapshots/")));

console.log("cloud worker test ok: auth; KV; cross-device merge/tombstones; memory; model fallback; demo reset/seed/AI gate; cloud sync; backup status");
