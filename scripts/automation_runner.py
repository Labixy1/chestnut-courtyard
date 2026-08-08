#!/usr/bin/env python3
"""Small in-process scheduler for weekly reports and memory maintenance."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path


class AutomationRunner:
    REPORT_DAYS = (0, 2, 5)  # Monday, Wednesday, Saturday
    REPORT_HOUR = 8
    def __init__(self, root: Path, memory_store, memory_distiller=None):
        self.root = root
        self.memory_store = memory_store
        self.memory_distiller = memory_distiller
        self.path = root / "core/automation_state.json"
        self.stop_event = threading.Event()
        self.thread = None
        self.distillation_thread = None
        self.distillation_lock = threading.Lock()
        if not self.path.exists():
            self._write({"version": 1, "last_check": "", "jobs": {}})

    @staticmethod
    def now():
        return datetime.now().astimezone().isoformat(timespec="seconds")

    def _read(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"version": 1, "last_check": "", "jobs": {}}

    def _write(self, data):
        temp = self.path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.path)

    @staticmethod
    def week_id(today=None):
        today = today or date.today()
        monday = today - timedelta(days=today.weekday())
        return "week_" + monday.isoformat()

    def _has_current_report(self):
        try:
            reports = json.loads((self.root / "core/notice_reports.json").read_text(encoding="utf-8")).get("reports", [])
        except (OSError, ValueError):
            return False
        current = self.week_id()
        return any(report.get("id") == current for report in reports)

    def _record(self, name, status, message=""):
        state = self._read()
        state["last_check"] = self.now()
        job = state.setdefault("jobs", {}).setdefault(name, {})
        job.update({"status": status, "message": message[-1000:], "updated_at": self.now()})
        self._write(state)

    @classmethod
    def latest_scheduled_run(cls, now=None):
        now = now or datetime.now().astimezone()
        candidates = []
        for offset in range(8):
            day = now.date() - timedelta(days=offset)
            if day.weekday() in cls.REPORT_DAYS:
                candidates.append(datetime.combine(day, datetime.min.time(), tzinfo=now.tzinfo).replace(hour=cls.REPORT_HOUR))
        return max(candidate for candidate in candidates if candidate <= now)

    def next_weekly_run(self, now=None):
        now = now or datetime.now().astimezone()
        candidates = []
        for offset in range(8):
            day = now.date() + timedelta(days=offset)
            if day.weekday() in self.REPORT_DAYS:
                candidate = datetime.combine(day, datetime.min.time(), tzinfo=now.tzinfo).replace(hour=self.REPORT_HOUR)
                if candidate > now:
                    candidates.append(candidate)
        return min(candidates)

    def _scheduled_weekly_due(self, now=None):
        now = now or datetime.now().astimezone()
        scheduled = self.latest_scheduled_run(now)
        state = self._read()
        last_date = str(state.get("jobs", {}).get("weekly_report", {}).get("last_scheduled_date") or "")
        return last_date != scheduled.date().isoformat(), scheduled

    def run_scheduled_weekly(self, now=None):
        now = now or datetime.now().astimezone()
        due, scheduled = self._scheduled_weekly_due(now)
        if not due:
            return False
        self.run_weekly(force=True)
        state = self._read()
        job = state.setdefault("jobs", {}).setdefault("weekly_report", {})
        if job.get("status") != "failed":
            job["last_scheduled_date"] = scheduled.date().isoformat()
            job["scheduled_at"] = scheduled.isoformat(timespec="minutes")
        job["next_run"] = self.next_weekly_run(now).isoformat(timespec="minutes")
        self._write(state)
        return job.get("status") != "failed"

    def run_weekly(self, force=False):
        if self._has_current_report() and not force:
            self._record("weekly_report", "ready", "本周周报已存在")
            return
        self._record("weekly_report", "running", "阿栗正在巡逻本周资讯")
        try:
            completed = subprocess.run(
                [sys.executable, str(self.root / "scripts/butler_weekly.py")],
                cwd=self.root, capture_output=True, text=True, timeout=360,
            )
            if completed.returncode != 0:
                raise RuntimeError((completed.stderr or completed.stdout or "周报生成失败")[-800:])
            self._record("weekly_report", "completed", "本周周报已生成")
        except Exception as exc:
            self._record("weekly_report", "failed", str(exc))

    def resolve_notice_requests(self):
        local_path = self.root / "core/local_state.json"
        try:
            local = json.loads(local_path.read_text(encoding="utf-8"))
            reports = json.loads((self.root / "core/notice_reports.json").read_text(encoding="utf-8")).get("reports", [])
        except (OSError, ValueError):
            self._record("notice_followups", "failed", "留言或周报数据无法读取")
            return
        requests = local.setdefault("values", {}).get("cozy_notice_requests", [])
        if not isinstance(requests, list):
            return
        pool = []
        for report in reports[:8]:
            pool.extend(report.get("hot_items", []))
            for section in report.get("sections", []):
                pool.extend(section.get("items", []))
        changed = 0
        today = date.today().isoformat()
        for request in requests:
            if request.get("found_items") or not request.get("date") or request.get("date") >= today:
                continue
            if request.get("kind") not in {"watch_topic", "link", "toolbox"}:
                continue
            text = str(request.get("text") or "")
            urls = re.findall(r"https?://[^\s，。；、)）]+", text)
            tokens = [token.lower() for token in re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.-]{3,}", text)][:12]
            scored = []
            for item in pool:
                haystack = " ".join(str(item.get(key) or "") for key in ("title", "summary", "ai_summary", "main_takeaway", "link", "url")).lower()
                score = 100 if any(url.rstrip("/").lower() in haystack for url in urls) else sum(5 for token in tokens if token in haystack)
                if score:
                    scored.append((score, item))
            found = []
            seen = set()
            for _score, item in sorted(scored, key=lambda pair: pair[0], reverse=True):
                marker = str(item.get("link") or item.get("url") or item.get("title") or "")
                if not marker or marker in seen:
                    continue
                seen.add(marker)
                found.append({
                    "title": item.get("title", ""), "summary": item.get("summary", ""),
                    "ai_summary": item.get("ai_summary") or item.get("main_takeaway", ""),
                    "media": item.get("media", ""), "published": item.get("published", ""),
                    "category": item.get("notice_tag") or item.get("category", ""),
                    "link": item.get("link") or item.get("url", ""),
                })
                if len(found) >= 3:
                    break
            if found:
                request["found_items"] = found
                request["found_at"] = self.now()
                changed += 1
        if changed:
            local["updated_at"] = self.now()
            temp = local_path.with_suffix(".json.tmp")
            temp.write_text(json.dumps(local, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temp.replace(local_path)
        self._record("notice_followups", "completed", "已回填 %d 条留言找到的真实资料" % changed)

    def run_memory_distillation(self, force=False):
        if not self.memory_distiller:
            return False
        with self.distillation_lock:
            if self.distillation_thread and self.distillation_thread.is_alive():
                return False
            if not force and not self.memory_distiller.should_run():
                return False
            self._record("memory_distillation", "running", "阿栗正在整理个人记忆档案")
            self.memory_distiller.queue()

            def work():
                try:
                    result = self.memory_distiller.run(force=force)
                    if result.get("status") == "skipped":
                        self._record("memory_distillation", "ready", result.get("summary", "记忆暂无变化"))
                    else:
                        self._record("memory_distillation", "completed", result.get("summary", "个人记忆档案已更新"))
                except Exception as exc:
                    self._record("memory_distillation", "failed", str(exc))

            self.distillation_thread = threading.Thread(target=work, daemon=True, name="cozy-memory-distillation")
            self.distillation_thread.start()
            return True

    def tick(self, now=None):
        now = now or datetime.now().astimezone()
        state = self._read()
        memory_job = state.get("jobs", {}).get("memory_maintenance", {})
        if str(memory_job.get("updated_at") or "")[:10] != now.date().isoformat():
            self.memory_store.prune_short()
            self._record("memory_maintenance", "completed", "短期记忆已按保留期整理")
        self.run_scheduled_weekly(now)
        notice_job = self._read().get("jobs", {}).get("notice_followups", {})
        try:
            notice_age = (now - datetime.fromisoformat(str(notice_job.get("updated_at") or ""))).total_seconds()
        except (TypeError, ValueError):
            notice_age = 3601
        if notice_age >= 3600:
            self.resolve_notice_requests()
        if self.memory_distiller and self.memory_distiller.should_run(now):
            self.run_memory_distillation(force=False)

    def _loop(self):
        time.sleep(3)
        while not self.stop_event.is_set():
            self.tick()
            self.stop_event.wait(60)

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._loop, daemon=True, name="cozy-automation")
        self.thread.start()

    def status(self):
        state = self._read()
        job = state.setdefault("jobs", {}).setdefault("weekly_report", {})
        job["schedule"] = "每周一、周三、周六 08:00"
        job["next_run"] = self.next_weekly_run().isoformat(timespec="minutes")
        if self.memory_distiller:
            distillation = state.setdefault("jobs", {}).setdefault("memory_distillation", {})
            distillation["schedule"] = self.memory_distiller.status().get("schedule", "每天 23:30，或累计足够新证据后")
            distillation["engine"] = self.memory_distiller.status()
        return state

    def stop(self):
        self.stop_event.set()
