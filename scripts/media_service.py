#!/usr/bin/env python3
"""Persistent image and video generation task service."""

from __future__ import annotations

import base64
import json
import re
import threading
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path


class MediaService:
    def __init__(self, root: Path, gateway):
        self.root = root
        self.gateway = gateway
        self.path = root / "core/generation_tasks.json"
        self.lock = threading.RLock()
        if not self.path.exists():
            self._write({"version": 1, "tasks": []})

    @staticmethod
    def now():
        return datetime.now().astimezone().isoformat(timespec="seconds")

    def _read(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeError):
            data = {"version": 1, "tasks": []}
        if not isinstance(data.get("tasks"), list):
            data["tasks"] = []
        return data

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.path)

    def _create(self, kind, provider, prompt, options):
        with self.lock:
            data = self._read()
            task = {
                "id": "gen_" + uuid.uuid4().hex[:14],
                "kind": kind,
                "provider": provider,
                "prompt": str(prompt)[:4000],
                "options": {key: value for key, value in options.items() if key not in {"images", "videos", "audios"}},
                "status": "running",
                "created_at": self.now(),
                "updated_at": self.now(),
                "outputs": [],
            }
            data["tasks"].insert(0, task)
            data["tasks"] = data["tasks"][:200]
            self._write(data)
            return dict(task)

    def _update(self, task_id, **changes):
        with self.lock:
            data = self._read()
            task = next((item for item in data["tasks"] if item.get("id") == task_id), None)
            if not task:
                raise ValueError("没有找到这个生成任务")
            task.update(changes)
            task["updated_at"] = self.now()
            self._write(data)
            return dict(task)

    def get(self, task_id):
        task = next((item for item in self._read()["tasks"] if item.get("id") == str(task_id)), None)
        if not task:
            raise ValueError("没有找到这个生成任务")
        return dict(task)

    def list(self, limit=30):
        return self._read()["tasks"][:max(1, min(int(limit), 100))]

    @staticmethod
    def _extension(output_format, mime=""):
        value = str(output_format or "").lower()
        if "jpeg" in mime or value in {"jpg", "jpeg"}:
            return ".jpg"
        if "webp" in mime or value == "webp":
            return ".webp"
        if "mp4" in mime or value == "mp4":
            return ".mp4"
        return ".png"

    def _download(self, url, destination, max_bytes):
        request = urllib.request.Request(str(url), headers={"User-Agent": "CozyEstate/1.0"})
        with urllib.request.urlopen(request, timeout=180) as response:
            content = response.read(max_bytes + 1)
            mime = response.headers.get_content_type()
        if len(content) > max_bytes:
            raise RuntimeError("生成文件超过本地保存上限")
        destination.write_bytes(content)
        return mime

    def _save_images(self, task_id, data, output_format):
        folder = self.root / "assets/generated/images"
        folder.mkdir(parents=True, exist_ok=True)
        outputs = []
        for index, item in enumerate(data[:15]):
            extension = self._extension(output_format, str(item.get("mime_type") or ""))
            destination = folder / f"{task_id}-{index + 1}{extension}"
            if item.get("b64_json"):
                raw = base64.b64decode(str(item["b64_json"]), validate=True)
                if len(raw) > 30 * 1024 * 1024:
                    raise RuntimeError("生成图片超过 30MB")
                destination.write_bytes(raw)
            elif item.get("url"):
                mime = self._download(item["url"], destination, 30 * 1024 * 1024)
                actual_extension = self._extension(output_format, mime)
                if actual_extension != destination.suffix:
                    renamed = destination.with_suffix(actual_extension)
                    destination.replace(renamed)
                    destination = renamed
            else:
                continue
            outputs.append({"file": destination.relative_to(self.root).as_posix(), "revised_prompt": item.get("revised_prompt", "")})
        return outputs

    def generate_image(self, payload):
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("图片提示词不能为空")
        provider = str(payload.get("provider") or "seedream").lower()
        options = {key: value for key, value in payload.items() if key not in {"prompt", "provider", "kind"}}
        task = self._create("image", provider, prompt, options)
        try:
            result = self.gateway.generate_image(prompt, provider, **options)
            outputs = self._save_images(task["id"], result.get("data") or [], options.get("output_format") or "png")
            if not outputs:
                raise RuntimeError("图片接口返回成功，但没有可保存的图片")
            return self._update(task["id"], status="succeeded", model=result.get("model"), outputs=outputs,
                                usage=result.get("usage") or {})
        except Exception as exc:
            self._update(task["id"], status="failed", error=str(exc)[:600])
            raise

    def create_video(self, payload):
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("视频提示词不能为空")
        provider = str(payload.get("provider") or "seedance").lower()
        options = {key: value for key, value in payload.items() if key not in {"prompt", "provider", "kind"}}
        task = self._create("video", provider, prompt, options)
        try:
            result = self.gateway.create_video(prompt, provider, **options)
            return self._update(task["id"], status=result.get("status") or "queued", remote_id=result["remote_id"],
                                model=result.get("model"))
        except Exception as exc:
            self._update(task["id"], status="failed", error=str(exc)[:600])
            raise

    def refresh_video(self, task_id):
        task = self.get(task_id)
        if task.get("kind") != "video" or not task.get("remote_id"):
            raise ValueError("这不是可查询的 Seedance 视频任务")
        if task.get("status") in {"succeeded", "failed", "cancelled"}:
            return task
        result = self.gateway.get_video_task(task["remote_id"])
        changes = {key: result.get(key) for key in ("status", "error", "usage", "duration", "ratio", "resolution") if result.get(key) is not None}
        video_url = str(result.get("video_url") or "")
        if result.get("status") == "succeeded" and video_url:
            folder = self.root / "assets/generated/videos"
            folder.mkdir(parents=True, exist_ok=True)
            destination = folder / f"{task['id']}.mp4"
            if not destination.exists():
                self._download(video_url, destination, 250 * 1024 * 1024)
            changes["outputs"] = [{"file": destination.relative_to(self.root).as_posix()}]
        return self._update(task["id"], **changes)

    def status(self):
        tasks = self._read()["tasks"]
        return {
            "providers": self.gateway.status(),
            "tasks": tasks[:20],
            "counts": {status: sum(1 for item in tasks if item.get("status") == status)
                       for status in ("running", "queued", "succeeded", "failed")},
        }
