"""Version 2.0.0 — physically scaled, local image tours with continuous portals."""

from __future__ import annotations

import math
import random
from collections.abc import Callable

from PIL import Image

from plotter_core.models import RasterPlacement

XY = tuple[float, float]
Progress = Callable[[str, int | None, int | None], None] | None


class DensityMap:
    def __init__(
        self,
        image: Image.Image,
        placement: RasterPlacement,
        coverage: Callable[[int], float],
        ink_width: Callable[[float], float],
    ) -> None:
        self.placement = placement
        scale = min(1.0, 512 / max(image.size))
        self.width = max(1, round(image.width * scale))
        self.height = max(1, round(image.height * scale))
        image = image.convert("L").resize((self.width, self.height), Image.Resampling.BOX)
        lookup = [coverage(i) for i in range(256)]
        self.tones = [lookup[int(v)] for v in list(image.getdata())]
        self.values = [(v / max(ink_width(v), 0.01)) ** 2 for v in self.tones]
        self.density = self._integral(self.values)
        self.mean = self._integral(self.tones)
        self.square = self._integral([v * v for v in self.tones])

    def _integral(self, values: list[float]) -> list[float]:
        stride = self.width + 1
        result = [0.0] * (stride * (self.height + 1))
        for y in range(self.height):
            row = 0.0
            for x in range(self.width):
                row += values[y * self.width + x]
                result[(y + 1) * stride + x + 1] = result[y * stride + x + 1] + row
        return result

    def average(self, integral: list[float], box: tuple[float, float, float, float]) -> float:
        x0, y0, x1, y1 = box
        # Normalized route coordinates have a lower-left origin.
        left = max(0, min(self.width - 1, math.floor(x0 * self.width)))
        right = max(left + 1, min(self.width, math.ceil(x1 * self.width)))
        top = max(0, min(self.height - 1, math.floor((1 - y1) * self.height)))
        bottom = max(top + 1, min(self.height, math.ceil((1 - y0) * self.height)))
        stride = self.width + 1
        total = integral[bottom * stride + right] - integral[top * stride + right]
        total -= integral[bottom * stride + left] - integral[top * stride + left]
        return max(0.0, total / ((right - left) * (bottom - top)))


def _cross(a: XY, b: XY, c: XY, d: XY) -> bool:
    def side(p: XY, q: XY, r: XY) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return side(a, b, c) * side(a, b, d) < -1e-16 and side(c, d, a) * side(c, d, b) < -1e-16


def _local_tour(start: XY, end: XY, sites: list[XY]) -> list[XY]:
    """Small fixed-endpoint TSP heuristic; all segments stay inside their own tile."""
    route = [start]
    remaining = list(sites)
    while remaining:
        nearest = min(range(len(remaining)), key=lambda i: math.dist(route[-1], remaining[i]))
        route.append(remaining.pop(nearest))
    route.append(end)
    # Local 2-opt shortens the path while preserving the entry and exit portals.
    for _ in range(8):
        changed = False
        for i in range(len(route) - 3):
            a, b = route[i], route[i + 1]
            for j in range(i + 2, len(route) - 1):
                c, d = route[j], route[j + 1]
                if math.dist(a, c) + math.dist(b, d) < math.dist(a, b) + math.dist(c, d) - 1e-9:
                    route[i + 1 : j + 1] = reversed(route[i + 1 : j + 1])
                    b = route[i + 1]
                    changed = True
        if not changed:
            break
    # Remove any crossings left after the bounded shortening passes.
    while True:
        crossing = next(
            (
                (i, j)
                for i in range(len(route) - 3)
                for j in range(i + 2, len(route) - 1)
                if _cross(route[i], route[i + 1], route[j], route[j + 1])
            ),
            None,
        )
        if crossing is None:
            return route
        i, j = crossing
        route[i + 1 : j + 1] = reversed(route[i + 1 : j + 1])


