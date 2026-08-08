#!/usr/bin/env python3
"""Permission, task, snapshot, dynamic skill, and system-change runtime."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from datetime import datetime
from pathlib import Path


TEXT_SUFFIXES = {".html", ".css", ".js", ".py", ".json", ".txt", ".md", ".yaml", ".yml", ".sh", ".command", ".swift", ".plist"}


class SystemRuntime:
    def __init__(self, root: Path, codex_candidates: list[str | None]):
        self.root = root
        self.codex_candidates = codex_candidates
        self.lock = threading.RLock()
        self.permission_path = root / "core/permissions.json"
        self.tasks_path = root / "core/tasks.json"
        self.audit_path = root / "core/audit_log.json"
        self.snapshots_dir = root / "core/snapshots"
        self.skills_dir = root / "core/private_skills"
        self.bundled_skills_dir = root / "core/skills"
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
                if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                    continue
                if self.snapshots_dir in path.parents or ".git" in path.parts:
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

    def _codex_binary(self):
        return next((str(path) for path in self.codex_candidates if path and Path(path).exists()), None)

    def run_system_change(self, instruction: str, mode: str = "modify", execution_context=None):
        self.require_steward()
        instruction = str(instruction or "").strip()
        if not instruction:
            raise ValueError("系统修改说明不能为空")
        binary = self._codex_binary()
        if not binary:
            raise RuntimeError("没有找到可执行系统修改的 Codex")
        task = self.task_start("掌院修改", "system_change", instruction)
        snapshot = self.create_snapshot(task["id"])
        self.task_update(task["id"], "running", "正在修改并验证", snapshot_id=snapshot["id"])
        with tempfile.NamedTemporaryFile(prefix="cozy_system_", suffix=".txt", delete=False) as tmp:
            output_path = Path(tmp.name)
        prompt = f"""你是栗壳小院的系统维护代理。主人已在密阁永久开启掌院权限。
只处理下面明确任务，保留现有原生 HTML/CSS/JS 和 Python 标准库架构，遵守 AGENTS.md，不引入构建工具。
修改前先阅读相关文件；完成后运行必要测试。不要删除用户数据，不要改 assets 图片，不要修改 core/snapshots。
主人已确认的执行偏好（只影响未明确指定的细节，当前任务要求始终优先）：
{json.dumps(execution_context or {}, ensure_ascii=False)[:6000]}
任务：{instruction[:8000]}
最后简短报告修改文件和验证结果。"""
        command = [
            binary, "exec", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write",
            "-C", str(self.root), "--output-last-message", str(output_path), prompt,
        ]
        try:
            completed = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL)
            report = output_path.read_text(encoding="utf-8", errors="replace").strip() if output_path.exists() else ""
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or report or "系统修改失败")[-1000:]
                self.task_update(task["id"], "failed", detail, snapshot_id=snapshot["id"])
                self.audit("system_change_failed", {"task_id": task["id"], "snapshot_id": snapshot["id"], "error": detail})
                raise RuntimeError(detail)
            self.task_update(task["id"], "completed", report or "系统修改已完成", snapshot_id=snapshot["id"])
            self.audit("system_change_completed", {"task_id": task["id"], "snapshot_id": snapshot["id"], "instruction": instruction})
            return {"ok": True, "summary": "系统修改与验证已完成", "task_id": task["id"], "snapshot_id": snapshot["id"], "report": report[:5000]}
        finally:
            try:
                output_path.unlink()
            except OSError:
                pass

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
