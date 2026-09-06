"""Version 2.0.0 — bounded, deterministic continuous-line raster styles.

The arc scribble is an original implementation inspired by the virtual-path and
tone-controlled loops described by Chiu et al. (2015), not a port of their code.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable, Sequence

from PIL import Image

from plotter_core.importers.raster import effective_pen_width_mm
from plotter_core.importers.tonal_route import DensityMap, build_tonal_route
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


def _segment_distance(point: XY, a: XY, b: XY) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    denominator = dx * dx + dy * dy
    if denominator == 0:
        return math.dist(point, a)
    t = max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator))
    return math.dist(point, (a[0] + t * dx, a[1] + t * dy))


def _rounded_route(
    points: list[XY], amount: float, callback: Progress, budget: int = MAX_VERTICES
) -> list[XY]:
    if amount <= 0 or len(points) < 3:
        return points
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

    for i in range(len(points) - 1):
        for cell in cells(points[i], points[i + 1]):
            grid[cell].add(i)
    rounded: list[XY] = [points[0]]
    samples = max(2, min(7, (budget - 2) // len(points)))
    for i in range(1, len(points) - 1):
        b = points[i]
        if i % 128 == 0:
            _progress(callback, "rounding-travelling-salesman-corners", i, len(points))
        a, c = points[i - 1], points[i + 1]
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
        for edge in nearby - {i, i - 1}:
            radius = min(radius, 0.4 * _segment_distance(b, points[edge], points[edge + 1]))
        if radius <= 1e-8:
            rounded.append(b)
            continue
        entry = (b[0] + (a[0] - b[0]) * radius / before, b[1] + (a[1] - b[1]) * radius / before)
        leave = (b[0] + (c[0] - b[0]) * radius / after, b[1] + (c[1] - b[1]) * radius / after)
        for sample in range(samples):
            t = sample / (samples - 1)
            rounded.append(
                (
                    (1 - t) ** 2 * entry[0] + 2 * (1 - t) * t * b[0] + t * t * leave[0],
                    (1 - t) ** 2 * entry[1] + 2 * (1 - t) * t * b[1] + t * t * leave[1],
                )
            )
    rounded.append(points[-1])
    # Retain an explicit final check as protection against floating-point degeneracy.
    return rounded if crossing_pair(rounded, callback) is None else points


def _arc_geometry(
    darkness: float, recipe: ProjectRecipe, pen_width: float
) -> tuple[float, float, float]:
    settings = recipe.raster_vectorize
    if darkness <= settings.single_line_min_darkness:
        return 0.0, pen_width, pen_width
    minimum = max(settings.arc_min_radius_mm, pen_width * 1.2)
    maximum = max(minimum, settings.arc_max_radius_mm)
    # Loops fade out in highlights; white connectors do not acquire thick circular sleeves.
    fade = min(1.0, darkness / 0.22)
    radius = (minimum + (maximum - minimum) * (1 - darkness)) * fade
    # Sub-pen loop advances redraw the same ink. Bound overlap in physical units instead.
    pitch = max(pen_width, radius * (2.6 - settings.arc_overlap))
    length_factor = math.sqrt(1 + (math.tau * radius / pitch) ** 2)
    ink_width = min(2 * radius + pen_width, pen_width * length_factor)
    return radius, pitch, max(pen_width, ink_width)


class _CurveBudgetReached(Exception):
    pass


def _arc_scribble(
    route: list[XY],
    tone: Tone,
    recipe: ProjectRecipe,
    pen_width: float,
    callback: Progress,
) -> list[XY]:
    settings, placement = recipe.raster_vectorize, tone.placement
    tolerance = pen_width * {"draft": 0.14, "standard": 0.08, "export": 0.04}[recipe.mode.quality]
    points: list[XY] = []
    phase = 0.0
    for i in range(len(route) - 1):
        a, b = route[i], route[i + 1]
        length = math.dist(a, b)
        travelled = 0.0
        while travelled < length:
            t = travelled / length
            x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            dark = tone(x, y)
            dark = (
                0.0
                if dark <= settings.single_line_min_darkness
                else min(1.0, dark * settings.single_line_ink_density)
            )
            radius, pitch, _ = _arc_geometry(dark, recipe, pen_width)
            clearance = max(
                0.0,
                min(
                    x - placement.x_mm,
                    y - placement.y_mm,
                    placement.x_mm + placement.width_mm - x,
                    placement.y_mm + placement.height_mm - y,
                ),
            )
            radius = min(radius, clearance)
            point = (x + radius * math.cos(phase), y + radius * math.sin(phase))
            if not points or math.dist(points[-1], point) > 1e-8:
                if len(points) >= MAX_VERTICES - 1:
                    raise _CurveBudgetReached
                points.append(point)
            angle = min(
                math.pi / 3, 2 * math.acos(max(-1.0, 1 - tolerance / max(radius, tolerance)))
            )
            step = min(
                length - travelled,
                pitch * angle / math.tau if radius > pen_width * 0.1 else max(pen_width, 0.5),
            )
            phase += math.tau * step / pitch
            travelled += step
            if len(points) % 512 == 0:
                _progress(callback, "filling-tonal-arcs", i, len(route) - 1)
    if route:
        points.append(route[-1])
    return points


def _drawing_pen_width(recipe: ProjectRecipe) -> float:
    """Use the same layer selection as the planner, ignoring unrelated colour passes."""
    layer_id = f"layer-raster-{recipe.raster_vectorize.algorithm}"
    pens = {pen.pen_id: pen.tip_width_mm for pen in recipe.pen_palette}
    widths = [
        pens[plot_pass.pen_profile_id]
        for plot_pass in recipe.passes
        if plot_pass.enabled
        and plot_pass.pen_profile_id in pens
        and (
            layer_id in plot_pass.source_layer_ids
            if plot_pass.source_layer_ids
            else plot_pass.semantic_role == "structure"
        )
    ]
    return min(widths) if widths else effective_pen_width_mm(recipe)


def single_line_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    placement: RasterPlacement,
    callback: Progress = None,
    *,
    warnings: list[str] | None = None,
) -> list[list[XY]]:
    settings = recipe.raster_vectorize
    if settings.algorithm == "spiral-wave":
        return [spiral_wave(image, recipe, placement, callback)]
    pen_width = _drawing_pen_width(recipe)
    tone = Tone(image, placement, settings.single_line_gamma)
    arcs = settings.algorithm == "arc-scribble"
    detail_scale = 1.0
    adjusted = False

    def coverage(value: int) -> float:
        dark = (1 - value / 255) ** settings.single_line_gamma
        return (
            0.0
            if dark <= settings.single_line_min_darkness
            else min(1.0, dark * settings.single_line_ink_density)
        )

    while True:
        drawing_width = pen_width * detail_scale

        def ink_width(dark: float, width_mm: float = drawing_width) -> float:
            width = _arc_geometry(dark, recipe, width_mm)[2] if arcs else width_mm
            # Raster coverage calibration: compensate for joins and repeated ink in
            # loops, with extra density near black to close the remaining paper gaps.
            return width * (0.68 if arcs else 0.8) * (1 - 0.16 * dark**4)

        field = DensityMap(image, placement, coverage, ink_width)
        point_budget = (
            MAX_VERTICES // 2 if arcs or settings.tsp_smoothing > 0 else int(MAX_VERTICES * 0.9)
        )
        route, limited = build_tonal_route(
            field,
            pen_width,
            recipe.mode.seed,
            1 + settings.single_line_edge_bias,
            point_budget,
            callback,
        )
        adjusted = adjusted or limited
        if not route:
            return []
        if not arcs:
            adjusted = adjusted or (settings.tsp_smoothing > 0 and len(route) * 7 > MAX_VERTICES)
            result = _rounded_route(route, settings.tsp_smoothing * 0.4, callback, MAX_VERTICES)
            break
        try:
            result = _arc_scribble(route, tone, recipe, drawing_width, callback)
            break
        except _CurveBudgetReached:
            # Rebuild the whole image with wider, less redundant curves. Tone remains
            # absolute and the complete image is covered on every successful attempt.
            detail_scale *= 1.5
            adjusted = True
            _progress(callback, "adapting-curve-detail", 0, 1)
    if adjusted and warnings is not None:
        warnings.append(
            "Detail was reduced to finish the complete image within the output budget; "
            "shading may be lighter. "
            "A wider pen or smaller image placement allows finer tonal detail."
        )
    return [result]
