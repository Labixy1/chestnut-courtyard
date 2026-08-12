import assert from "node:assert/strict";
import {handleRequest} from "../cloudflare/worker.js";
import {memoryContext} from "../cloudflare/state.js";

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
assert.equal(result.body.memory.cards[0].status, "candidate");

// Companion memory stays room-scoped, sparse, and avoids recent reuse.
await request("/api/memory/event", {event: {id: "companion-pref", source: "butler", type: "preference", content: "树洞陪聊不要每次追问，也不要说套话", summary: "树洞陪聊不要每次追问，也不要说套话", explicit: true, scope: "companion_style"}});
let companionState = await memoryContext(baseEnv, "heart_companion", {query: "今晚只想聊聊天"});
const companionCardId = companionState.selected_memory_ids[0];
result = await payload(await request("/api/memory/action", {action: "card_scope", id: companionCardId, scope: "record_only"}));
assert.equal(result.body.card.scope, "record_only");
await request("/api/memory/action", {action: "card_scope", id: companionCardId, scope: "companion_style"});
await request("/api/memory/event", {event: {id: "learning-table", source: "butler", type: "preference", content: "学习资料对比时我希望优先使用表格", summary: "学习资料对比时我希望优先使用表格", explicit: true, scope: "learning_format"}});
await request("/api/memory/event", {event: {id: "heart-work-1", source: "heart_hollow", content: "最近工作项目让我反复权衡方向", summary: "树洞对话已封存", sensitivity: "sealed", scope: "heart_only"}});
await request("/api/memory/event", {event: {id: "heart-work-2", source: "heart_hollow", content: "今天开会后又开始担心职业选择", summary: "树洞对话已封存", sensitivity: "sealed", scope: "heart_only"}});
await request("/api/memory/event", {event: {id: "travel-hz-1", source: "travel", type: "travel_reflection", content: "在西湖边散步时终于慢了下来", summary: "杭州旅行让我重新感受到慢下来的轻松", layer: "long", scope: "travel_only", room_id: "trip-hz"}});
const butlerMemory = await memoryContext(baseEnv, "butler", {query: "帮我整理今天的学习计划"});
assert.equal(JSON.stringify(butlerMemory).includes("西湖"), false);
assert.equal(JSON.stringify(butlerMemory).includes("工作项目"), false);
const firstHeartMemory = await memoryContext(baseEnv, "heart_companion", {query: "最近工作总是让我很累"});
assert.ok(firstHeartMemory.selected_memory_ids.length <= 2);
assert.ok(firstHeartMemory.selected_memory_ids.includes("inner:work"));
assert.equal(JSON.stringify(firstHeartMemory).includes("最近工作项目"), false);
assert.equal(JSON.stringify(firstHeartMemory).includes("优先使用表格"), false);
const secondHeartMemory = await memoryContext(baseEnv, "heart_companion", {query: "最近工作还是让我很累", recentIds: firstHeartMemory.selected_memory_ids});
assert.equal(secondHeartMemory.selected_memory_ids.some(id => firstHeartMemory.selected_memory_ids.includes(id)), false);
const travelMemory = await memoryContext(baseEnv, "travel_companion", {query: "这次杭州旅行让我有什么变化", roomId: "trip-hz"});
assert.ok(travelMemory.selected_memory_ids.length <= 2);
assert.ok(travelMemory.selected_memory_ids.includes("travel-hz-1"));
result = await payload(await request("/api/memory"));
assert.equal(result.body.memory.events.some(item => item.source === "heart_hollow"), false);
assert.deepEqual(result.body.memory.sealed, []);

