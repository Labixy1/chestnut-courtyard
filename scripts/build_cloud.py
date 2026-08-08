#!/usr/bin/env python3
"""Build a privacy-filtered Cloudflare Pages directory."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from copy import deepcopy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def copy_tree(source, destination, excluded=(), max_bytes=None):
    excluded = set(excluded)
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if any(part in excluded for part in relative.parts):
            continue
        target = destination / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            if max_bytes is not None and path.stat().st_size > max_bytes:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def read_json(name, fallback):
    try:
        return json.loads((ROOT / "core" / name).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return fallback


def public_seed():
    path = ROOT / "core" / "defaults" / "instance_seed.json"
    return json.loads(path.read_text(encoding="utf-8"))["files"]


def optimize_preview_assets():
    """Reduce cloud copies only; local high-resolution originals stay untouched."""
    if sys.platform != "darwin" or not shutil.which("sips"):
        return
    for path in (DIST / "assets").rglob("*.png"):
        if path.stat().st_size <= 4_800_000:
            continue
        target = 640 if path.name == "butler_dog.png" else 1920
        subprocess.run(["sips", "-Z", str(target), str(path), "--out", str(path)],
                       capture_output=True, text=True, check=True)


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for name in ("index.html", "logger.js", "manifest.webmanifest", "sw.js"):
        shutil.copy2(ROOT / name, DIST / name)
    copy_tree(ROOT / "pages", DIST / "pages")
    copy_tree(ROOT / "assets", DIST / "assets", excluded={"uploads", "generated", "hollow"}, max_bytes=24 * 1024 * 1024)
    optimize_preview_assets()
    (DIST / "core").mkdir()
    for name in ("butler_widget.js", "memory.js", "runtime.js", "pwa.js"):
        shutil.copy2(ROOT / "core" / name, DIST / "core" / name)
    seed = public_seed()
    estate = deepcopy(seed["estate_state.json"])
    public_bundle = {
        "estate_state": estate,
        "heart_hollow": deepcopy(seed["heart_hollow.json"]),
        "private_wing": deepcopy(seed["private_wing.json"]),
        "manifest": deepcopy(seed["manifest.json"]),
        "notice_reports": deepcopy(seed["notice_reports.json"]),
        "butler_sources": deepcopy(seed["butler_sources.json"]),
        "butler_state": deepcopy(seed["butler_state.json"]),
        "daily_questions": deepcopy(seed["daily_questions.json"]),
    }
    body = "/* Cloud build: private room data is intentionally excluded. */\nwindow.COZY = "
    (DIST / "core/data.js").write_text(body + json.dumps(public_bundle, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    runtime_config = {
        "mode": "preview", "appName": "栗壳小院 · 公开预览",
        "apiBase": "", "dataSource": "bundle", "allowWrites": False,
        "instanceId": "public-preview",
    }
    (DIST / "core/runtime-config.js").write_text(
        "window.COZY_RUNTIME_CONFIG = " + json.dumps(runtime_config, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    (DIST / "_headers").write_text(
        "/*\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: no-referrer\n"
        "  X-Frame-Options: DENY\n"
        "  Permissions-Policy: camera=(), geolocation=()\n",
        encoding="utf-8",
    )
    print(f"Cloudflare Pages bundle ready: {DIST}")


if __name__ == "__main__":
    main()
