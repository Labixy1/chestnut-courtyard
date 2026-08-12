#!/usr/bin/env python3
"""Evidence-backed memory cards for 栗壳小院."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path


SEALED_SOURCES = {"heart_hollow", "private_wing", "memory_nook"}
TRIVIAL_MEMORY = re.compile(r"^(?:在吗|你好|收到|好的|好|嗯|谢谢|测试|test)[！!。,.，\s]*$", re.I)
MEMORY_SCOPES = {
    "global", "learning_format", "topic_selection", "review_only", "record_only",
    "companion_style", "heart_only", "travel_only",
}

BASE_CATEGORIES = (
    ("identity", "身份与基本信息", ("身份", "基本信息", "个人信息")),
    ("communication", "沟通方式", ("表达", "语气", "回复方式")),
    ("visual", "视觉与审美", ("界面", "设计偏好", "审美")),
    ("workflow", "工作方式", ("流程", "执行偏好", "协作方式")),
    ("news", "资讯与关注", ("新闻", "周报", "信息源")),
    ("product-learning", "产品与学习", ("产品", "学习", "知识")),
    ("tools", "工具与技能", ("工具", "技能", "能力")),
    ("projects", "正在进行的事", ("项目", "任务", "进行中")),
    ("growth", "成长与方向", ("成长", "目标", "方向")),
    ("travel-life", "旅行与生活", ("旅行", "生活", "日常")),
    ("privacy", "隐私与权限", ("隐私", "权限", "边界")),
    ("experience", "经验与复盘", ("经验", "复盘", "任务经验")),
    ("general", "其他", ("通用", "未分类")),
)


class MemoryStore:
    def __init__(self, root: Path):
        self.root = root
        self.directory = root / "core/memory"
        self.lock = threading.RLock()
        self.paths = {
            "events": self.directory / "events.json",
            "short": self.directory / "short_term.json",
            "long": self.directory / "long_term.json",
            "sealed": self.directory / "sealed.json",
            "preferences": self.directory / "preferences.json",
            "working": self.directory / "working_context.json",
            "policy": self.directory / "policy.json",
            "cards": self.directory / "cards.json",
            "categories": self.directory / "categories.json",
            "profile": self.directory / "profile.json",
            "migration": self.directory / "migration.json",
        }
        self._ensure_files()
        self._migrate_legacy()
        self._repair_card_categories()
        self._import_core_records()
        self._repair_event_store()

    @staticmethod
    def now() -> str:
        return datetime.now().astimezone().isoformat(timespec="seconds")

    @staticmethod
    def _read(path: Path, fallback):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeError):
            return fallback

    @staticmethod
    def _write(path: Path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(path)

    def _ensure_files(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        now = self.now()
        defaults = {
            "events": {"version": 1, "items": []},
            "short": {"version": 3, "items": []},
            "long": {"version": 3, "items": []},
            "sealed": {"version": 1, "items": []},
            "preferences": {"version": 3, "updated_at": "", "items": []},
            "working": {"version": 1, "updated_at": "", "items": []},
            "cards": {"version": 1, "updated_at": now, "items": []},
            "categories": {
                "version": 1,
                "updated_at": now,
                "items": [
                    {"id": category_id, "name": name, "aliases": list(aliases), "system": True,
                     "status": "active", "created_at": now, "updated_at": now}
                    for category_id, name, aliases in BASE_CATEGORIES
                ],
                "suggestions": [],
            },
            "profile": {
                "version": 1, "generated_at": "", "fingerprint": "",
                "source_card_ids": [], "summary": "", "sections": [],
            },
            "migration": {"version": 1, "memory_cards_v1": {"status": "pending"}},
            "policy": {
                "version": 3,
                "short_term_days": 30,
                "repeat_to_promote": 3,
                "preference_repeat_to_confirm": 2,
                "candidate_preference_days": 45,
                "auto_category_min_cards": 3,
                "sealed_sources": sorted(SEALED_SOURCES),
                "normal_agent_can_read_sealed": False,
                "steward_agent_can_read_sealed_when_requested": True,
                "max_context_memories_per_reply": 2,
                "recent_memory_exclusion": True,
                "room_scopes": ["learning_format", "companion_style", "heart_only", "travel_only", "record_only"],
                "forgotten_ids": [],
            },
        }
        for key, value in defaults.items():
            if not self.paths[key].exists():
                self._write(self.paths[key], value)
        policy = self._read(self.paths["policy"], {})
        for key, value in defaults["policy"].items():
            policy.setdefault(key, value)
        policy["version"] = 3
        self._write(self.paths["policy"], policy)
        self._ensure_base_categories()

    def _ensure_base_categories(self):
        data = self._read(self.paths["categories"], {"version": 1, "items": [], "suggestions": []})
        existing = {item.get("id") for item in data.get("items", [])}
        now = self.now()
        for category_id, name, aliases in BASE_CATEGORIES:
            if category_id not in existing:
                data.setdefault("items", []).append({
                    "id": category_id, "name": name, "aliases": list(aliases), "system": True,
                    "status": "active", "created_at": now, "updated_at": now,
                })
        data.setdefault("suggestions", [])
        data["updated_at"] = now
        self._write(self.paths["categories"], data)

    def _core_json(self, name, fallback):
        return self._read(self.root / "core" / name, fallback)

    @staticmethod
    def _clean(value):
        return re.sub(r"\s+", " ", str(value or "")).strip()

    @staticmethod
    def _tokens(text):
        return [token.lower() for token in re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_-]{3,}", text or "")]

    def _signature(self, item):
        tokens = [token for token, _count in Counter(self._tokens(item.get("statement") or item.get("summary") or item.get("content"))).most_common(5)]
        return (item.get("source") or item.get("kind") or "unknown") + ":" + "|".join(tokens)

    @staticmethod
    def _slug(value):
        ascii_slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
        if ascii_slug:
            return ascii_slug[:36]
        return "custom-" + hashlib.sha1(str(value).encode("utf-8")).hexdigest()[:10]

    @staticmethod
    def _category_text(item):
        return " ".join(str(item.get(key) or "") for key in ("id", "name")) + " " + " ".join(item.get("aliases") or [])

    def _find_category(self, value):
        needle = self._clean(value).lower()
        if not needle:
            return None
        categories = self._read(self.paths["categories"], {"items": []}).get("items", [])
        return next((item for item in categories if item.get("status") == "active" and
                     needle in {str(item.get("id") or "").lower(), str(item.get("name") or "").lower(),
                                *(str(alias).lower() for alias in item.get("aliases") or [])}), None)

    def _infer_category(self, text, source=""):
        value = self._clean(text + " " + source)
        rules = (
            ("privacy", r"隐私|秘密|封存|密阁|树洞|权限|不要读取"),
            ("visual", r"界面|样式|颜色|配色|圆角|边框|外框|框框|图标|按钮|布局|字体|透明|背景|全屏|卡片"),
            ("news", r"周报|资讯|新闻|媒体|热点|摘要|原文|来源|栗夹|待读"),
            ("communication", r"回复|回答|问候|说话|语气|简短|详细|解释|称呼"),
            ("tools", r"工具|skill|技能|api|模型|解析链接|自动化"),
            ("product-learning", r"黑板|题目|答题|产品经理|产品|学习|评测|原型|知识"),
            ("workflow", r"验证|测试|自己执行|自动|运行|快点|仔细|一步到位|状态|流程"),
            ("travel-life", r"旅行|出游|照片|地点|回家|生活|卧室"),
            ("growth", r"果园|成长|困惑|方向|播种|感想|目标"),
            ("projects", r"项目|正在做|需求|开发|系统架构"),
            ("experience", r"经验|复盘|教训|完成了|效果"),
            ("identity", r"我是|我的名字|职业|身份|住在|所在地"),
        )
        return next((category_id for category_id, pattern in rules if re.search(pattern, value, re.I)), "general")

    def _repair_card_categories(self):
        data = self._read(self.paths["cards"], {"version": 1, "items": []})
        signature_map = {
            "news": "news", "visual": "visual", "communication": "communication",
            "product-learning": "product-learning", "learning": "product-learning",
            "workflow": "workflow", "privacy": "privacy", "travel-life": "travel-life",
            "travel": "travel-life", "growth": "growth", "tools": "tools",
        }
        changed = False
        for item in data.get("items", []):
            prefix = str(item.get("signature") or "").split(":", 1)[0]
            inferred = signature_map.get(prefix)
            if item.get("kind") == "preference" and inferred and item.get("category_id") != inferred:
                item["category_id"] = inferred
                changed = True
            elif item.get("category_id") == "general":
                inferred = self._infer_category(str(item.get("statement") or item.get("summary") or ""), str(item.get("source") or ""))
                if inferred != "general":
                    item["category_id"] = inferred
                    changed = True
            source = str(item.get("source") or "")
            if source == "travel" and item.get("scope") != "travel_only":
                item["scope"] = "travel_only"
                changed = True
            elif item.get("kind") in {"preference", "routine"} and not item.get("scope"):
                item["scope"] = "learning_format"
                changed = True
            elif not item.get("scope"):
                item["scope"] = "record_only"
                changed = True
        if changed:
            data["updated_at"] = self.now()
            self._write(self.paths["cards"], data)
            self._sync_legacy_views()

    def _repair_event_store(self):
        """Keep ordinary evidence unique and move historical sealed rows out of it."""
        with self.lock:
            events_data = self._read(self.paths["events"], {"version": 1, "items": []})
            sealed_data = self._read(self.paths["sealed"], {"version": 1, "items": []})
            cards_data = self._read(self.paths["cards"], {"version": 1, "items": []})
            forgotten = self._forgotten()
            sealed_by_id = {str(item.get("id")): item for item in sealed_data.get("items", []) if item.get("id")}
            ordinary = []
            ordinary_ids = set()
            moved_sealed = 0
            duplicate_ids = 0
            for index, original in enumerate(events_data.get("items", [])):
                item = dict(original or {})
                event_id = str(item.get("id") or "repair_%s" % hashlib.sha1(
                    (str(item.get("source")) + str(item.get("created_at")) + str(item.get("content")) + str(index)).encode("utf-8")
                ).hexdigest()[:16])
                item["id"] = event_id
                is_sealed = item.get("layer") == "sealed" or item.get("sensitivity") == "sealed" or item.get("source") in SEALED_SOURCES
                if is_sealed:
                    sealed_by_id.setdefault(event_id, {**item, "layer": "sealed", "sensitivity": "sealed"})
                    moved_sealed += 1
                    continue
                if event_id in ordinary_ids:
                    duplicate_ids += 1
                    continue
                ordinary_ids.add(event_id)
                ordinary.append(item)

            repaired_evidence = 0
            cards_changed = False
            for card in cards_data.get("items", []):
                if card.get("sensitivity") == "sealed":
                    continue
                evidence_ids = list(dict.fromkeys(str(value) for value in card.get("evidence_ids", []) if value))
                evidence_ids = [value for value in evidence_ids if value not in forgotten]
                if evidence_ids != card.get("evidence_ids", []):
                    card["evidence_ids"] = evidence_ids
                    cards_changed = True
                for evidence_id in evidence_ids:
                    if evidence_id in ordinary_ids or evidence_id in sealed_by_id:
                        continue
                    created = str(card.get("created_at") or self.now())
                    ordinary.append({
                        "id": evidence_id, "source": str(card.get("source") or "legacy"),
                        "type": "migrated_evidence", "content": self._clean(card.get("statement") or card.get("summary"))[:12000],
                        "summary": self._clean(card.get("summary") or card.get("statement"))[:600],
                        "layer": "long" if card.get("status") == "active" else "short", "sensitivity": "personal",
                        "weight": 3 if card.get("status") == "active" else 1, "created_at": created,
                        "date": created[:10], "time": created[11:16], "signature": str(card.get("signature") or ""),
                        "migration": "memory_integrity_v1",
                    })
                    ordinary_ids.add(evidence_id)
                    repaired_evidence += 1
                expected_count = len(evidence_ids)
                if evidence_ids and int(card.get("evidence_count") or 0) < expected_count:
                    card["evidence_count"] = expected_count
                    cards_changed = True

            sealed_items = list(sealed_by_id.values())[:800]
            changed = moved_sealed or duplicate_ids or repaired_evidence or len(ordinary) != len(events_data.get("items", []))
            if changed:
                events_data["items"] = ordinary[:2000]
                self._write(self.paths["events"], events_data)
                sealed_data["items"] = sealed_items
                self._write(self.paths["sealed"], sealed_data)
            if cards_changed:
                cards_data["updated_at"] = self.now()
                self._write(self.paths["cards"], cards_data)
            migration = self._read(self.paths["migration"], {"version": 1})
            if changed or not migration.get("memory_integrity_v1"):
                migration["memory_integrity_v1"] = {
                    "status": "completed", "completed_at": self.now(), "sealed_rows_moved": moved_sealed,
                    "duplicate_ids_removed": duplicate_ids, "evidence_rows_repaired": repaired_evidence,
                }
                self._write(self.paths["migration"], migration)

    def _infer_kind(self, text, source=""):
        value = self._clean(text + " " + source)
        if re.search(r"喜欢|偏好|希望|不要|习惯|默认", value):
            return "preference"
        if re.search(r"目标|方向|计划|想要|以后", value):
            return "goal"
        if re.search(r"项目|需求|系统|开发", value):
            return "project"
        if re.search(r"每周|每天|定时|习惯", value):
            return "routine"
        if re.search(r"经验|发现|意识到|复盘|启发", value):
            return "insight"
        if re.search(r"旅行|发生|经历|去了", value):
            return "experience"
        return "fact"

    def _legacy_card(self, item, status, kind=None, prefix="legacy"):
        statement = self._clean(item.get("statement") or item.get("summary") or item.get("content"))
        if not statement or TRIVIAL_MEMORY.match(statement):
            return None
        legacy_id = str(item.get("id") or hashlib.sha1(statement.encode("utf-8")).hexdigest()[:12])
        source = str(item.get("source") or "legacy")
        card_kind = kind or self._infer_kind(statement, source)
        category_id = self._infer_category(statement, source)
        evidence_ids = [str(value) for value in item.get("source_events") or [] if value]
        if item.get("id"):
            evidence_ids.append(str(item["id"]))
        evidence_ids = list(dict.fromkeys(evidence_ids))
        created = str(item.get("first_observed") or item.get("created_at") or self.now())
        updated = str(item.get("last_observed") or item.get("updated_at") or created)
        return {
            "id": "card_%s_%s" % (prefix, re.sub(r"[^A-Za-z0-9_-]", "", legacy_id)[:48]),
            "kind": card_kind,
            "category_id": category_id,
            "title": statement[:42],
            "statement": statement[:1200],
            "summary": statement[:600],
            "status": status,
            "confidence": float(item.get("confidence") or (0.92 if status == "active" else 0.58)),
            "evidence_ids": evidence_ids,
            "evidence_count": max(int(item.get("evidence_count") or 1), len(evidence_ids)),
            "scope": str(item.get("scope") or "global"),
            "valid_until": item.get("valid_until"),
            "last_verified": str(item.get("last_observed") or item.get("date") or updated)[:25],
            "created_at": created,
            "updated_at": updated,
            "sensitivity": "personal",
            "source": source,
            "signature": str(item.get("key") or item.get("signature") or self._signature({"source": source, "summary": statement})),
            "legacy_id": item.get("id"),
        }

    def _migrate_legacy(self):
        with self.lock:
            migration = self._read(self.paths["migration"], {"version": 1})
            if migration.get("memory_cards_v1", {}).get("status") == "completed":
                return
            cards_data = self._read(self.paths["cards"], {"version": 1, "items": []})
            known = {item.get("id") for item in cards_data.get("items", [])}
            imported = {"preferences": 0, "long": 0, "short": 0}
            sources = (
                ("preferences", self._read(self.paths["preferences"], {"items": []}).get("items", [])),
                ("long", self._read(self.paths["long"], {"items": []}).get("items", [])),
                ("short", self._read(self.paths["short"], {"items": []}).get("items", [])),
            )
            for source_name, items in sources:
                for item in items:
                    if source_name == "preferences":
                        legacy_status = str(item.get("status") or "candidate")
                        status = "active" if legacy_status == "confirmed" else legacy_status
                        card = self._legacy_card(item, status, kind="preference", prefix="pref")
                    else:
                        card = self._legacy_card(item, "active" if source_name == "long" else "candidate", prefix=source_name)
                    if card and card["id"] not in known:
                        cards_data.setdefault("items", []).append(card)
                        known.add(card["id"])
                        imported[source_name] += 1
            cards_data["updated_at"] = self.now()
            self._write(self.paths["cards"], cards_data)
            migration["memory_cards_v1"] = {
                "status": "completed", "completed_at": self.now(), "imported": imported,
                "legacy_files_retained": True,
            }
            self._write(self.paths["migration"], migration)
            self._sync_legacy_views()

    def _import_core_records(self):
        for entry in self._core_json("heart_hollow.json", {}).get("entries", []):
            self.add_event({
                "id": "core_heart_" + str(entry.get("date", "")) + "_" + str(entry.get("time", "")).replace(":", ""),
                "date": entry.get("date", ""), "time": entry.get("time", ""),
                "source": "heart_hollow", "type": "heart_entry", "layer": "sealed", "sensitivity": "sealed",
                "content": entry.get("transcript", ""), "summary": "树洞记录：" + str(entry.get("transcript", ""))[:100], "weight": 2,
            })
        wing = self._core_json("private_wing.json", {})
        for plate in wing.get("plates", []):
            self.add_event({
                "id": "core_plate_" + str(plate.get("id", "")), "date": plate.get("date", ""),
                "source": "private_wing", "type": "pattern_plate", "layer": "sealed", "sensitivity": "sealed",
                "content": plate.get("content", ""), "summary": plate.get("content", ""), "weight": 4,
            })
        for index, diary in enumerate(wing.get("diary", [])):
            self.add_event({
                "id": "core_diary_" + str(index) + "_" + str(diary.get("date", "")), "date": diary.get("date", ""),
                "source": "private_wing", "type": "private_diary", "layer": "sealed", "sensitivity": "sealed",
                "content": diary.get("content", ""), "summary": diary.get("content", ""), "weight": 4,
            })
        for trip in self._core_json("estate_state.json", {}).get("travel", {}).get("history", []):
            self.add_event({
                "id": "core_trip_" + str(trip.get("id", "")), "date": trip.get("date", ""),
                "source": "travel", "type": "trip", "layer": "long", "content": trip.get("line", ""),
                "summary": "旅行记录：%s · %s" % (trip.get("place", ""), trip.get("line", "")), "weight": 2,
                "scope": "travel_only", "room_id": str(trip.get("id") or ""),
            })

    def _forgotten(self):
        policy = self._read(self.paths["policy"], {})
        return {str(entry.get("id") if isinstance(entry, dict) else entry) for entry in policy.get("forgotten_ids", [])}

    def _sync_legacy_views(self):
        cards = self._read(self.paths["cards"], {"items": []}).get("items", [])
        visible = [item for item in cards if item.get("status") not in {"rejected", "superseded"}]
        def legacy(item, layer):
            return {
                **item, "layer": layer, "content": item.get("statement", ""),
                "summary": item.get("summary") or item.get("statement", ""),
                "date": str(item.get("updated_at") or item.get("created_at") or "")[:10],
                "time": str(item.get("updated_at") or item.get("created_at") or "")[11:16],
                "weight": max(1, min(5, round(float(item.get("confidence") or 0.5) * 5))),
            }
        long_items = [legacy(item, "long") for item in visible if item.get("status") == "active"]
        short_items = [legacy(item, "short") for item in visible if item.get("status") == "candidate"]
        preferences = []
        for item in cards:
            if item.get("kind") != "preference":
                continue
            preferences.append({
                **item,
                "domain": item.get("category_id", "general"),
                "status": "confirmed" if item.get("status") == "active" else item.get("status"),
                "last_observed": item.get("updated_at"),
                "first_observed": item.get("created_at"),
                "explicit": float(item.get("confidence") or 0) >= 0.9,
            })
        self._write(self.paths["long"], {"version": 3, "items": long_items[:800]})
        self._write(self.paths["short"], {"version": 3, "items": short_items[:800]})
        self._write(self.paths["preferences"], {"version": 3, "updated_at": self.now(), "items": preferences[:300]})
        self._refresh_profile(cards)

    def _refresh_profile(self, cards=None):
        cards = cards if isinstance(cards, list) else self._read(self.paths["cards"], {"items": []}).get("items", [])
        active = [item for item in cards if item.get("status") == "active" and item.get("sensitivity") != "sealed"]
        active = sorted(active, key=lambda item: (str(item.get("category_id") or ""), str(item.get("updated_at") or "")), reverse=True)
        category_items = self._read(self.paths["categories"], {"items": []}).get("items", [])
        categories = {item.get("id"): item.get("name") for item in category_items}
        fingerprint_source = "|".join(
            "%s:%s:%s:%s" % (item.get("id", ""), item.get("updated_at", ""), item.get("category_id", ""), item.get("statement", ""))
            for item in active
        )
        fingerprint_source += "||" + "|".join("%s:%s" % (item.get("id", ""), item.get("name", "")) for item in category_items)
        fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()[:20]
        current = self._read(self.paths["profile"], {"fingerprint": ""})
        if current.get("fingerprint") == fingerprint:
            return current
        section_order = (
            ("identity", "关于我"),
            ("projects", "我正在做的事"),
            ("growth", "我的方向"),
            ("communication", "我喜欢的沟通方式"),
            ("workflow", "我习惯的做事方式"),
            ("visual", "我的审美与体验偏好"),
            ("news", "我关注的信息"),
            ("product-learning", "我的产品与学习关注"),
            ("tools", "我常用的工具与能力"),
            ("travel-life", "我的生活与旅行"),
            ("experience", "我沉淀的经验"),
            ("privacy", "我的边界"),
            ("general", "其他关于我的事"),
        )
        grouped = {}
        for item in active:
            statement = self._clean(item.get("statement") or item.get("summary"))
            if statement:
                grouped.setdefault(item.get("category_id") or "general", []).append(statement)
        sections = []
        used = set()
        for category_id, title in section_order:
            statements = list(dict.fromkeys(grouped.get(category_id, [])))
            if not statements:
                continue
            used.add(category_id)
            text = "；".join(value.rstrip("。；") for value in statements[:8]) + "。"
            sections.append({"id": category_id, "title": title, "text": text})
        for category_id, statements in grouped.items():
            if category_id in used:
                continue
            text = "；".join(value.rstrip("。；") for value in list(dict.fromkeys(statements))[:8]) + "。"
            sections.append({"id": category_id, "title": categories.get(category_id, "其他关于我的事"), "text": text})
        if sections:
            summary = "\n\n".join(section["title"] + "\n" + section["text"] for section in sections)
        else:
            summary = "阿栗还没有足够确定的记忆。观察中的线索不会写进这份档案。"
        profile = {
            "version": 1,
            "generated_at": self.now(),
            "fingerprint": fingerprint,
            "source_card_ids": [item.get("id") for item in active],
            "source_count": len(active),
            "summary": summary,
            "sections": sections,
            "rules": ["只使用已生效记忆", "不包含封存原文", "记忆变化后自动重写"],
        }
        self._write(self.paths["profile"], profile)
        return profile

    def _inner_profile(self):
        """Turn sealed tree-hollow records into private, non-quoting tendencies."""
        sealed = self._read(self.paths["sealed"], {"items": []}).get("items", [])
        records = [item for item in sealed if item.get("source") == "heart_hollow"][:160]
        themes = (
            ("work", "工作与方向", r"工作|公司|项目|职业|面试|产品|会议|同事", "会认真追问投入是否值得，也希望把下一步想清楚"),
            ("relationship", "关系与边界", r"朋友|关系|家人|相处|他说|她说|理解|边界", "在关系里重视真诚、边界和是否被真正理解"),
            ("pressure", "自我要求", r"压力|累|焦虑|失败|做不好|来不及|应该|必须|责怪", "对自己有要求，也正在学习分辨哪些重量不必一直背着"),
            ("choice", "选择与变化", r"选择|决定|以后|方向|改变|放弃|离开|开始", "面对重要选择时会反复权衡，希望决定来自真实意愿"),
            ("life", "生活与恢复", r"旅行|睡|休息|家里|生活|天气|散步|吃饭", "会从具体生活体验里恢复能量，也珍惜不被任务占满的时刻"),
        )
        counts = Counter()
        for item in records:
            text = self._clean(str(item.get("content") or "") + " " + str(item.get("summary") or ""))
            for theme_id, _title, pattern, _insight in themes:
                if re.search(pattern, text, re.I):
                    counts[theme_id] += 1
        visible = []
        for theme_id, title, _pattern, insight in themes:
            count = counts.get(theme_id, 0)
            if count >= 2:
                visible.append({"id": theme_id, "title": title, "text": insight, "evidence_count": count})
        if not records:
            summary = "树洞里还没有足够内容形成内在轨迹。"
        elif visible:
            summary = "；".join(item["text"] for item in visible[:4]) + "。"
        else:
            summary = "树洞里已经有一些只属于你的记录，阿栗仍在观察重复出现的线索，不会用单次倾诉定义你。"
        fingerprint = hashlib.sha256("|".join(
            "%s:%s:%s" % (item.get("id", ""), item.get("date", ""), item.get("summary", ""))
            for item in records
        ).encode("utf-8")).hexdigest()[:20]
        return {
            "version": 1, "generated_at": self.now(), "fingerprint": fingerprint,
            "source_count": len(records), "summary": summary, "sections": visible,
            "rules": ["只提炼重复倾向", "不展示树洞原话", "单次倾诉不会定义人格"],
        }

    def state(self, include_sealed=False):
        cards = self._read(self.paths["cards"], {"items": []}).get("items", [])
        categories_data = self._read(self.paths["categories"], {"items": [], "suggestions": []})
        result = {
            "cards": cards,
            "categories": categories_data.get("items", []),
            "category_suggestions": categories_data.get("suggestions", []),
            "events": self._read(self.paths["events"], {"items": []}).get("items", []),
            "short": self._read(self.paths["short"], {"items": []}).get("items", []),
            "long": self._read(self.paths["long"], {"items": []}).get("items", []),
            "preferences": self._read(self.paths["preferences"], {"items": []}).get("items", []),
            "working": self._read(self.paths["working"], {"items": []}).get("items", []),
            "policy": self._read(self.paths["policy"], {}),
            "migration": self._read(self.paths["migration"], {}),
            "profile": self._refresh_profile(cards),
            "inner_profile": self._inner_profile(),
        }
        result["sealed"] = self._read(self.paths["sealed"], {"items": []}).get("items", []) if include_sealed else []
        return result

    def _upsert_card_from_event(self, item):
        if item.get("layer") == "sealed" or item.get("sensitivity") == "sealed":
            return None
        statement = self._clean(item.get("summary") or item.get("content"))
        if not statement or TRIVIAL_MEMORY.match(statement):
            return None
        cards_data = self._read(self.paths["cards"], {"version": 1, "items": []})
        signature = item.get("signature") or self._signature(item)
        card = next((old for old in cards_data.get("items", []) if old.get("signature") == signature and old.get("status") not in {"rejected", "superseded"}), None)
        explicit = bool(item.get("remember") or item.get("layer") == "long" or int(item.get("weight") or 1) >= 3)
        threshold = int(self._read(self.paths["policy"], {}).get("repeat_to_promote", 3))
        now = self.now()
        inferred_kind = self._infer_kind(statement, item.get("source", ""))
        requested_scope = str(item.get("scope") or "")
        if requested_scope not in MEMORY_SCOPES:
            requested_scope = "learning_format" if inferred_kind in {"preference", "routine"} else "record_only"
        if item.get("source") == "travel":
            requested_scope = "travel_only"
        if card:
            evidence_ids = list(dict.fromkeys([*(card.get("evidence_ids") or []), item["id"]]))
            card["evidence_ids"] = evidence_ids[-24:]
            card["evidence_count"] = max(int(card.get("evidence_count") or 1), len(evidence_ids))
            card["updated_at"] = now
            card["last_verified"] = item.get("created_at", now)
            card["scope"] = requested_scope
            if len(statement) > len(str(card.get("summary") or "")):
                card["summary"] = statement[:600]
                card["statement"] = statement[:1200]
            hold_count = int(card.get("distillation_hold_count") or 0)
            if explicit or (card["evidence_count"] >= threshold and card["evidence_count"] > hold_count):
                card["status"] = "active"
                card["confidence"] = max(0.9, float(card.get("confidence") or 0))
                card.pop("distillation_hold_count", None)
            else:
                card["confidence"] = min(0.88, float(card.get("confidence") or 0.55) + 0.08)
        else:
            status = "active" if explicit else "candidate"
            card = {
                "id": "card_" + uuid.uuid4().hex[:14],
                "kind": inferred_kind,
                "category_id": self._infer_category(statement, item.get("source", "")),
                "title": statement[:42], "statement": statement[:1200], "summary": statement[:600],
                "status": status, "confidence": 0.94 if explicit else 0.58,
                "evidence_ids": [item["id"]], "evidence_count": 1, "scope": requested_scope,
                "valid_until": None, "last_verified": item.get("created_at", now),
                "created_at": now, "updated_at": now, "sensitivity": "personal",
                "source": item.get("source", "unknown"), "signature": signature,
            }
            cards_data.setdefault("items", []).insert(0, card)
        cards_data["items"] = sorted(cards_data.get("items", []), key=lambda value: value.get("updated_at", ""), reverse=True)[:1000]
        cards_data["updated_at"] = now
        self._write(self.paths["cards"], cards_data)
        self._sync_legacy_views()
        return card

    def add_event(self, event: dict):
        with self.lock:
            item = dict(event or {})
            item["id"] = str(item.get("id") or ("mem_" + uuid.uuid4().hex[:14]))
            if item["id"] in self._forgotten():
                return {"id": item["id"], "ignored": True, "reason": "forgotten"}
            item["created_at"] = str(item.get("created_at") or self.now())
            item["date"] = str(item.get("date") or item["created_at"][:10])
            item["time"] = str(item.get("time") or item["created_at"][11:16])
            item["source"] = self._clean(item.get("source") or "unknown")[:60]
            item["type"] = self._clean(item.get("type") or "note")[:80]
            item["content"] = self._clean(item.get("content"))[:12000]
            item["summary"] = self._clean(item.get("summary") or item["content"])[:600]
            item["weight"] = max(1, min(int(item.get("weight") or 1), 5))
            requested = str(item.get("layer") or "short")
            item["sensitivity"] = str(item.get("sensitivity") or ("sealed" if item["source"] in SEALED_SOURCES else "personal"))
            item["layer"] = "sealed" if item["sensitivity"] == "sealed" or requested == "sealed" else ("long" if requested == "long" or item["weight"] >= 3 or item.get("remember") is True else "short")
            requested_scope = str(item.get("scope") or "")
            if requested_scope not in MEMORY_SCOPES:
                requested_scope = "heart_only" if item["layer"] == "sealed" else ("travel_only" if item["source"] == "travel" else "record_only")
            item["scope"] = requested_scope
            if item.get("room_id") is not None:
                item["room_id"] = self._clean(item.get("room_id"))[:160]
            item["signature"] = self._signature(item)
            if item["layer"] == "sealed":
                sealed = self._read(self.paths["sealed"], {"version": 1, "items": []})
                sealed["items"] = [old for old in sealed.get("items", []) if old.get("id") != item["id"]]
                sealed["items"].insert(0, item)
                sealed["items"] = sealed["items"][:800]
                self._write(self.paths["sealed"], sealed)
                self.prune_short()
                return item
            events = self._read(self.paths["events"], {"version": 1, "items": []})
            duplicate = next((old for old in events.get("items", []) if old.get("id") == item["id"] or
                              (old.get("source") == item["source"] and old.get("date") == item["date"] and self._clean(old.get("content")) == item["content"] and item["content"])), None)
            if duplicate:
                item = {**duplicate, **{key: value for key, value in item.items() if value not in (None, "")}}
                item["id"] = duplicate["id"]
                events["items"] = [old for old in events.get("items", []) if old.get("id") != duplicate.get("id")]
                events["items"].insert(0, item)
            else:
                events.setdefault("items", []).insert(0, item)
            events["items"] = events["items"][:2000]
            self._write(self.paths["events"], events)
            if not duplicate:
                self._upsert_card_from_event(item)
            self.prune_short()
            return item

    @staticmethod
    def _preference_domain(statement):
        mapping = {
            "news": "news", "visual": "visual", "communication": "communication", "voice": "communication",
            "learning": "product-learning", "workflow": "workflow", "privacy": "privacy",
            "travel": "travel-life", "growth": "growth", "general": "general",
        }
        text = str(statement or "")
        rules = (
            ("news", r"周报|资讯|新闻|媒体|热点|摘要|原文|来源|栗夹|待读"),
            ("visual", r"界面|样式|颜色|配色|圆角|边框|外框|框框|图标|按钮|布局|字体|大小|透明|背景|全屏|卡片"),
            ("communication", r"回复|回答|问候|说话|语气|简短|详细|解释|称呼"),
            ("voice", r"语音|话筒|麦克风|转文字|倾诉"),
            ("learning", r"黑板|题目|答题|产品经理|学习|评测|原型|记忆系统"),
            ("workflow", r"验证|测试|自己执行|自动|运行|快点|仔细|一步到位|状态"),
            ("privacy", r"隐私|秘密|封存|密阁|树洞|不要读取|权限"),
            ("travel", r"旅行|出游|照片|地点|回家"),
            ("growth", r"果园|成长|困惑|方向|播种|感想"),
        )
        domain = next((name for name, pattern in rules if re.search(pattern, text, re.I)), "general")
        return mapping[domain]

    @classmethod
    def _preference_key(cls, statement):
        text = cls._clean(statement).lower()
        domain = cls._preference_domain(text)
        slots = (
            ("opening", r"问候|开场|能力清单"), ("length", r"简短|详细|太长|太短|字数"),
            ("tone", r"语气|说话|死板|温柔|直接"), ("corners", r"圆角|圆边"),
            ("frames", r"边框|框框|外圈|胶囊"), ("colors", r"颜色|配色|粉色|绿色|金色|褐色"),
            ("icons", r"图标|话筒|麦克风|纸飞机|箭头"), ("layout", r"位置|布局|大小|全屏|尺寸"),
            ("news_focus", r"热点|重点资讯|重大|模型发布"), ("news_summary", r"摘要|总结|insight|关注点"),
            ("news_source", r"媒体|来源|官网"), ("voice_input", r"语音|转文字|倾诉"),
            ("validation", r"验证|测试|自己执行|能运行"), ("speed", r"快点|速度|慢"),
            ("privacy", r"隐私|封存|秘密|密阁|树洞"),
        )
        slot = next((name for name, pattern in slots if re.search(pattern, text, re.I)), "")
        prefix = "companion:" if cls._preference_scope(text) == "companion_style" else ""
        return prefix + domain + ":" + (slot or hashlib.sha1(text.encode("utf-8")).hexdigest()[:12])

    @staticmethod
    def _preference_scope(statement):
        text = str(statement or "")
        if re.search(r"陪聊|陪伴|树洞|情绪|安慰|解闷|聊天|死板|套话|总追问|每次都问|温和反驳|灵活一点", text, re.I):
            return "companion_style"
        return "learning_format"

    @classmethod
    def _preference_statement(cls, clause):
        text = cls._clean(clause).strip("，。；;、 ")
        return re.sub(r"^(?:然后|还有|就是|请|你|阿栗)+", "", text).strip()[:360]

    def add_preference(self, statement, source="butler", explicit=False, evidence="", status=""):
        with self.lock:
            statement = self._preference_statement(statement)
            if len(statement) < 4:
                return None
            now = self.now()
            key = self._preference_key(statement)
            scope = self._preference_scope(statement)
            cards_data = self._read(self.paths["cards"], {"version": 1, "items": []})
            card = next((item for item in cards_data.get("items", []) if item.get("kind") == "preference" and item.get("signature") == key and item.get("status") != "superseded"), None)
            threshold = int(self._read(self.paths["policy"], {}).get("preference_repeat_to_confirm", 2))
            evidence_id = "evidence_" + uuid.uuid4().hex[:14]
            event = {
                "id": evidence_id, "source": source, "type": "preference_evidence", "content": self._clean(evidence or statement)[:1200],
                "summary": statement, "date": now[:10], "time": now[11:16], "created_at": now,
                "layer": "short", "sensitivity": "personal", "weight": 1,
            }
            events = self._read(self.paths["events"], {"version": 1, "items": []})
            events.setdefault("items", []).insert(0, event)
            events["items"] = events["items"][:2000]
            self._write(self.paths["events"], events)
            desired = "active" if status in {"confirmed", "active"} or explicit else (status or "candidate")
            if card:
                previous = str(card.get("statement") or "")
                if explicit and previous != statement:
                    card.setdefault("history", []).insert(0, {"statement": previous, "superseded_at": now})
                    card["history"] = card["history"][:10]
                card["statement"] = statement if explicit or len(statement) >= len(previous) else previous
                card["summary"] = card["statement"][:600]
                card["title"] = card["statement"][:42]
                card["evidence_ids"] = list(dict.fromkeys([*(card.get("evidence_ids") or []), evidence_id]))[-24:]
                card["evidence_count"] = int(card.get("evidence_count") or 1) + 1
                card["confidence"] = min(0.99, max(float(card.get("confidence") or 0.55), 0.95 if explicit else 0.58 + card["evidence_count"] * 0.12))
                card["updated_at"] = now
                card["last_verified"] = now
                card["scope"] = scope
                card["status"] = "active" if explicit or desired == "active" or card["evidence_count"] >= threshold else desired
            else:
                card = {
                    "id": "card_" + uuid.uuid4().hex[:14], "kind": "preference",
                    "category_id": self._preference_domain(statement), "title": statement[:42],
                    "statement": statement, "summary": statement, "status": desired,
                    "confidence": 0.95 if explicit else 0.62, "evidence_ids": [evidence_id], "evidence_count": 1,
                    "scope": scope, "valid_until": None, "last_verified": now,
                    "created_at": now, "updated_at": now, "sensitivity": "personal",
                    "source": source, "signature": key, "history": [],
                }
                cards_data.setdefault("items", []).insert(0, card)
            cards_data["items"] = sorted(cards_data.get("items", []), key=lambda value: value.get("updated_at", ""), reverse=True)[:1000]
            cards_data["updated_at"] = now
            self._write(self.paths["cards"], cards_data)
            self._sync_legacy_views()
            return card

    def observe_message(self, message, source="butler"):
        text = self._clean(message)
        if not text or source in SEALED_SOURCES:
            return []
        now = self.now()
        working = self._read(self.paths["working"], {"version": 1, "updated_at": "", "items": []})
        working.setdefault("items", []).insert(0, {"id": "work_" + uuid.uuid4().hex[:12], "source": source, "summary": text[:500], "date": now[:10], "time": now[11:16], "created_at": now})
        working["items"] = working["items"][:80]
        working["updated_at"] = now
        self._write(self.paths["working"], working)
        clauses = [self._clean(value) for value in re.split(r"[。！？；\n]+", text) if self._clean(value)]
        observed = []
        explicit_pattern = r"我(?:更)?(?:喜欢|偏好|希望|不喜欢|不希望|习惯)|请记住|记住我|以后(?:都|请)|默认(?:用|是|要)"
        candidate_pattern = r"(?:^|，)(?:不要|别再|需要|要用|改成|保留|去掉|只要|不需要)"
        for clause in clauses[:12]:
            explicit = bool(re.search(explicit_pattern, clause))
            if not explicit and re.search(r"只读|不要修改任何内容|不要执行|先不|暂时|仅本次|这一次", clause):
                continue
            if explicit or re.search(candidate_pattern, clause):
                item = self.add_preference(clause, source=source, explicit=explicit, evidence=text)
                if item:
                    observed.append(item)
        return observed

    def observe_behavior(self, tool, arguments, result=None):
        args = arguments if isinstance(arguments, dict) else {}
        statement = ""
        if tool == "add_watch_topic" and args.get("topic"):
            statement = "资讯关注方向偏好：" + str(args["topic"])
        elif tool == "add_source" and (args.get("name") or args.get("url")):
            statement = "周报巡逻时关注来源：" + str(args.get("name") or args.get("url"))
        elif tool in {"archive_from_knowledge", "parse_and_archive"} and args.get("category"):
            statement = "资料归档时常用分类：" + str(args.get("category"))
        elif tool == "manage_growth_seed" and args.get("text"):
            statement = "当前成长关注方向：" + str(args.get("text"))[:220]
        return self.add_preference(statement, source="behavior:" + tool, explicit=False, evidence=json.dumps(args, ensure_ascii=False)[:500]) if statement else None

    def set_card_status(self, card_id, status):
        if status not in {"active", "candidate", "rejected", "superseded"}:
            raise ValueError("卡片状态无效")
        data = self._read(self.paths["cards"], {"version": 1, "items": []})
        item = next((entry for entry in data.get("items", []) if entry.get("id") == card_id or entry.get("legacy_id") == card_id), None)
        if not item:
            raise ValueError("没有找到这张记忆卡片")
        item["status"] = status
        item["updated_at"] = self.now()
        if status == "active":
            item["confidence"] = max(0.9, float(item.get("confidence") or 0))
            item["last_verified"] = self.now()
        data["updated_at"] = self.now()
        self._write(self.paths["cards"], data)
        self._sync_legacy_views()
        return {"ok": True, "summary": "记忆卡片状态已更新", "item": item}

    def set_card_scope(self, card_id, scope):
        if scope not in MEMORY_SCOPES - {"heart_only"}:
            raise ValueError("记忆参与范围无效")
        data = self._read(self.paths["cards"], {"version": 1, "items": []})
        item = next((entry for entry in data.get("items", []) if entry.get("id") == card_id or entry.get("legacy_id") == card_id), None)
        if not item:
            raise ValueError("没有找到这张记忆卡片")
        item["scope"] = scope
        item["updated_at"] = self.now()
        data["updated_at"] = self.now()
        self._write(self.paths["cards"], data)
        self._sync_legacy_views()
        return {"ok": True, "summary": "记忆参与范围已更新", "item": item}

    def set_preference_status(self, preference_id, status):
        mapped = {"confirmed": "active", "candidate": "candidate", "rejected": "rejected"}
        if status not in mapped:
            raise ValueError("偏好状态只能是 confirmed、candidate 或 rejected")
        return self.set_card_status(preference_id, mapped[status])

    def create_category(self, name, explicit=True, related_card_ids=None):
        name = self._clean(name)[:28]
        if len(name) < 2:
            raise ValueError("分类名称至少需要两个字")
        with self.lock:
            existing = self._find_category(name)
            if existing:
                return {"ok": True, "summary": "已使用现有分类“%s”" % existing["name"], "category": existing}
            data = self._read(self.paths["categories"], {"version": 1, "items": [], "suggestions": []})
            now = self.now()
            related = list(dict.fromkeys(str(value) for value in (related_card_ids or []) if value))
            if explicit:
                category = {"id": self._slug(name), "name": name, "aliases": [], "system": False,
                            "status": "active", "created_at": now, "updated_at": now}
                ids = {item.get("id") for item in data.get("items", [])}
                if category["id"] in ids:
                    category["id"] += "-" + uuid.uuid4().hex[:4]
                data.setdefault("items", []).append(category)
                data["suggestions"] = [item for item in data.get("suggestions", []) if item.get("name") != name]
                summary = "已创建记忆分类“%s”" % name
            else:
                suggestion = next((item for item in data.get("suggestions", []) if item.get("name") == name), None)
                if not suggestion:
                    suggestion = {"id": "suggest_" + uuid.uuid4().hex[:10], "name": name, "related_card_ids": [], "evidence_count": 0, "created_at": now}
                    data.setdefault("suggestions", []).append(suggestion)
                suggestion["related_card_ids"] = list(dict.fromkeys([*(suggestion.get("related_card_ids") or []), *related]))[-30:]
                suggestion["evidence_count"] = max(int(suggestion.get("evidence_count") or 0) + (0 if related else 1), len(suggestion["related_card_ids"]))
                suggestion["updated_at"] = now
                threshold = int(self._read(self.paths["policy"], {}).get("auto_category_min_cards", 3))
                if suggestion["evidence_count"] >= threshold:
                    return self.create_category(name, explicit=True, related_card_ids=related)
                category = suggestion
                summary = "已把“%s”记为候选分类，还需 %d 条相关记忆" % (name, threshold - suggestion["evidence_count"])
            data["updated_at"] = now
            self._write(self.paths["categories"], data)
            return {"ok": True, "summary": summary, "category": category}

    def rename_category(self, category_id, name):
        data = self._read(self.paths["categories"], {"items": [], "suggestions": []})
        item = next((entry for entry in data.get("items", []) if entry.get("id") == category_id), None)
        if not item:
            raise ValueError("没有找到这个分类")
        if item.get("system"):
            raise ValueError("基础分类不能重命名")
        if self._find_category(name):
            raise ValueError("已有同名或同义分类，请使用合并")
        old = item["name"]
        item["name"] = self._clean(name)[:28]
        item.setdefault("aliases", []).append(old)
        item["updated_at"] = self.now()
        data["updated_at"] = self.now()
        self._write(self.paths["categories"], data)
        return {"ok": True, "summary": "分类已重命名", "category": item}

    def move_card(self, card_id, category_id):
        category = self._find_category(category_id)
        if not category:
            raise ValueError("目标分类不存在")
        data = self._read(self.paths["cards"], {"items": []})
        item = next((entry for entry in data.get("items", []) if entry.get("id") == card_id), None)
        if not item:
            raise ValueError("没有找到这张记忆卡片")
        item["category_id"] = category["id"]
        item["updated_at"] = self.now()
        self._write(self.paths["cards"], data)
        self._sync_legacy_views()
        return {"ok": True, "summary": "记忆卡片已移到“%s”" % category["name"], "item": item}

    def merge_category(self, source_id, target_id):
        source = self._find_category(source_id)
        target = self._find_category(target_id)
        if not source or not target or source["id"] == target["id"]:
            raise ValueError("需要两个不同的有效分类")
        if source.get("system"):
            raise ValueError("基础分类不能被合并删除")
        cards = self._read(self.paths["cards"], {"items": []})
        moved = 0
        for item in cards.get("items", []):
            if item.get("category_id") == source["id"]:
                item["category_id"] = target["id"]
                item["updated_at"] = self.now()
                moved += 1
        categories = self._read(self.paths["categories"], {"items": [], "suggestions": []})
        target_item = next(item for item in categories["items"] if item.get("id") == target["id"])
        target_item["aliases"] = list(dict.fromkeys([*(target_item.get("aliases") or []), source["name"], *(source.get("aliases") or [])]))
        categories["items"] = [item for item in categories["items"] if item.get("id") != source["id"]]
        categories["updated_at"] = self.now()
        self._write(self.paths["cards"], cards)
        self._write(self.paths["categories"], categories)
        self._sync_legacy_views()
        return {"ok": True, "summary": "已合并分类并移动 %d 张卡片" % moved}

    def delete_category(self, category_id):
        category = self._find_category(category_id)
        if not category:
            raise ValueError("没有找到这个分类")
        if category.get("system"):
            raise ValueError("基础分类不能删除")
        cards = self._read(self.paths["cards"], {"items": []})
        for item in cards.get("items", []):
            if item.get("category_id") == category["id"]:
                item["category_id"] = "general"
                item["updated_at"] = self.now()
        categories = self._read(self.paths["categories"], {"items": [], "suggestions": []})
        categories["items"] = [item for item in categories["items"] if item.get("id") != category["id"]]
        categories["updated_at"] = self.now()
        self._write(self.paths["cards"], cards)
        self._write(self.paths["categories"], categories)
        self._sync_legacy_views()
        return {"ok": True, "summary": "分类已删除，卡片已移到“其他”"}

    @classmethod
    def _query_terms(cls, value):
        text = str(value or "").lower()
        terms = set(re.findall(r"[a-z0-9_-]{3,}", text))
        for chunk in re.findall(r"[\u4e00-\u9fff]{2,}", text):
            if len(chunk) <= 8:
                terms.add(chunk)
            terms.update(chunk[index:index + 2] for index in range(max(0, len(chunk) - 1)))
        return {term for term in terms if term}

    def _inner_tendency_for_query(self, query, recent_ids):
        if not re.search(r"又|还是|总是|一直|上次|之前|最近|反复|每次|老是", str(query or "")):
            return None
        patterns = {
            "work": r"工作|公司|项目|职业|面试|产品|会议|同事",
            "relationship": r"朋友|关系|家人|相处|理解|边界",
            "pressure": r"压力|累|焦虑|失败|做不好|来不及|应该|必须|责怪",
            "choice": r"选择|决定|以后|方向|改变|放弃|离开|开始",
            "life": r"旅行|睡|休息|家里|生活|天气|散步|吃饭",
        }
        profile = self._inner_profile()
        for section in profile.get("sections", []):
            memory_id = "inner:" + str(section.get("id") or "")
            if memory_id in recent_ids:
                continue
            if re.search(patterns.get(section.get("id"), r"$^"), str(query or ""), re.I):
                return {
                    "id": memory_id, "kind": "private_tendency", "category_id": "companion",
                    "title": section.get("title"), "statement": section.get("text"),
                    "summary": section.get("text"), "confidence": min(0.9, 0.55 + 0.08 * int(section.get("evidence_count") or 0)),
                    "last_verified": profile.get("generated_at"), "scope": "heart_only",
                }
        return None

    def prompt_context(self, query="", include_candidates=False, limit=12, purpose="butler", recent_ids=None, room_id=""):
        purpose = str(purpose or "butler")
        recent_ids = {str(value) for value in (recent_ids or []) if value}
        max_items = max(0, min(int(limit or 0), 12))
        query_terms = self._query_terms(query)
        category_terms = {
            "identity": ("身份", "个人信息", "名字", "职业", "所在地"),
            "communication": ("回复", "表达", "语气", "称呼", "对话", "聊天"),
            "visual": ("界面", "样式", "设计", "颜色", "图标", "布局", "按钮", "字体", "页面", "主屏"),
            "workflow": ("执行", "验证", "测试", "流程", "任务", "运行", "修改"),
            "news": ("资讯", "新闻", "周报", "媒体", "热点", "摘要", "公告板", "栗夹"),
            "product-learning": ("产品", "学习", "黑板", "题目", "评测", "原型"),
            "tools": ("工具", "技能", "skill", "api", "模型", "自动化"),
            "projects": ("项目", "需求", "开发", "架构", "系统"),
            "growth": ("成长", "方向", "困惑", "果园", "播种", "目标"),
            "travel-life": ("旅行", "生活", "照片", "地点", "卧室", "回家"),
            "privacy": ("隐私", "秘密", "封存", "密阁", "树洞", "权限"),
            "experience": ("经验", "复盘", "教训", "启发"),
        }
        query_lower = str(query or "").lower()
        query_categories = {category_id for category_id, terms in category_terms.items() if any(term.lower() in query_lower for term in terms)}
        allowed_status = {"active", "candidate"} if include_candidates else {"active"}
        cards = [item for item in self._read(self.paths["cards"], {"items": []}).get("items", [])
                 if item.get("status") in allowed_status and item.get("sensitivity") != "sealed" and str(item.get("id")) not in recent_ids]
        cutoff = (datetime.now().astimezone() - timedelta(days=30)).date().isoformat()

        def score(item):
            text = " ".join(str(item.get(key) or "") for key in ("title", "statement", "summary")).lower()
            overlap = len(query_terms.intersection(self._query_terms(text)))
            category_match = item.get("category_id") in query_categories
            freshness = 1 if str(item.get("updated_at") or "")[:10] >= cutoff else 0
            return overlap * 3 + (3 if category_match else 0) + freshness + float(item.get("confidence") or 0)

        def ranked(predicate, take, allow_zero=False):
            rows = [(score(item), item) for item in cards if predicate(item)]
            rows = [row for row in rows if allow_zero or row[0] > 1.1]
            return [item for _value, item in sorted(rows, key=lambda pair: (pair[0], pair[1].get("updated_at", "")), reverse=True)[:take]]

        companion_style = lambda item: item.get("kind") in {"preference", "routine"} and (
            item.get("scope") == "companion_style" or
            (item.get("scope") in {"learning_format", "global"} and item.get("category_id") in {"communication", "privacy"})
        )
        selected = []
        inner_selected = None

        if purpose == "learning_support":
            selected = ranked(lambda item: item.get("kind") in {"preference", "routine"} and item.get("scope") in {"learning_format", "global"}, min(max_items, 3), allow_zero=True)
        elif purpose == "heart_companion":
            selected = ranked(companion_style, min(max_items, 1), allow_zero=True)
            inner_selected = self._inner_tendency_for_query(query, recent_ids)
            if inner_selected and len(selected) < min(max_items, 2):
                selected.append(inner_selected)
            explicit_travel = bool(re.search(r"(?:我|我的).{0,10}(?:旅行|旅程|出游|去了哪里|去过)", str(query or "")))
            if explicit_travel and len(selected) < min(max_items, 2):
                travel = self._travel_context_events(query, recent_ids, room_id="", limit=1)
                selected.extend(travel[:1])
        elif purpose == "travel_companion":
            selected = ranked(companion_style, min(max_items, 1), allow_zero=True)
            selected.extend(self._travel_context_events(query, recent_ids, room_id=room_id, limit=max(0, min(max_items, 2) - len(selected))))
        elif purpose == "blackboard_question":
            selected = ranked(lambda item: item.get("category_id") in {"growth", "product-learning", "news"} and item.get("scope") not in {"record_only", "travel_only", "heart_only"}, min(max_items, 4))
        else:
            selected = ranked(lambda item: item.get("kind") in {"preference", "routine"} and item.get("scope") in {"learning_format", "global"}, min(max_items, 1), allow_zero=True)
            selected.extend(ranked(lambda item: item.get("scope") in {"topic_selection", "review_only", "global"} and item not in selected, max(0, min(max_items, 2) - len(selected))))
            if re.search(r"(?:我|我的).{0,10}(?:旅行|旅程|出游|去了哪里|去过)", str(query or "")) and len(selected) < min(max_items, 2):
                selected.extend(self._travel_context_events(query, recent_ids, room_id="", limit=1))

        unique = []
        seen = set()
        for item in selected:
            memory_id = str(item.get("id") or "")
            if not memory_id or memory_id in seen or memory_id in recent_ids:
                continue
            seen.add(memory_id)
            unique.append(item)
        selected = unique[:min(max_items, 2 if purpose in {"butler", "general", "heart_companion", "travel_companion"} else max_items)]
        category_names = {item.get("id"): item.get("name") for item in self._read(self.paths["categories"], {"items": []}).get("items", [])}
        compact = [{**{key: item.get(key) for key in ("id", "kind", "category_id", "title", "statement", "summary", "confidence", "last_verified", "scope")},
                    "category": category_names.get(item.get("category_id"), "房间记忆" if item.get("category_id") == "companion" else "其他")} for item in selected]
        preference_cards = [item for item in compact if item.get("kind") in {"preference", "routine"}]
        memory_cards = [item for item in compact if item.get("kind") not in {"preference", "routine"}]
        return {
            "purpose": purpose,
            "context_package": {"query": query, "generated_at": self.now(), "cards": compact},
            "selected_memory_ids": [item.get("id") for item in compact],
            "confirmed_preferences": preference_cards,
            "relevant_memory": memory_cards,
            "inner_profile": {"sections": [inner_selected]} if inner_selected else {"sections": []},
            "recent_working_context": [],
            "rules": [
                "每轮最多使用两条高度相关记忆，也可以完全不用；不要为了展示记忆而提起过去。",
                "当前明确要求始终覆盖历史记忆；记忆只调整陪伴或讲解方式，不替代事实判断。",
                "封存原文绝不进入普通上下文；树洞只可使用去隐私的重复倾向，旅行记录只在匹配旅程或明确追问时使用。",
                "不要使用 recent_memory_ids 中刚用过的记忆，也不要把单次经历反复包装成人格结论。",
            ],
        }

    def _travel_context_events(self, query, recent_ids, room_id="", limit=1):
        if limit <= 0:
            return []
        query_terms = self._query_terms(query)
        rows = []
        for item in self._read(self.paths["events"], {"items": []}).get("items", []):
            if item.get("source") != "travel" or str(item.get("id") or "") in recent_ids:
                continue
            if item.get("scope") not in {"travel_only", "record_only"}:
                continue
            same_room = bool(room_id and str(item.get("room_id") or "") == str(room_id))
            text = " ".join(str(item.get(key) or "") for key in ("summary", "content", "room_id"))
            overlap = len(query_terms.intersection(self._query_terms(text)))
            if room_id and not same_room and overlap == 0:
                continue
            if not room_id and overlap == 0:
                continue
            rows.append((100 if same_room else overlap * 3, item))
        selected = [item for _score, item in sorted(rows, key=lambda pair: (pair[0], pair[1].get("created_at", "")), reverse=True)[:limit]]
        return [{
            "id": item.get("id"), "kind": "experience", "category_id": "travel-life",
            "title": "同一段旅程的已保存感悟", "statement": item.get("content") or item.get("summary"),
            "summary": item.get("summary"), "confidence": 1.0, "last_verified": item.get("created_at"),
            "scope": "travel_only",
        } for item in selected]

    def sync(self, events):
        added = [self.add_event(event) for event in (events if isinstance(events, list) else []) if isinstance(event, dict)]
        return {"ok": True, "count": len(added), "items": added[-20:]}

    def search(self, query: str, include_sealed=False, limit=12):
        words = self._tokens(query)
        cards = self._read(self.paths["cards"], {"items": []}).get("items", [])
        pool = [item for item in cards if item.get("status") == "active" and item.get("sensitivity") != "sealed"]
        if include_sealed:
            pool += self._read(self.paths["sealed"], {"items": []}).get("items", [])
        scored = []
        for item in pool:
            text = " ".join(str(item.get(key) or "") for key in ("title", "statement", "summary", "content", "source")).lower()
            score = sum(3 if word in text else 0 for word in words) + round(float(item.get("confidence") or 0.5) * 3)
            if score > 0 or not words:
                scored.append((score, item))
        return [item for _score, item in sorted(scored, key=lambda pair: (pair[0], pair[1].get("updated_at", pair[1].get("date", ""))), reverse=True)[:limit]]

    def forget(self, query: str):
        query = self._clean(query).lower()
        if not query:
            raise ValueError("需要说明要忘记什么")
        def haystack(item):
            values = [str(item.get(name, "")) for name in (
                "id", "legacy_id", "source", "type", "title", "summary", "content", "statement",
            )]
            values.extend(str(value) for value in item.get("evidence_ids", []) if value)
            return " ".join(values).lower()

        events_data = self._read(self.paths["events"], {"items": []})
        sealed_data = self._read(self.paths["sealed"], {"items": []})
        cards_data = self._read(self.paths["cards"], {"items": []})
        matched_evidence_ids = {
            str(item.get("id")) for item in [*events_data.get("items", []), *sealed_data.get("items", [])]
            if item.get("id") and query in haystack(item)
        }
        matched_cards = [
            item for item in cards_data.get("items", [])
            if query in haystack(item) or matched_evidence_ids.intersection(str(value) for value in item.get("evidence_ids", []))
        ]
        related_ids = set(matched_evidence_ids)
        for item in matched_cards:
            related_ids.add(str(item.get("id")))
            related_ids.update(str(value) for value in item.get("evidence_ids", []) if value)
            if item.get("legacy_id"):
                related_ids.add(str(item["legacy_id"]))
        removed = 0
        forgotten_ids = set()
        for key in ("events", "sealed", "cards", "working"):
            data = self._read(self.paths[key], {"version": 1, "items": []})
            def matches(item):
                return str(item.get("id") or "") in related_ids or query in haystack(item)
            matched = [item for item in data.get("items", []) if matches(item)]
            forgotten_ids.update(str(item.get("id")) for item in matched if item.get("id"))
            before = len(data.get("items", []))
            data["items"] = [item for item in data.get("items", []) if not matches(item)]
            removed += before - len(data["items"])
            self._write(self.paths[key], data)
        forgotten_ids.update(related_ids)
        if forgotten_ids:
            policy = self._read(self.paths["policy"], {"version": 3})
            existing = [entry for entry in policy.get("forgotten_ids", []) if str(entry.get("id") if isinstance(entry, dict) else entry) not in forgotten_ids]
            policy["forgotten_ids"] = [{"id": memory_id, "forgotten_at": self.now()} for memory_id in sorted(forgotten_ids)] + existing
            policy["forgotten_ids"] = policy["forgotten_ids"][:1000]
            self._write(self.paths["policy"], policy)
        self._sync_legacy_views()
        return {"ok": True, "summary": "已忘记 %d 条相关记忆" % removed, "removed": removed, "forgotten_ids": sorted(forgotten_ids)}

    def move(self, memory_id: str, layer: str):
        if layer == "long":
            return self.set_card_status(memory_id, "active")
        if layer == "short":
            return self.set_card_status(memory_id, "candidate")
        if layer != "sealed":
            raise ValueError("记忆层级只能是 short、long 或 sealed")
        cards = self._read(self.paths["cards"], {"items": []})
        item = next((entry for entry in cards.get("items", []) if entry.get("id") == memory_id), None)
        if not item:
            raise ValueError("没有找到这条记忆")
        sealed = self._read(self.paths["sealed"], {"version": 1, "items": []})
        sealed_item = {**item, "layer": "sealed", "sensitivity": "sealed", "content": item.get("statement", ""), "date": self.now()[:10]}
        sealed.setdefault("items", []).insert(0, sealed_item)
        cards["items"] = [entry for entry in cards["items"] if entry.get("id") != memory_id]
        self._write(self.paths["sealed"], sealed)
        self._write(self.paths["cards"], cards)
        self._sync_legacy_views()
        return {"ok": True, "summary": "已封存这张记忆卡片", "item": sealed_item}

    def prune_short(self):
        policy = self._read(self.paths["policy"], {})
        cutoff = (datetime.now().astimezone() - timedelta(days=int(policy.get("short_term_days", 30)))).date().isoformat()
        candidate_cutoff = (datetime.now().astimezone() - timedelta(days=int(policy.get("candidate_preference_days", 45)))).date().isoformat()
        cards = self._read(self.paths["cards"], {"items": []})
        original_cards = cards.get("items", [])
        filtered_cards = [item for item in original_cards if not (
            item.get("status") == "candidate" and str(item.get("updated_at") or "")[:10] <
            (candidate_cutoff if item.get("kind") == "preference" else cutoff)
        )]
        cards_changed = len(filtered_cards) != len(original_cards)
        if cards_changed:
            cards["items"] = filtered_cards
            cards["updated_at"] = self.now()
            self._write(self.paths["cards"], cards)
        working = self._read(self.paths["working"], {"version": 1, "items": []})
        original_working = working.get("items", [])
        filtered_working = [item for item in original_working if item.get("date", "") >= cutoff][:80]
        if filtered_working != original_working:
            working["items"] = filtered_working
            working["updated_at"] = self.now()
            self._write(self.paths["working"], working)
        if cards_changed:
            self._sync_legacy_views()
