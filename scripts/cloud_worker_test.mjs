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
const request = (path, body, env = baseEnv) => handleRequest(new Request(`https://owner.example${path}`, body === undefined ? {} : {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)
}), env, {waitUntil: promise => promise});
const payload = async response => ({status: response.status, body: await response.json()});

let result = await payload(await request("/api/status"));
assert.equal(result.status, 200);
assert.equal(result.body.access, "preview");
assert.equal(result.body.storage.kv, true);

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

console.log("cloud worker test ok: auth boundary; KV data; local state; memory; tools-only assistant; read-only guard");
