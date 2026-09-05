"""Version 1.0.0 — bounded, deterministic continuous-line raster styles.

The arc scribble is an original implementation inspired by the virtual-path and
tone-controlled loops described by Chiu et al. (2015), not a port of their code.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from collections.abc import Callable, Sequence

from PIL import Image

from plotter_core.models import ProjectRecipe, RasterPlacement

XY = tuple[float, float]
Progress = Callable[[str, int | None, int | None], None] | None
MAX_VERTICES = 400_000


def _progress(callback: Progress, stage: str, done: int, total: int) -> None:
    if callback:
        callback(stage, done, total)


def _append(points: list[XY], point: XY) -> None:
    if len(points) >= MAX_VERTICES:
        raise ValueError(
            "Single-line detail exceeds 400,000 vertices. Increase spacing, reduce "
            "point count or wave frequency, or select draft quality."
        )
    if not points or math.dist(points[-1], point) > 1e-9:
        points.append(point)


class Tone:
    def __init__(self, image: Image.Image, placement: RasterPlacement, gamma: float) -> None:
        self.width, self.height = image.size
        self.values = list(image.convert("L").getdata())
        self.placement = placement
        self.gamma = gamma

    def __call__(self, x: float, y: float) -> float:
        p = self.placement
        px = max(0.0, min(self.width - 1.0, (x - p.x_mm) / p.width_mm * (self.width - 1)))
        py = max(0.0, min(self.height - 1.0, (1 - (y - p.y_mm) / p.height_mm) * (self.height - 1)))
        ix, iy = int(px), int(py)
        jx, jy = min(ix + 1, self.width - 1), min(iy + 1, self.height - 1)
        fx, fy = px - ix, py - iy
        a = self.values[iy * self.width + ix] * (1 - fx) + self.values[iy * self.width + jx] * fx
        b = self.values[jy * self.width + ix] * (1 - fx) + self.values[jy * self.width + jx] * fx
        return float(max(0.0, 1 - (a * (1 - fy) + b * fy) / 255) ** self.gamma)


def spiral_wave(
    image: Image.Image, recipe: ProjectRecipe, placement: RasterPlacement, callback: Progress
) -> list[XY]:
    settings = recipe.raster_vectorize
    tone = Tone(image, placement, settings.single_line_gamma)
    pitch = settings.spiral_spacing_mm
    amplitude = min(settings.spiral_amplitude_mm, pitch * 0.45)
    radius = min(placement.width_mm, placement.height_mm) / 2 - amplitude
    if radius <= 0:
        raise ValueError("Spiral amplitude is too large for this image placement.")
    cx, cy = placement.x_mm + placement.width_mm / 2, placement.y_mm + placement.height_mm / 2
    growth = pitch / math.tau
    end = radius / growth
    samples = {"draft": 8, "standard": 12, "export": 18}[recipe.mode.quality]
    theta, phase = 0.0, 0.0
    points: list[XY] = [(cx, cy)]
    while theta < end:
        r = growth * theta
        dark = tone(cx + r * math.cos(theta), cy + r * math.sin(theta))
        wavelength = settings.spiral_wavelength_mm / (1 + settings.spiral_frequency_gain * dark)
        ds = min(0.6, wavelength / samples)
        delta = min(0.15, ds / math.hypot(r, growth), end - theta)
        theta += delta
        phase += math.tau * delta * math.hypot(r, growth) / wavelength
        base = growth * theta
        offset = amplitude * dark * min(1.0, base / max(pitch, 0.01)) * math.sin(phase)
        actual = max(0.0, base + offset)
        _append(points, (cx + actual * math.cos(theta), cy + actual * math.sin(theta)))
        if len(points) % 512 == 0:
            _progress(callback, "spiral-waves", round(theta * 1000), round(end * 1000))
    return points


def _sites(tone: Tone, recipe: ProjectRecipe, inset: float, callback: Progress) -> list[XY]:
    settings, p = recipe.raster_vectorize, tone.placement
    width, height = p.width_mm - 2 * inset, p.height_mm - 2 * inset
    if min(width, height) <= 0:
        raise ValueError("Maximum loop size is too large for this image placement.")
    count = settings.single_line_point_count
    rng = random.Random(f"single-line-v1/{recipe.mode.seed}")
    # Poisson-style rejection keeps distinct sites far above export rounding precision.
    gap = max(0.02, math.sqrt(width * height / count) * 0.18)
    buckets: dict[tuple[int, int], list[XY]] = defaultdict(list)
    points: list[XY] = []
    for attempt in range(count * 80):
        if len(points) >= count:
            break
        if attempt % 256 == 0:
            _progress(callback, "tone-weighted-points", attempt, count * 80)
        x, y = p.x_mm + inset + rng.random() * width, p.y_mm + inset + rng.random() * height
        dark = tone(x, y)
        if dark < settings.single_line_min_darkness:
            continue
        edge = abs(tone(x + gap, y) - tone(x - gap, y))
        edge += abs(tone(x, y + gap) - tone(x, y - gap))
        weight = min(1.0, dark + settings.single_line_edge_bias * edge)
        if rng.random() > weight:
            continue
        cell = (int(x / gap), int(y / gap))
        neighbours = (
            point
            for ix in range(cell[0] - 1, cell[0] + 2)
            for iy in range(cell[1] - 1, cell[1] + 2)
            for point in buckets[(ix, iy)]
        )
        if any(math.dist((x, y), point) < gap for point in neighbours):
            continue
        points.append((x, y))
        buckets[cell].append((x, y))
    return points


def _orientation(a: XY, b: XY, c: XY) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _intersects(a: XY, b: XY, c: XY, d: XY) -> bool:
    if max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0]):
        return False
    if max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1]):
        return False
    return _orientation(a, b, c) * _orientation(a, b, d) <= 0 and (
        _orientation(c, d, a) * _orientation(c, d, b) <= 0
    )


def crossing_pair(points: Sequence[XY], callback: Progress = None) -> tuple[int, int] | None:
    """Find intersecting nonadjacent segments using a deterministic spatial grid."""
    if len(points) < 4:
        return None
    span = max(
        max(p[0] for p in points) - min(p[0] for p in points),
        max(p[1] for p in points) - min(p[1] for p in points),
        0.01,
    )
    cell_size = span / max(1, math.sqrt(len(points)))
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    closed = points[0] == points[-1]
    for i in range(len(points) - 1):
        if i % 256 == 0:
            _progress(callback, "checking-line-crossings", i, len(points) - 1)
        a, b = points[i], points[i + 1]
        cells = [
            (x, y)
            for x in range(
                math.floor(min(a[0], b[0]) / cell_size), math.floor(max(a[0], b[0]) / cell_size) + 1
            )
            for y in range(
                math.floor(min(a[1], b[1]) / cell_size), math.floor(max(a[1], b[1]) / cell_size) + 1
            )
        ]
        candidates = sorted({j for cell in cells for j in grid[cell]})
        for j in candidates:
            if i - j <= 1 or (closed and j == 0 and i == len(points) - 2):
                continue
            if _intersects(a, b, points[j], points[j + 1]):
                return j, i
        for cell in cells:
            grid[cell].append(i)
    return None


def _tour(points: list[XY], callback: Progress) -> list[XY]:
    if len(points) < 3:
        return points
    remaining = set(range(1, len(points)))
    route = [0]
    while remaining:
        if len(route) % 32 == 0:
            _progress(callback, "building-travelling-salesman-route", len(route), len(points))
        last = points[route[-1]]
        nearest = min(remaining, key=lambda i: (math.dist(last, points[i]), i))
        route.append(nearest)
        remaining.remove(nearest)
    ordered = [points[i] for i in route]
    # Each reversal shortens a crossed Euclidean tour. Never return a crossing on budget expiry.
    for swap in range(len(points) * 8):
        _progress(callback, "uncrossing-travelling-salesman-route", swap, len(points) * 8)
        crossing = crossing_pair([*ordered, ordered[0]], callback)
        if crossing is None:
            return ordered
        a, b = crossing
        ordered[a + 1 : b + 1] = reversed(ordered[a + 1 : b + 1])
    raise ValueError("Route optimization limit reached. Reduce single-line point count and retry.")


def _segment_distance(point: XY, a: XY, b: XY) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    denominator = dx * dx + dy * dy
    if denominator == 0:
        return math.dist(point, a)
    t = max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator))
    return math.dist(point, (a[0] + t * dx, a[1] + t * dy))


def _rounded_tour(points: list[XY], amount: float, callback: Progress) -> list[XY]:
    closed = [*points, points[0]]
    if amount <= 0 or len(points) < 3:
        return closed
    span = max(
        max(p[0] for p in points) - min(p[0] for p in points),
        max(p[1] for p in points) - min(p[1] for p in points),
        0.01,
    )
    cell_size = span / math.sqrt(len(points))
    grid: dict[tuple[int, int], set[int]] = defaultdict(set)

    def cells(a: XY, b: XY) -> list[tuple[int, int]]:
        return [
            (x, y)
            for x in range(
                math.floor(min(a[0], b[0]) / cell_size), math.floor(max(a[0], b[0]) / cell_size) + 1
            )
            for y in range(
                math.floor(min(a[1], b[1]) / cell_size), math.floor(max(a[1], b[1]) / cell_size) + 1
            )
        ]

    for i in range(len(points)):
        for cell in cells(closed[i], closed[i + 1]):
            grid[cell].add(i)
    rounded: list[XY] = []
    for i, b in enumerate(points):
        if i % 128 == 0:
            _progress(callback, "rounding-travelling-salesman-corners", i, len(points))
        a, c = points[i - 1], points[(i + 1) % len(points)]
        before, after = math.dist(a, b), math.dist(b, c)
        radius = min(before, after) * amount
        nearby = {
            edge
            for cell in cells(
                (b[0] - radius / 0.4, b[1] - radius / 0.4),
                (b[0] + radius / 0.4, b[1] + radius / 0.4),
            )
            for edge in grid[cell]
        }
        # Keep the curve inside a local disk clear of every nonincident edge.
        # Clearance disks are also disjoint, so rounding nearby corners cannot cross.
        for edge in nearby - {i, (i - 1) % len(points)}:
            radius = min(radius, 0.4 * _segment_distance(b, closed[edge], closed[edge + 1]))
        if radius <= 1e-8:
            rounded.append(b)
            continue
        entry = (b[0] + (a[0] - b[0]) * radius / before, b[1] + (a[1] - b[1]) * radius / before)
        leave = (b[0] + (c[0] - b[0]) * radius / after, b[1] + (c[1] - b[1]) * radius / after)
        for sample in range(7):
            t = sample / 6
            rounded.append(
                (
                    (1 - t) ** 2 * entry[0] + 2 * (1 - t) * t * b[0] + t * t * leave[0],
                    (1 - t) ** 2 * entry[1] + 2 * (1 - t) * t * b[1] + t * t * leave[1],
                )
            )
    rounded.append(rounded[0])
    # Retain an explicit final check as protection against floating-point degeneracy.
    return rounded if crossing_pair(rounded, callback) is None else closed


def _arc_scribble(
    route: list[XY], tone: Tone, recipe: ProjectRecipe, callback: Progress
) -> list[XY]:
    settings = recipe.raster_vectorize
    samples = {"draft": 12, "standard": 20, "export": 28}[recipe.mode.quality]
    points: list[XY] = []
    phase = 0.0
    for i, a in enumerate(route):
        b = route[(i + 1) % len(route)]
        length = math.dist(a, b)
        travelled = 0.0
        while travelled < length:
            t = travelled / length
            x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            dark = tone(x, y)
            radius = settings.arc_min_radius_mm + (
                settings.arc_max_radius_mm - settings.arc_min_radius_mm
            ) * (1 - dark)
            advance = settings.arc_loop_spacing_mm * (1 - 0.9 * dark)
            step = min(length - travelled, advance / samples)
            phase += math.tau * step / advance
            _append(points, (x + radius * math.cos(phase), y + radius * math.sin(phase)))
            travelled += step
            if len(points) % 512 == 0:
                _progress(callback, "drawing-overlapping-arcs", i, len(route))
    return points


def single_line_paths(
    image: Image.Image, recipe: ProjectRecipe, placement: RasterPlacement, callback: Progress = None
) -> list[list[XY]]:
    settings = recipe.raster_vectorize
    if settings.algorithm == "spiral-wave":
        return [spiral_wave(image, recipe, placement, callback)]
    tone = Tone(image, placement, settings.single_line_gamma)
    inset = settings.arc_max_radius_mm if settings.algorithm == "arc-scribble" else 0.02
    sites = _sites(tone, recipe, inset, callback)
    if len(sites) < 3:
        return []
    route = _tour(sites, callback)
    if settings.algorithm == "arc-scribble":
        return [_arc_scribble(route, tone, recipe, callback)]
    return [_rounded_tour(route, settings.tsp_smoothing * 0.4, callback)]
