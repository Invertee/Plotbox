from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass

from plotter_core.models import PenProfile


@dataclass(frozen=True)
class LabColor:
    lightness: float
    a: float
    b: float


@dataclass(frozen=True)
class PenColorSuggestion:
    pen_id: str
    display_color: str
    delta_e: float


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value) is None:
        raise ValueError("color must use six-digit #RRGGBB notation")
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))  # type: ignore[return-value]


def rgb_to_lab(rgb: tuple[int, int, int]) -> LabColor:
    linear = []
    for channel in rgb:
        normalized = channel / 255
        linear.append(
            normalized / 12.92 if normalized <= 0.04045 else ((normalized + 0.055) / 1.055) ** 2.4
        )
    red, green, blue = linear
    x = (0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047
    y = 0.2126729 * red + 0.7151522 * green + 0.072175 * blue
    z = (0.0193339 * red + 0.119192 * green + 0.9503041 * blue) / 1.08883

    def pivot(value: float) -> float:
        delta = 6 / 29
        return value ** (1 / 3) if value > delta**3 else value / (3 * delta**2) + 4 / 29

    fx, fy, fz = pivot(x), pivot(y), pivot(z)
    return LabColor(
        lightness=116 * fy - 16,
        a=500 * (fx - fy),
        b=200 * (fy - fz),
    )


def delta_e(first: LabColor, second: LabColor) -> float:
    return math.sqrt(
        (first.lightness - second.lightness) ** 2
        + (first.a - second.a) ** 2
        + (first.b - second.b) ** 2
    )


def suggest_nearest_pen(
    source_color: str,
    pens: Iterable[PenProfile],
) -> PenColorSuggestion | None:
    source = rgb_to_lab(hex_to_rgb(source_color))
    candidates = [
        PenColorSuggestion(
            pen_id=pen.pen_id,
            display_color=pen.display_color,
            delta_e=delta_e(source, rgb_to_lab(hex_to_rgb(pen.display_color))),
        )
        for pen in pens
    ]
    return min(candidates, key=lambda item: (item.delta_e, item.pen_id), default=None)
