#!/usr/bin/env python3
"""Build privacy-filtered public or owner Cloudflare assets."""

from __future__ import annotations

import argparse
import json
import shutil
from copy import deepcopy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
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


def optimize_assets(destination):
    """Reduce cloud copies only; local high-resolution originals stay untouched."""
    try:
        from PIL import Image
    except ImportError:
        return {}
    replacements = {}
    for path in (destination / "assets").rglob("*.png"):
        if path.stat().st_size <= 700_000:
            continue
        target = 640 if path.name == "butler_dog.png" else 1920
        webp = path.with_suffix(".webp")
        with Image.open(path) as image:
            image.thumbnail((target, target), Image.Resampling.LANCZOS)
            image.save(webp, "WEBP", quality=78, method=6)
        old = path.relative_to(destination).as_posix()
        new = webp.relative_to(destination).as_posix()
        replacements[old] = new
        path.unlink()
    return replacements


def rewrite_asset_references(destination, replacements):
    if not replacements:
        return
    suffixes = {".html", ".css", ".js", ".json", ".webmanifest"}
    for path in destination.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        text = path.read_text(encoding="utf-8")
        updated = text
        for old, new in replacements.items():
            updated = updated.replace(old, new)
        if updated != text:
            path.write_text(updated, encoding="utf-8")


def build(mode="preview", output=None):
    if mode not in {"preview", "owner"}:
        raise ValueError("mode must be preview or owner")
    destination = Path(output).resolve() if output else ROOT / ("dist-owner" if mode == "owner" else "dist")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir()
    for name in ("index.html", "logger.js", "manifest.webmanifest", "sw.js"):
        shutil.copy2(ROOT / name, destination / name)
    copy_tree(ROOT / "pages", destination / "pages")
    copy_tree(ROOT / "assets", destination / "assets", excluded={"uploads", "generated", "hollow"}, max_bytes=24 * 1024 * 1024)
    replacements = optimize_assets(destination)
    (destination / "core").mkdir()
    for name in ("butler_widget.js", "memory.js", "runtime.js", "pwa.js", "mobile.js"):
        shutil.copy2(ROOT / "core" / name, destination / "core" / name)
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
    (destination / "core/data.js").write_text(body + json.dumps(public_bundle, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    runtime_config = ({
        "mode": "interview", "appName": "栗壳小院 · 演示体验", "apiBase": "",
        "dataSource": "remote", "allowWrites": True, "instanceId": "interview-demo",
    } if mode == "preview" else {
        "mode": "owner", "appName": "栗壳小院", "apiBase": "",
        "dataSource": "remote", "allowWrites": True, "instanceId": "owner-cloud",
    })
    (destination / "core/runtime-config.js").write_text(
        "window.COZY_RUNTIME_CONFIG = " + json.dumps(runtime_config, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    microphone = "()" if mode == "preview" else "(self)"
    (destination / "_headers").write_text(
        "/*\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: no-referrer\n"
        "  X-Frame-Options: DENY\n"
        f"  Permissions-Policy: camera=(), microphone={microphone}, geolocation=()\n"
        "  Cache-Control: private, no-store\n",
        encoding="utf-8",
    )
    rewrite_asset_references(destination, replacements)
    print(f"Cloudflare {mode} bundle ready: {destination}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("preview", "owner"), default="preview")
    parser.add_argument("--output")
    args = parser.parse_args()
    build(args.mode, args.output)


if __name__ == "__main__":
    main()
