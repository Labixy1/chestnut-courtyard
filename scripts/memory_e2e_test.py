#!/usr/bin/env python3
"""End-to-end validation for the evidence-backed memory system."""

import json
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

from automation_runner import AutomationRunner
from memory_store import MemoryStore


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def card_for_evidence(memory, evidence_id):
    return next(
        (item for item in memory.state()["cards"] if evidence_id in item.get("evidence_ids", [])),
        None,
    )


def prepare_root(root):
    (root / "core/memory").mkdir(parents=True)
    (root / "core").mkdir(exist_ok=True)
    (root / "core/notice_reports.json").write_text('{"reports":[]}', encoding="utf-8")
    (root / "core/local_state.json").write_text('{"version":1,"values":{}}', encoding="utf-8")


with tempfile.TemporaryDirectory(prefix="cozy_memory_e2e_") as directory:
    root = Path(directory)
    prepare_root(root)
    memory = MemoryStore(root)
    results = {}

    # 1. Evidence capture and sealed-source isolation.
    once = memory.add_event({
        "id": "once_news", "source": "noticeboard", "content": "最近在关注低代码原型工具",
    })
    once_card = card_for_evidence(memory, once["id"])
    check(once_card and once_card["status"] == "candidate", "单次行为没有进入观察状态")
    sealed = memory.add_event({
        "id": "sealed_heart", "source": "heart_hollow", "content": "树洞最高级秘密",
    })
    check(sealed["layer"] == "sealed", "树洞内容没有进入封存密库")
    check(memory.state()["sealed"] == [], "普通状态读取到了封存原文")
    check(not any(item.get("id") == sealed["id"] for item in memory.state()["events"]), "封存原文泄漏到普通证据流水")
    check(memory.state(include_sealed=True)["sealed"], "授权状态未能读取封存内容")
    results["采集与封存"] = "pass"

    # 2. Automatic observation, promotion, explicit memory, and expiry.
    for index in range(3):
        memory.add_event({
            "id": "repeat_%d" % index,
            "source": "blackboard",
            "content": "持续练习用户访谈和需求判断",
            "date": (date.today() - timedelta(days=index)).isoformat(),
        })
    repeated = card_for_evidence(memory, "repeat_0")
    check(repeated and repeated["status"] == "active", "三次重复证据没有自动生效")
    check(repeated["evidence_count"] == 3, "重复证据数量不正确")
    explicit = memory.add_preference("我希望重要结论先说", source="butler", explicit=True)
    check(explicit["status"] == "active", "明确要求记住没有立即生效")
    candidate_pref = memory.add_preference("界面不要使用很重的边框", source="butler", explicit=False)
    check(candidate_pref["status"] == "candidate", "单次推断偏好不应立即生效")
    promoted_pref = memory.add_preference("界面不要使用很重的边框", source="butler", explicit=False)
    check(promoted_pref["status"] == "active", "重复偏好没有自动生效")

    stale_event = memory.add_event({
        "id": "stale_once", "source": "noticeboard", "content": "一次性关注冷门旧设备",
    })
    stale_card = card_for_evidence(memory, stale_event["id"])
    cards_data = memory._read(memory.paths["cards"], {"items": []})
    for item in cards_data["items"]:
        if item.get("id") == stale_card["id"]:
            item["updated_at"] = (datetime.now().astimezone() - timedelta(days=46)).isoformat(timespec="seconds")
    memory._write(memory.paths["cards"], cards_data)
    memory.prune_short()
    check(not any(item.get("id") == stale_card["id"] for item in memory.state()["cards"]), "过期观察线索没有自动清理")
    results["自动判断"] = "pass"

    # 3. Conflict correction keeps the newest explicit preference.
    old_length = memory.add_preference("我喜欢回复简短一点", source="butler", explicit=True)
    new_length = memory.add_preference("我喜欢回复详细一点", source="butler", explicit=True)
    check(old_length["id"] == new_length["id"], "同一偏好槽位产生了重复卡片")
    check(new_length["statement"] == "我喜欢回复详细一点", "新明确偏好没有覆盖旧偏好")
    check(new_length.get("history") and new_length["history"][0]["statement"] == "我喜欢回复简短一点", "偏好纠正没有保留历史")
    results["冲突与纠正"] = "pass"

    # 4. Text profile includes active cards only and rewrites automatically.
    profile_before = memory.state()["profile"]
    profile_text = profile_before["summary"]
    check("重要结论先说" in profile_text, "明确偏好没有进入文本档案")
    check("界面不要使用很重的边框" in profile_text, "自动生效偏好没有进入文本档案")
    check("低代码原型工具" not in profile_text, "单次观察线索泄漏到文本档案")
    check("树洞最高级秘密" not in profile_text, "封存原文泄漏到文本档案")
    check(len(profile_before.get("sections", [])) >= 2, "文本档案没有按主题整理")
    fingerprint_before = profile_before["fingerprint"]
    memory.add_preference("我偏好低饱和但不单调的配色", source="butler", explicit=True)
    profile_after = memory.state()["profile"]
    check(profile_after["fingerprint"] != fingerprint_before, "新增记忆后文本档案没有重写")
    check("低饱和但不单调" in profile_after["summary"], "新生效记忆没有进入自动档案")
    results["自动文本档案"] = "pass"

    # 5. Task context is relevant, active-only, and current instructions win.
    memory.add_event({
        "id": "growth_active", "source": "orchard", "content": "未来重点提升长期职业判断", "remember": True,
    })
    context = memory.prompt_context("整理本周 AI 资讯摘要")
    context_raw = json.dumps(context, ensure_ascii=False)
    check("树洞最高级秘密" not in context_raw, "封存原文进入普通任务上下文")
    check("低代码原型工具" not in context_raw, "候选线索进入普通任务上下文")
    check("长期职业判断" not in context_raw, "无关成长记忆进入资讯任务上下文")
    check(any("当前明确要求" in rule for rule in context["rules"]), "上下文没有声明当前指令优先")
    results["任务调用"] = "pass"

    # 5b. Companion memory is room-scoped, sparse, and excludes recent reuse.
    companion_pref = memory.add_preference("树洞陪聊不要每次追问，也不要说套话，要灵活一点", source="butler", explicit=True)
    check(companion_pref["scope"] == "companion_style", "陪伴偏好没有进入独立作用域")
    memory.set_card_scope(companion_pref["id"], "record_only")
    check(next(item for item in memory.state()["cards"] if item["id"] == companion_pref["id"])["scope"] == "record_only", "本地记忆参与范围修改没有生效")
    memory.set_card_scope(companion_pref["id"], "companion_style")
    memory.add_preference("学习资料对比时我希望优先使用表格", source="butler", explicit=True)
    memory.add_event({"id": "heart_work_1", "source": "heart_hollow", "content": "最近工作项目让我反复权衡方向", "layer": "sealed"})
    memory.add_event({"id": "heart_work_2", "source": "heart_hollow", "content": "今天开会后又开始担心职业选择", "layer": "sealed"})
    memory.add_event({
        "id": "travel_hz_1", "source": "travel", "type": "travel_reflection", "layer": "long",
        "scope": "travel_only", "room_id": "trip-hz", "content": "在西湖边散步时终于慢了下来",
        "summary": "杭州旅行让我重新感受到慢下来的轻松", "weight": 2,
    })
    butler_context = memory.prompt_context("帮我整理今天的学习计划", purpose="butler", limit=2)
    check("西湖" not in json.dumps(butler_context, ensure_ascii=False), "旅行原文进入普通管家上下文")
    check("工作项目" not in json.dumps(butler_context, ensure_ascii=False), "树洞原文进入普通管家上下文")
    first_heart = memory.prompt_context("最近工作总是让我很累", purpose="heart_companion", limit=2)
    check(len(first_heart["selected_memory_ids"]) <= 2, "树洞单轮注入超过两条记忆")
    check("优先使用表格" not in json.dumps(first_heart, ensure_ascii=False), "无关学习格式偏好串入树洞")
    check(any(str(value).startswith("inner:work") for value in first_heart["selected_memory_ids"]), "连续性表达没有选中去隐私的工作趋势")
    check("最近工作项目" not in json.dumps(first_heart, ensure_ascii=False), "树洞去隐私趋势泄漏了封存原文")
    second_heart = memory.prompt_context(
        "最近工作还是让我很累", purpose="heart_companion", limit=2,
        recent_ids=first_heart["selected_memory_ids"],
    )
    check(not set(first_heart["selected_memory_ids"]).intersection(second_heart["selected_memory_ids"]), "近期使用过的记忆被连续注入")
    travel_context = memory.prompt_context("这次杭州旅行让我有什么变化", purpose="travel_companion", room_id="trip-hz", limit=2)
    check(len(travel_context["selected_memory_ids"]) <= 2 and "travel_hz_1" in travel_context["selected_memory_ids"], "旅行页没有读取同一旅程的房间记忆")
    unrelated_heart = memory.prompt_context("今晚只想随便聊聊天", purpose="heart_companion", limit=2)
    check("travel_hz_1" not in unrelated_heart["selected_memory_ids"], "无关旅行记忆串入树洞")
    results["陪伴记忆边界"] = "pass"

    # 6. Category create, dedupe, automatic suggestion, rename, move, merge, and delete.
    custom = memory.create_category("研究与评测", explicit=True)["category"]
    duplicate = memory.create_category("研究与评测", explicit=True)["category"]
    check(custom["id"] == duplicate["id"], "同名分类重复创建")
    active_ids = [item["id"] for item in memory.state()["cards"] if item.get("status") == "active"][:3]
    for card_id in active_ids:
        memory.create_category("自动专题", explicit=False, related_card_ids=[card_id])
    auto_category = next((item for item in memory.state()["categories"] if item.get("name") == "自动专题"), None)
    check(auto_category, "三张相关卡片没有自动形成分类")
    memory.move_card(explicit["id"], custom["id"])
    moved_profile = memory.state()["profile"]
    check(any(section["title"] == "研究与评测" for section in moved_profile["sections"]), "移动卡片后文本档案没有采用新分类")
    memory.rename_category(custom["id"], "研究方法")
    renamed_profile = memory.state()["profile"]
    check(any(section["title"] == "研究方法" for section in renamed_profile["sections"]), "分类改名后文本档案没有更新")
    memory.merge_category(custom["id"], "product-learning")
    check(not any(item.get("id") == custom["id"] for item in memory.state()["categories"]), "分类合并后旧分类仍存在")
    disposable = memory.create_category("临时分类", explicit=True)["category"]
    memory.move_card(explicit["id"], disposable["id"])
    memory.delete_category(disposable["id"])
    check(next(item for item in memory.state()["cards"] if item["id"] == explicit["id"])["category_id"] == "general", "删除分类后卡片没有移到其他")
    results["分类系统"] = "pass"

    # 7. Forget removes the card and its evidence, and tombstones prevent resurrection.
    erase_event = memory.add_event({
        "id": "erase_evidence", "source": "noticeboard", "content": "需要被彻底遗忘的内容", "remember": True,
    })
    erase_card = card_for_evidence(memory, erase_event["id"])
    erased = memory.forget(erase_card["id"])
    check(erase_card["id"] in erased["forgotten_ids"], "被遗忘卡片没有写入 tombstone")
    check(not any(item.get("id") == erase_card["id"] for item in memory.state()["cards"]), "被遗忘卡片仍然存在")
    check(not any(item.get("id") == erase_event["id"] for item in memory.state()["events"]), "卡片相关证据没有同步删除")
    replay = memory.add_event({
        "id": "erase_evidence", "source": "noticeboard", "content": "需要被彻底遗忘的内容", "remember": True,
    })
    check(replay.get("ignored"), "已遗忘证据能够从旧副本复活")
    results["彻底遗忘"] = "pass"

    # 8. Restart persistence and migration idempotence.
    state_before_restart = memory.state()
    restarted = MemoryStore(root)
    state_after_restart = restarted.state()
    check(state_after_restart["profile"]["fingerprint"] == state_before_restart["profile"]["fingerprint"], "重启后文本档案发生漂移")
    check(len(state_after_restart["cards"]) == len(state_before_restart["cards"]), "重启后卡片重复或丢失")

    legacy_root = root / "legacy"
    prepare_root(legacy_root)
    (legacy_root / "core/memory/preferences.json").write_text(json.dumps({"version": 2, "items": [{
        "id": "legacy_pref", "statement": "我喜欢清晰直接的表达", "status": "confirmed",
    }]}, ensure_ascii=False), encoding="utf-8")
    legacy_once = MemoryStore(legacy_root)
    legacy_ids_once = [item["id"] for item in legacy_once.state()["cards"]]
    legacy_ids_twice = [item["id"] for item in MemoryStore(legacy_root).state()["cards"]]
    check(legacy_ids_once == legacy_ids_twice and len(legacy_ids_once) == 1, "旧记忆迁移不是幂等的")
    results["持久化与迁移"] = "pass"

    # 8b. Historical duplicate/sealed rows are repaired without losing lineage.
    repaired_root = root / "repair"
    prepare_root(repaired_root)
    repaired = MemoryStore(repaired_root)
    normal = repaired.add_event({"id": "normal_once", "source": "noticeboard", "content": "需要保留的普通证据", "remember": True})
    normal_card = card_for_evidence(repaired, normal["id"])
    event_data = repaired._read(repaired.paths["events"], {"items": []})
    event_data["items"].append(dict(event_data["items"][0]))
    event_data["items"].append({"id": "legacy_secret", "source": "heart_hollow", "content": "旧版封存原文", "summary": "旧版封存原文", "layer": "sealed", "sensitivity": "sealed"})
    repaired._write(repaired.paths["events"], event_data)
    cards_data = repaired._read(repaired.paths["cards"], {"items": []})
    normal_card_on_disk = next(item for item in cards_data["items"] if item["id"] == normal_card["id"])
    normal_card_on_disk["evidence_ids"].append("legacy_missing_evidence")
    repaired._write(repaired.paths["cards"], cards_data)
    repaired_after_restart = MemoryStore(repaired_root)
    repaired_state = repaired_after_restart.state()
    repaired_ids = [item["id"] for item in repaired_state["events"]]
    check(len(repaired_ids) == len(set(repaired_ids)), "历史重复证据没有在启动时修复")
    check("legacy_secret" not in repaired_ids, "历史封存原文仍留在普通证据流水")
    check(any(item.get("id") == "legacy_secret" for item in repaired_after_restart.state(include_sealed=True)["sealed"]), "历史封存原文迁移时丢失")
    check("legacy_missing_evidence" in repaired_ids, "旧卡片缺失的证据引用没有修复")
    results["证据完整性修复"] = "pass"

    # 9. Daily maintenance runs without owner confirmation.
    automation = AutomationRunner(root, restarted)
    automation.run_scheduled_weekly = lambda now=None: False
    automation.resolve_notice_requests = lambda: None
    automation.tick(datetime.now().astimezone())
    maintenance = automation.status().get("jobs", {}).get("memory_maintenance", {})
    check(maintenance.get("status") == "completed", "每日记忆维护没有自动执行")
    results["自动维护"] = "pass"

    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False, indent=2))
