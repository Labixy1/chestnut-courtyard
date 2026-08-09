#!/usr/bin/env python3
"""Offline contract tests for model and media gateways."""

from __future__ import annotations

import base64
import json
import tempfile
from pathlib import Path

from event_ledger import EventLedger
from media_service import MediaService
from model_gateway import ModelGateway


class FakeGateway(ModelGateway):
    def __init__(self):
        super().__init__({
            "OPENAI_API_KEY": "test", "ARK_API_KEY": "test", "DEEPSEEK_API_KEY": "test", "GEMINI_API_KEY": "test",
            "COZY_OPENAI_IMAGE_MODEL": "gpt-image-2", "COZY_SEEDREAM_MODEL": "seedream-test",
            "COZY_SEEDANCE_MODEL": "seedance-test", "COZY_GEMINI_IMAGE_MODEL": "gemini-image-test",
        })
        self.calls = []
        self.video_checks = 0

    def _request(self, provider, method, path, body=None, timeout=120):
        self.calls.append({"provider": provider, "method": method, "path": path, "body": body})
        if path == "/responses":
            return {"output_text": "online"}
        if path == "/chat/completions":
            return {"choices": [{"message": {"content": "compatible"}}]}
        if path == "/images/generations":
            return {"model": body["model"], "data": [{"b64_json": base64.b64encode(b"fake-png").decode("ascii")}], "usage": {"generated_images": 1}}
        if provider == "gemini" and path.endswith(":generateContent"):
            return {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(b"fake-gemini-png").decode("ascii")}}]}}], "usageMetadata": {"totalTokenCount": 42}}
        if method == "POST" and path == "/contents/generations/tasks":
            return {"id": "remote-video-1"}
        if method == "GET" and path.endswith("remote-video-1"):
            self.video_checks += 1
            return {"id": "remote-video-1", "status": "running", "content": {}, "usage": {}}
        raise AssertionError((provider, method, path))


class FallbackGateway(FakeGateway):
    def __init__(self):
        super().__init__()
        self.environ.update({
            "COZY_TEXT_PROVIDER": "deepseek",
            "COZY_TEXT_FALLBACK_PROVIDER": "openai",
            "COZY_OPENAI_MODEL": "gpt-5.6-luna",
            "COZY_OPENAI_TIMEOUT": "35",
            "COZY_DEEPSEEK_MODEL": "deepseek-v4-flash",
        })

    def _request(self, provider, method, path, body=None, timeout=120):
        if provider == "deepseek" and path == "/chat/completions":
            raise RuntimeError("simulated primary timeout")
        return super()._request(provider, method, path, body, timeout)


def main():
    gateway = FakeGateway()
    text, provider = gateway.call_text("hello", "openai")
    assert text == "online" and provider == "openai"
    text, provider = gateway.call_text("hello", "deepseek")
    assert text == "compatible" and provider == "deepseek"

    fallback = FallbackGateway()
    assert fallback.text_providers() == ["deepseek", "openai"]
    text, provider = fallback.call_text_with_fallback("hello")
    assert text == "online" and provider == "openai"
    assert fallback.status()["text_route"] == ["deepseek", "openai"]

    seedream = gateway.generate_image("院子", "seedream", size="2K")
    assert seedream["model"] == "seedream-test"
    assert gateway.calls[-1]["path"] == "/images/generations"
    assert gateway.calls[-1]["body"]["watermark"] is False
    assert "output_format" not in gateway.calls[-1]["body"]

    openai = gateway.generate_image("院子", "openai", size="1536x1024")
    assert openai["model"] == "gpt-image-2"
    assert gateway.calls[-1]["body"]["quality"] == "high"

    gemini = gateway.generate_image("院子", "nano-banana")
    assert gemini["model"] == "gemini-image-test" and gemini["data"][0]["b64_json"]
    assert gateway.calls[-1]["provider"] == "gemini" and gateway.calls[-1]["path"].endswith(":generateContent")

    video = gateway.create_video("风吹过树叶", duration=5, ratio="16:9")
    assert video["remote_id"] == "remote-video-1"
    assert gateway.calls[-1]["body"]["duration"] == 5

    with tempfile.TemporaryDirectory(prefix="cozy_gateway_test_") as directory:
        root = Path(directory)
        service = MediaService(root, gateway)
        task = service.generate_image({"kind": "image", "provider": "seedream", "prompt": "清晨小院"})
        assert task["status"] == "succeeded" and (root / task["outputs"][0]["file"]).exists()
        video_task = service.create_video({"kind": "video", "provider": "seedance", "prompt": "五秒树影"})
        refreshed = service.refresh_video(video_task["id"])
        assert refreshed["status"] == "running" and gateway.video_checks == 1

        ledger = EventLedger(root)
        saved = ledger.append({"context": "board", "action": "open", "detail": {"message": "private", "path": "/api/state"}})
        line = next((root / "core/ledger").glob("*.jsonl")).read_text(encoding="utf-8")
        assert saved["action"] == "open" and "private" not in line and json.loads(line)["detail"]["path"] == "/api/state"

    print("model gateway test ok: text providers; Seedream; GPT Image; Nano Banana; Seedance; persistence; ledger redaction")


if __name__ == "__main__":
    main()
