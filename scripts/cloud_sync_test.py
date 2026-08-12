#!/usr/bin/env python3
"""Validate Wrangler KV reads without contacting the owner cloud."""

from __future__ import annotations

import cloud_sync


original = cloud_sync.wrangler_run

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
finally:
    cloud_sync.wrangler_run = original

print("cloud sync test ok: present JSON; optional 404; real errors preserved")
