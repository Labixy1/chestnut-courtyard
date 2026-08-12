import {DEFAULT_DATA} from "./default_data.js";

export const DATA_KEYS = new Set(Object.keys(DEFAULT_DATA));
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const MEMORY_EXPORT_KEYS = ["memory:events", "memory:sealed", "memory:profile", "memory:categories", "memory:overrides", "memory:distillation", "memory:forgotten"];
const SEALED_MEMORY_SOURCES = new Set(["heart_hollow", "private_wing", "memory_nook"]);
const MEMORY_POLICY = {
  repeat_to_promote: 3,
  preference_repeat_to_confirm: 2,
  auto_category_min_cards: 3,
  sealed_context: "never_injected",
  max_learning_preferences_per_reply: 5,
  max_companion_memories_per_reply: 2,
  recent_use_exclusion: true,
  diversity_guard: "记忆只调整讲解方式，不替代事实判断；陪伴场景也不屏蔽相反观点，不把一次经历反复定义成主人"
};

export function requireState(env) {
  if (!env.COZY_STATE) throw new Error("COZY_STATE KV 尚未绑定");
  return env.COZY_STATE;
}

export async function readState(env, key, fallback) {
  const value = await requireState(env).get(key, "json");
  return value == null ? clone(fallback) : value;
}

export async function writeState(env, key, value, options) {
  await requireState(env).put(key, JSON.stringify(value), options);
  return value;
}

export async function readData(env, key) {
  if (!DATA_KEYS.has(key)) throw new Error("不支持的数据区域");
  return readState(env, `data:${key}`, DEFAULT_DATA[key]);
}

async function archiveDataVersion(env, key, value, revision) {
  if (!env.COZY_PRIVATE && !env.COZY_BACKUP) return false;
  const stamp = now();
  const objectKey = `state-versions/${key}/${stamp.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`;
  const archived = JSON.stringify({key, revision, archived_at: stamp, value});
  if (env.COZY_PRIVATE) {
    await env.COZY_PRIVATE.put(objectKey, archived, {
      httpMetadata: {contentType: "application/json; charset=utf-8"},
      customMetadata: {dataKey: key, revision: String(revision)}
    });
  } else {
    await env.COZY_BACKUP.put(objectKey, archived);
  }
  await writeState(env, "backup:status", {ok: true, storage: env.COZY_PRIVATE ? "r2" : "backup-kv", last_backup_at: stamp, last_key: key, last_revision: revision});
  return true;
}

export async function writeData(env, key, value) {
  if (!DATA_KEYS.has(key)) throw new Error("不支持的数据区域");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("数据格式不正确");
  const metaKey = `data-meta:${key}`;
  const previous = await readState(env, metaKey, {revision: 0});
  const revision = Number(previous.revision || 0) + 1;
  await writeState(env, `data:${key}`, value);
  await writeState(env, metaKey, {revision, updated_at: now()});
  if (env.COZY_PRIVATE || env.COZY_BACKUP) {
    try { await archiveDataVersion(env, key, value, revision); }
    catch (error) {
      await writeState(env, "backup:status", {ok: false, storage: "r2", last_error_at: now(), error: String(error.message || error).slice(0, 300)});
    }
  }
  return value;
}

export async function backupStatus(env) {
  const status = await readState(env, "backup:status", null);
  const storage = env.COZY_PRIVATE ? "r2" : env.COZY_BACKUP ? "backup-kv" : "kv-only";
  return status || {ok: false, storage, message: storage === "kv-only" ? "备份存储尚未绑定，当前只有 KV 主库" : "尚未生成备份"};
}

export async function exportCloudState(env) {
  const dataEntries = await Promise.all([...DATA_KEYS].map(async key => [key, await readData(env, key)]));
  const memoryEntries = await Promise.all(MEMORY_EXPORT_KEYS.map(async key => [key, await readState(env, key, null)]));
  return {
    version: 1,
    exported_at: now(),
    data: Object.fromEntries(dataEntries),
    memory: Object.fromEntries(memoryEntries.filter(([, value]) => value != null))
  };
}

