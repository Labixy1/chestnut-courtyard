#!/usr/bin/env python3
"""Verify the public bundle excludes personal and sealed state."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def main() -> None:
    data = (DIST / "core/data.js").read_text(encoding="utf-8")
    match = re.search(r"window\.COZY\s*=\s*(\{.*\});\s*$", data, re.S)
    if not match:
        raise AssertionError("public data bundle is invalid")
    bundle = json.loads(match.group(1))
    assert bundle["estate_state"].get("wall_photos") == []
    assert bundle["estate_state"].get("travel", {}).get("history") == []
    assert bundle["heart_hollow"].get("entries") == []
    assert bundle["private_wing"].get("plates") == []
    runtime_config = (DIST / "core/runtime-config.js").read_text(encoding="utf-8")
    assert '"mode": "interview"' in runtime_config
    assert '"allowWrites": true' in runtime_config
    assert (DIST / "core/mobile.js").is_file()
    assert "core/mobile.js" in (DIST / "index.html").read_text(encoding="utf-8")
    assert "panorama_mobile.webp" in (DIST / "index.html").read_text(encoding="utf-8")
    assert (DIST / "assets/estate/panorama_mobile.webp").is_file()
    forbidden = [
        DIST / "core/local_state.json", DIST / "core/memory", DIST / "core/tasks.json",
        DIST / "core/audit_log.json", DIST / "assets/photos/uploads",
        DIST / "assets/photos/hollow", DIST / "assets/generated",
    ]
    assert not any(path.exists() for path in forbidden)
    private_names = {
        "local_state.json", "tasks.json", "audit_log.json", "permissions.json",
        "heart_hollow.json", "private_wing.json", "notice_reports.json",
        "butler_state.json", "weather_cache.json", "user_profile.yaml",
    }
    assert not any(path.name in private_names for path in (DIST / "core").iterdir())
    print("cloud privacy test ok: isolated preview; memories; sealed rooms; photos; trips; runtime state excluded")


if __name__ == "__main__":
    main()
