#!/usr/bin/env python3
"""Provider-neutral text, image, and video API gateway.

Only Python's standard library is used. API keys stay in environment
variables and are never returned by status methods or written to disk.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request


class ModelGateway:
    def __init__(self, environ=None):
        self.environ = environ if environ is not None else os.environ

    def _env(self, name, default=""):
        return str(self.environ.get(name, default) or "").strip()

    def _key(self, provider):
        names = {
            "openai": ("OPENAI_API_KEY",),
            "deepseek": ("DEEPSEEK_API_KEY",),
            "glm": ("GLM_API_KEY", "BIGMODEL_API_KEY"),
            "qwen": ("QWEN_API_KEY", "DASHSCOPE_API_KEY"),
            "ark": ("ARK_API_KEY",),
        }
        return next((self._env(name) for name in names.get(provider, ()) if self._env(name)), "")

    def _base_url(self, provider):
        values = {
            "openai": ("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            "deepseek": ("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
            "glm": ("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
            "qwen": ("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "ark": ("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        }
        env_name, default = values[provider]
        return self._env(env_name, default).rstrip("/")

    def _model(self, provider, capability="text"):
        values = {
            ("openai", "text"): ("COZY_OPENAI_MODEL", "gpt-5-mini"),
            ("openai", "image"): ("COZY_OPENAI_IMAGE_MODEL", "gpt-image-2"),
            ("deepseek", "text"): ("COZY_DEEPSEEK_MODEL", "deepseek-chat"),
            ("glm", "text"): ("COZY_GLM_MODEL", "glm-4.7-flash"),
            ("qwen", "text"): ("COZY_QWEN_MODEL", "qwen3.7-flash"),
            ("ark", "image"): ("COZY_SEEDREAM_MODEL", "doubao-seedream-5-0-pro-260628"),
            ("ark", "video"): ("COZY_SEEDANCE_MODEL", "doubao-seedance-2-0-260128"),
        }
        env_name, default = values[(provider, capability)]
        return self._env(env_name, default)

    @staticmethod
    def _error_message(raw, fallback):
        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except (ValueError, UnicodeError):
            return fallback
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or fallback)
        return str(error or payload.get("message") or fallback)

    def _request(self, provider, method, path, body=None, timeout=120):
        key = self._key(provider)
        if not key:
            raise RuntimeError(f"{provider} API Key 尚未配置")
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self._base_url(provider) + path,
            data=data,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            raise RuntimeError(self._error_message(raw, f"{provider} 请求失败（HTTP {exc.code}）")) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{provider} 网络连接失败：{exc.reason}") from exc
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise RuntimeError(f"{provider} 返回了无法解析的数据") from exc

    def text_provider(self):
        preferred = self._env("COZY_TEXT_PROVIDER").lower()
        if preferred:
            if preferred not in {"openai", "deepseek", "glm", "qwen"}:
                raise RuntimeError("COZY_TEXT_PROVIDER 只支持 openai、deepseek、glm 或 qwen")
            return preferred if self._key(preferred) else ""
        return next((name for name in ("openai", "deepseek", "glm", "qwen") if self._key(name)), "")

    @staticmethod
    def _responses_text(payload):
        if isinstance(payload.get("output_text"), str):
            return payload["output_text"].strip()
        chunks = []
        for output in payload.get("output", []):
            for part in output.get("content", []):
                if isinstance(part.get("text"), str):
                    chunks.append(part["text"])
        return "\n".join(chunks).strip()

    def call_text(self, prompt, provider="", temperature=0.5, max_output_tokens=1200):
        provider = (provider or self.text_provider()).lower()
        if not provider:
            raise RuntimeError("没有配置可用的在线文本模型")
        model = self._model(provider, "text")
        if provider == "openai":
            payload = self._request(provider, "POST", "/responses", {
                "model": model,
                "input": str(prompt),
                "max_output_tokens": int(max_output_tokens),
            }, timeout=120)
            text = self._responses_text(payload)
        else:
            payload = self._request(provider, "POST", "/chat/completions", {
                "model": model,
                "messages": [{"role": "user", "content": str(prompt)}],
                "temperature": float(temperature),
                "max_tokens": int(max_output_tokens),
            }, timeout=120)
            choices = payload.get("choices") or []
            message = choices[0].get("message", {}) if choices else {}
            text = message.get("content", "") if isinstance(message, dict) else ""
            if isinstance(text, list):
                text = "\n".join(str(part.get("text") or "") for part in text if isinstance(part, dict))
            text = str(text).strip()
        if not text:
            raise RuntimeError(f"{provider} 没有返回文字")
        return text, provider

    def generate_image(self, prompt, provider="seedream", **options):
        provider = str(provider or "seedream").lower()
        if provider in {"seedream", "ark"}:
            body = {
                "model": str(options.get("model") or self._model("ark", "image")),
                "prompt": str(prompt),
                "size": str(options.get("size") or "2K"),
                "output_format": str(options.get("output_format") or "png"),
                "response_format": str(options.get("response_format") or "url"),
                "watermark": bool(options.get("watermark", False)),
            }
            images = options.get("images") or options.get("image")
            if images:
                body["image"] = images
            count = int(options.get("count") or 1)
            if count > 1:
                body["sequential_image_generation"] = "auto"
                body["sequential_image_generation_options"] = {"max_images": min(count, 15)}
            payload = self._request("ark", "POST", "/images/generations", body, timeout=180)
            return {"provider": "seedream", "model": payload.get("model") or body["model"],
                    "created": payload.get("created"), "data": payload.get("data") or [],
                    "usage": payload.get("usage") or {}}
        if provider in {"openai", "gpt-image", "gpt_image"}:
            if options.get("images") or options.get("image"):
                raise ValueError("GPT Image 参考图编辑将在编辑接口中单独接入；当前生成接口只接收文字")
            body = {
                "model": str(options.get("model") or self._model("openai", "image")),
                "prompt": str(prompt),
                "size": str(options.get("size") or "1536x1024"),
                "quality": str(options.get("quality") or "high"),
                "output_format": str(options.get("output_format") or "png"),
                "n": min(max(int(options.get("count") or 1), 1), 4),
            }
            payload = self._request("openai", "POST", "/images/generations", body, timeout=180)
            return {"provider": "openai", "model": body["model"], "created": payload.get("created"),
                    "data": payload.get("data") or [], "usage": payload.get("usage") or {}}
        raise ValueError("图片生成 provider 只支持 seedream 或 openai")

    def create_video(self, prompt, provider="seedance", **options):
        if str(provider or "seedance").lower() not in {"seedance", "ark"}:
            raise ValueError("视频生成目前只支持 Seedance")
        content = [{"type": "text", "text": str(prompt)}]
        for image in options.get("images") or []:
            content.append({"type": "image_url", "image_url": {"url": str(image)},
                            "role": str(options.get("image_role") or "reference_image")})
        for video in options.get("videos") or []:
            content.append({"type": "video_url", "video_url": {"url": str(video)}, "role": "reference_video"})
        for audio in options.get("audios") or []:
            content.append({"type": "audio_url", "audio_url": {"url": str(audio)}, "role": "reference_audio"})
        body = {
            "model": str(options.get("model") or self._model("ark", "video")),
            "content": content,
            "generate_audio": bool(options.get("generate_audio", False)),
            "ratio": str(options.get("ratio") or "16:9"),
            "resolution": str(options.get("resolution") or "720p"),
            "duration": min(max(int(options.get("duration") or 5), 3), 30),
            "watermark": bool(options.get("watermark", False)),
        }
        if options.get("callback_url"):
            body["callback_url"] = str(options["callback_url"])
        payload = self._request("ark", "POST", "/contents/generations/tasks", body, timeout=120)
        task_id = str(payload.get("id") or "")
        if not task_id:
            raise RuntimeError("Seedance 没有返回任务 ID")
        return {"provider": "seedance", "remote_id": task_id, "model": body["model"], "status": "queued"}

    def get_video_task(self, task_id):
        task_id = urllib.parse.quote(str(task_id), safe="")
        payload = self._request("ark", "GET", "/contents/generations/tasks/" + task_id, timeout=60)
        content = payload.get("content") if isinstance(payload.get("content"), dict) else {}
        return {
            "provider": "seedance",
            "remote_id": str(payload.get("id") or task_id),
            "model": payload.get("model"),
            "status": str(payload.get("status") or "unknown"),
            "video_url": content.get("video_url") or payload.get("video_url") or "",
            "last_frame_url": content.get("last_frame_url") or "",
            "error": payload.get("error"),
            "usage": payload.get("usage") or {},
            "duration": payload.get("duration"),
            "ratio": payload.get("ratio"),
            "resolution": payload.get("resolution"),
        }

    def status(self):
        text = {}
        for provider in ("openai", "deepseek", "glm", "qwen"):
            text[provider] = {"configured": bool(self._key(provider)), "model": self._model(provider, "text")}
        return {
            "text": text,
            "image": {
                "seedream": {"configured": bool(self._key("ark")), "model": self._model("ark", "image")},
                "openai": {"configured": bool(self._key("openai")), "model": self._model("openai", "image")},
            },
            "video": {"seedance": {"configured": bool(self._key("ark")), "model": self._model("ark", "video")}},
        }
