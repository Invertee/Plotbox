from __future__ import annotations

import base64
import io
import math
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any, cast

from PIL import Image, ImageFilter

from plotter_core.importers.raster import preprocess_color_image, preprocess_raster
from plotter_core.models import (
    DesignDiagnostic,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    ProjectRecipe,
    RasterPlacement,
    RasterPreview,
    RasterPreviewWarning,
    canonical_sha256,
)

ProgressCallback = Callable[[str, int | None, int | None], None]
Pixel = tuple[int, int]
FloatPoint = tuple[float, float]

RASTER_VECTORIZER_ID = "import.raster"
RASTER_VECTORIZER_VERSION = "1.1.0"
DITHER_VECTORIZER_VERSION = "1.0.0"
STIPPLE_VECTORIZER_VERSION = "1.0.0"
CIRCULAR_SCRIBBLE_VECTORIZER_VERSION = "1.0.0"
WORKING_PIXEL_LIMITS = {"draft": 250_000, "standard": 750_000, "export": 1_500_000}
NEIGHBOURS_8: tuple[Pixel, ...] = (
    (-1, -1),
    (0, -1),
    (1, -1),
    (-1, 0),
    (1, 0),
    (-1, 1),
    (0, 1),
    (1, 1),
)


@dataclass(frozen=True)
class VectorizationResult:
    paths: list[list[FloatPoint]]
    removed_components: int = 0
    removed_segments: int = 0


@dataclass(frozen=True)
class ColorVectorizationResult:
    rgb: tuple[int, int, int]
    pixel_count: int
    paths: list[list[FloatPoint]]
    removed_segments: int = 0


def _checkpoint(
    callback: ProgressCallback | None,
    stage: str,
    completed: int | None,
    total: int | None,
) -> None:
    if callback is not None:
        callback(stage, completed, total)


def _working_image(
    preview: RasterPreview,
    quality: str,
) -> tuple[Image.Image, bool]:
    image = Image.open(io.BytesIO(base64.b64decode(preview.preview_png_base64))).convert("L")
    limit = WORKING_PIXEL_LIMITS[quality]
    if image.width * image.height <= limit:
        return image, False
    scale = math.sqrt(limit / (image.width * image.height))
    size = (
        max(2, math.floor(image.width * scale)),
        max(2, math.floor(image.height * scale)),
    )
    return image.resize(size, Image.Resampling.LANCZOS), True


def _bounded_image(image: Image.Image, quality: str) -> tuple[Image.Image, bool]:
    limit = WORKING_PIXEL_LIMITS[quality]
    if image.width * image.height <= limit:
        return image, False
    scale = math.sqrt(limit / (image.width * image.height))
    size = (
        max(2, math.floor(image.width * scale)),
        max(2, math.floor(image.height * scale)),
    )
    return image.resize(size, Image.Resampling.LANCZOS), True


def _distance(first: FloatPoint, second: FloatPoint) -> float:
    return math.hypot(second[0] - first[0], second[1] - first[1])


def _path_length(points: Sequence[FloatPoint]) -> float:
    return sum(_distance(first, second) for first, second in pairwise(points))


def _point_line_distance(point: FloatPoint, start: FloatPoint, end: FloatPoint) -> float:
    dx, dy = end[0] - start[0], end[1] - start[1]
    denominator = dx * dx + dy * dy
    if denominator == 0:
        return _distance(point, start)
    ratio = max(
        0.0,
        min(
            1.0,
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator,
        ),
    )
    projection = (start[0] + ratio * dx, start[1] + ratio * dy)
    return _distance(point, projection)


def _simplify(points: Sequence[FloatPoint], tolerance: float) -> list[FloatPoint]:
    if len(points) <= 2 or tolerance <= 0:
        return list(points)
    index, maximum = 0, 0.0
    for candidate in range(1, len(points) - 1):
        distance = _point_line_distance(points[candidate], points[0], points[-1])
        if distance > maximum:
            index, maximum = candidate, distance
    if maximum <= tolerance:
        return [points[0], points[-1]]
    left = _simplify(points[: index + 1], tolerance)
    right = _simplify(points[index:], tolerance)
    return [*left[:-1], *right]


def _pixel_to_mm(
    point: FloatPoint,
    width: int,
    height: int,
    placement: RasterPlacement,
) -> FloatPoint:
    x_denominator = max(width - 1, 1)
    y_denominator = max(height - 1, 1)
    return (
        placement.x_mm + point[0] / x_denominator * placement.width_mm,
        placement.y_mm + (1 - point[1] / y_denominator) * placement.height_mm,
    )


def _pixel_paths_to_mm(
    paths: Iterable[Sequence[FloatPoint]],
    *,
    width: int,
    height: int,
    placement: RasterPlacement,
    simplify_tolerance_mm: float,
) -> list[list[FloatPoint]]:
    result: list[list[FloatPoint]] = []
    for path in paths:
        converted = [_pixel_to_mm(point, width, height, placement) for point in path]
        deduplicated = [
            point
            for index, point in enumerate(converted)
            if index == 0 or point != converted[index - 1]
        ]
        simplified = _simplify(deduplicated, simplify_tolerance_mm)
        if len(simplified) >= 2:
            result.append(simplified)
    return result


def _edge_key(first: Pixel, second: Pixel) -> tuple[Pixel, Pixel]:
    return (first, second) if first < second else (second, first)


def _pixel_adjacency(nodes: set[Pixel]) -> dict[Pixel, list[Pixel]]:
    return {
        node: [
            (node[0] + dx, node[1] + dy)
            for dx, dy in NEIGHBOURS_8
            if (node[0] + dx, node[1] + dy) in nodes
        ]
        for node in nodes
    }


def _components(adjacency: dict[Pixel, list[Pixel]]) -> list[set[Pixel]]:
    unseen = set(adjacency)
    result: list[set[Pixel]] = []
    while unseen:
        seed = min(unseen)
        component: set[Pixel] = set()
        pending = [seed]
        unseen.remove(seed)
        while pending:
            node = pending.pop()
            component.add(node)
            for neighbour in adjacency[node]:
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    pending.append(neighbour)
        result.append(component)
    return result


