#!/usr/bin/env python3
"""Install the Cozy Estate local service as a per-user macOS LaunchAgent."""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.cozy-estate.butler"
AGENT = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
LOG_DIR = ROOT / "core/logs"


def launchctl(*arguments):
    return subprocess.run(["launchctl", *arguments], capture_output=True, text=True)


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    AGENT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, str(ROOT / "scripts/cozy_server.py"), "--port", "8766"],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Background",
        "StandardOutPath": str(LOG_DIR / "service.log"),
        "StandardErrorPath": str(LOG_DIR / "service-error.log"),
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
    }
    with AGENT.open("wb") as handle:
        plistlib.dump(payload, handle)
    domain = "gui/%d" % os.getuid()
    launchctl("bootout", domain + "/" + LABEL)
    loaded = launchctl("bootstrap", domain, str(AGENT))
    if loaded.returncode != 0:
        raise SystemExit((loaded.stderr or loaded.stdout or "LaunchAgent 安装失败").strip())
    launchctl("kickstart", "-k", domain + "/" + LABEL)
    print("阿栗已设为登录后自动运行：http://127.0.0.1:8766/index.html")


if __name__ == "__main__":
    main()
