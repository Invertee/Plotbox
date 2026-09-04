from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def add_algorithm(path: str) -> None:
    target = ROOT / path
    content = target.read_text(encoding="utf-8")
    old = '                    "squiggle",\n                    "tone-contour",'
    if path.endswith("test_api.py"):
        old = '        "squiggle",\n        "tone-contour",'
        new = '        "squiggle",\n        "circular-scribble",\n        "tone-contour",'
    else:
        new = '                    "squiggle",\n                    "circular-scribble",\n                    "tone-contour",'
    if old not in content:
        raise RuntimeError(f"expected raster algorithm list not found in {path}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


add_algorithm("services/api/plotterapp_api/main.py")
add_algorithm("services/api/tests/test_api.py")