def _trace_graph(adjacency: dict[Pixel, list[Pixel]]) -> list[list[FloatPoint]]:
    visited: set[tuple[Pixel, Pixel]] = set()
    paths: list[list[FloatPoint]] = []

    def follow(start: Pixel, neighbour: Pixel) -> list[FloatPoint]:
        points: list[FloatPoint] = [(float(start[0]), float(start[1]))]
        previous, current = start, neighbour
        visited.add(_edge_key(previous, current))
        points.append((float(current[0]), float(current[1])))
        while len(adjacency[current]) == 2:
            candidates = [item for item in adjacency[current] if item != previous]
            if not candidates:
                break
            following = candidates[0]
            key = _edge_key(current, following)
            if key in visited:
                break
            previous, current = current, following
            visited.add(key)
            points.append((float(current[0]), float(current[1])))
        return points

    starts = sorted(node for node, neighbours in adjacency.items() if len(neighbours) != 2)
    for start in starts:
        for neighbour in sorted(adjacency[start]):
            if _edge_key(start, neighbour) not in visited:
                paths.append(follow(start, neighbour))
    for start in sorted(adjacency):
        for neighbour in sorted(adjacency[start]):
            if _edge_key(start, neighbour) not in visited:
                paths.append(follow(start, neighbour))
    return paths


def _filter_pixel_components(
    nodes: set[Pixel],
    *,
    minimum_length_mm: float,
    mm_per_pixel: float,
) -> tuple[dict[Pixel, list[Pixel]], int]:
    adjacency = _pixel_adjacency(nodes)
    kept: set[Pixel] = set()
    removed = 0
    for component in _components(adjacency):
        edge_length_px = sum(
            math.hypot(neighbour[0] - node[0], neighbour[1] - node[1])
            for node in component
            for neighbour in adjacency[node]
            if node < neighbour
        )
        if edge_length_px * mm_per_pixel < minimum_length_mm:
            removed += 1
        else:
            kept.update(component)
    return _pixel_adjacency(kept), removed


def _edge_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
) -> VectorizationResult:
    edges = image.filter(ImageFilter.FIND_EDGES)
    threshold = recipe.raster_vectorize.edge_threshold
    pixels = cast(Any, edges.load())
    nodes = {
        (x, y)
        for y in range(1, image.height - 1)
        for x in range(1, image.width - 1)
        if pixels[x, y] >= threshold
    }
    nodes = _thin(nodes, None)
    mm_per_pixel = max(
        preview.placement.width_mm / max(image.width - 1, 1),
        preview.placement.height_mm / max(image.height - 1, 1),
    )
    adjacency, removed = _filter_pixel_components(
        nodes,
        minimum_length_mm=recipe.raster_vectorize.edge_min_component_length_mm,
        mm_per_pixel=mm_per_pixel,
    )
    paths = _pixel_paths_to_mm(
        _trace_graph(adjacency),
        width=image.width,
        height=image.height,
        placement=preview.placement,
        simplify_tolerance_mm=recipe.geometry.simplification_tolerance_mm,
    )
    return VectorizationResult(paths=paths, removed_components=removed)


def _transitions(neighbours: Sequence[bool]) -> int:
    return sum(
        not neighbours[index] and neighbours[(index + 1) % len(neighbours)]
        for index in range(len(neighbours))
    )


def _thin(nodes: set[Pixel], checkpoint: ProgressCallback | None) -> set[Pixel]:
    iteration = 0
    maximum_iterations = max(
        max((x for x, _ in nodes), default=0),
        max((y for _, y in nodes), default=0),
    )
    maximum_iterations = max(1, maximum_iterations)
    while nodes:
        changed = False
        for second_pass in (False, True):
            remove: set[Pixel] = set()
            for x, y in nodes:
                neighbours = [
                    (x, y - 1) in nodes,
                    (x + 1, y - 1) in nodes,
                    (x + 1, y) in nodes,
                    (x + 1, y + 1) in nodes,
                    (x, y + 1) in nodes,
                    (x - 1, y + 1) in nodes,
                    (x - 1, y) in nodes,
                    (x - 1, y - 1) in nodes,
                ]
                count = sum(neighbours)
                if not 2 <= count <= 6 or _transitions(neighbours) != 1:
                    continue
                north, east, south, west = (
                    neighbours[0],
                    neighbours[2],
                    neighbours[4],
                    neighbours[6],
                )
                if second_pass:
                    condition = not (north and east and west) and not (north and south and west)
                else:
                    condition = not (north and east and south) and not (east and south and west)
                if condition:
                    remove.add((x, y))
            if remove:
                nodes.difference_update(remove)
                changed = True
        iteration += 1
        _checkpoint(checkpoint, "skeletonize", iteration, maximum_iterations)
        if not changed or iteration >= maximum_iterations:
            break
    return nodes


def _centerline_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    threshold = recipe.raster_vectorize.centerline_threshold
    pixels = cast(Any, image.load())
    nodes = {
        (x, y) for y in range(image.height) for x in range(image.width) if pixels[x, y] <= threshold
    }
    skeleton = _thin(nodes, checkpoint)
    adjacency = _pixel_adjacency(skeleton)
    pixel_paths = _trace_graph(adjacency)
    converted = _pixel_paths_to_mm(
        pixel_paths,
        width=image.width,
        height=image.height,
        placement=preview.placement,
        simplify_tolerance_mm=recipe.geometry.simplification_tolerance_mm,
    )
    minimum = max(
        recipe.raster_vectorize.minimum_segment_length_mm,
        recipe.raster_vectorize.centerline_prune_length_mm,
    )
    kept = [path for path in converted if _path_length(path) >= minimum]
    return VectorizationResult(paths=kept, removed_segments=len(converted) - len(kept))


def _sample_luminance(
    pixels: object,
    width: int,
    height: int,
    placement: RasterPlacement,
    point: FloatPoint,
) -> int:
    x = round((point[0] - placement.x_mm) / placement.width_mm * (width - 1))
    y = round((1 - (point[1] - placement.y_mm) / placement.height_mm) * (height - 1))
    x = min(width - 1, max(0, x))
    y = min(height - 1, max(0, y))
    return int(pixels[x, y])  # type: ignore[index]


