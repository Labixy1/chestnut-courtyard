#!/usr/bin/env python3
"""Verify the owner cloud bundle is private-runtime ready without owner data."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist-owner"


def main() -> None:
    config = (DIST / "core/runtime-config.js").read_text(encoding="utf-8")
    assert '"mode": "owner"' in config
    assert '"dataSource": "remote"' in config
    assert '"allowWrites": true' in config
    data = (DIST / "core/data.js").read_text(encoding="utf-8")
    match = re.search(r"window\.COZY\s*=\s*(\{.*\});\s*$", data, re.S)
    assert match
    bundle = json.loads(match.group(1))
    assert bundle["heart_hollow"]["entries"] == []
    assert bundle["private_wing"]["plates"] == []
    assert bundle["estate_state"]["wall_photos"] == []
    assert not (DIST / "core/memory").exists()
    assert not (DIST / "core/local_state.json").exists()
    headers = (DIST / "_headers").read_text(encoding="utf-8")
    assert "microphone=(self)" in headers
    assert "Cache-Control: private, no-store" in headers
    wrangler = (ROOT / "cloudflare" / "wrangler.toml").read_text(encoding="utf-8")
    assert 'AUTH_MODE = "passcode"' in wrangler
    assert "run_worker_first = true" in wrangler
    assert 'binding = "COZY_MEDIA"' in wrangler
    assert 'bucket_name = "chestnut-courtyard-media"' in wrangler
    assert 'COZY_MEDIA_LIMIT_BYTES = "9000000000"' in wrangler
    assert "REPLACE_WITH_KV_NAMESPACE_ID" not in wrangler
    print("cloud owner test ok: owner runtime; remote state; writable; private R2 media; starter-only bundle; private cache policy")


if __name__ == "__main__":
    main()
