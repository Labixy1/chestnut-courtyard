#!/bin/sh
cd "$(dirname "$0")" || exit 1
exec python3 scripts/cozy_server.py --port 8766
