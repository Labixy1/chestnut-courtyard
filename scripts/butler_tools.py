#!/usr/bin/env python3
"""Validated local tools used by the 阿栗 agent loop."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path


LIST_KEYS = ("chest", "read_later", "watch_topics", "sources", "toolbox", "custom_categories")
BASE_CATEGORIES = ("模型与技术", "产品与实践", "行业动态", "学术研究")
LEGACY_CATEGORIES = {
    "模型发布": "模型与技术", "评测方法": "模型与技术", "记忆系统": "模型与技术", "AI安全": "模型与技术", "安全治理": "模型与技术",
    "原型设计": "产品与实践", "工作流工具": "产品与实践", "产品效率": "产品与实践", "工具教程": "产品与实践", "竞品案例": "产品与实践", "案例观察": "产品与实践",
    "行业观察": "行业动态", "学术资料": "学术研究",
}


def normalize_category(category, item=None, allow_custom=False):
    item = item or {}
    raw = str(category or "").strip()
    if raw in BASE_CATEGORIES:
        return raw
    if raw in LEGACY_CATEGORIES:
        return LEGACY_CATEGORIES[raw]
    if allow_custom and raw:
        return raw
    title = " ".join(str(item.get(key, "")) for key in ("title", "notice_tag"))
    text = " ".join(str(item.get(key, "")) for key in
                    ("category", "notice_tag", "title", "summary", "ai_summary", "main_takeaway", "media"))
    if re.search(r"Claude Science|科研|论文|学术|paper|scientific|arxiv|实验复现", title, re.I):
        return "学术研究"
    if re.search(r"融资|估值|基金|市场|政策|监管|公司|暴雷", title, re.I):
        return "行业动态"
    if re.search(r"Agent|MCP|workflow|工作流|原型|prototype|Figma|产品实践|产品效率|customer|case|powers|personalization|at work", title, re.I):
        return "产品与实践"
    if re.search(r"GPT|Claude|Gemini|DeepSeek|Kimi|Qwen|通义|千问|豆包|Seed|模型|MoE|API|多模态|评测|benchmark|eval|发布|上线|开源", title, re.I):
        return "模型与技术"
    if re.search(r"科研|论文|学术|arxiv|实验复现", text, re.I):
        return "学术研究"
    if re.search(r"融资|估值|基金|市场|行业|公司|组织|政策|监管|暴雷", text, re.I):
        return "行业动态"
    if re.search(r"产品|PM|原型|Figma|UX|用户流程|工作流|workflow|Agent|MCP|Skills|工具|效率|案例|customer|体验|需求", text, re.I):
        return "产品与实践"
    if re.search(r"GPT|Claude|Gemini|DeepSeek|Kimi|Qwen|通义|千问|豆包|Seed|模型|MoE|API|多模态|评测|benchmark|eval|记忆系统|memory|安全|security|发布|上线|开源", text, re.I):
        return "模型与技术"
    return "行业动态"


class ButlerTools:
    def __init__(self, root: Path, call_ai, parse_url, system_runtime=None, memory_store=None, parse_tool=None, media_service=None):
        self.root = root
        self.call_ai = call_ai
        self.parse_url = parse_url
        self.state_path = root / "core/butler_state.json"
        self.skill_path = root / "core/skills/butler_agent.json"
        self.system_runtime = system_runtime
        self.memory_store = memory_store
        self.parse_tool = parse_tool
        self.media_service = media_service
        self.lock = threading.RLock()

    def _default_state(self):
        return {"version": 2, "updated_at": "", "chest": [], "read_later": [],
                "watch_topics": [], "sources": [], "toolbox": [], "custom_categories": [], "task_log": []}

    def load_state(self):
        with self.lock:
            try:
                state = json.loads(self.state_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                state = self._default_state()
            for key in LIST_KEYS + ("task_log",):
                if not isinstance(state.get(key), list):
                    state[key] = []
            for item in state["chest"]:
                item["category"] = normalize_category(item.get("category"), item, allow_custom=True)
            return state

    def save_state(self, state):
        with self.lock:
            state["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
            temp = self.state_path.with_suffix(".json.tmp")
            temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temp.replace(self.state_path)
            try:
                import ingest
                ingest.rebuild_data_js()
            except Exception:
                pass

    @staticmethod
    def _item_key(item):
        url = str(item.get("url") or item.get("link") or "").strip().lower().split("#")[0]
        return "url:" + url if url else "title:" + str(item.get("title") or item.get("name") or item.get("text") or "").strip().lower()

    def _upsert(self, state, key, item, limit=150):
        marker = self._item_key(item)
        state[key] = [old for old in state.get(key, []) if self._item_key(old) != marker]
        item = dict(item)
        item.setdefault("date", datetime.now().strftime("%Y-%m-%d"))
        state[key].insert(0, item)
        state[key] = state[key][:limit]

    @staticmethod
    def _tool_key(item):
        title = str(item.get("title") or item.get("name") or "").strip().lower()
        url = str(item.get("url") or "").strip().lower().split("#")[0]
        return "tool:" + title + "|" + url

    def _upsert_toolbox(self, state, item, limit=100):
        marker = self._tool_key(item)
        state["toolbox"] = [old for old in state.get("toolbox", []) if self._tool_key(old) != marker]
        saved = dict(item)
        saved.setdefault("date", datetime.now().strftime("%Y-%m-%d"))
        state["toolbox"].insert(0, saved)
        state["toolbox"] = state["toolbox"][:limit]

    def upsert_toolbox_item(self, item):
        state = self.load_state()
        self._upsert_toolbox(state, item)
        self.save_state(state)
        return state

    def merge_browser_context(self, context):
        mappings = {
            "chest": "chest", "read_later": "read_later", "watch_topics": "watch_topics",
            "local_sources": "sources", "local_tools": "toolbox", "custom_categories": "custom_categories",
        }
        state = self.load_state()
        changed = False
        for source_key, state_key in mappings.items():
            for item in context.get(source_key, []) if isinstance(context.get(source_key), list) else []:
                if isinstance(item, dict):
                    if state_key == "toolbox":
                        self._upsert_toolbox(state, item)
                    else:
                        self._upsert(state, state_key, item)
                    changed = True
        if changed:
            self.save_state(state)
        return state

    def sync_exact(self, payload):
        state = self.load_state()
        for key in LIST_KEYS:
            if isinstance(payload.get(key), list):
                state[key] = [item for item in payload[key] if isinstance(item, dict)][:150]
        for item in state["chest"]:
            item["category"] = normalize_category(item.get("category"), item, allow_custom=True)
        self.save_state(state)
        return state

    def archive_payload(self, item, source="agent"):
        state = self.load_state()
        payload = self._payload(item)
        payload["source"] = source
        if item.get("extracted_chars") is not None:
            payload["extracted_chars"] = item.get("extracted_chars")
        if item.get("parse_method"):
            payload["parse_method"] = item.get("parse_method")
        self._upsert(state, "chest", payload)
        state["task_log"].insert(0, {"time": datetime.now().astimezone().isoformat(timespec="seconds"),
                                     "tool": "archive_payload", "arguments": {"url": payload.get("url", "")},
                                     "result": "已归档《%s》" % payload["title"], "ok": True})
        state["task_log"] = state["task_log"][:100]
        self.save_state(state)
        return payload, state

    def _knowledge_items(self):
        items = []
        reports = self._read_json("core/notice_reports.json", {}).get("reports", [])
        for report in reports:
            for item in report.get("hot_items", []):
                items.append(dict(item))
            for section in report.get("sections", []):
                for item in section.get("items", []):
                    merged = dict(item)
                    merged.setdefault("category", section.get("name", "资讯"))
                    items.append(merged)
        for item in self._read_json("core/manifest.json", {}).get("items", []):
            items.append(dict(item))
        state = self.load_state()
        items.extend(state["chest"])
        items.extend(state["toolbox"])
        local = self._local_state().get("values", {})
        for topic in local.get("cozy_orchard_topics", []) if isinstance(local.get("cozy_orchard_topics"), list) else []:
            entries = topic.get("entries", []) if isinstance(topic.get("entries"), list) else []
            detail = " ".join(str(entry.get("question", "")) + " " + str(entry.get("answer", "")) for entry in entries[:8])
            items.append({"id": topic.get("id"), "title": topic.get("title"), "category": topic.get("category"),
                          "summary": (str(topic.get("summary") or "") + " " + " ".join(topic.get("entities") or []) + " " + detail)[:4000],
                          "source": "成长田知识专题"})
        unique = {}
        for item in items:
            unique[self._item_key(item)] = item
        return list(unique.values())

    def _read_json(self, relative, fallback):
        try:
            return json.loads((self.root / relative).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return fallback

    def _local_state(self):
        data = self._read_json("core/local_state.json", {"version": 1, "values": {}})
        data.setdefault("values", {})
        return data

    def _save_local_state(self, data):
        data["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        path = self.root / "core/local_state.json"
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(path)

    def find_knowledge(self, query):
        query = str(query or "").strip().lower()
        if not query:
            return None
        direct_url = re.search(r"https?://[^\s，。；、)）]+", query)
        scored = []
        tokens = [token for token in re.split(r"[\s，。；、:：/]+", query) if len(token) >= 2]
        for item in self._knowledge_items():
            haystack = " ".join(str(item.get(key, "")) for key in ("title", "summary", "media", "category", "url", "link")).lower()
            score = 0
            if direct_url and direct_url.group(0).rstrip(".,，。；;") in haystack:
                score += 100
            if query in haystack:
                score += 50
            score += sum(8 for token in tokens if token in haystack)
            if score:
                scored.append((score, item))
        return max(scored, key=lambda pair: pair[0])[1] if scored else None

    @staticmethod
    def _payload(item, category=""):
        return {
            "category": normalize_category(category or item.get("category") or item.get("notice_tag"), item),
            "title": item.get("title") or item.get("name") or item.get("url") or "未命名资料",
            "summary": item.get("summary") or item.get("use_when") or "",
            "ai_summary": item.get("ai_summary") or item.get("main_takeaway") or "",
            "media": item.get("media") or item.get("source") or "",
            "published": item.get("published") or item.get("date") or "",
            "url": item.get("url") or item.get("link") or "",
        }

    def execute(self, name, arguments):
        args = arguments if isinstance(arguments, dict) else {}
        state = self.load_state()
        if name == "parse_and_archive":
            url = str(args.get("url", "")).strip()
            if not url:
                raise ValueError("缺少需要解析的网页链接")
            item = self.parse_url(url, "自动解析并归档" + ("到" + str(args.get("category")) if args.get("category") else ""))
            if args.get("category"):
                item["category"] = normalize_category(args["category"], item, allow_custom=True)
            self._upsert(state, "chest", item)
            summary = "已解析并归档《%s》到“%s”" % (item["title"], item["category"])
            result = {"ok": True, "summary": summary, "item": item}
        elif name == "archive_from_knowledge":
            found = self.find_knowledge(args.get("query"))
            if not found:
                raise ValueError("知识库里没有找到对应资料")
            item = self._payload(found)
            if args.get("category"):
                item["category"] = normalize_category(args.get("category"), item, allow_custom=True)
            self._upsert(state, "chest", item)
            result = {"ok": True, "summary": "已收入栗夹：《%s》 · %s" % (item["title"], item["category"]), "item": item}
        elif name == "add_read_later":
            query = str(args.get("query") or "")
            found = self.find_knowledge(query)
            if not found and query.startswith(("http://", "https://")):
                found = self.parse_url(query, "加入待读")
            if not found:
                raise ValueError("没有找到要加入待读的资料")
            item = self._payload(found)
            self._upsert(state, "read_later", item)
            result = {"ok": True, "summary": "已加入待读：《%s》" % item["title"], "item": item}
        elif name == "move_archive":
            query = str(args.get("query") or "").lower()
            category = str(args.get("category") or "").strip()
            if not query or not category:
                raise ValueError("需要资料关键词和新分类")
            matches = [item for item in state["chest"] if query in (str(item.get("title", "")) + " " + str(item.get("url", ""))).lower()]
            if not matches:
                raise ValueError("栗夹里没有找到对应资料")
            matches[0]["category"] = category
            result = {"ok": True, "summary": "已把《%s》移到“%s”" % (matches[0]["title"], category), "item": matches[0]}
        elif name == "remove_archive":
            query = str(args.get("query") or "").lower()
            before = len(state["chest"])
            state["chest"] = [item for item in state["chest"] if query not in (str(item.get("title", "")) + " " + str(item.get("url", ""))).lower()]
            if len(state["chest"]) == before:
                raise ValueError("栗夹里没有找到对应资料")
            result = {"ok": True, "summary": "已从栗夹移出对应资料"}
        elif name == "add_watch_topic":
            topic = str(args.get("topic") or "").strip()
            if not topic:
                raise ValueError("关注方向不能为空")
            item = {"text": topic, "title": topic}
            self._upsert(state, "watch_topics", item, 60)
            result = {"ok": True, "summary": "已加入后续关注方向：%s" % topic, "item": item}
        elif name == "add_source":
            source = {"name": str(args.get("name") or "").strip(), "url": str(args.get("url") or "").strip(), "enabled": True}
            if not source["name"] and not source["url"]:
                raise ValueError("媒体名称或网址不能为空")
            source["title"] = source["name"] or source["url"]
            self._upsert(state, "sources", source, 80)
            result = {"ok": True, "summary": "已加入巡逻来源：%s" % source["title"], "item": source}
        elif name == "add_toolbox_item":
            item = {"title": str(args.get("title") or "").strip(), "category": str(args.get("category") or "其他"),
                    "purpose": str(args.get("purpose") or args.get("use_when") or "")[:600],
                    "use_when": str(args.get("use_when") or args.get("purpose") or "")[:600],
                    "key_capabilities": [str(value)[:120] for value in (args.get("key_capabilities") or []) if str(value).strip()][:6],
                    "use_cases": [str(value)[:160] for value in (args.get("use_cases") or []) if str(value).strip()][:5],
                    "example": str(args.get("example") or "")[:500],
                    "url": str(args.get("url") or ""), "source_url": str(args.get("source_url") or ""),
                    "price_url": str(args.get("price_url") or "")[:1000],
                    "pricing": args.get("pricing") if isinstance(args.get("pricing"), dict) else {},
                    "source": "butler_agent"}
            if not item["title"]:
                raise ValueError("工具名称不能为空")
            self._upsert_toolbox(state, item)
            result = {"ok": True, "summary": "已把 %s 放进工具箱的“%s”分类" % (item["title"], item["category"]), "item": item}
        elif name == "add_tool_from_link":
            url = str(args.get("url") or "").strip()
            if not url.startswith(("http://", "https://")):
                raise ValueError("请提供完整的工具官网或资讯链接")
            if not self.parse_tool:
                raise RuntimeError("工具链接解析能力没有启动")
            item = self.parse_tool(url, str(args.get("instruction") or ""))
            self._upsert_toolbox(state, item)
            result = {"ok": True, "summary": "已解析并把 %s 放进工具箱的“%s”分类" % (item["title"], item["category"]), "item": item}
        elif name == "manage_toolbox_item":
            action = str(args.get("action") or "move").lower()
            query = str(args.get("query") or args.get("title") or "").strip().lower()
            matches = [item for item in state["toolbox"] if query and query in str(item.get("title") or "").lower()]
            if not matches:
                raise ValueError("工具箱里没有找到对应工具")
            item = matches[0]
            if action in {"move", "update"}:
                if args.get("category"):
                    item["category"] = str(args.get("category"))[:30]
                if args.get("use_when"):
                    item["use_when"] = str(args.get("use_when"))[:500]
                for key in ("purpose", "example", "url", "price_url"):
                    if args.get(key):
                        item[key] = str(args.get(key))[:600]
                if isinstance(args.get("pricing"), dict):
                    item["pricing"] = args["pricing"]
                for key in ("key_capabilities", "use_cases"):
                    if isinstance(args.get(key), list):
                        item[key] = [str(value)[:160] for value in args[key] if str(value).strip()][:6]
                result = {"ok": True, "summary": "已更新工具箱里的 %s" % item["title"], "item": item}
            elif action == "remove":
                state["toolbox"] = [old for old in state["toolbox"] if old is not item]
                result = {"ok": True, "summary": "已从工具箱移出 %s" % item["title"]}
            else:
                raise ValueError("工具箱操作只能是 move、update 或 remove")
        elif name == "manage_trip":
            local = self._local_state()
            trips = local["values"].setdefault("cozy_trips", [])
            action = str(args.get("action") or "create").lower()
            trip_id = str(args.get("id") or "")
            trip = next((entry for entry in trips if str(entry.get("id")) == trip_id), None)
            if action == "create":
                place = str(args.get("place") or "").strip()
                if not place:
                    raise ValueError("旅程需要地点")
                trip = {"id": "trip_" + uuid.uuid4().hex[:12], "place": place, "start": str(args.get("start") or ""),
                        "end": str(args.get("end") or ""), "status": str(args.get("status") or "planned"), "photos": [],
                        "summary": str(args.get("summary") or "")[:500],
                        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds")}
                trips.insert(0, trip)
            elif not trip:
                raise ValueError("没有找到这段旅程")
            elif action in {"update", "complete"}:
                for key in ("place", "start", "end", "summary", "status"):
                    if args.get(key) is not None and str(args.get(key)).strip():
                        trip[key] = str(args.get(key)).strip()[:500]
                if action == "complete":
                    trip["status"] = "completed"
                    trip.setdefault("end", datetime.now().strftime("%Y-%m-%d"))
                trip["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
            elif action == "remove":
                trips[:] = [entry for entry in trips if entry is not trip]
            else:
                raise ValueError("旅程操作只能是 create、update、complete 或 remove")
            local["values"]["cozy_trips"] = trips[:100]
            self._save_local_state(local)
            result = {"ok": True, "summary": {"create": "已新建旅程", "update": "已更新旅程", "complete": "已记录回家", "remove": "已删除旅程"}[action] + ("：" + str((trip or {}).get("place") or "") if action != "remove" else ""), "item": trip}
        elif name == "manage_growth_seed":
            local = self._local_state()
            seeds = local["values"].setdefault("cozy_orchard_seeds", [])
            action = str(args.get("action") or "create").lower()
            seed_id = str(args.get("id") or "")
            seed = next((entry for entry in seeds if str(entry.get("id")) == seed_id), None)
            if action == "create":
                text = str(args.get("text") or "").strip()
                if not text:
                    raise ValueError("成长种子不能为空")
                seed = {"id": "seed_" + uuid.uuid4().hex[:12], "text": text, "status": "growing", "date": datetime.now().strftime("%Y-%m-%d"), "reply": str(args.get("reply") or "")[:800], "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds")}
                seeds.insert(0, seed)
            elif not seed:
                raise ValueError("没有找到这颗成长种子")
            elif action in {"update", "resolve"}:
                if args.get("text"):
                    seed["text"] = str(args.get("text"))[:1200]
                seed["status"] = "resolved" if action == "resolve" else str(args.get("status") or seed.get("status") or "growing")
                if args.get("reflection"):
                    seed["reflection"] = str(args.get("reflection"))[:1200]
                seed["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
            elif action == "remove":
                seeds[:] = [entry for entry in seeds if entry is not seed]
            else:
                raise ValueError("种子操作只能是 create、update、resolve 或 remove")
            local["values"]["cozy_orchard_seeds"] = seeds[:100]
            self._save_local_state(local)
            result = {"ok": True, "summary": {"create": "已在果园播下种子", "update": "已更新成长种子", "resolve": "已把种子标为收成", "remove": "已移除成长种子"}[action], "item": seed}
        elif name == "manage_knowledge_topic":
            local = self._local_state()
            topics = local["values"].setdefault("cozy_orchard_topics", [])
            action = str(args.get("action") or "upsert").lower()
            topic_id = str(args.get("id") or "")
            title = str(args.get("title") or "").strip()
            topic = next((entry for entry in topics if str(entry.get("id")) == topic_id), None)
            if topic is None and title:
                normalized = re.sub(r"[\s·・:：/\-]+", "", title).lower()
                topic = next((entry for entry in topics if re.sub(r"[\s·・:：/\-]+", "", str(entry.get("title") or "")).lower() == normalized), None)
            if action == "upsert":
                if topic is None:
                    if not title:
                        raise ValueError("知识专题需要名称")
                    topic = {"id": "topic_" + uuid.uuid4().hex[:12], "title": title, "category": str(args.get("category") or "其他"),
                             "summary": "", "entities": [], "entries": [], "createdAt": datetime.now().astimezone().isoformat(timespec="seconds")}
                    topics.insert(0, topic)
                for key in ("title", "category", "summary"):
                    if args.get(key):
                        topic[key] = str(args.get(key)).strip()[:1600]
                entities = args.get("entities") if isinstance(args.get("entities"), list) else []
                topic["entities"] = list(dict.fromkeys([str(value).strip() for value in (topic.get("entities") or []) + entities if str(value).strip()]))[:20]
                question, answer = str(args.get("question") or "").strip(), str(args.get("answer") or "").strip()
                if question or answer:
                    topic.setdefault("entries", []).insert(0, {"id": "knowledge_" + uuid.uuid4().hex[:12], "question": question[:1200], "answer": answer[:2400],
                                                              "date": datetime.now().strftime("%Y-%m-%d")})
                    topic["entries"] = topic["entries"][:30]
            elif not topic:
                raise ValueError("没有找到这个知识专题")
            elif action == "move":
                topic["category"] = str(args.get("category") or "其他").strip()[:80]
            elif action == "remove":
                topics[:] = [entry for entry in topics if entry is not topic]
            else:
                raise ValueError("知识专题操作只能是 upsert、move 或 remove")
            if topic:
                topic["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
            local["values"]["cozy_orchard_topics"] = topics[:60]
            self._save_local_state(local)
            result = {"ok": True, "summary": {"upsert": "已更新成长知识专题", "move": "已移动知识专题", "remove": "已删除知识专题"}[action] + ("：" + str((topic or {}).get("title") or "") if action != "remove" else ""), "item": topic}
        elif name == "run_weekly_report":
            completed = subprocess.run([sys.executable, str(self.root / "scripts/butler_weekly.py")], cwd=self.root,
                                       capture_output=True, text=True, timeout=420)
            if completed.returncode != 0:
                raise RuntimeError((completed.stderr or completed.stdout or "周报生成失败")[-500:])
            reports = self._read_json("core/notice_reports.json", {}).get("reports", [])
            result = {"ok": True, "summary": "本周周报已重新抓取并生成", "report": reports[0] if reports else {}}
        elif name == "generate_media":
            if not self.media_service:
                raise RuntimeError("多模态生成服务没有启动")
            kind = str(args.get("kind") or "image").lower()
            payload = {key: value for key, value in args.items() if value not in (None, "")}
            if kind == "image":
                task = self.media_service.generate_image(payload)
                summary = "已用 %s 生成并保存 %d 张图片" % (task.get("provider", "图片模型"), len(task.get("outputs", [])))
            elif kind == "video":
                task = self.media_service.create_video(payload)
                summary = "已提交 Seedance 视频任务，可离开页面后回来查看"
            else:
                raise ValueError("生成类型只支持 image 或 video")
            result = {"ok": True, "summary": summary, "task": task}
        elif name == "check_media_task":
            if not self.media_service:
                raise RuntimeError("多模态生成服务没有启动")
            task_id = str(args.get("id") or "").strip()
            task = self.media_service.get(task_id)
            if task.get("kind") == "video" and task.get("status") not in {"succeeded", "failed", "cancelled"}:
                task = self.media_service.refresh_video(task_id)
            result = {"ok": True, "summary": "生成任务当前状态：%s" % task.get("status", "unknown"), "task": task}
        elif name == "system_status":
            local = self._local_state().get("values", {})
            reports = self._read_json("core/notice_reports.json", {}).get("reports", [])
            estate_trips = self._read_json("core/estate_state.json", {}).get("travel", {}).get("history", [])
            local_trips = local.get("cozy_trips", []) if isinstance(local.get("cozy_trips"), list) else []
            memories = self.memory_store.state(include_sealed=False) if self.memory_store else {"short": [], "long": []}
            result = {"ok": True, "summary": "系统运行正常：%d 个工具、%d 份周报、%d 条活跃记忆" %
                      (len(self.skill_manifest().get("tools", [])), len(reports), len(memories.get("short", [])) + len(memories.get("long", []))),
                      "details": {"reports": len(reports), "trips": len(estate_trips) + len(local_trips), "seeds": len(local.get("cozy_orchard_seeds", [])), "knowledge_topics": len(local.get("cozy_orchard_topics", []))}}
        elif name == "manage_notice_category":
            action = str(args.get("action") or "create").strip().lower()
            category = str(args.get("category") or "").strip()[:24]
            target = str(args.get("target") or "").strip()[:24]
            if not category:
                raise ValueError("分类名称不能为空")
            names = [str(item.get("name") or item.get("title") or "") for item in state["custom_categories"]]
            if action == "create":
                if category not in BASE_CATEGORIES and category not in names:
                    state["custom_categories"].insert(0, {"name": category, "date": datetime.now().strftime("%Y-%m-%d")})
                result = {"ok": True, "summary": f"已新增公告板分类：“{category}”"}
            elif action == "rename":
                if not target:
                    raise ValueError("重命名需要新的分类名称")
                if category in BASE_CATEGORIES:
                    raise ValueError("四个基础分类不能重命名")
                changed = False
                for item in state["custom_categories"]:
                    if item.get("name") == category:
                        item["name"] = target
                        changed = True
                for item in state["chest"]:
                    if item.get("category") == category:
                        item["category"] = target
                        changed = True
                if not changed:
                    raise ValueError("没有找到这个自定义分类")
                result = {"ok": True, "summary": "已把分类“%s”改为“%s”" % (category, target)}
            elif action == "delete":
                if category in BASE_CATEGORIES:
                    raise ValueError("四个基础分类不能删除")
                state["custom_categories"] = [item for item in state["custom_categories"] if item.get("name") != category]
                for item in state["chest"]:
                    if item.get("category") == category:
                        item["category"] = "产品与实践"
                result = {"ok": True, "summary": "已删除分类“%s”，其中资料已移到“产品与实践”" % category}
            else:
                raise ValueError("分类操作只能是 create、rename 或 delete")
        elif name == "remember_memory":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            content = str(args.get("content") or "").strip()
            if not content:
                raise ValueError("需要说明要记住什么")
            item = self.memory_store.add_event({
                "source": "butler", "type": "explicit_memory", "content": content,
                "summary": str(args.get("summary") or content), "layer": str(args.get("layer") or "long"),
                "weight": 4, "remember": True,
            })
            result = {"ok": True, "summary": "已放入%s记忆" % ("封存" if item["layer"] == "sealed" else "长期"), "item": item}
        elif name == "remember_preference":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            statement = str(args.get("statement") or args.get("content") or "").strip()
            if not statement:
                raise ValueError("需要说明要记住什么偏好")
            item = self.memory_store.add_preference(statement, source="butler", explicit=True, evidence=statement)
            result = {"ok": True, "summary": "已记住这项偏好：%s" % item["statement"], "item": item}
        elif name == "manage_preference":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            action = str(args.get("action") or "confirm").lower()
            preference_id = str(args.get("id") or "")
            if action in {"confirm", "candidate", "reject"}:
                status = {"confirm": "confirmed", "candidate": "candidate", "reject": "rejected"}[action]
                result = self.memory_store.set_preference_status(preference_id, status)
            elif action == "forget":
                result = self.memory_store.forget(preference_id)
            else:
                raise ValueError("偏好操作只能是 confirm、candidate、reject 或 forget")
        elif name == "manage_memory_card":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            action = str(args.get("action") or "").lower()
            card_id = str(args.get("id") or "")
            if action in {"activate", "candidate", "reject"}:
                result = self.memory_store.set_card_status(card_id, {
                    "activate": "active", "candidate": "candidate", "reject": "rejected",
                }[action])
            elif action == "move":
                result = self.memory_store.move_card(card_id, str(args.get("category_id") or ""))
            elif action == "forget":
                result = self.memory_store.forget(card_id)
            else:
                raise ValueError("记忆卡片操作只能是 activate、candidate、reject、move 或 forget")
        elif name == "manage_memory_category":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            action = str(args.get("action") or "create").lower()
            category_id = str(args.get("id") or "")
            if action == "create":
                result = self.memory_store.create_category(str(args.get("name") or ""), explicit=True)
            elif action == "suggest":
                result = self.memory_store.create_category(
                    str(args.get("name") or ""), explicit=False,
                    related_card_ids=args.get("related_card_ids") if isinstance(args.get("related_card_ids"), list) else [],
                )
            elif action == "rename":
                result = self.memory_store.rename_category(category_id, str(args.get("name") or ""))
            elif action == "merge":
                result = self.memory_store.merge_category(category_id, str(args.get("target_id") or ""))
            elif action == "delete":
                result = self.memory_store.delete_category(category_id)
            else:
                raise ValueError("记忆分类操作只能是 create、suggest、rename、merge 或 delete")
        elif name == "forget_memory":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            result = self.memory_store.forget(str(args.get("query") or ""))
        elif name == "search_memory":
            if not self.memory_store:
                raise RuntimeError("记忆系统没有启动")
            include_sealed = bool(self.system_runtime and self.system_runtime.permissions().get("steward_mode") and args.get("include_sealed"))
            items = self.memory_store.search(str(args.get("query") or ""), include_sealed=include_sealed)
            result = {"ok": True, "summary": "找到了 %d 条相关记忆" % len(items), "items": items}
        elif name == "modify_system":
            if not self.system_runtime:
                raise RuntimeError("系统维护器没有启动")
            instruction = str(args.get("instruction") or "")
            preference_context = self.memory_store.prompt_context(instruction) if self.memory_store else {}
            result = self.system_runtime.run_system_change(instruction, execution_context=preference_context)
        elif name == "build_skill":
            if not self.system_runtime:
                raise RuntimeError("系统维护器没有启动")
            result = self.system_runtime.build_skill(str(args.get("name") or ""), str(args.get("purpose") or ""), str(args.get("example") or ""))
        elif name == "search_knowledge":
            found = self.find_knowledge(args.get("query"))
            if not found:
                raise ValueError("小院知识库里没有找到对应内容")
            item = self._payload(found)
            result = {"ok": True, "summary": "知识库找到：《%s》" % item["title"], "item": item}
        elif self.system_runtime and any(skill.get("name") == name for skill in self.system_runtime.dynamic_skills()):
            result = self.system_runtime.execute_dynamic(name, args)
        else:
            raise ValueError("不认识的工具：" + str(name))
        if self.memory_store:
            self.memory_store.observe_behavior(name, args, result)
        state["task_log"].insert(0, {"time": datetime.now().astimezone().isoformat(timespec="seconds"),
                                     "tool": name, "arguments": args, "result": result["summary"], "ok": True})
        state["task_log"] = state["task_log"][:100]
        self.save_state(state)
        return result

    def skill_manifest(self):
        manifest = self._read_json("core/skills/butler_agent.json", {"tools": []})
        manifest["tools"] = list(manifest.get("tools", []))
        if self.system_runtime:
            for skill in self.system_runtime.dynamic_skills():
                manifest["tools"].append({
                    "name": skill.get("name"), "description": skill.get("description", "动态 Skill"),
                    "arguments": skill.get("arguments", {}), "permission": skill.get("permission", "normal"),
                })
        manifest["health"] = self._read_json("core/skill_health.json", {
            "ok": False, "summary": "尚未运行 Skill 验证", "skills": [],
        })
        manifest["skills"] = self.system_runtime.skill_catalog() if self.system_runtime else []
        manifest["can_build"] = bool(self.system_runtime and self.system_runtime.permissions().get("steward_mode"))
        return manifest

    def skill_instructions(self, message):
        words = set(re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_-]{3,}", str(message or "")))
        scored = []
        for pattern in ("core/skills/*/SKILL.md", "core/private_skills/*/SKILL.md"):
            for path in self.root.glob(pattern):
                text = path.read_text(encoding="utf-8", errors="replace")[:5000]
                score = sum(1 for word in words if word.lower() in text.lower())
                if score:
                    scored.append((score, path.parent.name, text))
        return [{"name": name, "instructions": text[:2600]} for _score, name, text in sorted(scored, reverse=True)[:4]]

    @staticmethod
    def _extract_json(text):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
        try:
            return json.loads(cleaned)
        except ValueError:
            match = re.search(r"\{[\s\S]*\}", cleaned)
            if not match:
                raise ValueError("阿栗没有生成可执行的工具计划")
            return json.loads(match.group(0))

    def _fast_plan(self, message):
        """Route unambiguous commands without spending an AI round trip."""
        text = str(message or "").strip()
        urls = re.findall(r"https?://[^\s，。；、)）]+", text)
        asks_status = re.search(r"(检查|查看|确认).{0,8}(系统|小院|阿栗).{0,8}(状态|是否正常|健康)|系统状态", text)
        asks_change = re.search(r"(?<!不要)(?<!不用)(修改|重构|调整)", text)
        if asks_status and not asks_change:
            return {"answer": "我先直接检查小院的真实运行状态。", "tool_calls": [{"name": "system_status", "arguments": {}}]}
        if re.search(r"(立即|现在|重新|手动).{0,6}(更新|刷新|生成).{0,4}周报|重新抓取.{0,4}周报", text):
            return {"answer": "我现在重新巡逻信息源并生成本周周报。", "tool_calls": [{"name": "run_weekly_report", "arguments": {}}]}
        if urls and re.search(r"工具箱|加入工具|收录工具|工具卡片|这个工具", text):
            return {"answer": "我会读取链接、找到工具官网并整理成完整工具卡。", "tool_calls": [{"name": "add_tool_from_link", "arguments": {"url": urls[0], "instruction": text}}]}
        if urls and re.search(r"解析|归档|收入栗夹|收录|整理这篇|这个链接", text):
            category = next((name for name in BASE_CATEGORIES if name in text), "")
            return {"answer": "我会读取网页、生成摘要并写入栗夹。", "tool_calls": [{"name": "parse_and_archive", "arguments": {"url": urls[0], "category": category}}]}
        if re.search(r"加入待读|放进待读|稍后看", text):
            query = urls[0] if urls else re.sub(r"加入待读|放进待读|稍后看|这篇|帮我", "", text).strip()
            if query:
                return {"answer": "我现在把它加入待读。", "tool_calls": [{"name": "add_read_later", "arguments": {"query": query}}]}
        if re.search(r"收入栗夹|收进栗夹|归档到栗夹", text):
            query = re.sub(r"收入栗夹|收进栗夹|归档到栗夹|这篇|帮我|把", "", text).strip()
            if query:
                return {"answer": "我会从周报和知识库里找到它再归档。", "tool_calls": [{"name": "archive_from_knowledge", "arguments": {"query": query}}]}
        if urls and re.search(r"媒体|信息源|来源|以后.{0,8}(找|看|巡逻|关注)", text):
            before = text.split(urls[0], 1)[0]
            name = re.sub(r".*?(?:把|新增|加入|关注)", "", before).strip("，, 。")[-40:]
            return {"answer": "我会把这个来源加入后续巡逻。", "tool_calls": [{"name": "add_source", "arguments": {"name": name or urls[0], "url": urls[0]}}]}
        if re.search(r"你能做什么|有哪些能力|会做什么|怎么用阿栗", text):
            return {
                "answer": "我可以直接管理周报、解析并归档网页、整理栗夹和待读、管理工具箱与分类、记录旅行和果园种子、查询或修正记忆。掌院权限已开启时，我还能为系统快照后修改页面、提示词和 Skill，验证失败会明确报错。",
                "tool_calls": [],
            }
        return None

    def run_agent(self, message, browser_context, system_prompt, knowledge_context):
        state = self.merge_browser_context(browser_context or {})
        skill = self.skill_manifest()
        selected_skills = self.skill_instructions(message)
        permissions = self.system_runtime.permissions() if self.system_runtime else {"steward_mode": False}
        state_context = {key: value for key, value in state.items() if key != "task_log"}
        state_context["recent_tasks"] = state.get("task_log", [])[:8]
        prompt = f"""{system_prompt}

