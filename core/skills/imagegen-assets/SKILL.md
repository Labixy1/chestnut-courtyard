---
name: imagegen-assets
description: 生成小院所需的场景、植物、照片与透明素材，并完成尺寸、格式和页面适配。
---

# ImageGen 图像素材生成

1. 根据用途选择 Seedream、GPT Image 或 Nano Banana 等已配置图片模型。
2. 项目素材优先生成统一视角、统一光线和稳定尺寸的版本。
3. 需要透明素材时优先生成纯色背景，再调用 remove-background 完成抠图。
4. 压缩为适合页面加载的 WebP 或 PNG，并实际放入页面验证比例与融合效果。