export async function importCloudState(env, payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const data = input.data && typeof input.data === "object" ? input.data : {};
  const memory = input.memory && typeof input.memory === "object" ? input.memory : {};
  const imported = [];
  for (const key of DATA_KEYS) {
    if (data[key] && typeof data[key] === "object" && !Array.isArray(data[key])) {
      await writeData(env, key, data[key]);
      imported.push(key);
    }
  }
  for (const key of MEMORY_EXPORT_KEYS) {
    if (memory[key] != null) {
      await writeState(env, key, memory[key]);
      imported.push(key);
    }
  }
  await writeState(env, "sync:last_import", {at: now(), imported});
  return {ok: true, imported, imported_at: now()};
}

async function clearRuntimeState(env) {
  await Promise.all([
    writeState(env, "memory:events", []), writeState(env, "memory:sealed", []),
    writeState(env, "memory:profile", null), writeState(env, "memory:categories", []),
    writeState(env, "memory:overrides", {}), writeState(env, "memory:distillation", {status: "idle", recent_runs: []}),
    writeState(env, "memory:forgotten", []),
    writeState(env, "tasks:index", []), writeState(env, "automation:status", {last_check: "", jobs: {}})
  ]);
}

export async function resetDemoState(env) {
  for (const key of DATA_KEYS) await writeData(env, key, clone(DEFAULT_DATA[key]));
  await clearRuntimeState(env);
  await writeState(env, "demo:last_reset", {at: now()});
  return {ok: true, reset_at: now()};
}

export async function seedDemoState(env) {
  await resetDemoState(env);
  const estate = clone(DEFAULT_DATA.estate_state);
  estate.xp = 36;
  estate.level = "刚认识小院";
  estate.travel.history = [{id: "demo_trip", place: "杭州西湖", date: "2026-08-02", line: "傍晚沿湖走了一圈，重新注意到生活里的节奏。", file: "assets/travel/travel_postcard.webp", photos: []}];
  const reports = {version: 1, updated_at: now(), reports: [{
    id: "demo_report", generated_at: now(), week_start: "2026-08-03", week_end: "2026-08-09", focus_title: "AI 产品正在从回答问题转向完成任务",
    hot_items: [{id: "demo_news", title: "Agent 产品开始重视权限、记忆与结果验证", category: "产品与实践", media: "引导示例", published_at: "2026-08-09", original_summary: "示例资讯，用于体验公告板交互。", ai_summary: "真正影响产品体验的已经不只是模型回答质量，还包括工具权限、长期记忆、失败恢复和结果验证是否形成闭环。", link: "https://example.com/agent-product"}],
    sections: [], insights: ["能力越强，越需要明确权限边界和可追溯状态。"], advice: ["先选一个高频任务，把输入、执行、验证和失败恢复完整跑通，再扩展能力。"]
  }]};
  const questions = {version: 1, updated_at: now(), items: [{id: "demo_question", date: "2026-08-09", title: "Agent 权限边界", type: "Agent", question: "如果一个 AI 助手可以修改产品数据，你会怎样设计授权、确认和回滚机制？", standard_points: ["按风险拆分权限", "高风险操作二次确认", "保留审计与快照", "失败后可回滚"]}]};
  const localState = {version: 1, updated_at: now(), values: {
    cozy_orchard_seeds: [{id: "demo_seed", text: "AI 产品的记忆与权限怎样协同", category: "AI 产品系统", stage: 2, wateredDates: []}],
    cozy_notice_requests: [], cozy_blackboard_answers: []
  }};
  await Promise.all([
    writeData(env, "estate_state", estate), writeData(env, "notice_reports", reports),
    writeData(env, "daily_questions", questions), writeData(env, "local_state", localState)
  ]);
  await writeState(env, "demo:last_seed", {at: now()});
  return {ok: true, seeded_at: now()};
}

const stableSyncJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableSyncJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSyncJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

const syncRecordId = item => {
  if (item === null || typeof item !== "object") return `value:${JSON.stringify(item)}`;
  for (const key of ["id", "key", "url", "link", "source_url", "questionId", "question_id"]) {
    if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) return `${key}:${String(item[key]).trim()}`;
  }
  if (item.date || item.title) return `dated:${String(item.date || "")}|${String(item.title || "")}`;
  return `json:${stableSyncJson(item)}`;
};

