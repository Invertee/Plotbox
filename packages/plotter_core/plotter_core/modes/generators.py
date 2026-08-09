from __future__ import annotations

import math
from typing import cast

from plotter_core.models import (
    CloseCommand,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    canonical_sha256,
)
from plotter_core.modes.base import ComplexityEstimate, GenerationContext, QualityLevel

QUALITY_SCALE = {
    QualityLevel.DRAFT: 0.45,
    QualityLevel.STANDARD: 0.72,
    QualityLevel.EXPORT: 1.0,
}


def _polyline(path_id: str, points: list[Point], *, closed: bool = False) -> DesignPath:
    commands: list[MoveCommand | LineCommand | CloseCommand] = [MoveCommand(point=points[0])]
    commands.extend(LineCommand(point=point) for point in points[1:])
    if closed:
        commands.append(CloseCommand())
    return DesignPath(path_id=path_id, commands=commands, closed=closed, reversible=not closed)


def _document(
    context: GenerationContext,
    generator_id: str,
    layers: list[DesignLayer],
) -> DesignDocument:
    document = DesignDocument(
        document_id=f"{context.recipe.project_id}-design",
        page=context.recipe.page,
        layers=layers,
        metadata=DesignMetadata(
            generator_id=generator_id,
            generator_version="1.0.0",
            seed=context.recipe.mode.seed,
            quality=context.recipe.mode.quality,
        ),
    )
    digest = canonical_sha256(document)
    return document.model_copy(
        update={"metadata": document.metadata.model_copy(update={"normalized_sha256": digest})}
    )


def _counts(context: GenerationContext, base_paths: int, base_vertices: int) -> ComplexityEstimate:
    density = float(cast(int | float, context.parameters.get("density", 1.0)))
    scale = QUALITY_SCALE[context.quality] * density
    return ComplexityEstimate(
        paths=max(1, round(base_paths * scale)),
        vertices=max(
            2, round(base_vertices * scale * (0.7 + 0.3 * QUALITY_SCALE[context.quality]))
        ),
        relative_work=round(scale, 3),
    )


def estimate_flow(context: GenerationContext) -> ComplexityEstimate:
    return _counts(context, 120, 7200)


