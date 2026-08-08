#!/usr/bin/env python3
"""Permission, task, snapshot, dynamic skill, and system-change runtime."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path


TEXT_SUFFIXES = {".html", ".css", ".js", ".py", ".json", ".txt", ".md", ".yaml", ".yml", ".sh", ".command", ".swift", ".plist"}


class SystemRuntime:
    def __init__(self, root: Path, codex_candidates=None, model_call=None):
        self.root = Path(root).resolve()
        self.codex_candidates = codex_candidates or []  # Kept for backward-compatible callers; never executed.
        self.model_call = model_call
        self.lock = threading.RLock()
        self.permission_path = self.root / "core/permissions.json"
        self.tasks_path = self.root / "core/tasks.json"
        self.audit_path = self.root / "core/audit_log.json"
        self.snapshots_dir = self.root / "core/snapshots"
        self.skills_dir = self.root / "core/private_skills"
        self.bundled_skills_dir = self.root / "core/skills"
        self._ensure_files()
        self._recover_interrupted_tasks()

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
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.bundled_skills_dir.mkdir(parents=True, exist_ok=True)
        if not self.permission_path.exists():
            self._write(self.permission_path, {
                "steward_mode": False,
                "permanent": True,
                "scope": "project",
                "enabled_at": None,
                "updated_at": self.now(),
            })
        if not self.tasks_path.exists():
            self._write(self.tasks_path, {"version": 1, "tasks": []})
        if not self.audit_path.exists():
            self._write(self.audit_path, {"version": 1, "events": []})

    def _recover_interrupted_tasks(self):
        data = self.tasks()
        changed = False
        for task in data.get("tasks", []):
            if task.get("status") == "running":
                task.update({
                    "status": "failed",
                    "updated_at": self.now(),
                    "message": "服务重启前任务未完成，已停止，可重新下达。",
                })
                changed = True
        if changed:
            self._write(self.tasks_path, data)
            self.audit("interrupted_tasks_recovered", {"status": "failed"})

    def permissions(self):
        return self._read(self.permission_path, {"steward_mode": False, "permanent": True, "scope": "project"})

    def set_steward_mode(self, enabled: bool):
        with self.lock:
            state = self.permissions()
            if state.get("steward_mode") and not enabled:
                state.update({"permanent": True, "updated_at": self.now()})
                self._write(self.permission_path, state)
                self.audit("permission_change_ignored", {"reason": "steward_mode_is_permanent"})
                return state
            state.update({
                "steward_mode": bool(enabled),
                "permanent": True,
                "scope": "project",
                "enabled_at": self.now() if enabled else None,
                "updated_at": self.now(),
            })
            self._write(self.permission_path, state)
            self.audit("permission_changed", {"steward_mode": bool(enabled)})
            return state

    def require_steward(self):
        if not self.permissions().get("steward_mode"):
            raise PermissionError("掌院权限尚未开启。请到卧室密阁中打开权限开关。")

    def audit(self, kind: str, detail: dict):
        with self.lock:
            data = self._read(self.audit_path, {"version": 1, "events": []})
            data.setdefault("events", []).insert(0, {
                "id": "audit_" + uuid.uuid4().hex[:12],
                "time": self.now(),
                "kind": kind,
                "detail": detail,
            })
            data["events"] = data["events"][:500]
            self._write(self.audit_path, data)

    def tasks(self):
        return self._read(self.tasks_path, {"version": 1, "tasks": []})

    def task_start(self, title: str, kind: str, instruction: str = ""):
        with self.lock:
            data = self.tasks()
            task = {
                "id": "task_" + uuid.uuid4().hex[:12],
                "title": title[:160],
                "kind": kind,
                "instruction": instruction[:2000],
                "status": "running",
                "started_at": self.now(),
                "updated_at": self.now(),
                "steps": [{"name": "准备", "status": "completed"}],
            }
            data.setdefault("tasks", []).insert(0, task)
            data["tasks"] = data["tasks"][:100]
            self._write(self.tasks_path, data)
            return task

    def task_update(self, task_id: str, status: str, message: str = "", **extra):
        with self.lock:
            data = self.tasks()
            task = next((item for item in data.get("tasks", []) if item.get("id") == task_id), None)
            if not task:
                return None
            task.update({"status": status, "updated_at": self.now(), **extra})
            if message:
                task["message"] = message[:2000]
            self._write(self.tasks_path, data)
            return task

    def create_snapshot(self, label: str = "system-change"):
        with self.lock:
            snapshot_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + re.sub(r"[^a-z0-9-]+", "-", label.lower())[:36]
            target = self.snapshots_dir / snapshot_id
            files = []
            skipped = []
            for path in self.root.rglob("*"):
                if self.snapshots_dir in path.parents or ".git" in path.parts:
                    continue
                if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                    continue
                relative = path.relative_to(self.root)
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.copy2(path, destination)
                    files.append(str(relative))
                except OSError as exc:
                    skipped.append({"file": str(relative), "reason": exc.__class__.__name__})
            manifest = {
                "id": snapshot_id,
                "created_at": self.now(),
                "label": label,
                "files": files,
                "skipped": skipped,
            }
            self._write(target / "snapshot.json", manifest)
            self.audit("snapshot_created", {
                "snapshot_id": snapshot_id,
                "files": len(files),
                "skipped": [item["file"] for item in skipped],
            })
            return manifest

    def restore_snapshot(self, snapshot_id: str):
        self.require_steward()
        source = (self.snapshots_dir / snapshot_id).resolve()
        if source.parent != self.snapshots_dir.resolve() or not (source / "snapshot.json").exists():
            raise ValueError("没有找到这个系统快照")
        manifest = self._read(source / "snapshot.json", {})
        for relative in manifest.get("files", []):
            src = source / relative
            if src.is_file():
                dst = self.root / relative
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        self.audit("snapshot_restored", {"snapshot_id": snapshot_id})
        return {"ok": True, "summary": "已恢复系统快照 " + snapshot_id, "snapshot": manifest}

    def dynamic_skills(self):
        skills = []
        for directory in (self.bundled_skills_dir, self.skills_dir):
            for config_path in sorted(directory.glob("*/tool.json")):
                data = self._read(config_path, {})
                if data.get("name") and data.get("entrypoint"):
                    data["directory"] = str(config_path.parent.relative_to(self.root))
                    data["origin"] = "private" if directory == self.skills_dir else "bundled"
                    skills.append(data)
        return skills

    def skill_catalog(self):
        catalog = []
        dynamic_by_name = {item.get("name"): item for item in self.dynamic_skills()}
        for path in sorted(self.bundled_skills_dir.glob("*/SKILL.md")):
            text = path.read_text(encoding="utf-8", errors="replace")
            name_match = re.search(r"^name:\s*(.+)$", text, re.M)
            description_match = re.search(r"^description:\s*(.+)$", text, re.M)
            name = (name_match.group(1).strip() if name_match else path.parent.name)
            executable = dynamic_by_name.get(name)
            catalog.append({
                "name": name,
                "description": description_match.group(1).strip() if description_match else "",
                "origin": "bundled",
                "status": "installed",
                "kind": "executable" if executable else "guide",
                "permission": (executable or {}).get("permission") or ("steward" if name in {"build-skill", "manage-system"} else "normal"),
            })
        bundled_names = {item["name"] for item in catalog}
        for item in dynamic_by_name.values():
            if item.get("name") in bundled_names:
                continue
            catalog.append({
                "name": item.get("name"), "description": item.get("description", "实例私有 Skill"),
                "origin": item.get("origin", "private"), "status": "installed", "kind": "executable",
                "permission": item.get("permission", "normal"),
            })
        return catalog

    def execute_dynamic(self, name: str, arguments: dict):
        skill = next((item for item in self.dynamic_skills() if item.get("name") == name), None)
        if not skill:
            raise ValueError("没有找到动态 Skill：" + name)
        if skill.get("permission") == "steward":
            self.require_steward()
        skill_dir = self.root / skill["directory"]
        entrypoint = (skill_dir / skill["entrypoint"]).resolve()
        if skill_dir.resolve() not in entrypoint.parents or not entrypoint.is_file():
            raise ValueError("Skill 入口无效")
        completed = subprocess.run(
            [sys.executable, str(entrypoint)],
            input=json.dumps(arguments, ensure_ascii=False),
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=min(int(skill.get("timeout", 60)), 300),
        )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or completed.stdout or "Skill 执行失败")[-500:])
        try:
            result = json.loads(completed.stdout)
        except ValueError:
            result = {"ok": True, "summary": completed.stdout.strip()[:1000]}
        if not result.get("ok", True):
            raise RuntimeError(str(result.get("error") or result.get("summary") or "Skill 执行失败"))
        self.audit("dynamic_skill_executed", {"skill": name, "arguments": arguments, "result": result})
        return result

    def _safe_project_path(self, relative: str, must_exist=False):
        relative = str(relative or "").strip().replace("\\", "/")
        if not relative or relative.startswith("/") or relative.startswith(".") or ".." in Path(relative).parts:
            raise ValueError("文件路径必须位于小院项目内")
        path = (self.root / relative).resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError("文件路径越过了小院项目边界")
        if path.suffix.lower() not in TEXT_SUFFIXES:
            raise ValueError("掌院代理只能修改文本代码与配置文件")
        if any(part in {".git", "snapshots", "owner_data", "private_data"} for part in path.parts):
            raise ValueError("这个目录不允许由掌院代理修改")
        if must_exist and not path.is_file():
            raise ValueError("没有找到文件：" + relative)
        return path

    @staticmethod
    def _agent_json(raw):
        raw = raw[0] if isinstance(raw, tuple) else raw
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(raw or "").strip(), flags=re.I)
        try:
            value = json.loads(cleaned)
        except ValueError:
            match = re.search(r"\{[\s\S]*\}", cleaned)
            if not match:
                raise ValueError("掌院模型没有返回可执行 JSON")
            value = json.loads(match.group(0))
        if not isinstance(value, dict):
            raise ValueError("掌院模型返回格式不正确")
        return value

    def _agent_file_list(self, query=""):
        query = str(query or "").lower().strip()
        items = []
        for path in self.root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if any(part in {".git", "snapshots", "owner_data", "private_data", "__pycache__"} for part in path.parts):
                continue
            relative = str(path.relative_to(self.root))
            if query and query not in relative.lower():
                continue
            items.append({"path": relative, "bytes": path.stat().st_size})
        return items[:240]

    def _agent_search(self, query, path_hint=""):
        query = str(query or "").strip()
        if not query:
            raise ValueError("搜索词不能为空")
        matches = []
        for item in self._agent_file_list(path_hint):
            path = self.root / item["path"]
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for number, line in enumerate(lines, 1):
                if query.lower() in line.lower():
                    matches.append({"path": item["path"], "line": number, "text": line[:320]})
                    if len(matches) >= 80:
                        return matches
        return matches

    def _agent_read(self, relative, start=1, end=240):
        path = self._safe_project_path(relative, must_exist=True)
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(int(start or 1), 1)
        end = min(max(int(end or start + 239), start), start + 399, len(lines))
        return {"path": str(path.relative_to(self.root)), "start": start, "end": end,
                "content": "\n".join(f"{number:>5} {lines[number - 1]}" for number in range(start, end + 1))}

    def _validate_after_change(self):
        checks = []
        commands = [
            [sys.executable, "scripts/repository_readiness_test.py"],
            [sys.executable, "scripts/system_smoke_test.py"],
            [sys.executable, "scripts/skill_validation.py"],
        ]
        node = shutil.which("node")
        bundled_node = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
        if not node and bundled_node.is_file():
            node = str(bundled_node)
        if node:
            commands.insert(0, [node, "scripts/html_syntax_test.js"])
        env = dict(os.environ)
        env.setdefault("PYTHONPYCACHEPREFIX", "/tmp/cozy_pycache")
        for command in commands:
            completed = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=180, env=env)
            detail = (completed.stdout or completed.stderr or "ok").strip()[-1200:]
            checks.append({"command": " ".join(command[-2:]), "ok": completed.returncode == 0, "detail": detail})
            if completed.returncode != 0:
                return False, checks
        return True, checks

    def run_system_change(self, instruction: str, mode: str = "modify", execution_context=None):
        self.require_steward()
        instruction = str(instruction or "").strip()
        if not instruction:
            raise ValueError("系统修改说明不能为空")
        if not self.model_call:
            raise RuntimeError("没有配置可执行掌院修改的文本模型 API")
        task = self.task_start("掌院修改", "system_change", instruction)
        snapshot = self.create_snapshot(task["id"])
        self.task_update(task["id"], "running", "正在读取相关文件", snapshot_id=snapshot["id"])
        created = []
        changed = []
        transcript = []
        summary = ""
        system_rules = f"""你是栗壳小院内置的掌院代码代理，使用主人的文本模型 API 工作，不依赖 Codex。