const syncUpdatedAt = item => {
  if (!item || typeof item !== "object") return 0;
  const value = item.updatedAt || item.updated_at || item.modifiedAt || item.modified_at || item.createdAt || item.created_at || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function mergeArrayRecords(current, change, fieldTombstones, changedAt) {
  const records = new Map((Array.isArray(current) ? current : []).map(item => [syncRecordId(item), item]));
  const tombstones = {...(fieldTombstones || {})};
  const revive = new Set(Array.isArray(change.revive) ? change.revive.map(String) : []);
  for (const id of Array.isArray(change.deleted) ? change.deleted : []) {
    records.delete(String(id));
    tombstones[String(id)] = changedAt;
  }
  for (const item of Array.isArray(change.upserts) ? change.upserts : []) {
    const id = syncRecordId(item);
    const deletedAt = Date.parse(tombstones[id] || "") || 0;
    const itemTime = syncUpdatedAt(item);
    if (deletedAt && !revive.has(id) && (!itemTime || itemTime <= deletedAt)) continue;
    const existing = records.get(id);
    if (!existing || !syncUpdatedAt(existing) || !itemTime || itemTime >= syncUpdatedAt(existing)) records.set(id, item);
    delete tombstones[id];
  }
  return {value: [...records.values()], tombstones};
}

function mergeObjectRecords(current, change, fieldTombstones, changedAt) {
  const value = current && typeof current === "object" && !Array.isArray(current) ? {...current} : {};
  const tombstones = {...(fieldTombstones || {})};
  const revive = new Set(Array.isArray(change.revive) ? change.revive.map(String) : []);
  for (const key of Array.isArray(change.deleted) ? change.deleted : []) {
    delete value[String(key)];
    tombstones[String(key)] = changedAt;
  }
  const upserts = change.upserts && typeof change.upserts === "object" && !Array.isArray(change.upserts) ? change.upserts : {};
  for (const [key, item] of Object.entries(upserts)) {
    const deletedAt = Date.parse(tombstones[key] || "") || 0;
    const itemTime = syncUpdatedAt(item);
    if (deletedAt && !revive.has(key) && (!itemTime || itemTime <= deletedAt)) continue;
    const existing = value[key];
    if (existing === undefined || !syncUpdatedAt(existing) || !itemTime || itemTime >= syncUpdatedAt(existing)) value[key] = item;
    delete tombstones[key];
  }
  return {value, tombstones};
}

export async function mergeLocalState(env, input) {
  const current = await readData(env, "local_state");
  const next = {
    ...current,
    version: 2,
    updated_at: now(),
    values: {...(current.values || {})},
    tombstones: {...(current.tombstones || {})}
  };
  const payload = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const changes = payload.changes && typeof payload.changes === "object" ? payload.changes : null;
  if (!changes) {
    const values = payload.values && typeof payload.values === "object" && !Array.isArray(payload.values) ? payload.values : payload;
    next.values = {...next.values, ...values};
    return writeData(env, "local_state", next);
  }
  const changedAt = now();
  for (const [key, change] of Object.entries(changes)) {
    if (!change || typeof change !== "object") continue;
    if (change.type === "array") {
      const merged = mergeArrayRecords(next.values[key], change, next.tombstones[key], changedAt);
      next.values[key] = merged.value;
      next.tombstones[key] = merged.tombstones;
    } else if (change.type === "object") {
      const merged = mergeObjectRecords(next.values[key], change, next.tombstones[key], changedAt);
      next.values[key] = merged.value;
      next.tombstones[key] = merged.tombstones;
    } else if (Object.prototype.hasOwnProperty.call(change, "value")) {
      next.values[key] = change.value;
    }
  }
  return writeData(env, "local_state", next);
}

function uniqueItems(items, max = 150) {
  const seen = new Set();
  return items.filter(item => {
    const url = String(item?.source_url || item?.url || item?.link || "").trim().toLowerCase().replace(/#.*$/, "").replace(/\/$/, "");
    const key = url ? `url:${url}` : String(item?.id || item?.title || item?.name || item || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
}

export async function syncButlerState(env, patch) {
  const current = await readData(env, "butler_state");
  const listKeys = ["chest", "read_later", "watch_topics", "sources", "toolbox", "task_log", "custom_categories"];
  const next = {...current, version: 2, updated_at: now()};
  for (const key of listKeys) {
    if (Array.isArray(patch?.[key])) next[key] = uniqueItems(patch[key]);
  }
  return writeData(env, "butler_state", next);
}

export async function appendButlerItem(env, key, item) {
  const current = await readData(env, "butler_state");
  const list = uniqueItems([item, ...(Array.isArray(current[key]) ? current[key] : [])]);
  return syncButlerState(env, {[key]: list});
}

const cleanEvent = raw => {
  const created = now();
  return {
    id: String(raw?.id || `mem_${crypto.randomUUID()}`).slice(0, 120),
    date: String(raw?.date || created.slice(0, 10)).slice(0, 20),
    time: String(raw?.time || created.slice(11, 16)).slice(0, 10),
    source: String(raw?.source || raw?.context || "unknown").slice(0, 60),
    type: String(raw?.type || raw?.action || "note").slice(0, 80),
    layer: raw?.layer === "long" ? "long" : "short",
    content: String(raw?.content || "").slice(0, 12000),
    summary: String(raw?.summary || raw?.content || raw?.action || "一条行为记录").replace(/\s+/g, " ").trim().slice(0, 500),
    weight: Math.min(Math.max(Number(raw?.weight || 1), 1), 3),
    sensitivity: raw?.sensitivity === "sealed" || raw?.private === "sealed" ? "sealed" : "personal",
    remember: Boolean(raw?.remember),
    explicit: Boolean(raw?.explicit || raw?.confirmed),
    scope: ["learning_format", "topic_selection", "review_only", "record_only", "companion_style", "heart_only", "travel_only"].includes(raw?.scope) ? raw.scope
      : /preference|habit|routine|偏好|习惯|学习方式/i.test(`${raw?.type || ""} ${raw?.summary || ""}`) ? "learning_format"
      : /learning_interest|growth_question|学习关注/i.test(`${raw?.type || ""} ${raw?.summary || ""}`) ? "topic_selection"
      : "record_only",
    room_id: String(raw?.room_id || raw?.trip_id || "").slice(0, 160),
    created_at: String(raw?.created_at || created)
  };
};

const normalizedMemoryText = value => String(value || "").toLowerCase()
  .replace(/^(成长田关注|黑板答题|资讯笔记|交给阿栗|果园成长种子)[：:]\s*/u, "")
  .replace(/[^0-9a-z\u4e00-\u9fff]+/g, "")
  .slice(0, 320);

function stableMemoryHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function memorySignature(event) {
  const kind = /preference|habit|routine|偏好|习惯|学习方式/i.test(`${event.type} ${event.summary}`) ? "preference" : String(event.type || "fact");
  return `${kind}|${normalizedMemoryText(event.summary || event.content)}`;
}

function memoryKind(event) {
  const value = `${event.type} ${event.summary}`;
  if (/preference|偏好|喜欢|不喜欢|沟通方式|学习方式/i.test(value)) return "preference";
  if (/habit|routine|习惯|每天|每周/i.test(value)) return "routine";
  if (/goal|目标|方向|想要|计划/i.test(value)) return "goal";
  if (/project|项目|产品|系统/i.test(value)) return "project";
  if (/insight|复盘|洞察|发现|意识到/i.test(value)) return "insight";
  if (/experience|经历|旅行/i.test(value)) return "experience";
  return "fact";
}

export async function addMemoryEvents(env, input) {
  const rawItems = (Array.isArray(input) ? input : [input]).filter(Boolean).slice(0, 100);
  const forgotten = new Set((await readState(env, "memory:forgotten", [])).map(item => String(item?.id || item)));
  const personal = await readState(env, "memory:events", []);
  const sealed = await readState(env, "memory:sealed", []);
  const personalMap = new Map(personal.filter(item => item.sensitivity !== "sealed" && !SEALED_MEMORY_SOURCES.has(item.source)).map(item => [item.id, item]));
  const sealedMap = new Map(sealed.map(item => [item.id, item]));
  personal.filter(item => item.sensitivity === "sealed" || SEALED_MEMORY_SOURCES.has(item.source)).forEach(item => {
    sealedMap.set(item.id, {...item, sensitivity: "sealed", scope: item.scope || "heart_only"});
  });
  const saved = rawItems.map(cleanEvent).filter(item => !forgotten.has(item.id));
  for (const item of saved) {
    if (item.sensitivity === "sealed" || SEALED_MEMORY_SOURCES.has(item.source)) sealedMap.set(item.id, {...item, sensitivity: "sealed", scope: item.scope === "record_only" ? "heart_only" : item.scope});
    else personalMap.set(item.id, item);
  }
  await Promise.all([
    writeState(env, "memory:events", Array.from(personalMap.values()).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 500)),
    writeState(env, "memory:sealed", Array.from(sealedMap.values()).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 300))
  ]);
  return saved;
}

const BASE_CATEGORIES = [
  {id: "preferences", name: "偏好与习惯", system: true, status: "active"},
  {id: "growth", name: "成长与方向", system: true, status: "active"},
  {id: "knowledge", name: "知识关注", system: true, status: "active"},
  {id: "life", name: "生活与旅行", system: true, status: "active"},
  {id: "general", name: "其他", system: true, status: "active"}
];

function categoryFor(event) {
  if (["orchard", "blackboard"].includes(event.source)) return "growth";
  if (["noticeboard", "toolbox"].includes(event.source)) return "knowledge";
  if (["travel", "photo_wall"].includes(event.source)) return "life";
  if (/preference|habit|偏好|习惯/i.test(`${event.type} ${event.summary}`)) return "preferences";
  return "general";
}

function ruleProfile(cards) {
  const active = cards.filter(item => item.status === "active");
  const preferences = active.filter(item => ["preference", "routine"].includes(item.kind)).slice(0, 6);
  const focuses = active.filter(item => ["growth", "knowledge"].includes(item.category_id)).slice(0, 8);
  return {
    summary: active.length ? `目前有 ${active.length} 条经过确认或重复验证的记忆参与辅助。` : "阿栗还没有足够确定的记忆。观察中的线索不会影响回答。",
    sections: [
      {title: "学习与沟通方式", text: preferences.length ? preferences.map(item => item.statement).join("；") : "还没有形成稳定的学习偏好。"},
      {title: "成长关注", text: focuses.length ? focuses.map(item => item.statement).join("；") : "还没有形成稳定的关注主题。"},
      {title: "使用原则", text: "当前问题和事实证据永远优先；记忆只调整讲解方式，不限制观点多样性；树洞原文永不进入普通回答。"}
    ],
    generator: "rule_profile", generated_at: now()
  };
}

function innerProfile(sealed) {
  const records = sealed.filter(item => item.source === "heart_hollow");
  const themes = [
    ["work", "工作与方向", /工作|公司|项目|职业|面试|产品|会议/, "会认真追问投入是否值得，也希望把下一步想清楚"],
    ["relationship", "关系与边界", /朋友|关系|家人|相处|理解|边界/, "在关系里重视真诚、边界和是否被真正理解"],
    ["pressure", "自我要求", /压力|焦虑|失败|做不好|来不及|必须/, "对自己有要求，也在分辨哪些重量不必一直背着"],
    ["choice", "选择与变化", /选择|决定|以后|方向|改变|离开|开始/, "面对重要选择时会反复权衡，希望决定来自真实意愿"],
    ["life", "生活与恢复", /旅行|睡|休息|生活|天气|散步|吃饭/, "会从具体生活体验里恢复能量，也珍惜不被任务占满的时刻"]
  ];
  const sections = themes.map(([id, title, pattern, text]) => {
    const count = records.filter(item => pattern.test(`${item.summary} ${item.content}`)).length;
    return count >= 2 ? {id, title, text, evidence_count: count} : null;
  }).filter(Boolean);
  return {
    summary: !records.length ? "树洞里还没有足够内容形成内在轨迹。" : sections.length ? "只展示重复出现的内在主题，单次倾诉不会成为人格判断。" : "已经有一些封存记录，但重复证据还不足，暂不形成结论。",
    sections, source_count: records.length, generated_at: now()
  };
}

function buildMemoryCards(events, overrides) {
  const groups = new Map();
  [...events].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).forEach(event => {
    const signature = memorySignature(event);
    if (!normalizedMemoryText(event.summary || event.content)) return;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(event);
  });
  return [...groups.entries()].map(([signature, evidence]) => {
    const newest = evidence[0];
    const id = `card_${stableMemoryHash(signature)}`;
    const override = overrides[id] || evidence.map(item => overrides[item.id]).find(Boolean) || {};
    const kind = memoryKind(newest);
    const threshold = ["preference", "routine"].includes(kind) ? MEMORY_POLICY.preference_repeat_to_confirm : MEMORY_POLICY.repeat_to_promote;
    const explicit = evidence.some(item => item.remember || item.explicit);
    return {
      id, kind, title: newest.summary.slice(0, 42), statement: newest.summary,
      category_id: override.category_id || categoryFor(newest),
      status: override.status || (explicit || evidence.length >= threshold ? "active" : "candidate"),
      confidence: explicit ? 0.96 : Math.min(0.9, 0.5 + evidence.length * 0.13),
      evidence_ids: evidence.map(item => item.id), evidence_count: evidence.length,
      scope: override.scope || newest.scope || (["preference", "routine"].includes(kind) ? "learning_format" : "record_only"),
      sensitivity: "personal", source: newest.source, signature,
      created_at: evidence[evidence.length - 1].created_at, updated_at: newest.created_at
    };
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function memoryState(env, includeSealed = false) {
  const [storedEvents, storedSealed, storedProfile, customCategories, overrides] = await Promise.all([
    readState(env, "memory:events", []), readState(env, "memory:sealed", []),
    readState(env, "memory:profile", null), readState(env, "memory:categories", []),
    readState(env, "memory:overrides", {})
  ]);
  const recovered = storedEvents.filter(item => item.sensitivity === "sealed" || SEALED_MEMORY_SOURCES.has(item.source));
  const events = storedEvents.filter(item => item.sensitivity !== "sealed" && !SEALED_MEMORY_SOURCES.has(item.source));
  const sealedMap = new Map(storedSealed.map(item => [item.id, item]));
  recovered.forEach(item => sealedMap.set(item.id, {...item, sensitivity: "sealed", scope: item.scope || "heart_only"}));
  const sealed = [...sealedMap.values()];
  if (recovered.length) await Promise.all([writeState(env, "memory:events", events), writeState(env, "memory:sealed", sealed)]);
  const categories = [...BASE_CATEGORIES, ...customCategories.filter(item => !BASE_CATEGORIES.some(base => base.id === item.id))];
  const cards = buildMemoryCards(events, overrides);
  const active = cards.filter(item => item.status === "active");
  const profile = storedProfile?.source_card_ids?.every(id => active.some(card => card.id === id)) ? storedProfile : ruleProfile(cards);
  return {
    events, sealed: includeSealed ? sealed : [], cards, categories,
    long: active, short: cards.filter(item => item.status === "candidate"),
    preferences: cards.filter(item => ["preference", "routine"].includes(item.kind)),
    category_suggestions: [], profile, inner_profile: innerProfile(sealed),
    policy: MEMORY_POLICY
  };
}

function memoryTerms(value) {
  const text = String(value || "").toLowerCase();
  const terms = new Set(text.match(/[a-z0-9_-]{3,}/g) || []);
  for (const chunk of text.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (chunk.length <= 8) terms.add(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) terms.add(chunk.slice(index, index + 2));
  }
  return terms;
}

function memoryRelevance(item, query) {
  const queryTerms = memoryTerms(query);
  const itemTerms = memoryTerms(`${item.title || ""} ${item.statement || ""} ${item.summary || ""} ${item.content || ""}`);
  let overlap = 0;
  queryTerms.forEach(term => { if (itemTerms.has(term)) overlap += 1; });
  return overlap * 3 + Number(item.confidence || 0);
}

function compactMemory(item) {
  return {
    id: item.id, kind: item.kind || "experience", category: item.category_id || "general",
    statement: item.statement || item.content || item.summary, summary: item.summary || item.statement || "",
    evidence_count: item.evidence_count || 1, scope: item.scope || "record_only"
  };
}

function selectedInnerTendency(inner, query, recentIds) {
  if (!/又|还是|总是|一直|上次|之前|最近|反复|每次|老是/.test(String(query || ""))) return null;
  const patterns = {
    work: /工作|公司|项目|职业|面试|产品|会议|同事/,
    relationship: /朋友|关系|家人|相处|理解|边界/,
    pressure: /压力|累|焦虑|失败|做不好|来不及|应该|必须|责怪/,
    choice: /选择|决定|以后|方向|改变|放弃|离开|开始/,
    life: /旅行|睡|休息|家里|生活|天气|散步|吃饭/
  };
  const section = (inner?.sections || []).find(item => !recentIds.has(`inner:${item.id}`) && patterns[item.id]?.test(String(query || "")));
  return section ? {id: `inner:${section.id}`, kind: "private_tendency", category_id: "companion", statement: section.text, summary: section.text, evidence_count: section.evidence_count, scope: "heart_only"} : null;
}

function travelContextEvents(events, query, recentIds, roomId, limit = 1) {
  const rows = events.filter(item => item.source === "travel" && ["travel_only", "record_only"].includes(item.scope) && !recentIds.has(item.id)).map(item => {
    const sameRoom = Boolean(roomId && item.room_id === roomId);
    return {item, score: sameRoom ? 100 : memoryRelevance(item, query)};
  }).filter(row => roomId ? row.score > 0 : row.score > 0.5);
  return rows.sort((a, b) => b.score - a.score || String(b.item.created_at).localeCompare(String(a.item.created_at))).slice(0, limit).map(({item}) => ({
    id: item.id, kind: "experience", category_id: "life", statement: item.content || item.summary,
    summary: item.summary, evidence_count: 1, scope: "travel_only"
  }));
}

export async function memoryContext(env, purpose = "general", options = {}) {
  const permission = await permissions(env);
  if (permission.memory_assist_enabled === false) {
    return {enabled: false, profile: null, relevant_memories: [], selected_memory_ids: [], diversity_guard: MEMORY_POLICY.diversity_guard};
  }
  const state = await memoryState(env, false);
  const query = String(options?.query || "");
  const roomId = String(options?.roomId || options?.room_id || "");
  const recentIds = new Set((options?.recentIds || options?.recent_memory_ids || []).map(String));
  const active = state.cards.filter(item => item.status === "active" && !recentIds.has(item.id));
  const rank = (predicate, limit, allowZero = false) => active.filter(predicate).map(item => ({item, score: memoryRelevance(item, query)}))
    .filter(row => allowZero || row.score > 0.5).sort((a, b) => b.score - a.score || String(b.item.updated_at).localeCompare(String(a.item.updated_at))).slice(0, limit).map(row => row.item);
  const style = item => ["preference", "routine"].includes(item.kind) && (
    item.scope === "companion_style" || (item.scope === "learning_format" && /回复|表达|语气|称呼|简短|详细|解释|沟通|聊天|追问|套话|结论先说/.test(String(item.statement || "")))
  );
  let selected = [];
  if (purpose === "learning_support") {
    selected = rank(item => ["preference", "routine"].includes(item.kind) && item.scope === "learning_format", 3, true);
  } else if (purpose === "heart_companion") {
    selected = rank(style, 1, true);
    const inner = selectedInnerTendency(state.inner_profile, query, recentIds);
    if (inner && selected.length < 2) selected.push(inner);
    if (/(?:我|我的).{0,10}(?:旅行|旅程|出游|去了哪里|去过)/.test(query) && selected.length < 2) selected.push(...travelContextEvents(state.events, query, recentIds, "", 1));
  } else if (purpose === "travel_companion") {
    selected = rank(style, 1, true);
    selected.push(...travelContextEvents(state.events, query, recentIds, roomId, Math.max(0, 2 - selected.length)));
  } else if (purpose === "blackboard_question") {
    selected = rank(item => ["growth", "knowledge"].includes(item.category_id) && !["record_only", "travel_only", "heart_only"].includes(item.scope), 4);
  } else {
    selected = rank(item => ["preference", "routine"].includes(item.kind) && item.scope === "learning_format", 1, true);
    selected.push(...rank(item => ["topic_selection", "review_only"].includes(item.scope) && !selected.includes(item), Math.max(0, 2 - selected.length)));
    if (/(?:我|我的).{0,10}(?:旅行|旅程|出游|去了哪里|去过)/.test(query) && selected.length < 2) selected.push(...travelContextEvents(state.events, query, recentIds, "", 1));
  }
  const unique = [];
  const seen = new Set();
  for (const item of selected) {
    if (!item?.id || seen.has(item.id) || recentIds.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  selected = unique.slice(0, ["heart_companion", "travel_companion", "general", "butler"].includes(purpose) ? 2 : 4);
  return {
    enabled: true, purpose, profile: null,
    selected_memory_ids: selected.map(item => item.id),
    relevant_memories: selected.map(compactMemory),
    diversity_guard: MEMORY_POLICY.diversity_guard,
    rules: ["每轮最多使用两条高度相关记忆，也可以完全不用", "不得使用 recent_memory_ids 中刚用过的记忆", "树洞原文不进入普通上下文，旅行记录只在匹配旅程或明确追问时使用"]
  };
}

export async function memoryAction(env, input) {
  const action = String(input?.action || "");
  if (action === "forget") {
    const id = String(input.id || input.query || "");
    const currentState = await memoryState(env, true);
    const card = currentState.cards.find(item => item.id === id);
    const forgottenIds = new Set([id, ...(card?.evidence_ids || [])]);
    const events = (await readState(env, "memory:events", [])).filter(item => !forgottenIds.has(item.id));
    const sealed = (await readState(env, "memory:sealed", [])).filter(item => item.id !== id);
    const overrides = await readState(env, "memory:overrides", {});
    forgottenIds.forEach(value => { delete overrides[value]; });
    const forgotten = await readState(env, "memory:forgotten", []);
    const tombstones = [...forgottenIds].map(value => ({id: value, forgotten_at: now()}));
    await Promise.all([writeState(env, "memory:events", events), writeState(env, "memory:sealed", sealed), writeState(env, "memory:overrides", overrides), writeState(env, "memory:forgotten", [...tombstones, ...forgotten].slice(0, 1200))]);
    return {ok: true, forgotten_ids: [...forgottenIds]};
  }
  if (["card_activate", "card_candidate", "card_reject", "card_move_category", "card_scope"].includes(action)) {
    const overrides = await readState(env, "memory:overrides", {});
    const id = String(input.id || "");
    if (!id) throw new Error("缺少记忆卡片 id");
    const next = {...(overrides[id] || {})};
    if (action === "card_move_category") next.category_id = String(input.category_id || "general");
    else if (action === "card_scope") next.scope = ["learning_format", "topic_selection", "review_only", "record_only", "companion_style", "travel_only"].includes(input.scope) ? input.scope : "record_only";
    else next.status = {card_activate: "active", card_candidate: "candidate", card_reject: "rejected"}[action];
    overrides[id] = next;
    await writeState(env, "memory:overrides", overrides);
    return {ok: true, card: {id, ...next}};
  }
  const categories = await readState(env, "memory:categories", []);
  if (action === "category_create") {
    const name = String(input.name || "").trim().slice(0, 30);
    if (!name) throw new Error("分类名称不能为空");
    const category = {id: `custom_${crypto.randomUUID().slice(0, 8)}`, name, system: false, explicit: true, status: "active"};
    await writeState(env, "memory:categories", [...categories, category]);
    return {ok: true, category};
  }
  if (["category_rename", "category_delete", "category_merge"].includes(action)) {
    const id = String(input.id || "");
    if (BASE_CATEGORIES.some(item => item.id === id)) throw new Error("系统分类不能删除或改名");
    let nextCategories = categories;
    const overrides = await readState(env, "memory:overrides", {});
    if (action === "category_rename") nextCategories = categories.map(item => item.id === id ? {...item, name: String(input.name || "").trim().slice(0, 30)} : item);
    if (action === "category_delete" || action === "category_merge") {
      const target = action === "category_merge" ? String(input.target_id || "general") : "general";
      Object.keys(overrides).forEach(key => { if (overrides[key].category_id === id) overrides[key].category_id = target; });
      nextCategories = categories.filter(item => item.id !== id);
      await writeState(env, "memory:overrides", overrides);
    }
    await writeState(env, "memory:categories", nextCategories);
    return {ok: true};
  }
  throw new Error("云端暂不支持这个记忆操作");
}

export async function saveTask(env, task) {
  const value = {...task, updated_at: now()};
  await writeState(env, `task:${value.id}`, value, {expirationTtl: 60 * 60 * 24 * 90});
  const index = await readState(env, "tasks:index", []);
  const next = [value, ...index.filter(item => item.id !== value.id)].slice(0, 80);
  await writeState(env, "tasks:index", next);
  return value;
}

export async function tasks(env) {
  return readState(env, "tasks:index", []);
}

export async function updateTask(env, id, patch) {
  const current = await readState(env, `task:${id}`, null);
  if (!current) throw new Error("没有找到这个任务");
  return saveTask(env, {...current, ...patch, id});
}

export async function permissions(env) {
  return readData(env, "permissions");
}

export async function setStewardMode(env, enabled) {
  const current = await permissions(env);
  const value = {
    ...current, steward_mode: Boolean(enabled), permanent: true,
    enabled_at: enabled ? (current.enabled_at || now()) : current.enabled_at,
    updated_at: now()
  };
  return writeData(env, "permissions", value);
}

export async function setMemoryAssist(env, enabled) {
  const current = await permissions(env);
  return writeData(env, "permissions", {...current, memory_assist_enabled: Boolean(enabled), updated_at: now()});
}
