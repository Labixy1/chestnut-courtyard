---
name: remove-background
description: 使用 OpenCV 从项目图片中分离主体，输出带透明通道的 PNG 或 WebP 素材。
---

# OpenCV 智能抠图

1. 只处理项目目录内的图片，不读取项目外私人文件。
2. 使用主体矩形和 GrabCut 分割前景，保留最大的连通主体。
3. 输出透明 PNG 或 WebP，并返回尺寸、透明通道与保存路径。
4. 适合边界清晰的物体；毛发、玻璃、烟雾等复杂主体需要模型原生透明图。
