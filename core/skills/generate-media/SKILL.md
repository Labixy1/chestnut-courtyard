---
name: generate-media
description: Generate persistent images with Seedream or GPT Image and asynchronous videos with Seedance.
---

# Generate Media

Use this Skill only when the owner explicitly asks to create an image or video.

1. Preserve the owner's subject, setting, mood, and privacy constraints in the prompt.
2. Choose `seedream` for cottage scenes, reference-image work, or multiple related images.
3. Choose `openai` when the owner explicitly requests GPT Image.
4. Choose `seedance` for video. A video call creates an asynchronous task; never claim the video is finished until `check_media_task` reports `succeeded`.
5. Conserve the owner's 10 GB R2 allowance: default Seedream images to 1K, GPT Image to 1024x1024 medium-quality WebP, and videos to five seconds at 480p with no generated audio or watermark. Higher settings require an explicit owner request.
6. Stop before the media bucket reaches 9 GB so there is at least 1 GB of safety room. Never delete an older asset automatically to make room.
7. Never send tree-hollow or sealed-room content to an external provider unless the owner explicitly requests that exact generation.
8. Return the task id and the actual saved output path. Do not invent URLs, task states, or model results.

Tools: `generate_media`, `check_media_task`.
