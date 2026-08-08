#!/usr/bin/env python3
"""Build a private Windows migration zip without duplicated/cloud artifacts."""

from __future__ import annotations

import json
import zipfile
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parent / "cozy-estate-windows.zip"
EXCLUDED_DIRS = {
    ".git", "__pycache__", "dist", "node_modules",
    "core/runtime", "core/logs",
}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".DS_Store"}


def excluded(path: Path) -> bool:
    relative = path.relative_to(ROOT).as_posix()
    if any(relative == directory or relative.startswith(directory + "/") for directory in EXCLUDED_DIRS):
        return True
    return path.suffix in EXCLUDED_SUFFIXES or path.name == ".DS_Store"


def generated_profile() -> str:
    profile = json.loads((ROOT / "core/memory/profile.json").read_text(encoding="utf-8"))
    lines = ["# Generated from the validated non-sealed memory profile for migration.", "profile_summary: |", "  " + str(profile.get("summary") or "").replace("\n", "\n  "), "sections:"]
    for section in profile.get("sections", []):
        lines.extend(["  - title: " + json.dumps(str(section.get("title") or ""), ensure_ascii=False),
                      "    text: " + json.dumps(str(section.get("text") or ""), ensure_ascii=False)])
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    files = [path for path in ROOT.rglob("*") if path.is_file() and not excluded(path)]
    skipped = []
    manifest = {
        "built_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": ROOT.name,
        "files": 0,
        "contains_private_data": True,
        "start": "start-windows.bat",
    }
    OUTPUT.unlink(missing_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            try:
                archive.write(path, (Path(ROOT.name) / path.relative_to(ROOT)).as_posix())
            except (OSError, PermissionError) as exc:
                skipped.append({"file": path.relative_to(ROOT).as_posix(), "error": str(exc)[:160]})
        generated = []
        skipped_names = {item["file"] for item in skipped}
        profile_text = generated_profile()
        for relative in ("core/user_profile.yaml", "core/user_profile_runtime.yaml"):
            if relative in skipped_names:
                archive.writestr((Path(ROOT.name) / relative).as_posix(), profile_text)
                generated.append(relative)
        manifest["files"] = len(files) - len(skipped) + len(generated)
        manifest["skipped"] = skipped
        manifest["generated_compatibility_files"] = generated
        archive.writestr((Path(ROOT.name) / "MIGRATION_PACKAGE.json").as_posix(),
                         json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": True, "file": str(OUTPUT), "files": manifest["files"], "skipped": skipped, "bytes": OUTPUT.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
