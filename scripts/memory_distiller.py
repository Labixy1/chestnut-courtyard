#!/usr/bin/env python3
"""Validated AI distillation for non-sealed Cozy Estate memories."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path


DEFAULT_PROMPT = """你是栗壳小院的记忆编辑器。你的工作不是猜测主人，而是整理已有、可追溯的非封存记忆。
只根据输入卡片工作：合并语义重复，指出明确冲突，在证据足够时建议晋升候选，并把已生效记忆写成自然、克制、准确的个人档案。
每次都以旧档案为底稿：保留仍有证据支持的稳定信息，用新证据修正或补充，而不是整份重写得面目全非。
不得增加输入中没有的新事实，不得把单次行为写成稳定人格，不得输出任何树洞、密阁或秘密内容。
当前明确指令永远高于历史记忆。只输出一个 JSON 对象，不要使用 Markdown。"""


class MemoryDistiller:
    VERSION = 1

    def __init__(self, root: Path, memory_store, model_call=None, audit=None):
        self.root = Path(root)
        self.memory_store = memory_store
        self.model_call = model_call
        self.audit = audit
        self.lock = threading.RLock()
        self.status_path = self.root / "core/memory/distillation.json"
        self.runs_dir = self.root / "core/memory/distillations"
        self.prompt_path = self.root / "core/prompts/memory_distillation.txt"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        if not self.status_path.exists():
            self._write(self.status_path, {
                "version": self.VERSION,
                "status": "idle",
                "last_run": "",
                "last_success": "",
                "last_error": "",
                "last_source_fingerprint": "",
                "provider": "",
                "total_runs": 0,
                "recent_runs": [],
                "schedule": "每天 23:30，或累计至少 4 张变化卡片后",
            })

    @staticmethod
    def now():
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

    @staticmethod
    def _clean(value, limit=1200):
        return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]

    def status(self):
        return self._read(self.status_path, {"version": self.VERSION, "status": "idle"})

    def queue(self):
        state = self.status()
        state.update({"status": "queued", "last_error": ""})
        self._write(self.status_path, state)
        return state

    def _visible_cards(self):
        cards = self._read(self.memory_store.paths["cards"], {"items": []}).get("items", [])
        return [
            copy.deepcopy(item) for item in cards
            if item.get("status") not in {"rejected", "superseded"}
            and item.get("sensitivity") != "sealed"
            and self._clean(item.get("statement") or item.get("summary"))
        ]

    def source_fingerprint(self, cards=None):
        cards = cards if isinstance(cards, list) else self._visible_cards()
        raw = "|".join(
            "%s:%s:%s:%s:%s:%s" % (
                item.get("id", ""), item.get("status", ""), item.get("category_id", ""),
                item.get("updated_at", ""), item.get("evidence_count", 0), item.get("statement", ""),
            )
            for item in sorted(cards, key=lambda value: str(value.get("id") or ""))
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]

    @staticmethod
    def _card_versions(cards):
        versions = {}
        for item in cards:
            card_id = str(item.get("id") or "")
            raw = "%s:%s:%s:%s:%s" % (
                item.get("status", ""), item.get("category_id", ""), item.get("updated_at", ""),
                item.get("evidence_count", 0), item.get("statement", ""),
            )
            versions[card_id] = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
        return versions

    def should_run(self, now=None):
        now = now or datetime.now().astimezone()
        cards = self._visible_cards()
        if not cards:
            return False
        state = self.status()
        fingerprint = self.source_fingerprint(cards)
        if fingerprint == state.get("last_source_fingerprint"):
            return False
        last_success = str(state.get("last_success") or "")
        if not last_success:
            return len(cards) >= 2
        try:
            last = datetime.fromisoformat(last_success)
        except ValueError:
            return True
        if now.date() != last.astimezone(now.tzinfo).date() and (now.hour > 23 or (now.hour == 23 and now.minute >= 30)):
            return True
        current_versions = self._card_versions(cards)
        previous_versions = state.get("last_source_card_versions") or {
            str(value): "legacy" for value in state.get("last_source_card_ids") or []
        }
        changed_ids = {
            *set(previous_versions).symmetric_difference(current_versions),
            *(card_id for card_id in set(previous_versions) & set(current_versions)
              if previous_versions[card_id] != current_versions[card_id]),
        }
        return len(changed_ids) >= 4

    def _prompt(self, cards):
        categories = self._read(self.memory_store.paths["categories"], {"items": []}).get("items", [])
        policy = self._read(self.memory_store.paths["policy"], {})
        previous_profile = self._read(self.memory_store.paths["profile"], {})
        safe_cards = [{
            key: item.get(key) for key in (
                "id", "kind", "category_id", "title", "statement", "status", "confidence",
                "evidence_count", "evidence_ids", "source", "last_verified", "updated_at",
            )
        } for item in cards]
        system_prompt = DEFAULT_PROMPT
        try:
            custom = self.prompt_path.read_text(encoding="utf-8").strip()
            if custom:
                system_prompt = custom
        except OSError:
            pass
        schema = {
            "version": 1,
            "merge_groups": [{
                "keeper_id": "card_id", "duplicate_ids": ["card_id"], "title": "短标题",
                "statement": "合并后的准确陈述", "category_id": "existing_category_id",
                "kind": "preference|fact|goal|project|routine|insight|experience", "reason": "依据",
            }],
            "supersede": [{"winner_id": "card_id", "loser_ids": ["card_id"], "reason": "冲突依据"}],
            "candidate_decisions": [{"card_id": "card_id", "decision": "promote|keep|expire", "reason": "依据"}],
            "profile": {
                "summary": "自然的一段总览，可为空",
                "sections": [{
                    "id": "existing_category_id", "title": "自然小标题", "text": "准确自然的档案正文",
                    "source_card_ids": ["active_card_id"],
                }],
            },
        }
        payload = {
            "previous_profile": {
                "summary": previous_profile.get("summary", ""),
                "sections": previous_profile.get("sections", []),
                "generated_at": previous_profile.get("generated_at", ""),
            },
            "categories": [{"id": item.get("id"), "name": item.get("name")} for item in categories if item.get("status") == "active"],
            "thresholds": {
                "preference": int(policy.get("preference_repeat_to_confirm", 2)),
                "other": int(policy.get("repeat_to_promote", 3)),
                "candidate_preference_days": int(policy.get("candidate_preference_days", 45)),
                "candidate_other_days": int(policy.get("short_term_days", 30)),
            },
            "cards": safe_cards,
        }
        return (
            system_prompt + "\n\n输出结构必须严格匹配：\n" + json.dumps(schema, ensure_ascii=False)
            + "\n\n输入数据：\n" + json.dumps(payload, ensure_ascii=False)
        )

    @staticmethod
    def _parse_json(raw):
        text = str(raw or "").strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
            text = re.sub(r"\s*```$", "", text)
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型没有返回 JSON 对象")
        try:
            value = json.loads(text[start:end + 1])
        except ValueError as exc:
            raise ValueError("模型返回的 JSON 无法解析") from exc
        if not isinstance(value, dict):
            raise ValueError("蒸馏提案必须是 JSON 对象")
        return value

    def _call_model(self, prompt):
        if not callable(self.model_call):
            raise RuntimeError("没有可用的记忆蒸馏模型")
        result = self.model_call(prompt)
        if isinstance(result, tuple):
            return str(result[0]), str(result[1])
        return str(result), "configured-model"

    def _sealed_leak(self, proposal):
        raw = re.sub(r"\s+", "", json.dumps(proposal, ensure_ascii=False))
        sealed = self._read(self.memory_store.paths["sealed"], {"items": []}).get("items", [])
        for item in sealed:
            for key in ("content", "summary"):
                value = re.sub(r"\s+", "", str(item.get(key) or ""))
                if len(value) >= 16 and value[:200] in raw:
                    return True
        return False

    def _threshold(self, card, policy):
        if card.get("kind") == "preference":
            return int(policy.get("preference_repeat_to_confirm", 2))
        return int(policy.get("repeat_to_promote", 3))

    def _eligible_to_expire(self, card, policy, now):
        if card.get("status") != "candidate":
            return False
        days = int(policy.get("candidate_preference_days", 45) if card.get("kind") == "preference" else policy.get("short_term_days", 30))
        try:
            updated = datetime.fromisoformat(str(card.get("updated_at") or card.get("created_at") or ""))
        except ValueError:
            return False
        return now - updated.astimezone(now.tzinfo) >= timedelta(days=days)

    def _apply_proposal(self, proposal, original_cards):
        if self._sealed_leak(proposal):
            raise ValueError("蒸馏输出包含封存内容，已拒绝写入")
        cards = copy.deepcopy(original_cards)
        by_id = {str(item.get("id")): item for item in cards}
        visible_ids = set(by_id)
        category_ids = {
            str(item.get("id")) for item in self._read(self.memory_store.paths["categories"], {"items": []}).get("items", [])
            if item.get("status") == "active"
        }
        policy = self._read(self.memory_store.paths["policy"], {})
        now = datetime.now().astimezone()
        now_text = now.isoformat(timespec="seconds")
        touched = set()
        changes = {"merged": [], "superseded": [], "promoted": [], "expired": []}

        groups = proposal.get("merge_groups") or []
        if not isinstance(groups, list) or len(groups) > 24:
            raise ValueError("merge_groups 结构无效")
        for group in groups:
            if not isinstance(group, dict):
                raise ValueError("合并项必须是对象")
            keeper_id = str(group.get("keeper_id") or "")
            duplicate_ids = [str(value) for value in group.get("duplicate_ids") or []]
            if keeper_id not in visible_ids or not duplicate_ids or any(value not in visible_ids or value == keeper_id for value in duplicate_ids):
                raise ValueError("合并项引用了未知卡片")
            all_ids = [keeper_id, *duplicate_ids]
            if any(value in touched for value in all_ids):
                raise ValueError("同一张卡片不能参与多次合并或冲突处理")
            keeper = by_id[keeper_id]
            members = [by_id[value] for value in all_ids]
            evidence_ids = list(dict.fromkeys(value for item in members for value in (item.get("evidence_ids") or [])))
            keeper["evidence_ids"] = evidence_ids[-48:]
            keeper["evidence_count"] = len(evidence_ids) if evidence_ids else sum(max(1, int(item.get("evidence_count") or 1)) for item in members)
            statement = self._clean(group.get("statement") or keeper.get("statement"), 1200)
            if statement and statement != keeper.get("statement"):
                keeper.setdefault("history", []).insert(0, {"statement": keeper.get("statement", ""), "changed_at": now_text, "reason": "ai_distillation_merge"})
                keeper["history"] = keeper["history"][:20]
                keeper["statement"] = statement
                keeper["summary"] = statement[:600]
            keeper["title"] = self._clean(group.get("title") or keeper.get("title") or statement, 80)
            category_id = str(group.get("category_id") or keeper.get("category_id") or "general")
            keeper["category_id"] = category_id if category_id in category_ids else str(keeper.get("category_id") or "general")
            kind = str(group.get("kind") or keeper.get("kind") or "fact")
            if kind in {"preference", "fact", "goal", "project", "routine", "insight", "experience"}:
                keeper["kind"] = kind
            if any(item.get("status") == "active" for item in members):
                keeper["status"] = "active"
                keeper["confidence"] = max(0.9, max(float(item.get("confidence") or 0) for item in members))
                keeper.pop("distillation_hold_count", None)
            else:
                keeper["status"] = "candidate"
                keeper["confidence"] = min(0.88, max(float(item.get("confidence") or 0.55) for item in members) + 0.08)
                keeper["distillation_hold_count"] = keeper["evidence_count"]
            keeper["updated_at"] = now_text
            keeper["distilled_at"] = now_text
            for duplicate_id in duplicate_ids:
                duplicate = by_id[duplicate_id]
                duplicate.update({"status": "superseded", "superseded_by": keeper_id, "updated_at": now_text, "distilled_at": now_text})
            touched.update(all_ids)
            changes["merged"].append({"keeper_id": keeper_id, "duplicate_ids": duplicate_ids, "reason": self._clean(group.get("reason"), 300)})

        conflicts = proposal.get("supersede") or []
        if not isinstance(conflicts, list) or len(conflicts) > 24:
            raise ValueError("supersede 结构无效")
        for conflict in conflicts:
            if not isinstance(conflict, dict):
                raise ValueError("冲突项必须是对象")
            winner_id = str(conflict.get("winner_id") or "")
            loser_ids = [str(value) for value in conflict.get("loser_ids") or []]
            if winner_id not in visible_ids or not loser_ids or any(value not in visible_ids or value == winner_id for value in loser_ids):
                raise ValueError("冲突项引用了未知卡片")
            all_ids = [winner_id, *loser_ids]
            if any(value in touched for value in all_ids):
                raise ValueError("同一张卡片不能参与多次合并或冲突处理")
            winner = by_id[winner_id]
            if winner.get("status") != "active" and int(winner.get("evidence_count") or 1) < self._threshold(winner, policy):
                raise ValueError("证据不足的候选卡片不能覆盖其他记忆")
            winner["status"] = "active"
            winner["updated_at"] = now_text
            winner["distilled_at"] = now_text
            for loser_id in loser_ids:
                by_id[loser_id].update({"status": "superseded", "superseded_by": winner_id, "updated_at": now_text, "distilled_at": now_text})
            touched.update(all_ids)
            changes["superseded"].append({"winner_id": winner_id, "loser_ids": loser_ids, "reason": self._clean(conflict.get("reason"), 300)})

        decisions = proposal.get("candidate_decisions") or []
        if not isinstance(decisions, list) or len(decisions) > 100:
            raise ValueError("candidate_decisions 结构无效")
        for decision in decisions:
            if not isinstance(decision, dict):
                raise ValueError("候选决策必须是对象")
            card_id = str(decision.get("card_id") or "")
            action = str(decision.get("decision") or "keep")
            if card_id not in visible_ids or action not in {"promote", "keep", "expire"}:
                raise ValueError("候选决策引用无效")
            if card_id in touched and by_id[card_id].get("status") == "superseded":
                continue
            card = by_id[card_id]
            if card.get("status") != "candidate" or action == "keep":
                continue
            if action == "promote":
                if int(card.get("evidence_count") or 1) < self._threshold(card, policy):
                    continue
                card.update({"status": "active", "confidence": max(0.9, float(card.get("confidence") or 0)), "updated_at": now_text, "distilled_at": now_text})
                card.pop("distillation_hold_count", None)
                changes["promoted"].append(card_id)
            elif action == "expire" and self._eligible_to_expire(card, policy, now):
                card.update({"status": "expired", "updated_at": now_text, "distilled_at": now_text})
                changes["expired"].append(card_id)

        profile = self._validated_profile(proposal.get("profile") or {}, cards, category_ids)
        return cards, profile, changes

    def _validated_profile(self, raw_profile, cards, category_ids):
        if not isinstance(raw_profile, dict):
            raise ValueError("profile 必须是对象")
        active = {str(item.get("id")): item for item in cards if item.get("status") == "active" and item.get("sensitivity") != "sealed"}
        sections = raw_profile.get("sections") or []
        if active and (not isinstance(sections, list) or not sections or len(sections) > 20):
            raise ValueError("AI 档案章节为空或过多")
        normalized = []
        covered = set()
        for section in sections:
            if not isinstance(section, dict):
                raise ValueError("档案章节必须是对象")
            source_ids = list(dict.fromkeys(str(value) for value in section.get("source_card_ids") or []))
            if not source_ids or any(value not in active for value in source_ids):
                raise ValueError("档案章节引用了候选、封存或未知卡片")
            text = self._clean(section.get("text"), 900)
            title = self._clean(section.get("title"), 50)
            if not title or len(text) < 4:
                raise ValueError("档案章节标题或正文无效")
            category_id = str(section.get("id") or active[source_ids[0]].get("category_id") or "general")
            if category_id not in category_ids:
                category_id = str(active[source_ids[0]].get("category_id") or "general")
            covered.update(source_ids)
            normalized.append({"id": category_id, "title": title, "text": text, "source_card_ids": source_ids})
        minimum = min(len(active), max(1, math.ceil(len(active) * 0.6))) if active else 0
        if len(covered) < minimum:
            raise ValueError("AI 档案遗漏了过多已生效记忆")
        summary = self._clean(raw_profile.get("summary"), 5000)
        if not summary:
            summary = "\n\n".join(section["title"] + "\n" + section["text"] for section in normalized)
        fingerprint = self._profile_fingerprint(cards)
        return {
            "version": 2,
            "generated_at": self.now(),
            "generator": "ai_distillation",
            "fingerprint": fingerprint,
            "source_card_ids": sorted(covered),
            "source_count": len(covered),
            "summary": summary,
            "sections": normalized,
            "rules": ["只使用已生效记忆", "不包含封存原文", "AI 提案通过本地校验后写入"],
        }

    def _profile_fingerprint(self, cards):
        active = [item for item in cards if item.get("status") == "active" and item.get("sensitivity") != "sealed"]
        active = sorted(active, key=lambda item: (str(item.get("category_id") or ""), str(item.get("updated_at") or "")), reverse=True)
        category_items = self._read(self.memory_store.paths["categories"], {"items": []}).get("items", [])
        raw = "|".join(
            "%s:%s:%s:%s" % (item.get("id", ""), item.get("updated_at", ""), item.get("category_id", ""), item.get("statement", ""))
            for item in active
        )
        raw += "||" + "|".join("%s:%s" % (item.get("id", ""), item.get("name", "")) for item in category_items)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]

    @staticmethod
    def _profile_diff(before, after, changes):
        before_sections = {item.get("id"): item.get("text", "") for item in before.get("sections", [])}
        after_sections = {item.get("id"): item.get("text", "") for item in after.get("sections", [])}
        return {
            **changes,
            "profile_changed": before.get("summary") != after.get("summary"),
            "sections_added": sorted(set(after_sections) - set(before_sections)),
            "sections_removed": sorted(set(before_sections) - set(after_sections)),
            "sections_rewritten": sorted(key for key in set(before_sections) & set(after_sections) if before_sections[key] != after_sections[key]),
        }

    def run(self, force=False):
        with self.lock:
            cards = self._visible_cards()
            fingerprint = self.source_fingerprint(cards)
            state = self.status()
            if not force and fingerprint == state.get("last_source_fingerprint"):
                return {"ok": True, "status": "skipped", "summary": "记忆没有变化，不需要重新整理"}
            if not cards:
                return {"ok": True, "status": "skipped", "summary": "还没有可整理的普通记忆"}
            run_id = "distill_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
            before_profile = self._read(self.memory_store.paths["profile"], {})
            before_cards = self._read(self.memory_store.paths["cards"], {"version": 1, "items": []})
            state.update({"status": "running", "last_run": self.now(), "last_error": "", "current_run_id": run_id})
            self._write(self.status_path, state)
            try:
                raw, provider = self._call_model(self._prompt(cards))
                try:
                    proposal = self._parse_json(raw)
                except ValueError:
                    repair_prompt = (
                        "把下面不完整或不严格的模型输出修复成一个合法 JSON 对象。"
                        "只修复语法和缺失的闭合符号，不新增事实，不输出 Markdown。\n原输出：\n" + str(raw)[:14000]
                    )
                    repaired, repair_provider = self._call_model(repair_prompt)
                    proposal = self._parse_json(repaired)
                    provider = repair_provider or provider
                updated_visible, profile, changes = self._apply_proposal(proposal, cards)
                updated_map = {str(item.get("id")): item for item in updated_visible}
                final_cards = [updated_map.get(str(item.get("id")), item) for item in before_cards.get("items", [])]
                cards_payload = {**before_cards, "version": max(1, int(before_cards.get("version") or 1)), "updated_at": self.now(), "items": final_cards}
                diff = self._profile_diff(before_profile, profile, changes)
                run_record = {
                    "version": self.VERSION,
                    "id": run_id,
                    "status": "completed",
                    "started_at": state.get("last_run"),
                    "completed_at": self.now(),
                    "provider": provider,
                    "source_fingerprint": fingerprint,
                    "source_card_ids": [str(item.get("id")) for item in cards],
                    "before_profile": before_profile,
                    "before_cards": before_cards,
                    "after_profile": profile,
                    "diff": diff,
                    "proposal": proposal,
                }
                try:
                    self.memory_store._write(self.memory_store.paths["cards"], cards_payload)
                    self.memory_store._sync_legacy_views()
                    self.memory_store._write(self.memory_store.paths["profile"], profile)
                    self._write(self.runs_dir / (run_id + ".json"), run_record)
                except Exception:
                    self.memory_store._write(self.memory_store.paths["cards"], before_cards)
                    self.memory_store._sync_legacy_views()
                    self.memory_store._write(self.memory_store.paths["profile"], before_profile)
                    raise
                state = self.status()
                recent = [{"id": run_id, "time": run_record["completed_at"], "provider": provider, "diff": diff}, *(state.get("recent_runs") or [])]
                state.update({
                    "status": "completed", "last_success": run_record["completed_at"], "last_error": "",
                    "last_source_fingerprint": self.source_fingerprint(self._visible_cards()),
                    "last_source_card_ids": [str(item.get("id")) for item in self._visible_cards()],
                    "last_source_card_versions": self._card_versions(self._visible_cards()),
                    "provider": provider, "total_runs": int(state.get("total_runs") or 0) + 1,
                    "recent_runs": recent[:20], "current_run_id": "", "last_diff": diff,
                })
                self._write(self.status_path, state)
                if callable(self.audit):
                    self.audit("memory_distillation_completed", {"run_id": run_id, "provider": provider, "diff": diff})
                return {"ok": True, "status": "completed", "summary": "AI 已重新整理个人记忆档案", "run_id": run_id, "provider": provider, "diff": diff}
            except Exception as exc:
                state = self.status()
                state.update({"status": "failed", "last_error": str(exc)[:1000], "current_run_id": ""})
                self._write(self.status_path, state)
                if callable(self.audit):
                    self.audit("memory_distillation_failed", {"run_id": run_id, "error": str(exc)[:500]})
                raise

    def restore(self, run_id):
        with self.lock:
            run_id = str(run_id or "").strip()
            path = (self.runs_dir / (run_id + ".json")).resolve()
            if path.parent != self.runs_dir.resolve() or not path.is_file():
                raise ValueError("没有找到这次记忆整理记录")
            record = self._read(path, {})
            before_cards = record.get("before_cards")
            before_profile = record.get("before_profile")
            if not isinstance(before_cards, dict) or not isinstance(before_profile, dict):
                raise ValueError("这次整理记录不包含可恢复数据")
            self.memory_store._write(self.memory_store.paths["cards"], before_cards)
            self.memory_store._sync_legacy_views()
            self.memory_store._write(self.memory_store.paths["profile"], before_profile)
            state = self.status()
            state.update({
                "status": "restored", "last_error": "", "last_source_fingerprint": "",
                "restored_run_id": run_id, "restored_at": self.now(),
            })
            self._write(self.status_path, state)
            if callable(self.audit):
                self.audit("memory_distillation_restored", {"run_id": run_id})
            return {"ok": True, "summary": "已恢复 AI 整理前的记忆档案", "run_id": run_id}
