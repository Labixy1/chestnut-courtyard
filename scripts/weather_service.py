#!/usr/bin/env python3
"""Cached local weather for the estate panorama."""

from __future__ import annotations

import json
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


WEATHER_CACHE_SECONDS = 2 * 60 * 60
LOCATION_CACHE_HOURS = 6
DEFAULT_LOCATION = {
    "city": "杭州",
    "region": "浙江",
    "country": "中国",
    "latitude": 30.2741,
    "longitude": 120.1551,
    "timezone": "Asia/Shanghai",
}
PLACE_NAMES = {
    "Hangzhou": "杭州", "Zhejiang": "浙江", "Shanghai": "上海", "Beijing": "北京",
    "Shenzhen": "深圳", "Guangzhou": "广州", "Chengdu": "成都", "Nanjing": "南京",
    "Suzhou": "苏州", "Wuhan": "武汉", "China": "中国", "CN": "中国",
}


def localized_place(value) -> str:
    text = str(value or "")
    return PLACE_NAMES.get(text, text)


def scene_for(weather_code: int, local_time: str) -> str:
    """Map WMO weather and local hour to one of the supplied scene assets."""
    if weather_code in {71, 73, 75, 77, 85, 86}:
        return "snow"
    if weather_code in {45, 48}:
        return "fog"
    if weather_code in {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}:
        return "rain"
    if weather_code in {2, 3}:
        return "overcast"
    try:
        hour = datetime.fromisoformat(local_time).hour
    except (TypeError, ValueError):
        hour = datetime.now().astimezone().hour
    return "morning" if 5 <= hour < 10 else "sunny"


def weather_label(weather_code: int) -> str:
    if weather_code in {71, 73, 75, 77, 85, 86}:
        return "下雪"
    if weather_code in {45, 48}:
        return "有雾"
    if weather_code in {51, 53, 55, 56, 57}:
        return "小雨"
    if weather_code in {61, 63, 65, 66, 67, 80, 81, 82}:
        return "下雨"
    if weather_code in {95, 96, 99}:
        return "雷雨"
    if weather_code in {2, 3}:
        return "阴天"
    if weather_code == 1:
        return "晴间多云"
    return "晴天"


