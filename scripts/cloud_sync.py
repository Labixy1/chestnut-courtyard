#!/usr/bin/env python3
"""Migrate or restore Cozy Estate state with the owner cloud as authority."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_FILES = (
    "estate_state", "heart_hollow", "private_wing", "manifest", "notice_reports",
    "butler_sources", "butler_state", "daily_questions", "permissions",
    "automation_state", "local_state", "weather_cache", "generation_tasks", "tasks", "audit_log",
)


def load_env() -> dict[str, str]:
    values = dict(os.environ)
    for path in (ROOT / ".env", ROOT / "cloudflare" / ".dev.vars"):
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return values


def settings() -> tuple[str, str]:
    env = load_env()
    base = env.get("COZY_CLOUD_URL", "https://dcxin.neuralnode.top").rstrip("/")
    secret = env.get("COZY_SYNC_SECRET", "")
    if not secret:
        raise RuntimeError("COZY_SYNC_SECRET 尚未配置")
    return base, secret


def request(path: str, payload=None):
    base, secret = settings()
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base + path,
        data=body,
        headers={"accept": "application/json", "content-type": "application/json", "x-cozy-sync-key": secret},
        method="GET" if payload is None else "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8")).get("error", "")
        except Exception:
            detail = ""
        raise RuntimeError(detail or f"云端返回 HTTP {error.code}") from error


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return fallback


def unwrap_items(path: Path):
    value = read_json(path, {"items": []})
    return value.get("items", []) if isinstance(value, dict) else value


def local_payload() -> dict:
    data = {}
    for key in DATA_FILES:
        path = ROOT / "core" / f"{key}.json"
        if path.exists():
            value = read_json(path, None)
            if isinstance(value, dict):
                data[key] = value
    memory = {
        "memory:events": unwrap_items(ROOT / "core/memory/events.json"),
        "memory:sealed": unwrap_items(ROOT / "core/memory/sealed.json"),
        "memory:profile": read_json(ROOT / "core/memory/profile.json", None),
        "memory:categories": unwrap_items(ROOT / "core/memory/categories.json"),
        "memory:distillation": read_json(ROOT / "core/memory/distillation.json", None),
    }
    return {"version": 1, "data": data, "memory": {key: value for key, value in memory.items() if value is not None}}


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp = Path(handle.name)
    temp.replace(path)


def pull() -> None:
    snapshot = request("/api/sync/export")
    for key, value in (snapshot.get("data") or {}).items():
        if key in DATA_FILES and isinstance(value, dict):
            atomic_json(ROOT / "core" / f"{key}.json", value)
    memory = snapshot.get("memory") or {}
    wrappers = {
        "memory:events": "events.json", "memory:sealed": "sealed.json", "memory:categories": "categories.json"
    }
    for key, filename in wrappers.items():
        if isinstance(memory.get(key), list):
            atomic_json(ROOT / "core/memory" / filename, {"version": 1, "items": memory[key]})
    if isinstance(memory.get("memory:profile"), dict):
        atomic_json(ROOT / "core/memory/profile.json", memory["memory:profile"])
    if isinstance(memory.get("memory:distillation"), dict):
        atomic_json(ROOT / "core/memory/distillation.json", memory["memory:distillation"])
    from ingest import rebuild_data_js
    rebuild_data_js()
    print(f"已从主人云端恢复到本地：{snapshot.get('exported_at', '未知时间')}")


def main() -> None:
    parser = argparse.ArgumentParser(description="栗壳小院主人云端同步")
    parser.add_argument("action", choices=("status", "push", "pull", "backup"))
    parser.add_argument("--confirm-cloud-overwrite", action="store_true")
    args = parser.parse_args()
    if args.action == "status":
        status = request("/api/status")
        print(json.dumps({"service": status.get("service"), "storage": status.get("storage"), "backup": status.get("backup")}, ensure_ascii=False, indent=2))
    elif args.action == "push":
        if not args.confirm_cloud_overwrite:
            raise SystemExit("推送会覆盖主人云端同名数据，请增加 --confirm-cloud-overwrite")
        result = request("/api/sync/import", local_payload())
        print(f"已迁移到主人云端：{len(result.get('imported', []))} 个数据区")
    elif args.action == "pull":
        pull()
    else:
        result = request("/api/backup/run", {})
        print(json.dumps(result.get("backup", {}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
