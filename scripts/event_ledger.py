#!/usr/bin/env python3
"""Append-only interaction ledger, deliberately separate from memory."""

from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path


SEALED_CONTEXTS = {"heart_hollow", "private_wing", "memory_nook"}


class EventLedger:
    def __init__(self, root: Path):
        self.directory = root / "core/ledger"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    @staticmethod
    def now():
        return datetime.now().astimezone().isoformat(timespec="milliseconds")

    @staticmethod
    def _clean(value, limit):
        return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]

    def append(self, event):
        raw = event if isinstance(event, dict) else {}
        now = self.now()
        context = self._clean(raw.get("context") or raw.get("ctx") or "unknown", 60)
        item = {
            "id": self._clean(raw.get("id"), 80) or "evt_" + uuid.uuid4().hex[:16],
            "ts": self._clean(raw.get("ts"), 40) or now,
            "received_at": now,
            "context": context,
            "action": self._clean(raw.get("action") or raw.get("act") or "event", 100),
            "page": self._clean(raw.get("page"), 300),
            "status": self._clean(raw.get("status"), 40),
            "task_id": self._clean(raw.get("task_id"), 100),
            "sensitivity": "sealed" if context in SEALED_CONTEXTS or raw.get("sensitivity") == "sealed" else "personal",
        }
        detail = raw.get("detail")
        if isinstance(detail, dict):
            item["detail"] = {self._clean(key, 80): self._clean(value, 500)
                              for key, value in list(detail.items())[:20]
                              if key not in {"content", "transcript", "message", "prompt", "api_key", "token"}}
        path = self.directory / (now[:7] + ".log.jsonl")
        line = json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self.lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line)
                handle.flush()
        return item

    def append_many(self, events):
        return [self.append(event) for event in list(events or [])[:100]]
