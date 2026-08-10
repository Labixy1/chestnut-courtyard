#!/usr/bin/env python3
"""Migrate or restore Cozy Estate state with the owner cloud as authority."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
import re
import shutil
import subprocess
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
MEMORY_KEYS = ("memory:events", "memory:sealed", "memory:profile", "memory:categories", "memory:overrides", "memory:distillation")
WRANGLER_CONFIG = ROOT / "cloudflare" / "wrangler.toml"


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


def wrangler_namespaces() -> tuple[str, str]:
    text = WRANGLER_CONFIG.read_text(encoding="utf-8")
    pairs = dict(re.findall(r'binding\s*=\s*"([^"]+)"\s*\n\s*id\s*=\s*"([^"]+)"', text))
    primary, backup = pairs.get("COZY_STATE", ""), pairs.get("COZY_BACKUP", "")
    if not primary or not backup:
        raise RuntimeError("wrangler.toml 缺少 COZY_STATE 或 COZY_BACKUP 命名空间")
    return primary, backup


def wrangler_command() -> list[str]:
    env = load_env()
    explicit = env.get("COZY_WRANGLER_JS", "")
    candidates = [Path(explicit)] if explicit else []
    candidates.extend(sorted(Path.home().glob(".npm/_npx/*/node_modules/wrangler/bin/wrangler.js"), reverse=True))
    script = next((path for path in candidates if path.is_file()), None)
    node_candidates = [Path(env.get("COZY_NODE", ""))] if env.get("COZY_NODE") else []
    if shutil.which("node"):
        node_candidates.append(Path(shutil.which("node")))
    node_candidates.append(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
    node = next((path for path in node_candidates if path.is_file()), None)
    if script and node:
        return [str(node), str(script)]
    executable = shutil.which("wrangler")
    if executable:
        return [executable]
    raise RuntimeError("没有找到 Wrangler。请先运行 npx wrangler login，或配置 COZY_WRANGLER_JS 与 COZY_NODE")


def wrangler_run(*args: str) -> str:
    command = [*wrangler_command(), *args, "--config", str(WRANGLER_CONFIG)]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180)
    if completed.returncode:
        raise RuntimeError((completed.stderr or completed.stdout or "Wrangler 执行失败")[-1200:])
    return completed.stdout.strip()


def kv_get(namespace: str, key: str):
    output = wrangler_run("kv", "key", "get", key, "--namespace-id", namespace, "--remote", "--text")
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"KV 键 {key} 不是合法 JSON") from error


def kv_put(namespace: str, key: str, value) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        path = Path(handle.name)
    try:
        wrangler_run("kv", "key", "put", key, "--path", str(path), "--namespace-id", namespace, "--remote")
    finally:
        path.unlink(missing_ok=True)


def wrangler_snapshot() -> dict:
    primary, _backup = wrangler_namespaces()
    data = {}
    for key in DATA_FILES:
        value = kv_get(primary, f"data:{key}")
        if isinstance(value, dict):
            data[key] = value
    memory = {}
    for key in MEMORY_KEYS:
        value = kv_get(primary, key)
        if value is not None:
            memory[key] = value
    return {"version": 1, "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"), "data": data, "memory": memory}


def wrangler_backup(reason: str = "manual") -> dict:
    _primary, backup = wrangler_namespaces()
    snapshot = wrangler_snapshot()
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    key = f"full-snapshots/{reason}/{stamp}.json"
    kv_put(backup, key, snapshot)
    return {"ok": True, "storage": "backup-kv", "key": key, "exported_at": snapshot["exported_at"]}


def wrangler_push() -> list[str]:
    primary, _backup = wrangler_namespaces()
    payload = local_payload()
    wrangler_backup("before-import")
    imported = []
    for key, value in payload["data"].items():
        kv_put(primary, f"data:{key}", value)
        imported.append(key)
    for key, value in payload["memory"].items():
        kv_put(primary, key, value)
        imported.append(key)
    kv_put(primary, "sync:last_import", {"at": datetime.now().astimezone().isoformat(timespec="seconds"), "imported": imported, "transport": "wrangler"})
    return imported


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


def restore_snapshot(snapshot: dict) -> None:
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


def pull() -> None:
    restore_snapshot(request("/api/sync/export"))


def main() -> None:
    parser = argparse.ArgumentParser(description="栗壳小院主人云端同步")
    parser.add_argument("action", choices=("status", "push", "pull", "backup"))
    parser.add_argument("--transport", choices=("http", "wrangler"), default="http", help="公司网络拦截 HTTPS 时使用 wrangler")
    parser.add_argument("--confirm-cloud-overwrite", action="store_true")
    args = parser.parse_args()
    if args.transport == "wrangler" and args.action == "status":
        primary, _backup = wrangler_namespaces()
        local_state = kv_get(primary, "data:local_state") or {}
        backup = kv_get(primary, "backup:status") or {}
        print(json.dumps({"service": "cozy-estate-owner", "storage": {"kv": True}, "local_state_updated_at": local_state.get("updated_at", ""), "backup": backup}, ensure_ascii=False, indent=2))
    elif args.transport == "wrangler" and args.action == "pull":
        restore_snapshot(wrangler_snapshot())
    elif args.transport == "wrangler" and args.action == "backup":
        print(json.dumps(wrangler_backup(), ensure_ascii=False, indent=2))
    elif args.transport == "wrangler" and args.action == "push":
        if not args.confirm_cloud_overwrite:
            raise SystemExit("推送会覆盖主人云端同名数据，请增加 --confirm-cloud-overwrite")
        imported = wrangler_push()
        print(f"已通过 Wrangler 迁移到主人云端：{len(imported)} 个数据区")
    elif args.action == "status":
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
