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
5. Default images to no watermark. Default videos to five seconds, 720p, no generated audio, and no watermark unless the owner asks otherwise.
6. Never send tree-hollow or sealed-room content to an external provider unless the owner explicitly requests that exact generation.
7. Return the task id and the actual saved output path. Do not invent URLs, task states, or model results.

Tools: `generate_media`, `check_media_task`.