你现在是一个可以调用真实本地工具的 Agent。根据主人要求决定是否调用工具。
必须只返回 JSON，不要 Markdown：
{{"answer":"对问题的直接回答或执行说明，不得声称尚未执行","tool_calls":[{{"name":"工具名","arguments":{{}}}}]}}
规则：
1. 主人要求解析、归档、待读、改分类、加来源、加关注方向或加工具时，必须调用相应工具，不能只用文字答应。
2. 链接要求解析/整理/归档时用 parse_and_archive；链接要求加入工具箱时用 add_tool_from_link；提到周报已有文章时用 archive_from_knowledge。
3. 一次最多 5 个工具。工具参数必须来自主人原话，不得编造链接。
4. 只是问问题时可以用 search_knowledge；普通闲聊可以不调用工具。
5. 归档默认只用“模型与技术 / 产品与实践 / 行业动态 / 学术研究”四类；只有主人明确说出自定义分类名时才使用新分类。
6. 主人要求新增、改名或删除公告板分类时调用 manage_notice_category。
7. 主人明确要求记住、忘记或查询个人记忆时调用对应记忆工具。
8. 涉及页面、系统逻辑、Prompt、记忆架构或 Skill 的修改必须调用 modify_system；缺少可复用能力时调用 build_skill。掌院权限关闭时如实提示去密阁开启。
9. 不得仅凭文字声称完成修改。系统工具返回成功后才能说已完成。
10. 只要返回了 tool_calls，answer 只能简短说明准备做什么，不得提前编造工具结果、清单、摘要或成功状态；真实结果会由系统在工具执行后追加。
11. 主人要求记录旅行、回家、删除旅程时调用 manage_trip；要求播种、更新困惑或收成时调用 manage_growth_seed；要求新增、更新、移动或删除成长知识专题时调用 manage_knowledge_topic。
12. 主人要求立即刷新周报时调用 run_weekly_report；询问系统是否正常时调用 system_status。
13. 只有主人明确要求生成图片或视频时才调用 generate_media；图片可指定 seedream 或 openai，视频使用 seedance。视频提交后不要声称已经生成完成。
14. 主人要求查看生成进度时调用 check_media_task，不得编造任务状态。

