#!/usr/bin/env python3
import json
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

from butler_tools import ButlerTools
from automation_runner import AutomationRunner
from memory_store import MemoryStore
from system_runtime import SystemRuntime


with tempfile.TemporaryDirectory(prefix="cozy_system_test_") as directory:
    root = Path(directory)
    (root / "core/skills").mkdir(parents=True)
    (root / "core/skills/butler_agent.json").write_text('{"tools":[]}', encoding="utf-8")
    (root / "core/manifest.json").write_text('{"items":[]}', encoding="utf-8")
    (root / "core/notice_reports.json").write_text('{"reports":[]}', encoding="utf-8")

    runtime = SystemRuntime(root, [])
    assert runtime.permissions()["steward_mode"] is False
    runtime.set_steward_mode(True)
    assert SystemRuntime(root, []).permissions()["steward_mode"] is True
    runtime.set_steward_mode(False)

    legacy_root = root / "legacy_case"
    (legacy_root / "core/memory").mkdir(parents=True)
    (legacy_root / "core/memory/preferences.json").write_text(json.dumps({"version": 2, "items": [{
        "id": "old_pref", "statement": "我喜欢回复简短清楚", "status": "confirmed", "confidence": 0.96,
    }]}, ensure_ascii=False), encoding="utf-8")
    (legacy_root / "core/memory/long_term.json").write_text(json.dumps({"version": 1, "items": [{
        "id": "old_long", "source": "travel", "summary": "旅行时喜欢记录地点和感悟",
    }]}, ensure_ascii=False), encoding="utf-8")
    legacy_memory = MemoryStore(legacy_root)
    first_migration_ids = [item["id"] for item in legacy_memory.state()["cards"]]
    second_migration_ids = [item["id"] for item in MemoryStore(legacy_root).state()["cards"]]
    assert first_migration_ids == second_migration_ids and len(first_migration_ids) == 2
    assert legacy_memory.state()["migration"]["memory_cards_v1"]["status"] == "completed"

    memory = MemoryStore(root)
    sealed = memory.add_event({"source": "heart_hollow", "content": "私密内容"})
    assert sealed["layer"] == "sealed"
    explicit = memory.add_event({"source": "orchard", "content": "记住成长方向", "remember": True})
    assert explicit["layer"] == "long"
    for offset in range(3):
        memory.add_event({
            "source": "blackboard", "summary": "反复练习用户研究方法", "content": "反复练习用户研究方法",
            "date": (date.today() - timedelta(days=offset)).isoformat(), "id": "repeat_" + str(offset),
        })
    repeated_card = next(item for item in memory.state()["cards"] if "用户研究方法" in item.get("statement", ""))
    assert repeated_card["status"] == "active" and repeated_card["evidence_count"] == 3
    assert memory.state(include_sealed=False)["sealed"] == []
    assert memory.state(include_sealed=True)["sealed"]
    forgotten = memory.add_event({"id": "forget_me", "source": "noticeboard", "content": "永久忘记测试"})
    assert forgotten["id"] == "forget_me"
    memory.forget("forget_me")
    assert memory.add_event({"id": "forget_me", "source": "noticeboard", "content": "永久忘记测试"})["ignored"]
    assert not any(item.get("id") == "forget_me" for item in memory.state()["events"])

    explicit_preference = memory.observe_message("我喜欢阿栗回复简短一点，以后都这样", "butler")
    assert explicit_preference and explicit_preference[0]["status"] == "active"
    assert memory.observe_message("只读检查，不要修改任何内容", "butler") == []
    candidate_preference = memory.observe_message("不要在主屏入口加外框", "butler")[0]
    assert candidate_preference["status"] == "candidate"
    promoted_preference = memory.observe_message("不要在主屏入口加外框", "butler")[0]
    assert promoted_preference["status"] == "active" and promoted_preference["evidence_count"] == 2
    prompt_context = memory.prompt_context("修改主屏入口")
    assert any(item["statement"] == promoted_preference["statement"] for item in prompt_context["confirmed_preferences"])
    assert not any("成长方向" in str(item.get("statement")) for item in prompt_context["context_package"]["cards"])
    assert "私密内容" not in json.dumps(prompt_context, ensure_ascii=False)
    profile_before = memory.state()["profile"]
    assert promoted_preference["statement"] in profile_before["summary"]
    assert "私密内容" not in profile_before["summary"]
    memory.add_preference("我希望重要结论先说", source="butler", explicit=True)
    profile_after = memory.state()["profile"]
    assert profile_after["fingerprint"] != profile_before["fingerprint"]
    assert "我希望重要结论先说" in profile_after["summary"]
    memory.set_preference_status(promoted_preference["id"], "candidate")
    assert next(item for item in memory.state()["preferences"] if item["id"] == promoted_preference["id"])["status"] == "candidate"
    custom = memory.create_category("研究方法", explicit=True)["category"]
    assert memory.create_category("研究方法", explicit=True)["category"]["id"] == custom["id"]
    memory.move_card(repeated_card["id"], custom["id"])
    assert next(item for item in memory.state()["cards"] if item["id"] == repeated_card["id"])["category_id"] == custom["id"]
    memory.rename_category(custom["id"], "研究与评测")
    assert next(item for item in memory.state()["categories"] if item["id"] == custom["id"])["name"] == "研究与评测"
    auto_texts = ["研究访谈观察", "可用性测试记录", "评测指标设计"]
    auto_ids = [memory.add_event({"id": "auto_%d" % index, "source": "butler", "content": text})["id"] for index, text in enumerate(auto_texts)]
    for evidence_id in auto_ids:
        card_id = next(item["id"] for item in memory.state()["cards"] if evidence_id in item.get("evidence_ids", []))
        memory.create_category("自动形成分类", explicit=False, related_card_ids=[card_id])
    assert any(item["name"] == "自动形成分类" for item in memory.state()["categories"])
    memory.merge_category(custom["id"], "product-learning")
    assert not any(item["id"] == custom["id"] for item in memory.state()["categories"])

    tools = ButlerTools(root, lambda prompt: ('{}', 'test'), lambda url, instruction: {}, runtime, memory)
    result = tools.execute("manage_notice_category", {"action": "create", "category": "用户研究"})
    assert result["ok"] and tools.load_state()["custom_categories"][0]["name"] == "用户研究"
    tools.execute("manage_notice_category", {"action": "rename", "category": "用户研究", "target": "研究方法"})
    assert tools.load_state()["custom_categories"][0]["name"] == "研究方法"
    tools.execute("manage_notice_category", {"action": "delete", "category": "研究方法"})
    assert not tools.load_state()["custom_categories"]
    remembered_preference = tools.execute("remember_preference", {"statement": "我希望测试结果简短清楚"})
    assert remembered_preference["item"]["status"] == "active"
    tools.execute("manage_preference", {"action": "candidate", "id": remembered_preference["item"]["id"]})
    assert next(item for item in memory.state()["preferences"] if item["id"] == remembered_preference["item"]["id"])["status"] == "candidate"

    parsed_tool = {
        "title": "测试工具", "category": "产品与原型", "purpose": "生成交互原型",
        "use_when": "生成交互原型", "key_capabilities": ["页面生成", "交互预览"],
        "use_cases": ["验证产品流程"], "example": "生成一个注册流程", "url": "https://example.com/tool",
        "source_url": "https://example.com/news", "source": "tool_link_parser",
    }
    tool_parser = ButlerTools(root, lambda prompt: ('{}', 'test'), lambda url, instruction: {}, runtime, memory,
                              lambda url, instruction: dict(parsed_tool))
    imported = tool_parser.execute("add_tool_from_link", {"url": "https://example.com/news"})
    assert imported["item"]["url"] == "https://example.com/tool"
    assert imported["item"]["key_capabilities"] == ["页面生成", "交互预览"]

    trip = tools.execute("manage_trip", {"action": "create", "place": "测试小镇", "start": "2026-08-06"})
    assert trip["ok"] and trip["item"]["updatedAt"]
    tools.execute("manage_trip", {"action": "complete", "id": trip["item"]["id"]})
    assert tools._local_state()["values"]["cozy_trips"][0]["status"] == "completed"
    tools.execute("manage_trip", {"action": "remove", "id": trip["item"]["id"]})
    assert not tools._local_state()["values"]["cozy_trips"]

    seed = tools.execute("manage_growth_seed", {"action": "create", "text": "验证成长种子"})
    assert seed["ok"] and seed["item"]["updatedAt"]
    tools.execute("manage_growth_seed", {"action": "resolve", "id": seed["item"]["id"], "reflection": "已验证"})
    assert tools._local_state()["values"]["cozy_orchard_seeds"][0]["status"] == "resolved"
    tools.execute("manage_growth_seed", {"action": "remove", "id": seed["item"]["id"]})
    assert not tools._local_state()["values"]["cozy_orchard_seeds"]

    yesterday = (date.today() - timedelta(days=1)).isoformat()
    (root / "core/local_state.json").write_text(json.dumps({"version": 1, "values": {
        "cozy_notice_requests": [{"text": "下周关注 Agent 工作流", "kind": "watch_topic", "date": yesterday}]
    }}, ensure_ascii=False), encoding="utf-8")
    (root / "core/notice_reports.json").write_text(json.dumps({"reports": [{"hot_items": [{
        "title": "Agent 工作流更新", "summary": "后台任务和工具调用", "link": "https://example.com/agent"
    }], "sections": []}]}, ensure_ascii=False), encoding="utf-8")
    automation = AutomationRunner(root, memory)
    automation.resolve_notice_requests()
    followup = json.loads((root / "core/local_state.json").read_text(encoding="utf-8"))["values"]["cozy_notice_requests"][0]
    assert followup["found_items"][0]["title"] == "Agent 工作流更新"

    monday = date.today() + timedelta(days=(0 - date.today().weekday()) % 7)
    scheduled_time = datetime.now().astimezone().replace(
        year=monday.year, month=monday.month, day=monday.day, hour=8, minute=0, second=0, microsecond=0
    )
    runs = []
    automation.run_weekly = lambda force=False: (runs.append(force), automation._record("weekly_report", "completed", "测试周报已生成"))
    assert automation.run_scheduled_weekly(scheduled_time) is True and runs == [True]
    assert automation.run_scheduled_weekly(scheduled_time + timedelta(minutes=1)) is False
    weekly_job = automation.status()["jobs"]["weekly_report"]
    assert weekly_job["schedule"] == "每周一、周三、周六 08:00" and weekly_job["last_scheduled_date"] == monday.isoformat()
    wednesday = scheduled_time + timedelta(days=2)
    assert automation.next_weekly_run(scheduled_time) == wednesday
    assert automation.run_scheduled_weekly(wednesday) is True and runs == [True, True]
    saturday = scheduled_time + timedelta(days=5)
    assert automation.next_weekly_run(wednesday) == saturday

print("system smoke test ok: permission; evidence-backed cards; preference candidates; prompt context; forgetting; card promotion; dynamic categories; toolbox import; travel; orchard; notice follow-up; 2-3 day report schedule")
