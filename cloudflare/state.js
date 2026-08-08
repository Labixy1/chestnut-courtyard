import {DEFAULT_DATA} from "./default_data.js";

export const DATA_KEYS = new Set(Object.keys(DEFAULT_DATA));
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

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

export async function writeData(env, key, value) {
  if (!DATA_KEYS.has(key)) throw new Error("不支持的数据区域");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("数据格式不正确");
  return writeState(env, `data:${key}`, value);
}

export async function mergeLocalState(env, values) {
  const current = await readData(env, "local_state");
  const safe = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const next = {...current, version: 1, updated_at: now(), values: {...(current.values || {}), ...safe}};
  return writeData(env, "local_state", next);
}

function uniqueItems(items, max = 150) {
  const seen = new Set();
  return items.filter(item => {
    const key = String(item?.id || item?.url || item?.title || item?.name || item || "").trim().toLowerCase();
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
    created_at: String(raw?.created_at || created)
  };
};

export async function addMemoryEvents(env, input) {
  const rawItems = (Array.isArray(input) ? input : [input]).filter(Boolean).slice(0, 100);
  const personal = await readState(env, "memory:events", []);
  const sealed = await readState(env, "memory:sealed", []);
  const personalMap = new Map(personal.map(item => [item.id, item]));
  const sealedMap = new Map(sealed.map(item => [item.id, item]));
  const saved = rawItems.map(cleanEvent);
  for (const item of saved) {
    if (item.sensitivity === "sealed") sealedMap.set(item.id, item);
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

function ruleProfile(events) {
  const counts = {};
  events.forEach(item => { counts[item.source] = (counts[item.source] || 0) + 1; });
  const focuses = events.filter(item => item.weight >= 2 || item.layer === "long").slice(0, 8).map(item => item.summary).filter(Boolean);
  const sources = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, count]) => `${name} ${count} 次`).join("、");
  return {
    summary: events.length ? `目前已从 ${events.length} 条行为中整理出关注方向。` : "阿栗还没有足够确定的记忆。",
    sections: [
      {title: "近期关注", text: focuses.length ? focuses.join("；") : "还没有形成稳定的关注主题。"},
      {title: "互动轨迹", text: sources || "小院里还没有足够的互动记录。"},
      {title: "使用原则", text: "当前指令永远优先；敏感内容封存在密阁，不会进入普通任务上下文。"}
    ],
    generator: "rule_profile", generated_at: now()
  };
}

export async function memoryState(env, includeSealed = false) {
  const [events, sealed, storedProfile, customCategories, overrides] = await Promise.all([
    readState(env, "memory:events", []), readState(env, "memory:sealed", []),
    readState(env, "memory:profile", null), readState(env, "memory:categories", []),
    readState(env, "memory:overrides", {})
  ]);
  const categories = [...BASE_CATEGORIES, ...customCategories.filter(item => !BASE_CATEGORIES.some(base => base.id === item.id))];
  const cards = events.filter(item => item.summary).map(item => {
    const override = overrides[item.id] || {};
    return {
      id: item.id, kind: item.type, title: item.summary.slice(0, 42), statement: item.summary,
      category_id: override.category_id || categoryFor(item),
      status: override.status || (item.layer === "long" || item.weight >= 2 ? "active" : "candidate"),
      evidence_ids: [item.id], sensitivity: "personal", updated_at: item.created_at
    };
  });
  return {
    events, sealed: includeSealed ? sealed : [], cards, categories,
    category_suggestions: [], profile: storedProfile || ruleProfile(events),
    policy: {auto_category_min_cards: 3, sealed_context: "explicit_only"}
  };
}

export async function memoryContext(env) {
  const state = await memoryState(env, false);
  const active = state.cards.filter(item => item.status === "active").slice(0, 12);
  return {
    profile: state.profile,
    relevant_memories: active.map(item => ({category: item.category_id, statement: item.statement})),
    recent_activity: state.events.slice(0, 12).map(item => ({source: item.source, type: item.type, summary: item.summary}))
  };
}

export async function memoryAction(env, input) {
  const action = String(input?.action || "");
  if (action === "forget") {
    const id = String(input.id || input.query || "");
    const events = (await readState(env, "memory:events", [])).filter(item => item.id !== id);
    const sealed = (await readState(env, "memory:sealed", [])).filter(item => item.id !== id);
    await Promise.all([writeState(env, "memory:events", events), writeState(env, "memory:sealed", sealed)]);
    return {ok: true, forgotten_ids: [id]};
  }
  if (["card_activate", "card_candidate", "card_reject", "card_move_category"].includes(action)) {
    const overrides = await readState(env, "memory:overrides", {});
    const id = String(input.id || "");
    if (!id) throw new Error("缺少记忆卡片 id");
    const next = {...(overrides[id] || {})};
    if (action === "card_move_category") next.category_id = String(input.category_id || "general");
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
  if (current.steward_mode && !enabled) return current;
  const value = {
    ...current, steward_mode: Boolean(enabled), permanent: true,
    enabled_at: enabled ? (current.enabled_at || now()) : current.enabled_at,
    updated_at: now()
  };
  return writeData(env, "permissions", value);
}