可用 Skill：{json.dumps(skill, ensure_ascii=False)}
当前匹配的 Skill 说明：{json.dumps(selected_skills, ensure_ascii=False)}
当前权限：{json.dumps(permissions, ensure_ascii=False)}
当前持久化状态：{json.dumps(state_context, ensure_ascii=False)[:10000]}
小院知识库索引：{json.dumps(knowledge_context, ensure_ascii=False)[:14000]}
主人：{message[:6000]}"""
        plan = self._fast_plan(message)
        provider = "local-router" if plan else ""
        if not plan:
            raw, provider = self.call_ai(prompt)
            plan = self._extract_json(raw)
        calls = plan.get("tool_calls") if isinstance(plan.get("tool_calls"), list) else []
        results = []
        for call in calls[:5]:
            if not isinstance(call, dict):
                continue
            name = str(call.get("name") or "")
            try:
                results.append({"tool": name, **self.execute(name, call.get("arguments") or {})})
            except Exception as exc:
                failed = {"tool": name, "ok": False, "summary": str(exc)[:300]}
                results.append(failed)
                failed_state = self.load_state()
                failed_state["task_log"].insert(0, {"time": datetime.now().astimezone().isoformat(timespec="seconds"),
                                                     "tool": name, "arguments": call.get("arguments") or {},
                                                     "result": failed["summary"], "ok": False})
                failed_state["task_log"] = failed_state["task_log"][:100]
                self.save_state(failed_state)
        answer = str(plan.get("answer") or "").strip()
        if results:
            completed = [result["summary"] for result in results if result.get("ok")]
            failed = [result["summary"] for result in results if not result.get("ok")]
            lines = []
            if answer:
                lines.append(answer)
            if completed:
                lines.append("已完成：" + "；".join(completed) + "。")
            if failed:
                lines.append("未完成：" + "；".join(failed) + "。")
            answer = "\n".join(lines)
        if not answer:
            answer = "阿栗已经检查过，但这条话里没有可执行动作。"
        return {"reply": answer, "provider": provider, "tool_results": results, "state": self.load_state()}