class WeatherService:
    def __init__(self, root: Path):
        self.cache_path = root / "core/weather_cache.json"
        self.lock = threading.RLock()

    @staticmethod
    def _now() -> datetime:
        return datetime.now().astimezone()

    @staticmethod
    def _read_json(path: Path, fallback):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeError):
            return fallback

    @staticmethod
    def _write_json(path: Path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(path)

    @staticmethod
    def _fetch_json(url: str, timeout: int = 10):
        request = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 CozyEstate/1.0",
        })
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def _age_seconds(iso_time: str) -> float:
        try:
            return max(0, (datetime.now().astimezone() - datetime.fromisoformat(iso_time)).total_seconds())
        except (TypeError, ValueError):
            return float("inf")

    @staticmethod
    def _local_now(timezone: str) -> str:
        try:
            return datetime.now(ZoneInfo(timezone)).isoformat(timespec="minutes")
        except Exception:
            return datetime.now().astimezone().isoformat(timespec="minutes")

    def _refresh_scene_time(self, payload: dict) -> dict:
        location = dict(payload.get("location") or {})
        for key in ("city", "region", "country"):
            location[key] = localized_place(location.get(key))
        result = {**payload, "location": location, "current": dict(payload.get("current") or {})}
        current = result["current"]
        local_now = self._local_now(str(current.get("timezone") or (payload.get("location") or {}).get("timezone") or ""))
        current["local_now"] = local_now
        current["scene"] = scene_for(int(current.get("weather_code", 0)), local_now)
        return result

    def _resolve_location(self, cache: dict) -> dict:
        cached = cache.get("location") if isinstance(cache.get("location"), dict) else {}
        if cached:
            cached = {
                **cached,
                "city": localized_place(cached.get("city")),
                "region": localized_place(cached.get("region")),
                "country": localized_place(cached.get("country")),
            }
        if cached and self._age_seconds(cached.get("resolved_at", "")) < LOCATION_CACHE_HOURS * 3600:
            return cached

        providers = (
            ("https://ipinfo.io/json", self._location_from_ipinfo),
            ("https://api.ip.sb/geoip", self._location_from_ipsb),
        )
        for url, parser in providers:
            try:
                location = parser(self._fetch_json(url))
                if location:
                    location["resolved_at"] = self._now().isoformat(timespec="seconds")
                    return location
            except Exception:
                continue
        if cached:
            return cached
        return {**DEFAULT_LOCATION, "resolved_at": self._now().isoformat(timespec="seconds"), "fallback": True}

    @staticmethod
    def _location_from_ipinfo(data: dict):
        parts = str(data.get("loc") or "").split(",")
        if len(parts) != 2:
            return None
        return {
            "city": localized_place(data.get("city") or "本地"),
            "region": localized_place(data.get("region") or ""),
            "country": localized_place(data.get("country") or ""),
            "latitude": float(parts[0]),
            "longitude": float(parts[1]),
            "timezone": data.get("timezone") or "auto",
            "source": "ipinfo",
        }

    @staticmethod
    def _location_from_ipsb(data: dict):
        if data.get("latitude") is None or data.get("longitude") is None:
            return None
        return {
            "city": localized_place(data.get("city") or "本地"),
            "region": localized_place(data.get("region") or ""),
            "country": localized_place(data.get("country") or ""),
            "latitude": float(data["latitude"]),
            "longitude": float(data["longitude"]),
            "timezone": data.get("timezone") or "auto",
            "source": "ip.sb",
        }

    def _forecast(self, location: dict) -> dict:
        query = urllib.parse.urlencode({
            "latitude": location["latitude"],
            "longitude": location["longitude"],
            "current": "weather_code,temperature_2m,is_day",
            "timezone": "auto",
        })
        data = self._fetch_json("https://api.open-meteo.com/v1/forecast?" + query)
        current = data.get("current") or {}
        code = int(current.get("weather_code", 0))
        weather_time = str(current.get("time") or self._now().isoformat(timespec="minutes"))
        timezone = data.get("timezone") or location.get("timezone") or "auto"
        local_time = self._local_now(str(timezone))
        temperature = current.get("temperature_2m")
        return {
            "weather_code": code,
            "condition": weather_label(code),
            "temperature": temperature,
            "temperature_unit": (data.get("current_units") or {}).get("temperature_2m", "°C"),
            "local_time": local_time,
            "weather_time": weather_time,
            "is_day": bool(current.get("is_day", 1)),
            "scene": scene_for(code, local_time),
            "timezone": timezone,
        }

    def _fallback(self, cache: dict, error: str = "") -> dict:
        stale = cache.get("current") if isinstance(cache.get("current"), dict) else None
        location = cache.get("location") if isinstance(cache.get("location"), dict) else DEFAULT_LOCATION
        if stale:
            return self._refresh_scene_time({
                "ok": True, "cached": True, "stale": True, "location": location,
                "current": stale, "updated_at": cache.get("updated_at", ""), "error": error[:160],
            })
        now = self._now().isoformat(timespec="minutes")
        current = {
            "weather_code": 0, "condition": "晴天", "temperature": None,
            "temperature_unit": "°C", "local_time": now, "is_day": True,
            "scene": scene_for(0, now), "timezone": location.get("timezone", "auto"),
        }
        return {
            "ok": True, "cached": False, "stale": False, "fallback": True,
            "location": location, "current": current, "updated_at": now, "error": error[:160],
        }

    def current(self, force: bool = False) -> dict:
        with self.lock:
            cache = self._read_json(self.cache_path, {})
            if not force and cache.get("current") and self._age_seconds(cache.get("updated_at", "")) < WEATHER_CACHE_SECONDS:
                return self._refresh_scene_time({"ok": True, "cached": True, "stale": False, **cache})
            try:
                location = self._resolve_location(cache)
                current = self._forecast(location)
                saved = {
                    "version": 1,
                    "updated_at": self._now().isoformat(timespec="seconds"),
                    "location": location,
                    "current": current,
                }
                self._write_json(self.cache_path, saved)
                return self._refresh_scene_time({"ok": True, "cached": False, "stale": False, **saved})
            except Exception as exc:
                return self._fallback(cache, str(exc))
