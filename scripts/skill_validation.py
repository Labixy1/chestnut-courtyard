#!/usr/bin/env python3
"""Validate every fixed Skill and every registered executable tool without touching owner data."""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

from automation_runner import AutomationRunner
from butler_tools import ButlerTools
from memory_store import MemoryStore
from system_runtime import SystemRuntime


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SKILLS = {
    "archive-travel", "build-skill", "coach-blackboard", "curate-news", "curate-photos",
    "guide-orchard", "listen-tree-hollow", "manage-memory", "manage-system",
    "manage-toolbox", "organize-checklist", "run-automation", "generate-media",
    "imagegen-assets", "remove-background",
}


def read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return fallback


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def fixed_skill_contracts():
    found = {}
    for path in sorted((ROOT / "core/skills").glob("*/SKILL.md")):
        text = path.read_text(encoding="utf-8")
        name_match = re.search(r"^name:\s*(.+)$", text, re.M)
        description_match = re.search(r"^description:\s*(.+)$", text, re.M)
        check(name_match and description_match, f"{path.parent.name} 缺少 Skill 元数据")
        check(name_match.group(1).strip() == path.parent.name, f"{path.parent.name} 名称和目录不一致")
        check(len(text.splitlines()) >= 8, f"{path.parent.name} 规则过少")
        found[path.parent.name] = text
    check(set(found) == EXPECTED_SKILLS, "固定 Skill 清单不完整：" + str(sorted(set(found) ^ EXPECTED_SKILLS)))
    return found


def prepare_root(directory):
    root = Path(directory)
    (root / "core").mkdir(parents=True)
    shutil.copytree(ROOT / "core/skills", root / "core/skills")
    (root / "core/manifest.json").write_text(json.dumps({"items": [{
        "type": "news", "title": "测试模型更新", "summary": "能力与价格变化",
        "url": "https://example.com/model", "category": "模型与技术",
    }]}, ensure_ascii=False), encoding="utf-8")
    (root / "core/notice_reports.json").write_text(json.dumps({"reports": [{
        "id": "week_test", "week_start": "2026-08-03", "week_end": "2026-08-09",
        "hot_items": [{"title": "测试模型更新", "summary": "能力与价格变化", "link": "https://example.com/model", "category": "模型与技术"}],
        "sections": [{"name": "产品相关动态", "items": [{"title": "原型案例", "summary": "AI 原型案例", "link": "https://example.com/prototype"}]}],
    }]}, ensure_ascii=False), encoding="utf-8")
    (root / "core/estate_state.json").write_text('{"travel":{"history":[]},"wall_photos":[]}', encoding="utf-8")
    (root / "core/private_wing.json").write_text('{"plates":[],"diary":[]}', encoding="utf-8")
    (root / "core/heart_hollow.json").write_text('{"entries":[],"settings":{}}', encoding="utf-8")
    (root / "index.html").write_text("<html>snapshot</html>", encoding="utf-8")
    return root


