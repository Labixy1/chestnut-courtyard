#!/usr/bin/env python3
"""Check runtime modes, starter data and installable-app files before GitHub."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from instance_data import ensure_instance_data


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        assert (ROOT / icon["src"]).is_file(), icon["src"]

    html_files = [ROOT / "index.html", *sorted((ROOT / "pages").glob("*.html"))]
    for path in html_files:
        text = path.read_text(encoding="utf-8")
        prefix = "" if path.parent == ROOT else "../"
        assert f'{prefix}core/runtime-config.js' in text, path.name
        assert f'{prefix}core/runtime.js' in text, path.name
        assert f'{prefix}manifest.webmanifest' in text, path.name

    runtime = (ROOT / "core/runtime.js").read_text(encoding="utf-8")
    for mode in ("owner", "selfhost", "interview", "preview", "dev"):
        assert f"'{mode}'" in runtime

    seed = json.loads((ROOT / "core/defaults/instance_seed.json").read_text(encoding="utf-8"))
    required = {"estate_state.json", "heart_hollow.json", "private_wing.json", "manifest.json", "notice_reports.json", "permissions.json"}
    assert required <= set(seed["files"])
    with tempfile.TemporaryDirectory(prefix="cozy_starter_") as directory:
        clone = Path(directory)
        (clone / "core/defaults").mkdir(parents=True)
        shutil.copy2(ROOT / "core/defaults/instance_seed.json", clone / "core/defaults/instance_seed.json")
        created = ensure_instance_data(clone)
        assert "core/data.js" in created
        assert (clone / "core/heart_hollow.json").is_file()
        assert json.loads((clone / "core/private_wing.json").read_text(encoding="utf-8"))["plates"] == []
    print(f"repository readiness ok: {len(html_files)} pages; five modes; PWA; safe starter bootstrap")


if __name__ == "__main__":
    main()