let companionTravelCalls = 0;
const companionEnv = {
  ...baseEnv,
  AI: {run: async (_model, input) => {
    const prompt = input.messages?.[0]?.content || "";
    if (prompt.includes("房间：heart_hollow")) return {response: JSON.stringify({
      reply: "你不是想把难过讲漂亮，只是想有人真的听懂这次委屈。", mode: "dialogue", response_style: "reframe",
      growth_signal: {should_grow: false, title: "", hint: "", nourishment: 1}
    })};
    if (prompt.includes("房间：travel")) {
      companionTravelCalls += 1;
      if (!prompt.includes("上一版把归档摘要和陪伴回应")) return {response: JSON.stringify({summary: "西湖边散步让我慢下来", reply: "西湖边散步让我慢下来", response_style: "listen", title: "杭州"})};
      return {response: JSON.stringify({summary: "西湖边散步让我慢下来", reply: "这份轻松不必马上变成道理，先让它多停一会儿。", response_style: "lighten", title: "杭州"})};
    }
    return {response: JSON.stringify({reply: "ok"})};
  }}
};
result = await payload(await request("/api/room", {room: "travel", message: "在西湖边散步时终于慢了下来", context: {trip_id: "trip-hz", commit: false}}, companionEnv));
assert.equal(result.body.memory_event, null);
assert.notEqual(result.body.result.summary, result.body.result.reply);
assert.equal(result.body.result.response_style, "lighten");
result = await payload(await request("/api/room", {room: "travel", message: "在西湖边散步时终于慢了下来", context: {trip_id: "trip-hz", commit: true, latest_entry: "这次我没有赶行程", memory_event_id: "travel-committed"}}, companionEnv));
assert.equal(result.body.memory_event.id, "travel-committed");
assert.equal(result.body.memory_event.scope, "travel_only");
assert.ok(companionTravelCalls >= 4);
result = await payload(await request("/api/room", {room: "heart_hollow", message: "这次被误解后我很委屈", context: {mode: "dialogue", current_text: "这次被误解后我很委屈", memory_event_id: "heart-committed", recent_reply_styles: ["listen"]}}, companionEnv));
assert.equal(result.body.result.response_style, "reframe");
assert.equal(result.body.memory_event.sensitivity, "sealed");
assert.equal((await kv.get("memory:events", "json")).some(item => item.id === "heart-committed"), false);
assert.equal((await kv.get("memory:sealed", "json")).some(item => item.id === "heart-committed"), true);

result = await payload(await request("/api/assistant", {message: "新增一个分类：AI评测"}));
assert.equal(result.status, 200);
assert.match(result.body.reply, /已经完成/);
assert.equal(result.body.tool_results[0].ok, true);
result = await payload(await request("/api/state"));
assert.deepEqual(result.body.state.custom_categories, ["AI评测"]);

