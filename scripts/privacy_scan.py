#!/usr/bin/env python3
"""Fail a release when private instance data or obvious secrets can enter Git."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PRIVATE_PATHS = {
    ".env", ".wrangler", "dist", "core/data.js", "core/logs", "core/runtime",
    "core/snapshots", "core/ledger", "core/memory", "core/audit_log.json",
    "core/automation_state.json", "core/butler_sources.json", "core/butler_state.json",
    "core/daily_questions.json", "core/estate_state.json", "core/generation_tasks.json",
    "core/heart_hollow.json", "core/local_state.json", "core/manifest.json",
    "core/notice_reports.json", "core/permissions.json", "core/private_wing.json",
    "core/private_skills",
    "core/skill_health.json", "core/tasks.json", "core/user_profile.yaml",
    "core/user_profile_runtime.yaml", "core/weather_cache.json",
}
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['\"][^'\"]{12,}['\"]"),
)
TEXT_SUFFIXES = {".html", ".css", ".js", ".json", ".py", ".md", ".txt", ".toml", ".yaml", ".yml", ".sh", ".command", ".bat", ".webmanifest"}


def is_private(relative: str) -> bool:
    return any(relative == item or relative.startswith(item + "/") for item in PRIVATE_PATHS)


def tracked_files() -> list[str]:
    if not (ROOT / ".git").exists():
        return []
    completed = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def main() -> None:
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    missing = sorted(path for path in PRIVATE_PATHS if path not in ignore and path + "/" not in ignore)
    if missing:
        raise AssertionError("private paths missing from .gitignore: " + ", ".join(missing))

    tracked = tracked_files()
    leaked = sorted(path for path in tracked if is_private(path))
    if leaked:
        raise AssertionError("private files are tracked: " + ", ".join(leaked))

    candidates = tracked or [path.relative_to(ROOT).as_posix() for path in ROOT.rglob("*") if path.is_file() and not is_private(path.relative_to(ROOT).as_posix())]
    secret_hits = []
    for relative in candidates:
        path = ROOT / relative
        if path.suffix.lower() not in TEXT_SUFFIXES or not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if any(pattern.search(text) for pattern in SECRET_PATTERNS):
            secret_hits.append(relative)
    if secret_hits:
        raise AssertionError("possible secrets found: " + ", ".join(sorted(secret_hits)))

    seed = json.loads((ROOT / "core/defaults/instance_seed.json").read_text(encoding="utf-8"))
    assert seed.get("description") and seed.get("files", {}).get("heart_hollow.json", {}).get("entries") == []
    assert seed["files"]["private_wing.json"].get("plates") == []
    print(f"privacy scan ok: {len(candidates)} public files checked; private instance paths excluded")


if __name__ == "__main__":
    main()
