#!/usr/bin/env python3
"""Create a transparent cutout from a project image with OpenCV GrabCut."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np


ROOT = Path.cwd().resolve()


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def project_path(value: str, must_exist: bool = False) -> Path:
    path = (ROOT / str(value or "")).resolve()
    if ROOT != path and ROOT not in path.parents:
        emit({"ok": False, "error": "路径必须位于项目目录内"}, 1)
    if must_exist and not path.is_file():
        emit({"ok": False, "error": "输入图片不存在"}, 1)
    return path


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        emit({"ok": False, "error": "输入不是有效 JSON"}, 1)
    source = project_path(payload.get("input"), True)
    output = project_path(payload.get("output"))
    if output.suffix.lower() not in {".png", ".webp"}:
        emit({"ok": False, "error": "输出格式必须是 PNG 或 WebP"}, 1)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        emit({"ok": False, "error": "无法读取输入图片"}, 1)
    height, width = image.shape[:2]
    ratios = payload.get("rect") if isinstance(payload.get("rect"), list) and len(payload["rect"]) == 4 else [0.08, 0.06, 0.84, 0.88]
    x, y, rw, rh = [max(0.0, min(1.0, float(value))) for value in ratios]
    rect = (int(width * x), int(height * y), max(2, int(width * rw)), max(2, int(height * rh)))
    rect = (rect[0], rect[1], min(rect[2], width - rect[0]), min(rect[3], height - rect[1]))
    mask = np.zeros((height, width), np.uint8)
    background = np.zeros((1, 65), np.float64)
    foreground = np.zeros((1, 65), np.float64)
    cv2.grabCut(image, mask, rect, background, foreground, 7, cv2.GC_INIT_WITH_RECT)
    alpha = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(alpha, 8)
    if count <= 1:
        emit({"ok": False, "error": "没有识别出可用主体"}, 1)
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    alpha = np.where(labels == largest, 255, 0).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (5, 5), 0)
    ys, xs = np.where(alpha > 8)
    pad = max(8, round(min(width, height) * 0.01))
    x0, x1 = max(0, int(xs.min()) - pad), min(width, int(xs.max()) + pad + 1)
    y0, y1 = max(0, int(ys.min()) - pad), min(height, int(ys.max()) + pad + 1)
    rgba = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha
    crop = rgba[y0:y1, x0:x1]
    output.parent.mkdir(parents=True, exist_ok=True)
    params = [cv2.IMWRITE_PNG_COMPRESSION, 9] if output.suffix.lower() == ".png" else [cv2.IMWRITE_WEBP_QUALITY, 90]
    if not cv2.imwrite(str(output), crop, params):
        emit({"ok": False, "error": "透明图片保存失败"}, 1)
    emit({"ok": True, "summary": "已使用 OpenCV 生成透明抠图", "output": str(output.relative_to(ROOT)), "width": int(crop.shape[1]), "height": int(crop.shape[0]), "alpha": True})


if __name__ == "__main__":
    main()
