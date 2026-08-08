#!/usr/bin/env python3
"""Organize task items into a deterministic pending checklist."""

from __future__ import annotations

import hashlib
import json
import re
import sys


def emit(payload: dict, status: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    raise SystemExit(status)


def normalize_title(value) -> str:
    if isinstance(value, dict):
        for key in ("title", "text", "name", "content"):
            text = str(value.get(key) or "").strip()
            if text:
                return re.sub(r"\s+", " ", text)
        return ""
    text = str(value or "").strip()
    return re.sub(r"\s+", " ", text)


def stable_id(title: str, occurrence: int) -> str:
    normalized = title.casefold()
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:10]
    suffix = "" if occurrence == 1 else "_%d" % occurrence
    return "chk_%s%s" % (digest, suffix)


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        emit({"ok": False, "summary": "缺少 JSON 输入", "error": "empty_input"}, 1)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit({"ok": False, "summary": "输入不是有效 JSON", "error": str(exc)}, 1)

    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        emit({"ok": False, "summary": "items 必须是数组", "error": "items_must_be_array"}, 1)

    checklist = []
    seen = {}
    for item in items:
        title = normalize_title(item)
        if not title:
            continue
        key = title.casefold()
        seen[key] = seen.get(key, 0) + 1
        checklist.append({
            "id": stable_id(title, seen[key]),
            "order": len(checklist) + 1,
            "title": title,
            "status": "pending",
        })

    emit({
        "ok": True,
        "summary": "已整理 %d 条任务为 pending 清单" % len(checklist),
        "count": len(checklist),
        "checklist": checklist,
    })


if __name__ == "__main__":
    main()
