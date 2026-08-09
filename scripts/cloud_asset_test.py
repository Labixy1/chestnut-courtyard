#!/usr/bin/env python3
"""Verify cloud bundles contain every referenced local asset."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".html", ".css", ".js", ".json", ".webmanifest"}
ASSET_PATTERN = re.compile(r"(?:\.\./)*assets/[A-Za-z0-9_./@+-]+\.(?:png|jpe?g|webp|gif|svg|mp4|webm)", re.I)


def validate(bundle: Path) -> tuple[int, int]:
    references = set()
    for path in bundle.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in ASSET_PATTERN.findall(text):
            references.add(re.sub(r"^(?:\.\./)+", "", match))
    missing = sorted(reference for reference in references if not (bundle / reference).is_file())
    if missing:
        raise AssertionError(f"{bundle.name} missing assets: " + ", ".join(missing))
    return len(references), sum(1 for path in (bundle / "assets").rglob("*") if path.is_file())


def main() -> None:
    results = {name: validate(ROOT / name) for name in ("dist", "dist-owner")}
    print("cloud asset test ok: " + "; ".join(
        f"{name} {references} references/{files} files" for name, (references, files) in results.items()
    ))


if __name__ == "__main__":
    main()
