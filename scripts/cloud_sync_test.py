#!/usr/bin/env python3
"""Validate Wrangler KV reads without contacting the owner cloud."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import types

import cloud_sync


original = cloud_sync.wrangler_run
original_namespaces = cloud_sync.wrangler_namespaces
original_kv_get = cloud_sync.kv_get
original_root = cloud_sync.ROOT

try:
    cloud_sync.wrangler_run = lambda *_args: '{"ok":true}'
    assert cloud_sync.kv_get("namespace", "present") == {"ok": True}

    def missing(*_args):
        raise RuntimeError(
            "Failed to fetch https://api.cloudflare.com/client/v4/accounts/example/"
            "storage/kv/namespaces/example/values/memory%3Aoverrides - 404: Not Found"
        )

    cloud_sync.wrangler_run = missing
    assert cloud_sync.kv_get("namespace", "memory:overrides") is None

    def forbidden(*_args):
        raise RuntimeError("Cloudflare API - 403: Forbidden")

    cloud_sync.wrangler_run = forbidden
    try:
        cloud_sync.kv_get("namespace", "private")
    except RuntimeError as error:
        assert "403" in str(error)
    else:
        raise AssertionError("403 must not be treated as a missing key")

    assert "memory:forgotten" in cloud_sync.MEMORY_KEYS
    cloud_sync.wrangler_namespaces = lambda: ("primary", "backup")
    cloud_sync.kv_get = lambda _namespace, key: ([{"id": "forgotten-1"}] if key == "memory:forgotten" else None)
    snapshot = cloud_sync.wrangler_snapshot()
    assert snapshot["memory"]["memory:forgotten"] == [{"id": "forgotten-1"}]

    with tempfile.TemporaryDirectory(prefix="cozy_cloud_sync_") as directory:
        cloud_sync.ROOT = Path(directory)
        policy_path = cloud_sync.ROOT / "core/memory/policy.json"
        policy_path.parent.mkdir(parents=True)
        policy_path.write_text(json.dumps({"version": 3, "forgotten_ids": [{"id": "forgotten-2"}]}), encoding="utf-8")
        payload = cloud_sync.local_payload()
        assert payload["memory"]["memory:forgotten"] == [{"id": "forgotten-2"}]

        previous_ingest = sys.modules.get("ingest")
        fake_ingest = types.ModuleType("ingest")
        fake_ingest.rebuild_data_js = lambda: None
        sys.modules["ingest"] = fake_ingest
        try:
            cloud_sync.restore_snapshot({"version": 1, "data": {}, "memory": {
                "memory:forgotten": [{"id": "forgotten-3"}]
            }})
            restored_policy = json.loads(policy_path.read_text(encoding="utf-8"))
            assert restored_policy["version"] == 3
            assert restored_policy["forgotten_ids"] == [{"id": "forgotten-3"}]
        finally:
            if previous_ingest is None:
                sys.modules.pop("ingest", None)
            else:
                sys.modules["ingest"] = previous_ingest
finally:
    cloud_sync.wrangler_run = original
    cloud_sync.wrangler_namespaces = original_namespaces
    cloud_sync.kv_get = original_kv_get
    cloud_sync.ROOT = original_root

print("cloud sync test ok: present JSON; optional 404; real errors preserved; forgotten tombstones backed up")