def _line_rectangle_interval(
    origin: FloatPoint,
    direction: FloatPoint,
    placement: RasterPlacement,
) -> tuple[float, float] | None:
    minimums = (placement.x_mm, placement.y_mm)
    maximums = (
        placement.x_mm + placement.width_mm,
        placement.y_mm + placement.height_mm,
    )
    lower, upper = -math.inf, math.inf
    for coordinate, component, minimum, maximum in zip(
        origin,
        direction,
        minimums,
        maximums,
        strict=True,
    ):
        if abs(component) < 1e-12:
            if not minimum <= coordinate <= maximum:
                return None
            continue
        first, second = (minimum - coordinate) / component, (maximum - coordinate) / component
        lower = max(lower, min(first, second))
        upper = min(upper, max(first, second))
    return (lower, upper) if lower <= upper else None


def _hatch_angle(
    image: Image.Image,
    placement: RasterPlacement,
    *,
    angle_degrees: float,
    spacing_mm: float,
    threshold: int,
    minimum_segment_mm: float,
    checkpoint: ProgressCallback | None,
    stage: str,
) -> tuple[list[list[FloatPoint]], int]:
    angle = math.radians(angle_degrees)
    direction = (math.cos(angle), math.sin(angle))
    normal = (-direction[1], direction[0])
    center = (
        placement.x_mm + placement.width_mm / 2,
        placement.y_mm + placement.height_mm / 2,
    )
    corners = (
        (placement.x_mm, placement.y_mm),
        (placement.x_mm + placement.width_mm, placement.y_mm),
        (placement.x_mm, placement.y_mm + placement.height_mm),
        (
            placement.x_mm + placement.width_mm,
            placement.y_mm + placement.height_mm,
        ),
    )
    projections = [
        (corner[0] - center[0]) * normal[0] + (corner[1] - center[1]) * normal[1]
        for corner in corners
    ]
    first_offset = math.floor(min(projections) / spacing_mm) * spacing_mm
    last_offset = math.ceil(max(projections) / spacing_mm) * spacing_mm
    count = max(1, round((last_offset - first_offset) / spacing_mm) + 1)
    sample_step = max(
        0.08,
        min(placement.width_mm / image.width, placement.height_mm / image.height) * 0.75,
    )
    pixels = cast(Any, image.load())
    paths: list[list[FloatPoint]] = []
    removed = 0
    for index in range(count):
        _checkpoint(checkpoint, stage, index, count)
        offset = first_offset + index * spacing_mm
        origin = (center[0] + normal[0] * offset, center[1] + normal[1] * offset)
        interval = _line_rectangle_interval(origin, direction, placement)
        if interval is None:
            continue
        start_t, end_t = interval
        samples = max(2, math.ceil((end_t - start_t) / sample_step) + 1)
        active: list[FloatPoint] = []
        for sample in range(samples):
            t = start_t + (end_t - start_t) * sample / (samples - 1)
            point = (
                min(
                    placement.x_mm + placement.width_mm,
                    max(placement.x_mm, origin[0] + direction[0] * t),
                ),
                min(
                    placement.y_mm + placement.height_mm,
                    max(placement.y_mm, origin[1] + direction[1] * t),
                ),
            )
            if (
                _sample_luminance(
                    pixels,
                    image.width,
                    image.height,
                    placement,
                    point,
                )
                <= threshold
            ):
                active.append(point)
            elif active:
                if _path_length(active) >= minimum_segment_mm:
                    paths.append([active[0], active[-1]])
                else:
                    removed += 1
                active = []
        if active:
            if _path_length(active) >= minimum_segment_mm:
                paths.append([active[0], active[-1]])
            else:
                removed += 1
    _checkpoint(checkpoint, stage, count, count)
    return paths, removed


def _hatch_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
    *,
    crosshatch: bool,
) -> VectorizationResult:
    settings = recipe.raster_vectorize
    angle_thresholds = (
        list(enumerate(settings.crosshatch_thresholds))
        if crosshatch
        else [(0, settings.hatch_tone_threshold)]
    )
    paths: list[list[FloatPoint]] = []
    removed = 0
    for index, threshold in angle_thresholds:
        angle_paths, angle_removed = _hatch_angle(
            image,
            preview.placement,
            angle_degrees=settings.hatch_angle_degrees
            + index * settings.crosshatch_angle_step_degrees,
            spacing_mm=settings.hatch_spacing_mm,
            threshold=threshold,
            minimum_segment_mm=settings.minimum_segment_length_mm,
            checkpoint=checkpoint,
            stage=f"hatch-angle-{index + 1}",
        )
        paths.extend(angle_paths)
        removed += angle_removed
    return VectorizationResult(paths=paths, removed_segments=removed)


def _squiggle_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    settings = recipe.raster_vectorize
    placement = preview.placement
    count = max(1, math.floor(placement.height_mm / settings.squiggle_spacing_mm))
    sample_step = max(
        0.08,
        min(
            placement.width_mm / image.width,
            settings.squiggle_wavelength_mm / 16,
        ),
    )
    samples = max(2, math.ceil(placement.width_mm / sample_step) + 1)
    pixels = cast(Any, image.load())
    paths: list[list[FloatPoint]] = []
    removed = 0
    for row in range(count):
        _checkpoint(checkpoint, "squiggle-scanlines", row, count)
        baseline = placement.y_mm + (row + 0.5) * placement.height_mm / count
        points: list[FloatPoint] = []
        phase = 0.0
        maximum_darkness = 0.0
        previous_x = placement.x_mm
        for sample in range(samples):
            x = placement.x_mm + placement.width_mm * sample / (samples - 1)
            darkness = (
                1
                - _sample_luminance(
                    pixels,
                    image.width,
                    image.height,
                    placement,
                    (x, baseline),
                )
                / 255
            )
            maximum_darkness = max(maximum_darkness, darkness)
            frequency_factor = (
                0.35 + 1.65 * darkness
                if settings.squiggle_modulation in {"frequency", "both"}
                else 1.0
            )
            phase += (
                (x - previous_x) * 2 * math.pi / settings.squiggle_wavelength_mm * frequency_factor
            )
            amplitude_factor = (
                darkness if settings.squiggle_modulation in {"amplitude", "both"} else 1.0
            )
            y = baseline + settings.squiggle_amplitude_mm * amplitude_factor * math.sin(phase)
            y = min(
                placement.y_mm + placement.height_mm,
                max(placement.y_mm, y),
            )
            points.append((x, y))
            previous_x = x
        if maximum_darkness >= settings.squiggle_min_darkness:
            simplified = _simplify(points, recipe.geometry.simplification_tolerance_mm)
            paths.append(simplified if row % 2 == 0 else list(reversed(simplified)))
        else:
            removed += 1
    _checkpoint(checkpoint, "squiggle-scanlines", count, count)
    return VectorizationResult(paths=paths, removed_segments=removed)


