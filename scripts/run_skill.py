#!/usr/bin/env python3
"""Run one registered Butler tool as a short-lived CLI process."""

from __future__ import annotations

import argparse
import json
import sys

import cozy_server


def main():
    parser = argparse.ArgumentParser(description="Run one Cozy Estate Skill tool")
    parser.add_argument("name", nargs="?", help="registered tool name")
    parser.add_argument("--json", default="{}", help="JSON object with tool arguments")
    parser.add_argument("--list", action="store_true", help="list registered tools")
    args = parser.parse_args()
    if args.list:
        print(json.dumps(cozy_server.BUTLER_TOOLS.skill_manifest(), ensure_ascii=False, indent=2))
        return 0
    if not args.name:
        parser.error("name is required unless --list is used")
    try:
        arguments = json.loads(args.json)
        if not isinstance(arguments, dict):
            raise ValueError("--json must be an object")
        result = cozy_server.BUTLER_TOOLS.execute(args.name, arguments)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
