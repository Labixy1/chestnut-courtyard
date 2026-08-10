#!/usr/bin/env python3
"""Build lightweight WebP backgrounds while keeping source artwork intact."""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]

DESKTOP = [
    *(f"assets/estate/panorama{name}.webp" for name in ("", "_morning", "_snow", "_rain", "_overcast", "_fog")),
    "assets/estate/heart_hollow.webp",
    "assets/travel/travel_postcard.webp",
    "assets/interior/bedroom_day.webp",
    "assets/interior/bedroom_night.webp",
    "assets/photos/photo_wall.webp",
    "assets/news/noticeboard.webp",
]

MOBILE = [
    *(f"assets/estate/panorama{name}_mobile.webp" for name in ("", "_morning", "_snow", "_rain", "_overcast", "_fog", "_thunder")),
    "assets/estate/heart_hollow_mobile.webp",
    "assets/travel/travel_postcard_mobile.webp",
    "assets/interior/bedroom_day_mobile.webp",
    "assets/interior/bedroom_night_mobile.webp",
    "assets/photos/photo_wall_mobile.webp",
    "assets/plants/orchard_field_mobile.webp",
]

DERIVED = {
    "assets/plants/orchard_field.jpg": "assets/plants/orchard_field.webp",
    "assets/plants/orchard_spring.jpg": "assets/plants/orchard_spring.webp",
    "assets/plants/orchard_summer.jpg": "assets/plants/orchard_summer.webp",
    "assets/plants/orchard_autumn.jpg": "assets/plants/orchard_autumn.webp",
    "assets/plants/orchard_winter.jpg": "assets/plants/orchard_winter.webp",
}


def optimize(source_name, output_name=None, max_width=1440, quality=66):
    source = ROOT / source_name
    output = ROOT / (output_name or source_name)
    before = output.stat().st_size if output.exists() else source.stat().st_size
    with Image.open(source) as image:
        image = image.convert("RGB")
        if source == output and image.width <= max_width:
            print(f"{output.relative_to(ROOT)}: already optimized, {image.width}x{image.height}")
            return before, before
        if image.width > max_width:
            height = round(image.height * max_width / image.width)
            image = image.resize((max_width, height), Image.Resampling.LANCZOS)
        image.save(output, "WEBP", quality=quality, method=6)
        dimensions = image.size
    after = output.stat().st_size
    print(f"{output.relative_to(ROOT)}: {before // 1024} KB -> {after // 1024} KB, {dimensions[0]}x{dimensions[1]}")
    return before, after


def main():
    totals = [0, 0]
    for name in DESKTOP:
        before, after = optimize(name, max_width=1440, quality=66)
        totals[0] += before
        totals[1] += after
    for name in MOBILE:
        before, after = optimize(name, max_width=900, quality=62)
        totals[0] += before
        totals[1] += after
    for source, output in DERIVED.items():
        before, after = optimize(source, output, max_width=1600, quality=66)
        totals[0] += before
        totals[1] += after
    saved = totals[0] - totals[1]
    print(f"total: {totals[0] / 1024 / 1024:.2f} MB -> {totals[1] / 1024 / 1024:.2f} MB; saved {saved / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
