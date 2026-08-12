#!/usr/bin/env python3
"""Exercise the live local service without leaving verification data behind."""

from __future__ import annotations

import base64
import json
import os
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("COZY_BASE_URL", "http://127.0.0.1:8766").rstrip("/")
PNG_1PX = base64.b64encode(
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDAT\x08\xd7c\xf8"
    b"\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
).decode("ascii")


def request(path, payload=None, timeout=30, require_ok=True):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        result = json.loads(response.read().decode("utf-8"))
    if require_ok:
        assert result.get("ok"), result
    return result


def main():
    local_path = ROOT / "core/local_state.json"
    estate_path = ROOT / "core/estate_state.json"
    bundle_path = ROOT / "core/data.js"
    backups = {path: path.read_bytes() for path in (local_path, estate_path, bundle_path)}
    created = None
    try:
        health = request("/api/health", require_ok=False)
        assert health["checks"]["required_files"] and health["checks"]["json_valid"]

        providers = request("/api/providers")["providers"]
        assert "seedream" in providers["image"] and "nano_banana" in providers["image"] and "seedance" in providers["video"]
        media_status = request("/api/media/tasks")
        assert "providers" in media_status and "counts" in media_status

        weather = request("/api/weather")
        assert weather["current"]["scene"] in {"sunny", "morning", "snow", "rain", "thunder", "overcast", "fog"}
        assert weather["location"].get("city")

        automation = request("/api/automation")["automation"]
        assert automation["jobs"]["weekly_report"]["schedule"] == "每周一、周三、周五 08:00"
        assert automation["jobs"]["weekly_report"].get("next_run")

        distillation = request("/api/memory/distillation")["distillation"]
        assert "每天 23:30" in distillation.get("schedule", "")
        assert distillation.get("status") in {"idle", "queued", "running", "completed", "failed", "restored"}

        first = request("/api/blackboard/today")["question"]
        second = request("/api/blackboard/today")["question"]
        assert first["date"] == second["date"] and first["question"] == second["question"]
        assert first.get("alignment_version") == 4
        if first.get("source_title"):
            assert first["source_title"] in first["question"]
            assert first["source_title"] in " ".join(first.get("materials", []))
            if "Daybreak" in first["source_title"]:
                joined_materials = " ".join(first.get("materials", []))
                assert "网络安全" in joined_materials and "漏洞" in joined_materials

        pending_id = "service_smoke_pending"
        state = request("/api/local-state")["state"]
        values = state.setdefault("values", {})
        star_key = "service-smoke-star"
        request("/api/local-state", {"values": {"cozy_blackboard_starred": [star_key]}})
        synced_stars = request("/api/local-state")["state"]["values"].get("cozy_blackboard_starred", [])
        assert synced_stars == [star_key]
        buried = [item for item in values.get("cozy_hollow_buried_media", []) if item.get("id") != pending_id]
        buried.insert(0, {"id": pending_id, "kind": "image", "status": "pending", "title": "验证"})
        request("/api/local-state", {"values": {"cozy_hollow_buried_media": buried}})

        uploaded = request("/api/media/upload", {
            "kind": "tree_hollow",
            "replace_id": pending_id,
            "title": "服务验证图片",
            "data_url": "data:image/png;base64," + PNG_1PX,
        })
        created = ROOT / uploaded["item"]["file"]
        server_items = uploaded["local_state"]["values"]["cozy_hollow_buried_media"]
        assert created.exists()
        assert not any(item.get("id") == pending_id for item in server_items)
        assert sum(item.get("id") == uploaded["item"]["id"] for item in server_items) == 1

        weekly = request("/api/weekly/run", {"force": False}, timeout=30)
        assert weekly["automation"]["jobs"]["weekly_report"]["status"] in {"ready", "completed"}
    finally:
        if created and created.exists():
            created.unlink()
        for path, content in backups.items():
            path.write_bytes(content)
    print("service smoke test ok: health; providers; media tasks; weather; daily question; starred sync; upload; weekly readiness")


if __name__ == "__main__":
    main()
