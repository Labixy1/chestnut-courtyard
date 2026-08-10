#!/usr/bin/env python3
"""Verify local-state merge behavior matches the Cloudflare Worker."""

import tempfile
from pathlib import Path

import cozy_server


def check(condition, message):
    if not condition:
        raise AssertionError(message)


with tempfile.TemporaryDirectory(prefix="cozy-local-sync-") as directory:
    cozy_server.LOCAL_STATE_PATH = Path(directory) / "local_state.json"
    cozy_server.sync_local_state({"values": {"cozy_blackboard_starred": ["q1"]}})

    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {
        "type": "array", "upserts": [{"id": "a", "place": "杭州", "updatedAt": "2026-08-10T08:00:00+08:00"}], "deleted": []
    }}})
    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {
        "type": "array", "upserts": [{"id": "b", "place": "上海", "updatedAt": "2026-08-10T08:01:00+08:00"}], "deleted": []
    }}})
    check(sorted(item["id"] for item in state["values"]["cozy_trips"]) == ["a", "b"], "independent device additions were not merged")

    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {
        "type": "array", "upserts": [{"id": "a", "place": "旧副本", "updatedAt": "2026-08-10T07:59:00+08:00"}], "deleted": []
    }}})
    check(next(item for item in state["values"]["cozy_trips"] if item["id"] == "a")["place"] == "杭州", "older update won")

    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {"type": "array", "upserts": [], "deleted": ["id:a"]}}})
    check(all(item["id"] != "a" for item in state["values"]["cozy_trips"]), "record was not deleted")
    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {
        "type": "array", "upserts": [{"id": "a", "place": "离线旧副本", "updatedAt": "2026-08-10T08:00:00+08:00"}], "deleted": []
    }}})
    check(all(item["id"] != "a" for item in state["values"]["cozy_trips"]), "tombstone did not block stale resurrection")
    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {
        "type": "array", "upserts": [{"id": "a", "place": "无时间戳旧副本"}], "deleted": []
    }}})
    check(all(item["id"] != "a" for item in state["values"]["cozy_trips"]), "tombstone accepted an undated stale record")
    state = cozy_server.sync_local_state({"changes": {"cozy_trips": {
        "type": "array", "upserts": [{"id": "a", "place": "主人重新创建"}], "deleted": [], "revive": ["id:a"]
    }}})
    check(any(item["id"] == "a" and item["place"] == "主人重新创建" for item in state["values"]["cozy_trips"]), "explicit recreation was blocked")

    state = cozy_server.sync_local_state({"changes": {"cozy_trip_reflections": {
        "type": "object", "upserts": {"one": {"summary": "一", "updatedAt": "2026-08-10T08:00:00+08:00"}}, "deleted": []
    }}})
    state = cozy_server.sync_local_state({"changes": {"cozy_trip_reflections": {
        "type": "object", "upserts": {"two": {"summary": "二", "updatedAt": "2026-08-10T08:01:00+08:00"}}, "deleted": []
    }}})
    check(sorted(state["values"]["cozy_trip_reflections"]) == ["one", "two"], "object maps were not merged")
    state = cozy_server.sync_local_state({"changes": {"cozy_trip_reflections": {
        "type": "object", "upserts": {}, "deleted": ["one"]
    }}})
    state = cozy_server.sync_local_state({"changes": {"cozy_trip_reflections": {
        "type": "object", "upserts": {"one": {"summary": "无时间戳旧副本"}}, "deleted": []
    }}})
    check("one" not in state["values"]["cozy_trip_reflections"], "object tombstone accepted an undated stale record")
    state = cozy_server.sync_local_state({"changes": {"cozy_trip_reflections": {
        "type": "object", "upserts": {"one": {"summary": "主人重新创建"}}, "deleted": [], "revive": ["one"]
    }}})
    check(state["values"]["cozy_trip_reflections"]["one"]["summary"] == "主人重新创建", "explicit object recreation was blocked")

print("local state sync test ok: union; latest-wins; tombstones; object maps")