def build_tonal_route(
    field: DensityMap,
    pen_width: float,
    seed: str,
    detail: float,
    point_budget: int,
    callback: Progress = None,
) -> tuple[list[XY], bool]:
    p = field.placement
    area = p.width_mm * p.height_mm
    total = field.average(field.density, (0, 0, 1, 1)) * area
    if total <= 1e-8:
        return [], False
    scale = min(1.0, point_budget / max(total, 1))
    adjusted = scale < 1

    def generate(scale: float) -> list[XY]:
        route: list[XY] = []
        rng = random.Random("tonal-route-v2/" + seed)
        tiles = 0
        inset = min(pen_width * 0.04, min(p.width_mm, p.height_mm) / 4096)

        def visit(
            x: float, y: float, ax: float, ay: float, bx: float, by: float, depth: int
        ) -> None:
            nonlocal tiles
            corners = [(x, y), (x + ax, y + ay), (x + bx, y + by), (x + ax + bx, y + ay + by)]
            box = (
                min(c[0] for c in corners),
                min(c[1] for c in corners),
                max(c[0] for c in corners),
                max(c[1] for c in corners),
            )
            width, height = (box[2] - box[0]) * p.width_mm, (box[3] - box[1]) * p.height_mm
            expected = field.average(field.density, box) * width * height * scale
            mean = field.average(field.mean, box)
            variance = field.average(field.square, box) - mean * mean
            split = expected > 42 or (
                expected > 3
                and variance > 0.008 / max(0.25, detail)
                and max(width, height) > max(pen_width * 6, 1.5)
            )
            if split and depth < 10:
                visit(x, y, bx / 2, by / 2, ax / 2, ay / 2, depth + 1)
                visit(x + ax / 2, y + ay / 2, ax / 2, ay / 2, bx / 2, by / 2, depth + 1)
                visit(
                    x + ax / 2 + bx / 2,
                    y + ay / 2 + by / 2,
                    ax / 2,
                    ay / 2,
                    bx / 2,
                    by / 2,
                    depth + 1,
                )
                visit(
                    x + ax / 2 + bx, y + ay / 2 + by, -bx / 2, -by / 2, -ax / 2, -ay / 2, depth + 1
                )
                return
            tiles += 1
            if callback and tiles % 64 == 0:
                callback("routing-image-tones", len(route), round(total * scale))
            # All leaves share the same physical corner offset, even at different depths.
            # Neighbouring Hilbert portals meet across their shared boundary.
            alength = math.hypot(ax * p.width_mm, ay * p.height_mm)
            blength = math.hypot(bx * p.width_mm, by * p.height_mm)
            ea, eb = min(0.1, inset / alength), min(0.1, inset / blength)

            def world(u: float, v: float) -> XY:
                return (
                    p.x_mm + (x + u * ax + v * bx) * p.width_mm,
                    p.y_mm + (y + u * ay + v * by) * p.height_mm,
                )

            start, end = world(ea, eb), world(ea, 1 - eb)
            count = max(0, round(expected) - 2)
            # Stratified sites avoid the holes and clumps of independent random samples.
            rows = max(1, round(math.sqrt(max(count, 1) * blength / alength)))
            sites: list[XY] = []
            for row in range(rows):
                columns = round(count * (row + 1) / rows) - round(count * row / rows)
                for col in range(columns):
                    u = (col + 0.5 + rng.uniform(-0.18, 0.18)) / columns
                    v = (row + 0.5 + rng.uniform(-0.18, 0.18)) / rows
                    sites.append(world(ea + u * (1 - 2 * ea), eb + v * (1 - 2 * eb)))
            route.extend(_local_tour(start, end, sites))

        visit(0, 0, 1, 0, 0, 1, 0)
        return route

    # Retrying scales the complete image; it never returns a partially drawn route.
    while True:
        route = generate(scale)
        if len(route) <= point_budget:
            return route, adjusted
        scale *= min(0.8, point_budget / len(route) * 0.9)
        adjusted = True
