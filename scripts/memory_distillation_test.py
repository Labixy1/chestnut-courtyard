#!/usr/bin/env python3
"""End-to-end checks for validated AI memory distillation."""

import hashlib
import json
import tempfile
from pathlib import Path

from memory_distiller import MemoryDistiller
from memory_store import MemoryStore


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(condition, message):
    if not condition:
        raise AssertionError(message)


with tempfile.TemporaryDirectory(prefix="cozy_distillation_") as directory:
    root = Path(directory)
    (root / "core/memory").mkdir(parents=True)
    (root / "core/prompts").mkdir(parents=True)
    (root / "core/notice_reports.json").write_text('{"reports":[]}', encoding="utf-8")
    (root / "core/local_state.json").write_text('{"version":1,"values":{}}', encoding="utf-8")
    memory = MemoryStore(root)

    first = memory.add_event({
        "id": "pref_direct", "source": "butler", "content": "喜欢简洁直接的答复方式",
    })
    second = memory.add_event({
        "id": "pref_conclusion", "source": "butler", "content": "偏好先给结论再解释细节",
    })
    visual = memory.add_event({
        "id": "visual_active", "source": "butler", "content": "界面偏好低饱和但不要单调",
        "remember": True,
    })
    low_texts = ["帮我看看临时网页链接", "请读一下这篇短文章", "这个公告先放着稍后处理"]
    low_events = [memory.add_event({
        "id": "low_signal_%d" % index, "source": "noticeboard", "content": text,
    }) for index, text in enumerate(low_texts)]
    memory.add_event({
        "id": "sealed_secret", "source": "heart_hollow", "content": "这句话绝不能进入普通蒸馏提示词",
    })
    cards = memory.state()["cards"]
    first_card = next(item for item in cards if first["id"] in item.get("evidence_ids", []))
    second_card = next(item for item in cards if second["id"] in item.get("evidence_ids", []))
    visual_card = next(item for item in cards if visual["id"] in item.get("evidence_ids", []))
    low_cards = [next(item for item in cards if event["id"] in item.get("evidence_ids", [])) for event in low_events]
    captured = {}

    def valid_model(prompt):
        captured["prompt"] = prompt
        return json.dumps({
            "version": 1,
            "merge_groups": [{
                "keeper_id": first_card["id"],
                "duplicate_ids": [second_card["id"]],
                "title": "沟通方式",
                "statement": "偏好先给结论，并保持表达简洁直接。",
                "category_id": "communication",
                "kind": "preference",
                "reason": "两条卡片共同描述答复结构和简洁度",
            }, {
                "keeper_id": low_cards[0]["id"],
                "duplicate_ids": [low_cards[1]["id"], low_cards[2]["id"]],
                "title": "临时请求",
                "statement": "一次临时的公告板请求，尚不足以形成稳定记忆。",
                "category_id": "news",
                "kind": "fact",
                "reason": "三条只是同类临时请求，不代表稳定偏好",
            }],
            "supersede": [],
            "candidate_decisions": [{
                "card_id": first_card["id"], "decision": "promote",
                "reason": "两条独立证据共同支持这一稳定沟通偏好",
            }, {
                "card_id": low_cards[0]["id"], "decision": "keep",
                "reason": "重复不等于稳定偏好，继续观察",
            }],
            "profile": {
                "summary": "主人重视清楚直接的沟通，也偏好克制而不单调的视觉体验。",
                "sections": [
                    {
                        "id": "communication", "title": "沟通方式",
                        "text": "希望先看到结论，再用简洁直接的方式补充必要细节。",
                        "source_card_ids": [first_card["id"]],
                    },
                    {
                        "id": "visual", "title": "视觉偏好",
                        "text": "喜欢低饱和但不单调的界面。",
                        "source_card_ids": [visual_card["id"]],
                    },
                ],
            },
        }, ensure_ascii=False), "fake-model"

    audit = []
    engine = MemoryDistiller(root, memory, valid_model, lambda kind, detail: audit.append((kind, detail)))
    result = engine.run(force=True)
    check(result["status"] == "completed", "有效蒸馏没有完成")
    check("绝不能进入" not in captured["prompt"], "封存原文进入了模型提示词")
    state = memory.state()
    merged = next(item for item in state["cards"] if item["id"] == first_card["id"])
    duplicate = next(item for item in state["cards"] if item["id"] == second_card["id"])
    check(merged["status"] == "active" and merged["evidence_count"] == 2, "语义合并后没有按证据阈值晋升")
    check(duplicate["status"] == "superseded" and duplicate["superseded_by"] == merged["id"], "重复卡片没有保留可追溯关系")
    low_keeper = next(item for item in state["cards"] if item["id"] == low_cards[0]["id"])
    check(low_keeper["status"] == "candidate" and low_keeper.get("distillation_hold_count") == 3, "低信号重复被错误晋升")
    check(state["profile"].get("generator") == "ai_distillation", "AI 档案没有成为展示档案")
    check("先看到结论" in json.dumps(state["profile"], ensure_ascii=False) or "先给结论" in state["profile"]["summary"], "AI 档案缺少有效总结")
    check("绝不能进入" not in json.dumps(state["profile"], ensure_ascii=False), "封存原文泄漏到档案")
    check(audit and audit[-1][0] == "memory_distillation_completed", "成功蒸馏没有写审计")
    run_path = engine.runs_dir / (result["run_id"] + ".json")
    run_record = json.loads(run_path.read_text(encoding="utf-8"))
    check(run_record.get("before_cards") and run_record["diff"]["merged"], "蒸馏记录缺少回滚数据或差异")
    check(engine.run()["status"] == "skipped", "没有变化时仍然重复调用模型")

    memory.add_event({"id": "low_signal_0", "source": "noticeboard", "content": low_texts[0]})
    replayed = next(item for item in memory.state()["cards"] if item["id"] == low_cards[0]["id"])
    check(replayed["status"] == "candidate", "重复同步旧证据导致候选错误晋升")
    check(memory.state()["profile"].get("generator") == "ai_distillation", "重复同步旧证据覆盖了 AI 档案")

    cards_hash = digest(memory.paths["cards"])
    profile_hash = digest(memory.paths["profile"])

    def invalid_model(_prompt):
        return json.dumps({
            "merge_groups": [], "supersede": [], "candidate_decisions": [],
            "profile": {"sections": [{
                "id": "communication", "title": "无效", "text": "引用不存在卡片",
                "source_card_ids": ["card_unknown"],
            }]},
        }, ensure_ascii=False), "fake-model"

    invalid_engine = MemoryDistiller(root, memory, invalid_model, lambda kind, detail: audit.append((kind, detail)))
    try:
        invalid_engine.run(force=True)
        raise AssertionError("无效模型输出被写入")
    except ValueError:
        pass
    check(digest(memory.paths["cards"]) == cards_hash, "无效输出修改了记忆卡片")
    check(digest(memory.paths["profile"]) == profile_hash, "无效输出修改了个人档案")
    check(invalid_engine.status()["status"] == "failed", "失败状态没有持久化")

    restored = engine.restore(result["run_id"])
    check(restored["ok"], "蒸馏回滚失败")
    restored_cards = memory.state()["cards"]
    check(next(item for item in restored_cards if item["id"] == first_card["id"])["status"] == "candidate", "回滚没有恢复原始候选卡片")
    check(next(item for item in restored_cards if item["id"] == second_card["id"])["status"] == "candidate", "回滚没有恢复重复卡片")
    check(engine.status()["status"] == "restored", "回滚状态没有持久化")

    print(json.dumps({
        "ok": True,
        "checks": ["sealed isolation", "structured validation", "semantic merge", "threshold promotion", "AI profile", "idempotence", "atomic rejection", "audit", "rollback"],
    }, ensure_ascii=False, indent=2))