def generate_flow(context: GenerationContext) -> DesignDocument:
    page = context.recipe.page
    low, high = page.safe_min, page.safe_max
    estimate = estimate_flow(context)
    rng = context.random.scalar("placement")
    field = cast(str, context.parameters["field"])
    step = float(cast(int | float, context.parameters["step_mm"]))
    spacing = float(cast(int | float, context.parameters["spacing_mm"]))
    steps = max(8, estimate.vertices // estimate.paths)
    paths: list[DesignPath] = []
    occupied: list[tuple[float, float]] = []
    for _index in range(estimate.paths * 2):
        if len(paths) >= estimate.paths:
            break
        context.checkpoint("integrating streamlines", len(paths), estimate.paths)
        x = rng.uniform(low.x, high.x)
        y = rng.uniform(low.y, high.y)
        points = [Point(x=x, y=y)]
        for tick in range(steps):
            nx = (x - low.x) / max(high.x - low.x, 1)
            ny = (y - low.y) / max(high.y - low.y, 1)
            if field == "radial":
                angle = math.atan2(y - (low.y + high.y) / 2, x - (low.x + high.x) / 2)
            elif field == "vortex":
                angle = math.atan2(y - (low.y + high.y) / 2, x - (low.x + high.x) / 2) + math.pi / 2
            elif field == "curl":
                angle = math.sin(nx * 8 + rng.random()) * 2.2 - math.cos(ny * 7) * 1.4
            else:
                angle = math.sin(nx * 9 + ny * 5 + rng.uniform(-0.2, 0.2)) * math.pi
            x += math.cos(angle) * step
            y += math.sin(angle) * step
            if not (low.x <= x <= high.x and low.y <= y <= high.y):
                break
            if tick % 5 == 0 and any(
                (x - ox) ** 2 + (y - oy) ** 2 < spacing**2 for ox, oy in occupied[-1000:]
            ):
                break
            points.append(Point(x=x, y=y))
        if len(points) >= 5:
            occupied.extend((point.x, point.y) for point in points[::5])
            paths.append(_polyline(f"flow-{len(paths):04d}", points))
    context.checkpoint("complete", len(paths), len(paths))
    split = max(1, len(paths) // 2)
    return _document(
        context,
        "builtin.flow-field",
        [
            DesignLayer(
                layer_id="flow-primary",
                name="Primary flow",
                semantic_role="structure",
                preview_color="#132a38",
                paths=paths[:split],
            ),
            DesignLayer(
                layer_id="flow-secondary",
                name="Secondary flow",
                semantic_role="accent",
                preview_color="#dd5f3f",
                paths=paths[split:],
            ),
        ],
    )


def estimate_topographic(context: GenerationContext) -> ComplexityEstimate:
    levels = int(cast(int, context.parameters["levels"]))
    scale = QUALITY_SCALE[context.quality]
    return ComplexityEstimate(
        paths=max(2, round(levels * scale)),
        vertices=max(48, round(levels * 180 * scale)),
        relative_work=levels * scale / 12,
    )


def generate_topographic(context: GenerationContext) -> DesignDocument:
    low, high = context.recipe.page.safe_min, context.recipe.page.safe_max
    estimate = estimate_topographic(context)
    rng = context.random.scalar("terrain")
    cx = (low.x + high.x) / 2 + rng.uniform(-12, 12)
    cy = (low.y + high.y) / 2 + rng.uniform(-8, 8)
    warp = float(cast(int | float, context.parameters["warp"]))
    points_per = max(24, estimate.vertices // estimate.paths)
    paths: list[DesignPath] = []
    maximum_radius = min(high.x - low.x, high.y - low.y) * 0.46
    for level in range(estimate.paths):
        context.checkpoint("extracting contours", level, estimate.paths)
        radius = maximum_radius * (level + 1) / (estimate.paths + 1)
        phase = rng.uniform(0, math.tau)
        points = []
        for index in range(points_per):
            angle = math.tau * index / points_per
            ripple = 1 + warp * 0.12 * (
                math.sin(angle * 3 + phase) + 0.45 * math.sin(angle * 7 - phase)
            )
            x = min(high.x, max(low.x, cx + radius * ripple * math.cos(angle) * 1.35))
            y = min(high.y, max(low.y, cy + radius * ripple * math.sin(angle)))
            points.append(Point(x=x, y=y))
        paths.append(_polyline(f"contour-{level:03d}", points, closed=True))
    context.checkpoint("complete", len(paths), len(paths))
    emphasized = paths[::3]
    detail = [path for index, path in enumerate(paths) if index % 3]
    return _document(
        context,
        "builtin.topographic-contours",
        [
            DesignLayer(
                layer_id="contour-major",
                name="Major contours",
                semantic_role="structure",
                preview_color="#40372d",
                paths=emphasized,
            ),
            DesignLayer(
                layer_id="contour-minor",
                name="Minor contours",
                semantic_role="accent",
                preview_color="#a26639",
                paths=detail,
            ),
        ],
    )


def estimate_truchet(context: GenerationContext) -> ComplexityEstimate:
    page = context.recipe.page
    tile = float(cast(int | float, context.parameters["tile_size_mm"]))
    columns = max(1, int((page.safe_max.x - page.safe_min.x) / tile))
    rows = max(1, int((page.safe_max.y - page.safe_min.y) / tile))
    scale = QUALITY_SCALE[context.quality]
    return ComplexityEstimate(
        paths=max(1, round(columns * rows * scale)),
        vertices=max(4, round(columns * rows * 14 * scale)),
        relative_work=columns * rows * scale / 100,
    )


def generate_truchet(context: GenerationContext) -> DesignDocument:
    low, high = context.recipe.page.safe_min, context.recipe.page.safe_max
    tile = float(cast(int | float, context.parameters["tile_size_mm"]))
    mutation = float(cast(int | float, context.parameters["mutation"]))
    estimate = estimate_truchet(context)
    rng = context.random.scalar("tiles")
    columns = max(1, int((high.x - low.x) / tile))
    rows = max(1, int((high.y - low.y) / tile))
    candidates = [(column, row) for row in range(rows) for column in range(columns)]
    rng.shuffle(candidates)
    candidates = sorted(candidates[: estimate.paths])
    families: list[list[DesignPath]] = [[], []]
    samples = max(6, round(12 * QUALITY_SCALE[context.quality]))
    for index, (column, row) in enumerate(candidates):
        context.checkpoint("laying tiles", index, len(candidates))
        family = (column + row + (1 if rng.random() < mutation else 0)) % 2
        x0, y0 = low.x + column * tile, low.y + row * tile
        corner_x = x0 if family == 0 else x0 + tile
        corner_y = y0
        start = math.pi / 2 if family == 0 else math.pi
        points = [
            Point(
                x=corner_x + tile * math.cos(start + math.pi / 2 * tick / (samples - 1)),
                y=corner_y + tile * math.sin(start + math.pi / 2 * tick / (samples - 1)),
            )
            for tick in range(samples)
        ]
        clipped = [
            Point(x=min(high.x, max(low.x, point.x)), y=min(high.y, max(low.y, point.y)))
            for point in points
        ]
        families[family].append(_polyline(f"tile-{row:03d}-{column:03d}", clipped))
    context.checkpoint("complete", len(candidates), len(candidates))
    return _document(
        context,
        "builtin.truchet",
        [
            DesignLayer(
                layer_id="truchet-a",
                name="Tile family A",
                semantic_role="structure",
                preview_color="#173f5f",
                paths=families[0],
            ),
            DesignLayer(
                layer_id="truchet-b",
                name="Tile family B",
                semantic_role="accent",
                preview_color="#d1495b",
                paths=families[1],
            ),
        ],
    )


def estimate_guilloche(context: GenerationContext) -> ComplexityEstimate:
    repetitions = int(cast(int, context.parameters["repetitions"]))
    samples = int(cast(int, context.parameters["samples"]))
    scale = QUALITY_SCALE[context.quality]
    return ComplexityEstimate(
        paths=max(1, round(repetitions * scale)),
        vertices=max(24, round(repetitions * samples * scale)),
        relative_work=repetitions * samples * scale / 4000,
    )


def generate_guilloche(context: GenerationContext) -> DesignDocument:
    low, high = context.recipe.page.safe_min, context.recipe.page.safe_max
    estimate = estimate_guilloche(context)
    family = cast(str, context.parameters["family"])
    frequency = float(cast(int | float, context.parameters["frequency"]))
    phase = math.radians(float(cast(int | float, context.parameters["phase_degrees"])))
    seed_phase = context.random.scalar("curves").uniform(-0.2, 0.2)
    cx, cy = (low.x + high.x) / 2, (low.y + high.y) / 2
    rx, ry = (high.x - low.x) * 0.45, (high.y - low.y) * 0.45
    samples = max(24, estimate.vertices // estimate.paths)
    paths: list[DesignPath] = []
    for repetition in range(estimate.paths):
        context.checkpoint("drawing parametric curves", repetition, estimate.paths)
        offset = repetition / max(estimate.paths, 1)
        points = []
        for index in range(samples):
            t = math.tau * index / (samples - 1)
            if family == "lissajous":
                x = cx + rx * math.sin(frequency * t + phase + offset + seed_phase)
                y = cy + ry * math.sin((frequency + 1) * t)
            elif family == "harmonograph":
                decay = math.exp(-0.08 * t)
                x = cx + rx * decay * math.sin(frequency * t + phase + offset + seed_phase)
                y = cy + ry * decay * math.sin((frequency + 0.5) * t)
            else:
                ratio = frequency + (0.5 if family == "epitrochoid" else -0.5)
                radius = 0.55 + 0.2 * math.sin(ratio * t + phase + offset + seed_phase)
                x = cx + rx * radius * math.cos(t)
                y = cy + ry * radius * math.sin(t)
            points.append(Point(x=min(high.x, max(low.x, x)), y=min(high.y, max(low.y, y))))
        paths.append(_polyline(f"guilloche-{repetition:03d}", points))
    context.checkpoint("complete", len(paths), len(paths))
    split = (len(paths) + 1) // 2
    return _document(
        context,
        "builtin.guilloche",
        [
            DesignLayer(
                layer_id="guilloche-primary",
                name="Primary curves",
                semantic_role="structure",
                preview_color="#202020",
                paths=paths[:split],
            ),
            DesignLayer(
                layer_id="guilloche-accent",
                name="Interlace curves",
                semantic_role="accent",
                preview_color="#b8860b",
                paths=paths[split:],
            ),
        ],
    )