目标：{instruction[:8000]}
主人相关偏好：{json.dumps(execution_context or {}, ensure_ascii=False)[:5000]}
技术边界：原生 HTML/CSS/JS 与 Python 标准库；保留现有交互风格；不要安装依赖；不要碰图片、私人数据、快照和 Git。
你每次只能返回一个 JSON 对象，并选择一个动作：
1. {{"action":"list","query":"可选路径关键词"}}
2. {{"action":"search","query":"精确搜索词","path_hint":"可选路径关键词"}}
3. {{"action":"read","path":"项目相对路径","start":1,"end":240}}
4. {{"action":"replace","path":"项目相对路径","old":"必须逐字匹配的原文","new":"替换后的完整文本"}}
5. {{"action":"write","path":"仅用于新建文本文件的项目相对路径","content":"完整内容"}}
6. {{"action":"finish","summary":"完成了什么"}}
先搜索和读取再改。replace 的 old 必须来自 read 结果，范围尽量小且唯一。不得删除文件。完成必要改动后 finish。"""
        try:
            for turn in range(24):
                prompt = system_rules + "\n\n动作记录：\n" + json.dumps(transcript[-14:], ensure_ascii=False)[:30000]
                action = self._agent_json(self.model_call(prompt))
                name = str(action.get("action") or "").lower()
                if name == "list":
                    result = self._agent_file_list(action.get("query"))
                elif name == "search":
                    result = self._agent_search(action.get("query"), action.get("path_hint"))
                elif name == "read":
                    result = self._agent_read(action.get("path"), action.get("start"), action.get("end"))
                elif name == "replace":
                    path = self._safe_project_path(action.get("path"), must_exist=True)
                    old = str(action.get("old") or "")
                    new = str(action.get("new") or "")
                    if not old or len(old) > 50000 or len(new) > 100000:
                        raise ValueError("替换内容为空或过大")
                    content = path.read_text(encoding="utf-8")
                    count = content.count(old)
                    if count != 1:
                        result = {"ok": False, "error": f"old 必须唯一匹配，当前匹配 {count} 次"}
                        transcript.append({"request": action, "result": result})
                        continue
                    path.write_text(content.replace(old, new, 1), encoding="utf-8")
                    relative = str(path.relative_to(self.root))
                    if relative not in changed:
                        changed.append(relative)
                    result = {"ok": True, "changed": relative}
                    self.task_update(task["id"], "running", "正在修改 " + relative, snapshot_id=snapshot["id"])
                elif name == "write":
                    path = self._safe_project_path(action.get("path"))
                    if path.exists():
                        raise ValueError("write 只能新建文件；已有文件请使用 replace")
                    content = str(action.get("content") or "")
                    if not content or len(content) > 150000:
                        raise ValueError("新文件内容为空或过大")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content, encoding="utf-8")
                    relative = str(path.relative_to(self.root))
                    created.append(relative)
                    changed.append(relative)
                    result = {"ok": True, "created": relative}
                elif name == "finish":
                    summary = str(action.get("summary") or "系统修改已完成")[:2000]
                    break
                else:
                    result = {"ok": False, "error": "不认识的动作"}
                transcript.append({"request": action, "result": result})
            else:
                raise RuntimeError("掌院代理超过最大操作轮数，已停止并回滚")
            if not changed:
                raise RuntimeError("掌院代理没有产生任何文件改动")
            self.task_update(task["id"], "running", "正在自动验证并准备回滚保护", snapshot_id=snapshot["id"])
            valid, checks = self._validate_after_change()
            if not valid:
                raise RuntimeError("自动验证失败：" + next(item["detail"] for item in checks if not item["ok"]))
            report = summary + "\n修改：" + "、".join(changed) + "\n验证：" + "；".join(item["detail"] for item in checks)
            self.task_update(task["id"], "completed", report[:2000], snapshot_id=snapshot["id"], changed_files=changed, checks=checks)
            self.audit("system_change_completed", {"task_id": task["id"], "snapshot_id": snapshot["id"], "instruction": instruction})
            return {"ok": True, "summary": "系统修改与验证已完成", "task_id": task["id"], "snapshot_id": snapshot["id"], "report": report[:5000]}
        except Exception as exc:
            for relative in created:
                try:
                    (self.root / relative).unlink()
                except OSError:
                    pass
            for relative in snapshot.get("files", []):
                src = self.snapshots_dir / snapshot["id"] / relative
                if src.is_file():
                    dst = self.root / relative
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
            detail = str(exc)[:1200]
            self.task_update(task["id"], "failed", detail, snapshot_id=snapshot["id"], rolled_back=True)
            self.audit("system_change_failed", {"task_id": task["id"], "snapshot_id": snapshot["id"], "error": detail, "rolled_back": True})
            raise

    def build_skill(self, name: str, purpose: str, example: str = ""):
        self.require_steward()
        slug = re.sub(r"[^a-z0-9-]+", "-", str(name or "").lower()).strip("-")[:50]
        if not slug:
            raise ValueError("Skill 名称需要使用英文或数字")
        instruction = (
            f"在 core/private_skills/{slug}/ 创建一个实例私有的可执行 Skill。用途：{purpose}. 示例任务：{example}. "
            "必须包含 SKILL.md、tool.json、scripts/run.py。tool.json 包含 name、description、arguments、entrypoint、permission、timeout。"
            "run.py 从 stdin 读取 JSON，输出带 ok 和 summary 的 JSON，只用 Python 标准库。实际运行一个示例验证。"
        )
        result = self.run_system_change(instruction, "build_skill")
        skill = next((item for item in self.dynamic_skills() if item.get("name") == slug), None)
        if not skill:
            raise RuntimeError("Skill 文件已生成，但注册检查没有通过")
        return {**result, "summary": f"已创建并验证 Skill：“{slug}”", "skill": skill}