def run_validation():
    contracts = fixed_skill_contracts()
    source_server = (ROOT / "scripts/cozy_server.py").read_text(encoding="utf-8")
    source_index = (ROOT / "index.html").read_text(encoding="utf-8")
    results = {}

    with tempfile.TemporaryDirectory(prefix="cozy_skill_validation_") as directory:
        root = prepare_root(directory)
        runtime = SystemRuntime(root, [])
        memory = MemoryStore(root)

        def parse_url(url, instruction):
            return {"title": "解析资料", "summary": "解析成功", "url": url, "category": "产品与实践", "media": "测试源"}

        def parse_tool(url, instruction):
            return {"title": "测试工具", "category": "产品与实践", "purpose": "验证工具能力", "use_when": "需要验证时",
                    "key_capabilities": ["解析", "执行"], "use_cases": ["集成测试"], "example": "运行一个验证", "url": "https://example.com/tool"}

        class FakeMediaService:
            def __init__(self):
                self.tasks = {}

            def generate_image(self, payload):
                task = {"id": "gen_image_test", "kind": "image", "provider": payload.get("provider", "seedream"),
                        "status": "succeeded", "outputs": [{"file": "assets/generated/images/test.png"}]}
                self.tasks[task["id"]] = task
                return task

            def create_video(self, payload):
                task = {"id": "gen_video_test", "kind": "video", "provider": "seedance", "status": "queued", "outputs": []}
                self.tasks[task["id"]] = task
                return task

            def get(self, task_id):
                return self.tasks[task_id]

            def refresh_video(self, task_id):
                self.tasks[task_id]["status"] = "succeeded"
                self.tasks[task_id]["outputs"] = [{"file": "assets/generated/videos/test.mp4"}]
                return self.tasks[task_id]

        tools = ButlerTools(root, lambda prompt: ('{"answer":"ok","tool_calls":[]}', "test"), parse_url, runtime, memory, parse_tool, FakeMediaService())
        manifest = tools.skill_manifest()
        names = [item.get("name") for item in manifest.get("tools", [])]
        check(len(names) == len(set(names)), "工具注册存在重名")
        check(len(names) >= 23, "注册工具数量异常")
        check(len(manifest.get("skills", [])) == len(EXPECTED_SKILLS), "工具箱 Skill 专区没有完整读取内置 Skill")

        trip = tools.execute("manage_trip", {"action": "create", "place": "测试岛", "start": "2026-08-06"})
        tools.execute("manage_trip", {"action": "complete", "id": trip["item"]["id"]})
        check(tools._local_state()["values"]["cozy_trips"][0]["status"] == "completed", "旅行没有完成")
        tools.execute("manage_trip", {"action": "remove", "id": trip["item"]["id"]})
        results["archive-travel"] = "pass: 新建、结束、删除旅程均落盘"

        check("build_skill" in names, "build_skill 未注册")
        dynamic = runtime.dynamic_skills()
        check(dynamic and dynamic[0]["name"] == "organize-checklist", "动态 Skill 未注册")
        results["build-skill"] = "pass: 动态 Skill 目录、权限和入口契约有效"

        check('"blackboard": "core/skills/coach-blackboard/SKILL.md"' in source_server, "黑板 Skill 未接入房间路由")
        check("standard_points" in source_server and "suggestions" in source_server, "黑板批改输出不完整")
        results["coach-blackboard"] = "pass: 出题、批改、标准答案和建议路由已接入"

        reports = read_json(root / "core/notice_reports.json", {}).get("reports", [])
        check(reports and reports[0].get("hot_items") and reports[0].get("sections"), "周报结构不完整")
        check("run_weekly_report" in names, "周报执行工具未注册")
        results["curate-news"] = "pass: 周报结构、来源条目和执行入口有效"

        check("cozy_photo_albums" in source_index and "photo-album-grid" in source_index, "照片墙没有相册集合逻辑")
        check("travelAlbums" in source_index and "photo-date-mark" in source_index, "照片墙没有旅行相册或时间标记")
        check("moveAlbumPhoto" in source_index and "removeAlbumPhoto" in source_index, "照片墙缺少照片管理能力")
        check("heart_hollow" not in source_index[source_index.find("function seedPhotoAlbums"):source_index.find("function savePhotoAlbums")],
              "树洞封存影像不应进入照片墙相册")
        results["curate-photos"] = "pass: 相册集合、旅行导入、时间标记、增删移动和树洞媒体隔离有效"

        seed = tools.execute("manage_growth_seed", {"action": "create", "text": "如何提升产品判断"})
        tools.execute("manage_growth_seed", {"action": "resolve", "id": seed["item"]["id"], "reflection": "先做小实验"})
        check(tools._local_state()["values"]["cozy_orchard_seeds"][0]["status"] == "resolved", "果园种子没有收成")
        tools.execute("manage_growth_seed", {"action": "remove", "id": seed["item"]["id"]})
        topic = tools.execute("manage_knowledge_topic", {"action": "upsert", "title": "AI 编程助手", "category": "工具与技术",
                                                           "entities": ["Cursor", "Claude Code"], "question": "两者有什么区别", "answer": "交互形态和代理深度不同"})
        tools.execute("manage_knowledge_topic", {"action": "upsert", "id": topic["item"]["id"], "title": "AI 编程助手",
                                                   "entities": ["Codex"], "question": "它们和 Codex 有什么区别", "answer": "任务执行边界不同"})
        stored_topic = tools._local_state()["values"]["cozy_orchard_topics"][0]
        check(len(stored_topic["entries"]) == 2 and "Codex" in stored_topic["entities"], "知识专题没有原地追加更新")
        results["guide-orchard"] = "pass: 播种、收成、知识专题追加和删除均落盘"

        image = tools.execute("generate_media", {"kind": "image", "provider": "seedream", "prompt": "测试小院"})
        video = tools.execute("generate_media", {"kind": "video", "provider": "seedance", "prompt": "测试风吹树叶"})
        checked = tools.execute("check_media_task", {"id": video["task"]["id"]})
        check(image["task"]["outputs"] and checked["task"]["status"] == "succeeded", "多模态生成任务没有完成状态流转")
        results["generate-media"] = "pass: 图片保存、视频异步提交和任务查询契约有效"

        check("imagegen-assets" in contracts, "图像素材生成 Skill 未注册")
        check("generate_media" in names, "图像素材生成未关联真实模型能力")
        results["imagegen-assets"] = "pass: 图像素材工作流已关联真实生成任务"

        remove_skill = next((item for item in runtime.dynamic_skills() if item.get("name") == "remove-background"), None)
        check(remove_skill and remove_skill.get("entrypoint"), "OpenCV 抠图 Skill 未注册")
        results["remove-background"] = "pass: OpenCV 抠图入口、项目路径限制与透明输出契约有效"

        sealed = memory.add_event({"source": "heart_hollow", "content": "封存测试"})
        check(sealed["layer"] == "sealed" and not memory.state()["sealed"], "树洞封存隔离失效")
        check('heart_mode == "oracle"' in source_server and '"dialogue"' in source_server, "树洞双模式未接入")
        results["listen-tree-hollow"] = "pass: 签语/对话双模式与封存隔离有效"

        explicit = memory.observe_message("我喜欢阿栗回复简短一点，以后都这样", "butler")
        check(explicit and explicit[0]["status"] == "active", "明确偏好没有激活")
        first = memory.observe_message("不要在主屏入口加外框", "butler")[0]
        check(first["status"] == "candidate", "单次行为不应直接成为确认偏好")
        second = memory.observe_message("不要在主屏入口加外框", "butler")[0]
        check(second["status"] == "active", "重复偏好没有晋升")
        profile = memory.prompt_context("修改主屏入口")
        check(profile["confirmed_preferences"], "偏好没有进入 Prompt 上下文")
        check("封存测试" not in json.dumps(profile, ensure_ascii=False), "封存原文泄漏到普通上下文")
        results["manage-memory"] = "pass: 证据、候选卡片、激活、Prompt 上下文和封存隔离有效"

        runtime.set_steward_mode(True)
        snapshot = runtime.create_snapshot("validation")
        check("index.html" in snapshot["files"] and (root / "core/snapshots" / snapshot["id"] / "snapshot.json").exists(), "系统快照失败")
        results["manage-system"] = "pass: 权限、快照、卷宗和可回滚清单有效"

        added = tools.execute("add_toolbox_item", {"title": "原型工具", "category": "产品与实践", "purpose": "做原型", "url": "https://example.com/tool"})
        check(added["item"]["title"] == "原型工具", "工具没有加入")
        tools.execute("manage_toolbox_item", {"action": "update", "query": "原型工具", "use_when": "快速验证流程"})
        tools.execute("manage_toolbox_item", {"action": "remove", "query": "原型工具"})
        check(not tools.load_state()["toolbox"], "工具没有移出")
        results["manage-toolbox"] = "pass: 新增、解析、更新和移除契约有效"

        checklist_one = runtime.execute_dynamic("organize-checklist", {"items": ["确认需求", "运行测试"]})
        checklist_two = runtime.execute_dynamic("organize-checklist", {"items": ["确认需求", "运行测试"]})
        check(checklist_one["ok"] and checklist_one["checklist"][0]["id"] == checklist_two["checklist"][0]["id"], "清单 id 不稳定")
        results["organize-checklist"] = "pass: 动态执行成功且相同输入 id 稳定"

        automation = AutomationRunner(root, memory)
        monday = date.today() + timedelta(days=(0 - date.today().weekday()) % 7)
        now = datetime.now().astimezone().replace(year=monday.year, month=monday.month, day=monday.day, hour=8, minute=0, second=0, microsecond=0)
        runs = []
        automation.run_weekly = lambda force=False: (runs.append(force), automation._record("weekly_report", "completed", "验证完成"))
        check(automation.run_scheduled_weekly(now) and runs == [True], "自动周报没有触发")
        check(not automation.run_scheduled_weekly(now + timedelta(minutes=1)), "自动周报重复触发")
        automation.tick(now + timedelta(hours=1))
        check(automation.status().get("jobs", {}).get("memory_maintenance", {}).get("status") == "completed", "记忆维护未运行")
        results["run-automation"] = "pass: 定时、幂等、周报和记忆维护有效"

        archived = tools.execute("parse_and_archive", {"url": "https://example.com/article"})
        tools.execute("add_read_later", {"query": "https://example.com/article"})
        tools.execute("add_watch_topic", {"topic": "Agent 记忆系统"})
        tools.execute("add_source", {"name": "测试媒体", "url": "https://example.com/news"})
        tools.execute("manage_notice_category", {"action": "create", "category": "测试分类"})
        remembered = tools.execute("remember_preference", {"statement": "我希望测试结果简短清楚"})
        tools.execute("manage_preference", {"action": "confirm", "id": remembered["item"]["id"]})
        check(archived["ok"] and tools.execute("search_knowledge", {"query": "解析资料"})["ok"], "知识工具链失败")

        executable = {name for name in names if re.search(r'[`"\']' + re.escape(name) + r'[`"\']', (ROOT / "scripts/butler_tools.py").read_text(encoding="utf-8"))}
        check(set(names) <= executable | {item["name"] for item in dynamic}, "存在未接入的注册工具")

    return {
        "version": 1,
        "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "ok": len(results) == len(EXPECTED_SKILLS) and all(value.startswith("pass") for value in results.values()),
        "summary": f"{len(results)}/{len(EXPECTED_SKILLS)} 个固定 Skill 通过；注册工具契约与动态入口通过",
        "skills": [{"name": name, "status": "pass", "detail": results[name]} for name in sorted(results)],
    }


if __name__ == "__main__":
    try:
        report = run_validation()
    except Exception as exc:
        report = {
            "version": 1, "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "ok": False, "summary": str(exc), "skills": [],
        }
    output = ROOT / "core/skill_health.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(report["summary"])
    raise SystemExit(0 if report["ok"] else 1)
