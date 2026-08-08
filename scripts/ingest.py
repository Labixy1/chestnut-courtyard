#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ingest.py —— 手动归档：把 inbox/ 或任意路径的图片，收进庄园。

只用 Python 标准库，不装任何包。归档后会：
  1) 把图片移动到 assets/<类别>/ 下
  2) 写进对应的 JSON（manifest.json 或 estate_state.json）
  3) 重新生成 core/data.js（保证 file:// 双击也能读到最新数据）

用法：
  # 黑板产品题图
  python scripts/ingest.py inbox/moe.png --type blackboard --title "MoE" --tags "架构,LLM"

  # 工具箱卡片（一般手动编辑 manifest 更方便，这里也支持）
  python scripts/ingest.py inbox/logo.png --type toolbox --title "Cursor" \
      --use-when "多文件修改" --avoid-when "陌生技术栈" --url "https://cursor.com"

  # 外墙生活小照片
  python scripts/ingest.py inbox/tea.jpg --type photo --note "晚上的茶"

  # 旅行拍立得（同时钉上外墙 + 进旅行历史）
  python scripts/ingest.py inbox/mountain.jpg --type travel --place "山里" \
      --note "信号不好，睡得好" --line "山里信号不好，反而睡得很好。"
"""

import argparse, json, os, random, shutil, sys
from datetime import datetime
from pathlib import Path

try:
    from instance_data import ensure_instance_data
except ImportError:
    from scripts.instance_data import ensure_instance_data

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "core")
ASSETS = os.path.join(ROOT, "assets")
ensure_instance_data(Path(ROOT))

ASSET_DIR = {
    "blackboard": "blackboard",
    "toolbox": "toolbox",
    "photo": "photos",
    "travel": "travel",
    "card": "cards",
    "plant": "plants",
    "news": "news",
}


def load_json(name):
    p = os.path.join(CORE, name)
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(name, data):
    p = os.path.join(CORE, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def rebuild_data_js():
    """把 core JSON 重新打包进 core/data.js，供 file:// 场景读取。"""
    bundle = {
        "estate_state": load_json("estate_state.json"),
        "heart_hollow": load_json("heart_hollow.json"),
        "private_wing": load_json("private_wing.json"),
        "manifest": load_json("manifest.json"),
    }
    for optional_name, key in (
        ("notice_reports.json", "notice_reports"),
        ("butler_sources.json", "butler_sources"),
        ("butler_state.json", "butler_state"),
        ("daily_questions.json", "daily_questions"),
    ):
        path = os.path.join(CORE, optional_name)
        if os.path.exists(path):
            bundle[key] = load_json(optional_name)
    body = json.dumps(bundle, ensure_ascii=False, indent=2)
    header = (
        "/* 由 scripts/ingest.py 自动生成，请勿手改；改数据请改 core/*.json 再跑 ingest。 */\n"
        "window.COZY = "
    )
    with open(os.path.join(CORE, "data.js"), "w", encoding="utf-8") as f:
        f.write(header + body + ";\n")


def move_into(kind, src):
    if not os.path.exists(src):
        sys.exit(f"找不到文件：{src}")
    sub = ASSET_DIR.get(kind, "photos")
    dst_dir = os.path.join(ASSETS, sub)
    os.makedirs(dst_dir, exist_ok=True)
    fname = os.path.basename(src)
    dst = os.path.join(dst_dir, fname)
    # 避免重名覆盖
    base, ext = os.path.splitext(fname)
    i = 1
    while os.path.exists(dst):
        dst = os.path.join(dst_dir, f"{base}_{i}{ext}")
        i += 1
    shutil.move(src, dst)
    rel = os.path.relpath(dst, ROOT).replace(os.sep, "/")
    print(f"→ 已移动到 {rel}")
    return rel


def add_manifest_item(item):
    m = load_json("manifest.json")
    m.setdefault("items", []).append(item)
    save_json("manifest.json", m)


def add_wall_photo(rel, ptype, date, note):
    s = load_json("estate_state.json")
    photos = s.setdefault("wall_photos", [])
    pid = f"ph_{len(photos)+1:02d}"
    photos.append({
        "id": pid, "type": ptype, "file": rel, "date": date, "note": note or "",
        "position": {"x": random.randint(12, 82), "y": random.randint(48, 74),
                     "rotate": random.randint(-9, 9)},
    })
    # 外墙最多留 15 张
    if len(photos) > 15:
        del photos[0]
    save_json("estate_state.json", s)


def add_travel(rel, place, date, line):
    s = load_json("estate_state.json")
    hist = s.setdefault("travel", {}).setdefault("history", [])
    hist.append({"id": f"tr_{len(hist)+1:02d}", "place": place or "", "date": date,
                 "line": line or "", "file": rel})
    save_json("estate_state.json", s)


def main():
    ap = argparse.ArgumentParser(description="把图片归档进庄园")
    ap.add_argument("src", help="源图片路径，如 inbox/x.png")
    ap.add_argument("--type", required=True,
                    choices=["blackboard", "toolbox", "photo", "travel", "card", "plant", "news"])
    ap.add_argument("--title", default="")
    ap.add_argument("--tags", default="")
    ap.add_argument("--note", default="")
    ap.add_argument("--place", default="")
    ap.add_argument("--line", default="")
    ap.add_argument("--use-when", dest="use_when", default="")
    ap.add_argument("--avoid-when", dest="avoid_when", default="")
    ap.add_argument("--url", default="")
    args = ap.parse_args()

    today = datetime.now().strftime("%Y-%m-%d")
    rel = move_into(args.type, args.src)

    if args.type in ("blackboard", "card", "plant", "news"):
        add_manifest_item({
            "id": f"{args.type}_{datetime.now().strftime('%Y%m%d%H%M%S')}",
            "type": args.type, "title": args.title or os.path.basename(rel),
            "file": rel, "tags": [t.strip() for t in args.tags.split(",") if t.strip()],
            "source": "manual",
        })
        print("→ 已写入 manifest.json")

    elif args.type == "toolbox":
        add_manifest_item({
            "id": f"tool_{datetime.now().strftime('%Y%m%d%H%M%S')}",
            "type": "toolbox", "title": args.title or "未命名工具",
            "use_when": args.use_when, "avoid_when": args.avoid_when,
            "url": args.url, "file": rel, "source": "manual",
        })
        print("→ 已写入 manifest.json（工具箱）")

    elif args.type == "photo":
        add_wall_photo(rel, "life", today, args.note)
        print("→ 已钉上外墙照片墙")

    elif args.type == "travel":
        add_wall_photo(rel, "travel", today, args.note)
        add_travel(rel, args.place, today, args.line)
        print("→ 已加入旅行历史并钉上外墙")

    rebuild_data_js()
    print("✅ 完成。刷新 index.html 就能看到。")


if __name__ == "__main__":
    main()
