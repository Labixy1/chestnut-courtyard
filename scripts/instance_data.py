#!/usr/bin/env python3
"""Initialize private instance files from public, non-personal defaults."""

from __future__ import annotations

import json
from pathlib import Path


BRIDGE_FILES = {
    "estate_state": "estate_state.json",
    "heart_hollow": "heart_hollow.json",
    "private_wing": "private_wing.json",
    "manifest": "manifest.json",
    "notice_reports": "notice_reports.json",
    "butler_sources": "butler_sources.json",
    "butler_state": "butler_state.json",
    "daily_questions": "daily_questions.json",
}


def rebuild_data_bridge(root: Path) -> Path:
    core = Path(root) / "core"
    bundle = {}
    for key, name in BRIDGE_FILES.items():
        path = core / name
        if path.exists():
            bundle[key] = json.loads(path.read_text(encoding="utf-8"))
    target = core / "data.js"
    body = "/* Generated private instance bridge; ignored by Git. */\nwindow.COZY = "
    target.write_text(body + json.dumps(bundle, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    return target


def ensure_instance_data(root: Path) -> list[str]:
    root = Path(root)
    core = root / "core"
    seed_path = core / "defaults" / "instance_seed.json"
    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    created: list[str] = []
    for name, value in seed.get("files", {}).items():
        path = core / name
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        created.append(path.relative_to(root).as_posix())
    for name, value in seed.get("profiles", {}).items():
        path = core / name
        if path.exists():
            continue
        path.write_text(str(value), encoding="utf-8")
        created.append(path.relative_to(root).as_posix())
    bridge = core / "data.js"
    if not bridge.exists():
        rebuild_data_bridge(root)
        created.append(bridge.relative_to(root).as_posix())
    return created


if __name__ == "__main__":
    project = Path(__file__).resolve().parents[1]
    items = ensure_instance_data(project)
    print(json.dumps({"ok": True, "created": items}, ensure_ascii=False))