def _circular_scribble_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    """Trace one tone-aware serpentine path made from overlapping circular loops."""

    settings = recipe.raster_vectorize
    placement = preview.placement
    maximum_radius = min(
        settings.squiggle_amplitude_mm,
        placement.width_mm / 4,
        placement.height_mm / 4,
    )
    if maximum_radius <= 0:
        return VectorizationResult(paths=[], removed_segments=1)

    minimum_radius = maximum_radius * 0.6
    lane_spacing = max(settings.squiggle_spacing_mm, maximum_radius * 1.8)
    light_pitch = max(0.2, settings.squiggle_wavelength_mm)
    dark_pitch = max(0.2, min(light_pitch, maximum_radius * 1.1))
    segments_per_loop = {"draft": 6, "standard": 8, "export": 10}[recipe.mode.quality]

    min_center_x = placement.x_mm + maximum_radius
    max_center_x = placement.x_mm + placement.width_mm - maximum_radius
    min_center_y = placement.y_mm + maximum_radius
    max_center_y = placement.y_mm + placement.height_mm - maximum_radius
    vertical_span = max_center_y - min_center_y
    row_count = max(1, math.floor(vertical_span / lane_spacing) + 1)
    baselines = (
        [(min_center_y + max_center_y) / 2]
        if row_count == 1
        else [min_center_y + vertical_span * row / (row_count - 1) for row in range(row_count)]
    )

    pixels = cast(Any, image.load())
    points: list[FloatPoint] = []
    phase = 0.0
    golden_angle = math.pi * (3 - math.sqrt(5))

    def clamp_point(x: float, y: float) -> FloatPoint:
        return (
            min(placement.x_mm + placement.width_mm, max(placement.x_mm, x)),
            min(placement.y_mm + placement.height_mm, max(placement.y_mm, y)),
        )

    def darkness_at(point: FloatPoint) -> float:
        raw_darkness = (
            1.0
            - _sample_luminance(
                pixels,
                image.width,
                image.height,
                placement,
                point,
            )
            / 255.0
        )
        floor = settings.squiggle_min_darkness
        if raw_darkness <= floor:
            return 0.0
        return min(1.0, max(0.0, (raw_darkness - floor) / max(1e-9, 1.0 - floor)))

    for row, baseline in enumerate(baselines):
        _checkpoint(checkpoint, "circular-scribble-lanes", row, row_count)
        direction = 1.0 if row % 2 == 0 else -1.0
        center_x = min_center_x if direction > 0 else max_center_x
        end_x = max_center_x if direction > 0 else min_center_x

        while (direction > 0 and center_x <= end_x) or (direction < 0 and center_x >= end_x):
            darkness = darkness_at((center_x, baseline))
            radius = (
                maximum_radius - (maximum_radius - minimum_radius) * darkness
                if settings.squiggle_modulation in {"amplitude", "both"}
                else maximum_radius
            )
            pitch = (
                light_pitch - (light_pitch - dark_pitch) * darkness
                if settings.squiggle_modulation in {"frequency", "both"}
                else light_pitch
            )
            for segment in range(segments_per_loop + 1):
                angle = phase + direction * 2 * math.pi * segment / segments_per_loop
                radial_scale = 0.96 + 0.04 * math.sin(3 * angle + row * 0.73 + center_x * 0.031)
                loop_radius = radius * radial_scale
                points.append(
                    clamp_point(
                        center_x + loop_radius * math.cos(angle),
                        baseline + loop_radius * math.sin(angle),
                    )
                )
            phase = (phase + direction * golden_angle) % (2 * math.pi)
            center_x += direction * pitch

        if row + 1 < row_count:
            next_baseline = baselines[row + 1]
            turn_x = max_center_x if direction > 0 else min_center_x
            turn_sign = 1.0 if direction > 0 else -1.0
            transition_points = max(3, segments_per_loop // 2)
            for step in range(1, transition_points + 1):
                ratio = step / transition_points
                points.append(
                    clamp_point(
                        turn_x + turn_sign * maximum_radius * 0.55 * math.sin(math.pi * ratio),
                        baseline + (next_baseline - baseline) * ratio,
                    )
                )

    _checkpoint(checkpoint, "circular-scribble-lanes", row_count, row_count)
    deduplicated = [
        point for index, point in enumerate(points) if index == 0 or point != points[index - 1]
    ]
    return VectorizationResult(paths=[deduplicated] if len(deduplicated) >= 2 else [])


def _interpolate(
    first: FloatPoint,
    second: FloatPoint,
    first_value: int,
    second_value: int,
    level: float,
) -> FloatPoint:
    if first_value == second_value:
        ratio = 0.5
    else:
        ratio = (level - first_value) / (second_value - first_value)
    return (
        first[0] + (second[0] - first[0]) * ratio,
        first[1] + (second[1] - first[1]) * ratio,
    )


def _marching_segments(image: Image.Image, level: float) -> list[tuple[FloatPoint, FloatPoint]]:
    pixels = cast(Any, image.load())
    segments: list[tuple[FloatPoint, FloatPoint]] = []
    table: dict[int, tuple[tuple[int, int], ...]] = {
        1: ((3, 0),),
        2: ((0, 1),),
        3: ((3, 1),),
        4: ((1, 2),),
        5: ((3, 0), (1, 2)),
        6: ((0, 2),),
        7: ((3, 2),),
        8: ((2, 3),),
        9: ((0, 2),),
        10: ((0, 1), (2, 3)),
        11: ((1, 2),),
        12: ((1, 3),),
        13: ((0, 1),),
        14: ((3, 0),),
    }
    for y in range(image.height - 1):
        for x in range(image.width - 1):
            values = (
                255 - int(pixels[x, y]),
                255 - int(pixels[x + 1, y]),
                255 - int(pixels[x + 1, y + 1]),
                255 - int(pixels[x, y + 1]),
            )
            case = sum(1 << index for index, value in enumerate(values) if value >= level)
            if case in {0, 15}:
                continue
            corners: tuple[FloatPoint, ...] = (
                (float(x), float(y)),
                (float(x + 1), float(y)),
                (float(x + 1), float(y + 1)),
                (float(x), float(y + 1)),
            )
            edge_corners = ((0, 1), (1, 2), (3, 2), (0, 3))
            edge_points = [
                _interpolate(
                    corners[first],
                    corners[second],
                    values[first],
                    values[second],
                    level,
                )
                for first, second in edge_corners
            ]
            segments.extend(
                (edge_points[first], edge_points[second]) for first, second in table[case]
            )
    return segments


def _float_key(point: FloatPoint) -> tuple[int, int]:
    return round(point[0] * 1_000_000), round(point[1] * 1_000_000)


def _stitch_segments(
    segments: Sequence[tuple[FloatPoint, FloatPoint]],
) -> list[list[FloatPoint]]:
    endpoint_map: dict[tuple[int, int], list[int]] = defaultdict(list)
    for index, (first, second) in enumerate(segments):
        endpoint_map[_float_key(first)].append(index)
        endpoint_map[_float_key(second)].append(index)
    unused = set(range(len(segments)))
    paths: list[list[FloatPoint]] = []

    def extend(path: list[FloatPoint], at_start: bool) -> None:
        while True:
            endpoint = path[0] if at_start else path[-1]
            candidates = [item for item in endpoint_map[_float_key(endpoint)] if item in unused]
            if not candidates:
                return
            index = min(candidates)
            unused.remove(index)
            first, second = segments[index]
            following = second if _float_key(first) == _float_key(endpoint) else first
            if at_start:
                path.insert(0, following)
            else:
                path.append(following)

    starts = sorted(
        ((key, indices[0]) for key, indices in endpoint_map.items() if len(indices) == 1),
        key=lambda item: item[0],
    )
    for _, index in starts:
        if index not in unused:
            continue
        unused.remove(index)
        path = [segments[index][0], segments[index][1]]
        extend(path, True)
        extend(path, False)
        paths.append(path)
    while unused:
        index = min(unused)
        unused.remove(index)
        path = [segments[index][0], segments[index][1]]
        extend(path, False)
        paths.append(path)
    return paths


def _tone_contour_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    count = recipe.raster_vectorize.contour_levels
    pixel_paths: list[list[FloatPoint]] = []
    for index in range(count):
        _checkpoint(checkpoint, "tone-contours", index, count)
        level = 255 * (index + 1) / (count + 1)
        pixel_paths.extend(_stitch_segments(_marching_segments(image, level)))
    converted = _pixel_paths_to_mm(
        pixel_paths,
        width=image.width,
        height=image.height,
        placement=preview.placement,
        simplify_tolerance_mm=recipe.geometry.simplification_tolerance_mm,
    )
    minimum = recipe.raster_vectorize.minimum_segment_length_mm
    kept = [path for path in converted if _path_length(path) >= minimum]
    _checkpoint(checkpoint, "tone-contours", count, count)
    return VectorizationResult(paths=kept, removed_segments=len(converted) - len(kept))


def _quantized_regions(
    image: Image.Image,
    recipe: ProjectRecipe,
) -> list[tuple[tuple[int, int, int], int, Image.Image]]:
    settings = recipe.raster_vectorize
    quantized = image.quantize(
        colors=min(256, settings.color_count + 1),
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )
    palette = quantized.getpalette()
    if palette is None:
        raise ValueError("color quantization did not produce a palette")
    counts = sorted(quantized.getcolors(maxcolors=256) or [], reverse=True)
    candidates: list[tuple[int, tuple[int, int, int], int]] = []
    for raw_count, raw_palette_index in counts:
        count = int(raw_count)
        palette_index = cast(int, raw_palette_index)
        offset = palette_index * 3
        rgb = cast(
            tuple[int, int, int],
            tuple(int(value) for value in palette[offset : offset + 3]),
        )
        if min(rgb) >= settings.color_background_threshold:
            continue
        candidates.append((palette_index, rgb, count))
    candidates = candidates[: settings.color_count]
    candidates.sort(
        key=lambda item: (
            round(0.2126 * item[1][0] + 0.7152 * item[1][1] + 0.0722 * item[1][2]),
            item[1],
        )
    )
    indexes = quantized.tobytes()
    return [
        (
            rgb,
            count,
            Image.frombytes(
                "L",
                quantized.size,
                bytes(0 if value == palette_index else 255 for value in indexes),
            ),
        )
        for palette_index, rgb, count in candidates
    ]


def _color_paths(
    image: Image.Image,
    placement: RasterPlacement,
    recipe: ProjectRecipe,
    checkpoint: ProgressCallback | None,
    *,
    hatch: bool,
) -> list[ColorVectorizationResult]:
    regions = _quantized_regions(image, recipe)
    results: list[ColorVectorizationResult] = []
    for index, (rgb, pixel_count, mask) in enumerate(regions):
        _checkpoint(checkpoint, "quantized-color-regions", index, len(regions))
        if hatch:
            paths, removed = _hatch_angle(
                mask,
                placement,
                angle_degrees=recipe.raster_vectorize.hatch_angle_degrees,
                spacing_mm=recipe.raster_vectorize.hatch_spacing_mm,
                threshold=127,
                minimum_segment_mm=recipe.raster_vectorize.minimum_segment_length_mm,
                checkpoint=checkpoint,
                stage=f"color-hatch-{index + 1}",
            )
        else:
            pixel_paths = _stitch_segments(_marching_segments(mask, 127))
            converted = _pixel_paths_to_mm(
                pixel_paths,
                width=mask.width,
                height=mask.height,
                placement=placement,
                simplify_tolerance_mm=recipe.geometry.simplification_tolerance_mm,
            )
            minimum = recipe.raster_vectorize.minimum_segment_length_mm
            paths = [path for path in converted if _path_length(path) >= minimum]
            removed = len(converted) - len(paths)
        results.append(
            ColorVectorizationResult(
                rgb=rgb,
                pixel_count=pixel_count,
                paths=paths,
                removed_segments=removed,
            )
        )
    _checkpoint(checkpoint, "quantized-color-regions", len(regions), len(regions))
    return results


_BAYER_4X4: tuple[tuple[int, ...], ...] = (
    (0, 8, 2, 10),
    (12, 4, 14, 6),
    (3, 11, 1, 9),
    (15, 7, 13, 5),
)


def _bounded_darkness(luminance: int, contrast: float, gamma: float) -> float:
    darkness = 1.0 - luminance / 255.0
    darkness = max(0.0, min(1.0, (darkness - 0.5) * contrast + 0.5))
    return float(darkness**gamma)


def _dot_mark(center: FloatPoint, diameter_mm: float) -> list[FloatPoint]:
    radius = diameter_mm / 2
    # Twelve segments keep small marks light while preserving a visibly round loop at plot scale.
    return [
        (
            center[0] + radius * math.cos(2 * math.pi * index / 12),
            center[1] + radius * math.sin(2 * math.pi * index / 12),
        )
        for index in range(13)
    ]


def _cross_mark(
    center: FloatPoint,
    size_mm: float,
    angle_degrees: float,
) -> list[list[FloatPoint]]:
    half = size_mm / 2
    angle = math.radians(angle_degrees)
    direction = (math.cos(angle) * half, math.sin(angle) * half)
    perpendicular = (-direction[1], direction[0])
    return [
        [
            (center[0] - direction[0], center[1] - direction[1]),
            (center[0] + direction[0], center[1] + direction[1]),
        ],
        [
            (center[0] - perpendicular[0], center[1] - perpendicular[1]),
            (center[0] + perpendicular[0], center[1] + perpendicular[1]),
        ],
    ]


def _dither_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> list[VectorizationResult]:
    settings = recipe.raster_vectorize
    placement = preview.placement
    spacing = (
        settings.dither_pen_thickness_mm + settings.dither_dot_gap_mm
        if settings.dither_mark == "pen-dots"
        else settings.dither_spacing_mm
    )
    columns = max(1, math.floor(placement.width_mm / spacing))
    rows = max(1, math.floor(placement.height_mm / spacing))
    x_positions = [
        placement.x_mm + placement.width_mm / 2
        if columns == 1
        else placement.x_mm + spacing / 2 + column * spacing
        for column in range(columns)
    ]
    y_positions = [
        placement.y_mm + placement.height_mm / 2
        if rows == 1
        else placement.y_mm + spacing / 2 + row * spacing
        for row in range(rows)
    ]
    band_count = settings.dither_pass_count if settings.dither_pass_mode == "contrast-bands" else 1
    maximum_size = min(settings.dither_max_mark_size_mm, spacing)
    minimum_size = min(settings.dither_min_mark_size_mm, maximum_size)
    pixels = cast(Any, image.load())
    paths_by_band: list[list[list[FloatPoint]]] = [[] for _ in range(band_count)]
    removed_by_band = [0 for _ in range(band_count)]
    total_rows = len(y_positions)

    for row, y in enumerate(y_positions):
        _checkpoint(checkpoint, "dither-grid", row, total_rows)
        for column, x in enumerate(x_positions):
            luminance = _sample_luminance(
                pixels,
                image.width,
                image.height,
                placement,
                (x, y),
            )
            darkness = _bounded_darkness(
                luminance,
                settings.dither_contrast,
                settings.dither_gamma,
            )
            if darkness < settings.dither_threshold:
                continue
            ordered_threshold = (_BAYER_4X4[row % 4][column % 4] + 0.5) / 16
            for band in range(band_count):
                intensity = min(1.0, max(0.0, darkness * band_count - band))
                if intensity <= ordered_threshold:
                    continue
                center = (x, y)
                if settings.dither_mark == "dots":
                    size = minimum_size + (maximum_size - minimum_size) * intensity
                    if size < max(settings.minimum_segment_length_mm, 1e-9):
                        removed_by_band[band] += 1
                        continue
                    paths_by_band[band].append(_dot_mark(center, size))
                elif settings.dither_mark == "crosses":
                    size = minimum_size + (maximum_size - minimum_size) * intensity
                    if size < max(settings.minimum_segment_length_mm, 1e-9):
                        removed_by_band[band] += 1
                        continue
                    paths_by_band[band].extend(
                        _cross_mark(center, size, settings.dither_angle_degrees)
                    )
                else:
                    # A duplicated point carries a physical pen tap through DesignPath; planning
                    # turns it into a zero-travel dot action.
                    paths_by_band[band].append([center, center])
    _checkpoint(checkpoint, "dither-grid", total_rows, total_rows)
    return [
        VectorizationResult(
            paths=paths,
            removed_segments=removed_by_band[index],
        )
        for index, paths in enumerate(paths_by_band)
    ]


def _noise(row: int, column: int, salt: int) -> float:
    """Return a stable, inexpensive pseudo-random value for a grid cell."""

    value = (row * 374_761_393 + column * 668_265_263 + salt * 2_246_822_519) & 0xFFFFFFFF
    value = ((value ^ (value >> 13)) * 1_274_126_177) & 0xFFFFFFFF
    return ((value ^ (value >> 16)) & 0xFFFFFFFF) / 2**32


def _stipple_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    placement: RasterPlacement,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    """Create density-based dots on an even or gently jittered grid."""

    settings = recipe.raster_vectorize
    spacing = (
        settings.stipple_pen_thickness_mm + settings.stipple_dot_gap_mm
        if settings.stipple_mark == "pen-dots"
        else settings.stipple_spacing_mm
    )
    columns = max(1, math.floor(placement.width_mm / spacing))
    rows = max(1, math.floor(placement.height_mm / spacing))
    maximum_size = min(settings.stipple_max_dot_size_mm, spacing)
    minimum_size = min(settings.stipple_min_dot_size_mm, maximum_size)
    pixels = cast(Any, image.load())
    paths: list[list[FloatPoint]] = []
    removed = 0

    for row in range(rows):
        _checkpoint(checkpoint, "stipple-dots", row, rows)
        base_y = (
            placement.y_mm + placement.height_mm / 2
            if rows == 1
            else placement.y_mm + spacing / 2 + row * spacing
        )
        for column in range(columns):
            base_x = (
                placement.x_mm + placement.width_mm / 2
                if columns == 1
                else placement.x_mm + spacing / 2 + column * spacing
            )
            jitter = spacing * 0.32 if settings.stipple_layout == "natural" else 0.0
            center = (
                min(
                    placement.x_mm + placement.width_mm,
                    max(placement.x_mm, base_x + (_noise(row, column, 1) - 0.5) * 2 * jitter),
                ),
                min(
                    placement.y_mm + placement.height_mm,
                    max(placement.y_mm, base_y + (_noise(row, column, 2) - 0.5) * 2 * jitter),
                ),
            )
            darkness = _bounded_darkness(
                _sample_luminance(pixels, image.width, image.height, placement, center),
                settings.stipple_contrast,
                settings.stipple_gamma,
            )
            if darkness < settings.stipple_threshold or darkness <= _noise(row, column, 3):
                continue
            if settings.stipple_mark == "pen-dots":
                paths.append([center, center])
                continue
            size = minimum_size + (maximum_size - minimum_size) * darkness
            if size < max(settings.minimum_segment_length_mm, 1e-9):
                removed += 1
                continue
            paths.append(_dot_mark(center, size))
    _checkpoint(checkpoint, "stipple-dots", rows, rows)
    return VectorizationResult(paths=paths, removed_segments=removed)


def _color_stipple_paths(
    image: Image.Image,
    placement: RasterPlacement,
    recipe: ProjectRecipe,
    checkpoint: ProgressCallback | None,
) -> list[ColorVectorizationResult]:
    results: list[ColorVectorizationResult] = []
    regions = _quantized_regions(image, recipe)
    for index, (rgb, pixel_count, mask) in enumerate(regions):
        _checkpoint(checkpoint, "stipple-colors", index, len(regions))
        result = _stipple_paths(mask, recipe, placement, checkpoint)
        results.append(
            ColorVectorizationResult(
                rgb=rgb,
                pixel_count=pixel_count,
                paths=result.paths,
                removed_segments=result.removed_segments,
            )
        )
    _checkpoint(checkpoint, "stipple-colors", len(regions), len(regions))
    return results


def _design_paths(
    algorithm: str,
    paths: Sequence[Sequence[FloatPoint]],
    *,
    pen_dot_diameter_mm: float | None = None,
) -> list[DesignPath]:
    return [
        DesignPath(
            path_id=f"raster-{algorithm}-{index + 1:06d}",
            commands=[
                MoveCommand(point=Point(x=points[0][0], y=points[0][1])),
                *(LineCommand(point=Point(x=point[0], y=point[1])) for point in points[1:]),
            ],
            closed=len(points) > 2 and points[0] == points[-1],
            metadata={
                "source": "raster",
                "algorithm": algorithm,
                **(
                    {"mark_kind": "pen-dot", "dot_diameter_mm": pen_dot_diameter_mm}
                    if pen_dot_diameter_mm is not None
                    else {}
                ),
            },
        )
        for index, points in enumerate(paths)
        if len(points) >= 2
    ]


def vectorize_raster(
    content: bytes,
    media_type: str,
    recipe: ProjectRecipe,
    *,
    source_sha256: str,
    preview: RasterPreview | None = None,
    checkpoint: ProgressCallback | None = None,
) -> DesignDocument:
    """Convert a preprocessed PNG/JPEG into deterministic page-space vector geometry."""

    preview = preview or preprocess_raster(
        content,
        media_type,
        recipe,
        source_sha256=source_sha256,
        checkpoint=checkpoint,
    )
    algorithm = recipe.raster_vectorize.algorithm
    _checkpoint(checkpoint, f"vectorize-{algorithm}", 0, 1)
    color_results: list[ColorVectorizationResult] | None = None
    dither_results: list[VectorizationResult] | None = None
    color_warnings: list[RasterPreviewWarning] = []
    color_stipple = (
        algorithm == "stipple" and recipe.raster_vectorize.stipple_color_mode == "separate"
    )
    if algorithm in {"color-outline", "color-hatch"} or color_stipple:
        color_image, placement, color_warnings = preprocess_color_image(content, media_type, recipe)
        image, resolution_reduced = _bounded_image(color_image, recipe.mode.quality)
        color_results = (
            _color_stipple_paths(image, placement, recipe, checkpoint)
            if color_stipple
            else _color_paths(
                image,
                placement,
                recipe,
                checkpoint,
                hatch=algorithm == "color-hatch",
            )
        )
        result = VectorizationResult(
            paths=[path for color_result in color_results for path in color_result.paths],
            removed_segments=sum(item.removed_segments for item in color_results),
        )
    else:
        image, resolution_reduced = _working_image(preview, recipe.mode.quality)
        if algorithm == "edge":
            result = _edge_paths(image, recipe, preview)
        elif algorithm == "centerline":
            result = _centerline_paths(image, recipe, preview, checkpoint)
        elif algorithm == "hatch":
            result = _hatch_paths(image, recipe, preview, checkpoint, crosshatch=False)
        elif algorithm == "crosshatch":
            result = _hatch_paths(image, recipe, preview, checkpoint, crosshatch=True)
        elif algorithm == "squiggle":
            result = _squiggle_paths(image, recipe, preview, checkpoint)
        elif algorithm == "circular-scribble":
            result = _circular_scribble_paths(image, recipe, preview, checkpoint)
        elif algorithm == "dither":
            dither_results = _dither_paths(image, recipe, preview, checkpoint)
            result = VectorizationResult(
                paths=[path for item in dither_results for path in item.paths],
                removed_segments=sum(item.removed_segments for item in dither_results),
            )
        elif algorithm == "stipple":
            result = _stipple_paths(image, recipe, preview.placement, checkpoint)
        else:
            result = _tone_contour_paths(image, recipe, preview, checkpoint)

    diagnostics = [
        DesignDiagnostic(
            code="raster-vectorization-report",
            message=(
                f"{algorithm} emitted {len(result.paths)} paths; removed "
                f"{result.removed_components} components and {result.removed_segments} "
                "short segments."
            ),
        )
    ]
    if resolution_reduced:
        diagnostics.append(
            DesignDiagnostic(
                code="vectorization-resolution-reduced",
                message=(
                    f"{algorithm} used a bounded {image.width} x {image.height} working image; "
                    "page-space output scale is unchanged."
                ),
            )
        )
    diagnostics.extend(
        DesignDiagnostic(code=warning.code, message=warning.message) for warning in preview.warnings
    )
    diagnostics.extend(
        DesignDiagnostic(code=warning.code, message=warning.message) for warning in color_warnings
    )
    diagnostics = list(
        {
            (diagnostic.code, diagnostic.message, diagnostic.element_id): diagnostic
            for diagnostic in diagnostics
        }.values()
    )
    if dither_results is not None and recipe.raster_vectorize.dither_pass_mode == "contrast-bands":
        layers = []
        band_count = len(dither_results)
        for index, band_result in enumerate(dither_results):
            band_fraction = index / max(1, band_count - 1)
            tone = round(23 + 145 * band_fraction)
            color_hex = f"#{tone:02x}{tone:02x}{tone:02x}"
            layer_algorithm = f"dither-tone-{index + 1:02d}"
            layers.append(
                DesignLayer(
                    layer_id=f"layer-raster-{layer_algorithm}",
                    name=f"Dither tone {index + 1}/{band_count}",
                    semantic_role=f"dither-tone-{index + 1}",
                    preview_color=color_hex,
                    paths=_design_paths(
                        layer_algorithm,
                        band_result.paths,
                        pen_dot_diameter_mm=(
                            recipe.raster_vectorize.dither_pen_thickness_mm
                            if recipe.raster_vectorize.dither_mark == "pen-dots"
                            else None
                        ),
                    ),
                    metadata={
                        "source": "raster",
                        "algorithm": algorithm,
                        "dither_mark": recipe.raster_vectorize.dither_mark,
                        "tone_band": index + 1,
                        "tone_band_count": band_count,
                        "path_count": len(band_result.paths),
                        "removed_segments": band_result.removed_segments,
                        "working_width_px": image.width,
                        "working_height_px": image.height,
                    },
                )
            )
    elif color_results is None:
        layers = [
            DesignLayer(
                layer_id=f"layer-raster-{algorithm}",
                name=f"Raster {algorithm.replace('-', ' ').title()}",
                semantic_role="structure",
                preview_color="#171717",
                paths=_design_paths(
                    algorithm,
                    result.paths,
                    pen_dot_diameter_mm=(
                        recipe.raster_vectorize.dither_pen_thickness_mm
                        if algorithm == "dither"
                        and recipe.raster_vectorize.dither_mark == "pen-dots"
                        else recipe.raster_vectorize.stipple_pen_thickness_mm
                        if algorithm == "stipple"
                        and recipe.raster_vectorize.stipple_mark == "pen-dots"
                        else None
                    ),
                ),
                metadata={
                    "source": "raster",
                    "algorithm": algorithm,
                    **(
                        {
                            "dither_mark": recipe.raster_vectorize.dither_mark,
                            "dither_pass_mode": recipe.raster_vectorize.dither_pass_mode,
                            "dither_pass_count": recipe.raster_vectorize.dither_pass_count,
                        }
                        if algorithm == "dither"
                        else {
                            "stipple_layout": recipe.raster_vectorize.stipple_layout,
                            "stipple_color_mode": recipe.raster_vectorize.stipple_color_mode,
                            "stipple_mark": recipe.raster_vectorize.stipple_mark,
                        }
                        if algorithm == "stipple"
                        else {}
                    ),
                    "path_count": len(result.paths),
                    "removed_components": result.removed_components,
                    "removed_segments": result.removed_segments,
                    "working_width_px": image.width,
                    "working_height_px": image.height,
                },
            )
        ]
    else:
        layers = []
        for color_result in color_results:
            color_hex = "#" + "".join(f"{channel:02x}" for channel in color_result.rgb)
            color_key = color_hex[1:]
            layers.append(
                DesignLayer(
                    layer_id=f"layer-raster-color-{color_key}",
                    name=f"Source color {color_hex.upper()}",
                    semantic_role=f"source-color-{color_key}",
                    preview_color=color_hex,
                    paths=_design_paths(
                        f"{algorithm}-{color_key}",
                        color_result.paths,
                        pen_dot_diameter_mm=(
                            recipe.raster_vectorize.stipple_pen_thickness_mm
                            if algorithm == "stipple"
                            and recipe.raster_vectorize.stipple_mark == "pen-dots"
                            else None
                        ),
                    ),
                    metadata={
                        "source": "raster",
                        "algorithm": algorithm,
                        "quantized_color": color_hex,
                        "quantized_pixel_count": color_result.pixel_count,
                        "path_count": len(color_result.paths),
                        "removed_components": 0,
                        "removed_segments": color_result.removed_segments,
                        "working_width_px": image.width,
                        "working_height_px": image.height,
                    },
                )
            )
        if not layers:
            raise ValueError(
                "color quantization found no foreground colors below the background threshold"
            )
    document = DesignDocument(
        document_id=f"{recipe.project_id}-raster-{algorithm}-design",
        page=recipe.page,
        layers=layers,
        metadata=DesignMetadata(
            generator_id=RASTER_VECTORIZER_ID,
            generator_version=(
                DITHER_VECTORIZER_VERSION
                if algorithm == "dither"
                else STIPPLE_VECTORIZER_VERSION
                if algorithm == "stipple"
                else CIRCULAR_SCRIBBLE_VECTORIZER_VERSION
                if algorithm == "circular-scribble"
                else RASTER_VECTORIZER_VERSION
                if algorithm in {"color-outline", "color-hatch"}
                else "1.0.0"
            ),
            seed="",
            quality=recipe.mode.quality,
            source_asset_sha256=source_sha256,
            diagnostics=diagnostics,
        ),
    )
    digest = canonical_sha256(document)
    _checkpoint(checkpoint, "complete", 1, 1)
    return document.model_copy(
        update={"metadata": document.metadata.model_copy(update={"normalized_sha256": digest})}
    )