let latestOrchardPrompt = "";
const gradingRubric = [
  {id:"comprehension",criterion:"题意理解与核心判断",max:20,scoring_scope:"只评价审题、立场和概念准确性。",full_credit:"准确回应题目并给出明确判断。",partial_credit:"方向相关但判断含糊。"},
  {id:"coverage",criterion:"任务完成与要点覆盖",max:30,scoring_scope:"只评价任务要求和必要角度是否覆盖。",full_credit:"完整覆盖明确任务。",partial_credit:"覆盖部分关键角度。"},
  {id:"reasoning",criterion:"推理链条与证据支撑",max:30,scoring_scope:"只评价已有观点的因果、比较、条件和证据。",full_credit:"推理链清楚且有支撑。",partial_credit:"观点相关但展开不足。"},
  {id:"transfer",criterion:"边界意识与迁移应用",max:20,scoring_scope:"评价真实判断、验证和边界。",full_credit:"能支持真实决策并说明边界。",partial_credit:"已有行动方向但缺判断标准。"}
];
const evaluationReference=["按风险分层定义真实任务","覆盖超时和越权等失败路径","记录每次工具调用产生的副作用","建立固定回归集并设置通过阈值"];
const aiEnv = {
  ...baseEnv,
  AI: {run: async (_model, input) => {
    const prompt = input.messages?.[0]?.content || "";
    if (prompt.includes("产品黑板出题人")) return {response: JSON.stringify({
      title: "评测边界", question: "如何为一个会调用工具的 Agent 构建评测集？", types: ["AI评测"],
      materials: ["关注任务成功率与副作用"], standard_points: ["按风险分层定义真实任务", "覆盖超时和越权等失败路径", "记录每次工具调用产生的副作用", "建立固定回归集并设置通过阈值"]
    })};
    if (prompt.includes("grade-blackboard-answer Skill")) return {response: JSON.stringify({
      score_breakdown: [
        {rubric_id:"comprehension",criterion:"题意理解与核心判断",max:20,awarded:16,evidence:"任务成功率",reason:"抓住了评测需要判断任务结果这一核心方向。",teaching:"把立场补成先定义真实任务，再判断成功率是否提升。"},
        {rubric_id:"coverage",criterion:"任务完成与要点覆盖",max:30,awarded:8,evidence:"任务成功率",reason:"覆盖了结果指标，但失败路径、副作用和回归集还没有出现。",teaching:"补写失败路径、副作用和固定回归集三个必要角度。"},
        {rubric_id:"reasoning",criterion:"推理链条与证据支撑",max:30,awarded:5,evidence:"先看任务成功率",reason:"提出了一个指标，但没有解释为什么它能代表功能变好。",teaching:"用因为任务成功率直接对应用户是否完成目标来解释指标选择。"},
        {rubric_id:"transfer",criterion:"边界意识与迁移应用",max:20,awarded:6,evidence:"任务成功率",reason:"已有可观察信号，但没有样本分层、阈值或停止条件。",teaching:"按风险分层测试并设置每层成功率阈值和停止条件。"}
      ], score_summary: "已经抓住任务成功率，但失败路径和副作用还没有形成可执行评测。",
      requirement_map: [
        {reference_point:evaluationReference[0],relation:"partial",evidence:"任务成功率",assessment:"已经提出成功标准，但还没有按风险分层定义真实任务。",teaching:"按风险分层抽取真实任务样本，并为每层设置通过阈值。"},
        {reference_point:evaluationReference[1],relation:"not_covered",evidence:"",assessment:"原答案没有超时、越权或工具失败样本。",teaching:"增加超时和越权测试，记录失败率与人工接管率。"},
        {reference_point:evaluationReference[2],relation:"not_covered",evidence:"",assessment:"原答案没有记录工具调用后的数据变化。",teaching:"记录每次工具调用产生的副作用，并设置严重事故为零的阈值。"},
        {reference_point:evaluationReference[3],relation:"not_covered",evidence:"",assessment:"原答案没有固定回归集或通过阈值。",teaching:"建立固定回归样本，并设置版本上线的通过阈值。"}
      ], strengths:[{evidence:"任务成功率",why_good:"这是一个能直接观察任务结果的指标，比泛泛说体验更好更可核验。"}],direction:"partly_correct",correction_path:"保留任务成功率，先定义真实任务和分层，再加入失败、副作用与回归阈值。",priority_fix:"先按风险分层建立任务样本，并为每层设置成功率阈值。",
      minimal_revision:"我会先看任务成功率，并按风险分层抽取真实任务，加入超时和越权样本，同时记录工具调用副作用和人工接管率。",next_question:"设计一个越权用例",next_question_reference:["写明越权目标、预期阻断和审计记录"]
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
assert.equal(result.body.question.rubric_version, 3);
assert.deepEqual(result.body.question.rubric.map(item=>item.id), ["comprehension","coverage","reasoning","transfer"]);
assert.equal(result.body.question.rubric.every(item=>item.score_bands.length===5), true);
assert.equal(result.body.question.task_type, "decision");
const invalidQuestionEnv = {...baseEnv, COZY_STATE: new MemoryKV(), AI: {run: async () => ({response: JSON.stringify({
  title: "空壳题", question: "如果模型只返回格式要求，你会怎样处理这个无效题目并确保用户拿到当天可回答的新题？", types: ["产品场景"],
  materials: [], standard_points: ["4到7条参考答案要点"]
})})}};
result = await payload(await request("/api/blackboard/today", undefined, invalidQuestionEnv));
assert.equal(result.status, 200);
assert.equal(result.body.question.provider, "deterministic-fallback");
assert.ok(result.body.question.standard_points.length >= 4);
assert.equal(result.body.question.standard_points.some(item => /参考答案要点/.test(item)), false);
result = await payload(await request("/api/room", {room: "blackboard", message: "我会先看任务成功率", context: {intent:"grade_answer",question: "如何构建评测集？",reference:evaluationReference,rubric:gradingRubric}}, aiEnv));
assert.equal(result.body.result.requirement_map.length, 4);
assert.equal(result.body.result.score_breakdown[1].criterion,"任务完成与要点覆盖");
assert.equal(result.body.result.score_breakdown[0].band,"solid");
assert.match(result.body.result.grading_policy,/同一缺陷只归一个维度/);

let blackboardRetryAttempts = 0;
const redTeamReference=["定义外部攻击范围","覆盖关键风险","建立漏洞处置闭环"];
const blackboardRetryEnv = {...baseEnv, AI: {run: async () => {
  blackboardRetryAttempts += 1;
  if (blackboardRetryAttempts === 1) return {response: JSON.stringify({
    score_breakdown: ["问题理解", "方案完整", "验证与指标", "风险与回滚"].map(criterion => ({criterion, max: 25, awarded: 0, reason: "没有具体产品信息，无法评估"})),
    score_summary: "产品信息不足", diagnosis: ["缺乏产品信息"], polished_answer: "产品信息不足", standard_points: []
  })};
  return {response: JSON.stringify({
    score_breakdown: [
      {rubric_id:"comprehension",criterion:"题意理解与核心判断",max:20,awarded:18,evidence:"准备不同类别的攻击问题",reason:"准确把外部评测理解为主动设计攻击问题。",teaching:"把核心判断补成通过独立红队暴露高风险失败。"},
      {rubric_id:"coverage",criterion:"任务完成与要点覆盖",max:30,awarded:21,evidence:"源码、数据泄露和伦理误导",reason:"覆盖三类关键风险，但漏洞处置闭环尚未涉及。",teaching:"补写漏洞分级、修复责任和复测三个环节。"},
      {rubric_id:"reasoning",criterion:"推理链条与证据支撑",max:30,awarded:10,evidence:"探测源码、数据泄露和伦理误导",reason:"列出了测试对象，但还没解释每类风险如何判断严重程度。",teaching:"为每类风险定义严重度，并说明为什么达到该等级就阻断上线。"},
      {rubric_id:"transfer",criterion:"边界意识与迁移应用",max:20,awarded:7,evidence:"不同类别的攻击问题",reason:"已经有测试动作，但缺少通过阈值、处置和复测条件。",teaching:"设置严重漏洞为零的上线阈值，并记录修复时限和复测结果。"}
    ], score_summary: "已覆盖三类红队测试，但分级、修复和复测还没有闭环", requirement_map: [
      {reference_point:redTeamReference[0],relation:"covered",evidence:"不同类别的攻击问题",assessment:"已经明确用多类攻击问题扩大外部攻击范围。",teaching:"按数据、权限和内容安全分层记录每类样本数量。"},
      {reference_point:redTeamReference[1],relation:"covered",evidence:"源码、数据泄露和伦理误导",assessment:"已经覆盖源码、数据与伦理三类关键风险。",teaching:"为三类风险分别设置严重等级和通过阈值。"},
      {reference_point:redTeamReference[2],relation:"not_covered",evidence:"",assessment:"原答案没有漏洞分级、修复责任人与复测流程。",teaching:"定义漏洞分级、修复时限和同样本复测的通过条件。"}
    ],strengths:[{evidence:"源码、数据泄露和伦理误导",why_good:"把抽象的安全评测拆成了三类可执行测试对象。"}],direction:"partly_correct",correction_path:"保留三类攻击对象，下一步按严重度分级，再补修复责任和复测通过条件。",priority_fix:"补上漏洞分级、修复时限和复测通过条件。",minimal_revision:"准备不同类别的攻击问题，探测源码、数据泄露和伦理误导；再按严重度分级，明确修复时限，并用同一批样本复测到达通过阈值。"
  })};
}}};
result = await payload(await request("/api/room", {room: "blackboard", message: "准备不同类别的攻击问题，探测源码、数据泄露和伦理误导", context: {intent: "grade_answer", question: "假设你负责一款 AI 产品，如何设计外部评测机制？",reference:redTeamReference,rubric:gradingRubric}}, blackboardRetryEnv));
assert.equal(result.status, 200);
assert.equal(blackboardRetryAttempts, 2);
assert.equal(result.body.result.score_breakdown.reduce((sum, item) => sum + item.awarded, 0), 56);
assert.equal(result.body.result.requirement_map[0].evidence, "不同类别的攻击问题");

let commercialGradeAttempts=0;
const commercialGradeEnv={...baseEnv,AI:{run:async()=>{
  commercialGradeAttempts+=1;
  if(commercialGradeAttempts===1)return{response:JSON.stringify({
    score_breakdown:["问题理解","方案完整","验证与指标","风险与回滚"].map(criterion=>({criterion,max:25,awarded:5,reason:"未提及用户价值、付费意愿和单位经济。"})),
    score_summary:"未提及用户价值、付费意愿和单位经济。",requirement_map:[
      {requirement:"用户价值",status:"missing",evidence:"",assessment:"没有用户价值判断。",action:"访谈目标用户并记录愿意持续使用的核心任务。"},
      {requirement:"付费意愿",status:"missing",evidence:"",assessment:"没有付费验证。",action:"设置真实价格测试并统计付费转化率。"},
      {requirement:"单位经济",status:"missing",evidence:"",assessment:"没有成本收益计算。",action:"计算单次收入减模型调用成本后的贡献毛利。"}
    ],priority_fix:"设置真实价格测试并统计转化率。",minimal_revision:"我会验证用户价值、付费意愿和单位经济模型，再设置真实价格测试并统计转化率。"
  })};
  return{response:JSON.stringify({
    score_breakdown:[
      {rubric_id:"comprehension",criterion:"题意理解与核心判断",max:20,awarded:18,evidence:"验证用户价值、付费意愿和单位经济模型",reason:"准确抓住商业可行性的三个判断层次。",teaching:"把立场补成价值成立后再验证支付与成本。"},
      {rubric_id:"coverage",criterion:"任务完成与要点覆盖",max:30,awarded:26,evidence:"用户价值、付费意愿和单位经济模型",reason:"三个必要角度都已覆盖，没有把商业判断缩成使用次数。",teaching:"为三个角度分别定义测试方法和判断信号。"},
      {rubric_id:"reasoning",criterion:"推理链条与证据支撑",max:30,awarded:9,evidence:"我会验证用户价值",reason:"提出了验证对象，但没有解释三个层次为何相互依赖。",teaching:"用因为价值、支付和成本共同决定可持续性来连接三个层次。"},
      {rubric_id:"transfer",criterion:"边界意识与迁移应用",max:20,awarded:7,evidence:"单位经济模型",reason:"意识到成本收益，但缺少真实价格测试和停止阈值。",teaching:"设置真实价格测试，计算贡献毛利并定义停止阈值。"}
    ],score_summary:"三个商业判断维度都已覆盖，主要缺口是测试动作和停止阈值。",requirement_map:[
      {reference_point:"验证用户价值",relation:"partial",evidence:"用户价值",assessment:"已识别验证对象，但没有说明用什么用户任务验证。",teaching:"访谈目标用户并观察核心任务完成率与重复使用率。"},
      {reference_point:"验证付费意愿",relation:"partial",evidence:"付费意愿",assessment:"已识别付费判断，但没有真实价格测试。",teaching:"设置两个真实价格档进行支付测试并统计付费转化率。"},
      {reference_point:"计算单位经济",relation:"partial",evidence:"单位经济模型",assessment:"已考虑成本收益，但没有计算口径和停止线。",teaching:"计算每次付费收入减模型调用成本后的贡献毛利，并设置最低阈值。"}
    ],strengths:[{evidence:"用户价值、付费意愿和单位经济模型",why_good:"同时考虑了价值、支付和成本，判断框架是完整且相关的。"}],direction:"partly_correct",correction_path:"保留三个判断层次，先补验证顺序，再为每层增加测试动作、判断信号和停止条件。",priority_fix:"先跑真实价格测试，同时记录付费转化率和单次贡献毛利。",minimal_revision:"我会先验证用户价值、付费意愿和单位经济模型：用核心任务完成率和重复使用率判断价值，用真实价格测试统计付费转化率，再计算每次收入减模型调用成本后的贡献毛利；若低于设定阈值就停止或降级。"
  })};
}}};
result=await payload(await request("/api/room",{room:"blackboard",message:"我会验证用户价值、付费意愿和单位经济模型",context:{intent:"grade_answer",question:"一个 AI 功能调用成本较高时，如何验证商业可行性？",reference:["验证用户价值","验证付费意愿","计算单位经济"],rubric:gradingRubric}},commercialGradeEnv));
assert.equal(commercialGradeAttempts,2);
assert.equal(result.body.result.requirement_map.every(item=>item.relation==="partial"),true);
assert.match(result.body.result.minimal_revision,/用户价值、付费意愿和单位经济模型/);

let alternativeGradeAttempts=0;
const alternativeAnswer="我不会直接A/B放量，而是先让新模型只在影子模式处理真实流量，离线比较错误率和成本，达到阈值再逐步灰度。";
const alternativeReference=["先进行线上A/B测试","收集用户主观反馈"];
const alternativeGradeEnv={...baseEnv,AI:{run:async()=>{
  alternativeGradeAttempts+=1;
  return{response:JSON.stringify({
    score_breakdown:[
      {rubric_id:"comprehension",criterion:"题意理解与核心判断",max:20,awarded:19,evidence:"不会直接A/B放量",reason:"准确识别直接放量会把验证风险暴露给真实用户。",teaching:"把立场补成先无用户影响验证，再逐步扩大暴露。"},
      {rubric_id:"coverage",criterion:"任务完成与要点覆盖",max:30,awarded:24,evidence:"影子模式处理真实流量",reason:"虽然没有照抄线上A/B，但影子流量同样完成新旧方案比较。",teaching:"补充灰度阶段的用户反馈记录，覆盖主观体验角度。"},
      {rubric_id:"reasoning",criterion:"推理链条与证据支撑",max:30,awarded:25,evidence:"离线比较错误率和成本，达到阈值再逐步灰度",reason:"验证指标、通过条件和放量顺序形成了完整因果链。",teaching:"再解释错误率和成本阈值如何根据任务风险分层设置。"},
      {rubric_id:"transfer",criterion:"边界意识与迁移应用",max:20,awarded:18,evidence:"达到阈值再逐步灰度",reason:"给出了低风险验证、阈值和渐进上线边界，可以直接用于决策。",teaching:"记录灰度中的异常率，并定义异常上升时的回滚条件。"}
    ],score_summary:"采用影子模式走了比直接A/B更谨慎且有效的验证路径，主要可补用户反馈与分层阈值。",requirement_map:[
      {reference_point:alternativeReference[0],relation:"equivalent",evidence:"影子模式处理真实流量，离线比较错误率和成本",assessment:"没有直接线上A/B，但完成了新旧模型在真实分布上的可比验证，作用等价且风险更低。",teaching:"把影子模式结果与旧模型做对照，并记录同一任务集的错误率和成本。"},
      {reference_point:alternativeReference[1],relation:"not_covered",evidence:"",assessment:"原答案还没有收集用户主观体验或可理解性反馈。",teaching:"在小流量灰度中访谈用户并记录满意度与问题类型。"}
    ],strengths:[{evidence:"离线比较错误率和成本，达到阈值再逐步灰度",why_good:"把比较指标、通过线和上线节奏连成了可执行决策链。"}],direction:"correct",correction_path:"保留影子模式路径，补上按风险分层的阈值和灰度阶段用户反馈即可。",priority_fix:"为高低风险任务分别设置错误率阈值，并记录灰度用户反馈。",minimal_revision:"我不会直接A/B放量，而是先让新模型只在影子模式处理真实流量，按任务风险离线比较错误率和成本；达到分层阈值后再逐步灰度，同时记录用户反馈，异常率上升就回滚。"
  })};
}}};
result=await payload(await request("/api/room",{room:"blackboard",message:alternativeAnswer,context:{intent:"grade_answer",question:"怎样验证新模型是否值得上线？",reference:alternativeReference,rubric:gradingRubric}},alternativeGradeEnv));
assert.equal(alternativeGradeAttempts,1);
assert.equal(result.body.result.requirement_map[0].relation,"equivalent");
assert.ok(result.body.result.score_breakdown.find(item=>item.rubric_id==="coverage").awarded>=20);
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
assert.match(latestOrchardPrompt, /记忆只调整讲解方式，不替代事实判断/);

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
const isDirectNewsFeed = value => ["openai.com/news/rss.xml", "blog.google/technology/ai/rss/", "deepmind.google/blog/rss.xml", "theverge.com/rss/ai-artificial-intelligence", "techcrunch.com/category/artificial-intelligence/feed", "technologyreview.com/topic/artificial-intelligence/feed", "github.blog/ai-and-ml/feed", "aws.amazon.com/blogs/machine-learning/feed", "export.arxiv.org/api/query", "qbitai.com/feed/", "gateway.36kr.com/api/mis/nav/newsflash/flow", "api.rss2json.com/v1/api.json"].some(part => String(value).includes(part));
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
  if (String(url).includes("openai.com/news/rss.xml")) return new Response(newsXml("OpenAI launches an important model update", "https://news.example/model", "The model adds new reasoning capabilities at a lower price."), {status: 200});
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
assert.equal(firstNoticeReport.hot_items[0].link, "https://news.example/model");
assert.match(firstNoticeReport.hot_items[0].ai_summary, /[\u4e00-\u9fff]/);
assert.equal((await payload(await request("/api/data?key=notice_reports", undefined, aiEnv))).body.reports.length, 1);

const chineseMediaEnv = {...aiEnv, COZY_STATE: new MemoryKV()};
globalThis.fetch = async url => {
  if (String(url).includes("gateway.36kr.com/api/mis/nav/newsflash/flow")) return new Response(JSON.stringify({code: 0, data: {itemList: [{itemId: 12345, templateMaterial: {publishTime: Date.now(), widgetTitle: "36氪测试 AI 产品更新", widgetContent: "一家 AI 产品发布了新的智能体工作流能力。"}}]}}), {status: 200, headers: {"content-type": "application/json"}});
  return new Response("upstream unavailable", {status: 503});
};
result = await payload(await request("/api/weekly/run", {force: true}, chineseMediaEnv));
await Promise.all(pendingTasks.splice(0));
const chineseMediaReport = (await payload(await request("/api/data?key=notice_reports", undefined, chineseMediaEnv))).body.reports[0];
assert.equal(chineseMediaReport.hot_items[0].media, "36氪");
assert.match(chineseMediaReport.hot_items[0].link, /36kr\.com\/newsflashes\/12345/);
globalThis.fetch = nativeFetch;

const rssProxyEnv = {...aiEnv, COZY_STATE: new MemoryKV()};
globalThis.fetch = async url => {
  const value=String(url);
  if(value.includes("api.rss2json.com/v1/api.json")&&decodeURIComponent(value).includes("qbitai.com/feed/")) return new Response(JSON.stringify({status:"ok",items:[{title:"量子位测试 AI 更新",link:"https://www.qbitai.com/2026/08/test.html",pubDate:"2026-08-11 20:00:00",description:"量子位报道了一项新的智能体产品能力。"}]}),{status:200,headers:{"content-type":"application/json"}});
  return new Response("upstream unavailable",{status:503});
};
result = await payload(await request("/api/weekly/run", {force: true}, rssProxyEnv));
await Promise.all(pendingTasks.splice(0));
const rssProxyReport=(await payload(await request("/api/data?key=notice_reports",undefined,rssProxyEnv))).body.reports[0];
assert.equal(rssProxyReport.hot_items[0].media,"量子位");
assert.match(rssProxyReport.hot_items[0].link,/qbitai\.com/);
globalThis.fetch=nativeFetch;

const todayShanghai = new Date().toLocaleDateString("en-CA", {timeZone: "Asia/Shanghai"});
const newsVariant = [...Array(12).keys()].map(index => `related-${index}`).find(variant => [...`${todayShanghai}|${variant}`].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3 === 0);
const plainVariant = [...Array(12).keys()].map(index => `plain-${index}`).find(variant => [...`${todayShanghai}|${variant}`].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3 !== 0);
result = await payload(await request(`/api/blackboard/today?refresh=${newsVariant}`, undefined, aiEnv));
assert.equal(result.status, 200);
assert.equal(result.body.question.alignment_version, 4);
assert.match(result.body.question.question, /OpenAI launches an important model update/);
assert.match(result.body.question.materials.join(" "), /OpenAI launches an important model update/);
assert.equal(result.body.question.related_notice.title, "OpenAI launches an important model update");
result = await payload(await request(`/api/blackboard/today?refresh=${plainVariant}`, undefined, aiEnv));
assert.equal(result.body.question.alignment_version, 4);
assert.equal(result.body.question.related_notice, null);
assert.doesNotMatch(result.body.question.question, /OpenAI launches an important model update/);
assert.equal((await payload(await request("/api/automation", undefined, aiEnv))).body.automation.jobs.notice_report.status, "completed");

globalThis.fetch = async (url, options) => {
  if (String(url).includes("openai.com/news/rss.xml")) return new Response(newsXml("OpenAI launches an important model update", "https://news.example/model", "The model adds new reasoning capabilities at a lower price."), {status: 200});
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
const degradedAutomation=(await payload(await request("/api/automation",undefined,aiEnv))).body.automation.jobs.notice_report;
assert.equal(degradedAutomation.status,"completed");
assert.equal(degradedAutomation.degraded,true);
assert.match(degradedAutomation.message,/资讯源暂时不可用/);
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
assert.equal(sourceFallbackReport.hot_items[0].translation_zh, "");
assert.equal(sourceFallbackReport.hot_items[0].ai_summary, "");
assert.doesNotMatch(sourceFallbackReport.hot_items[0].summary, /&lt;|href=|<a/);

const balancedFallbackEnv = {...baseEnv, COZY_STATE: new MemoryKV(), COZY_NEWS_AI_TIMEOUT_MS: "10", AI: {run: async () => new Promise(() => {})}};
globalThis.fetch = async url => {
  const value=String(url);
  if(value.includes("openai.com/news/rss.xml"))return new Response(newsXml("OpenAI international model update", "https://openai.com/index/international-update", "A concrete international model capability update."),{status:200});
  if(value.includes("gateway.36kr.com/api/mis/nav/newsflash/flow"))return new Response(JSON.stringify({code:0,data:{itemList:[{itemId:67890,templateMaterial:{publishTime:Date.now(),widgetTitle:"36氪国内 AI 产品更新",widgetContent:"国内团队发布了新的智能体产品能力。"}}]}}),{status:200,headers:{"content-type":"application/json"}});
  return new Response("upstream unavailable",{status:503});
};
await payload(await request("/api/weekly/run", {force:true}, balancedFallbackEnv));
await Promise.all(pendingTasks.splice(0));
const balancedReport=(await payload(await request("/api/data?key=notice_reports",undefined,balancedFallbackEnv))).body.reports[0];
const balancedItems=[...balancedReport.hot_items,...balancedReport.sections.flatMap(section=>section.items)];
assert.ok(balancedItems.some(item=>String(item.link).includes("openai.com")));
assert.ok(balancedItems.some(item=>item.media==="36氪"));
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
