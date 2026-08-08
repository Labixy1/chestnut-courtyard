#!/bin/sh
LABEL="com.cozy-estate.butler"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "阿栗自动启动已关闭。"
