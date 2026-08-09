from __future__ import annotations

import math
from collections.abc import Callable
from typing import cast

from plotter_core.models import (
    CloseCommand,
    CubicCommand,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    ProjectRecipe,
    QuadraticCommand,
    canonical_sha256,
)
from plotter_core.modes.base import GenerationContext, QualityLevel

GENERATOR_ID = "builtin.test-pattern"
GENERATOR_VERSION = "1.0.0"


def _rounded_rectangle(
    path_id: str, left: float, bottom: float, right: float, top: float, radius: float
) -> DesignPath:
    return DesignPath(
        path_id=path_id,
        closed=True,
        commands=[
            MoveCommand(point=Point(x=left + radius, y=bottom)),
            LineCommand(point=Point(x=right - radius, y=bottom)),
            QuadraticCommand(
                control=Point(x=right, y=bottom), point=Point(x=right, y=bottom + radius)
            ),
            LineCommand(point=Point(x=right, y=top - radius)),
            QuadraticCommand(control=Point(x=right, y=top), point=Point(x=right - radius, y=top)),
            LineCommand(point=Point(x=left + radius, y=top)),
            QuadraticCommand(control=Point(x=left, y=top), point=Point(x=left, y=top - radius)),
            LineCommand(point=Point(x=left, y=bottom + radius)),
            QuadraticCommand(
                control=Point(x=left, y=bottom), point=Point(x=left + radius, y=bottom)
            ),
            CloseCommand(),
        ],
    )


def _circle(path_id: str, center: Point, radius: float) -> DesignPath:
    kappa = 0.5522847498307936
    return DesignPath(
        path_id=path_id,
        closed=True,
        commands=[
            MoveCommand(point=Point(x=center.x + radius, y=center.y)),
            CubicCommand(
                control1=Point(x=center.x + radius, y=center.y + kappa * radius),
                control2=Point(x=center.x + kappa * radius, y=center.y + radius),
                point=Point(x=center.x, y=center.y + radius),
            ),
            CubicCommand(
                control1=Point(x=center.x - kappa * radius, y=center.y + radius),
                control2=Point(x=center.x - radius, y=center.y + kappa * radius),
                point=Point(x=center.x - radius, y=center.y),
            ),
            CubicCommand(
                control1=Point(x=center.x - radius, y=center.y - kappa * radius),
                control2=Point(x=center.x - kappa * radius, y=center.y - radius),
                point=Point(x=center.x, y=center.y - radius),
            ),
            CubicCommand(
                control1=Point(x=center.x + kappa * radius, y=center.y - radius),
                control2=Point(x=center.x + radius, y=center.y - kappa * radius),
                point=Point(x=center.x + radius, y=center.y),
            ),
            CloseCommand(),
        ],
    )


def _wave(path_id: str, left: float, right: float, baseline: float, amplitude: float) -> DesignPath:
    commands: list[MoveCommand | CubicCommand] = [MoveCommand(point=Point(x=left, y=baseline))]
    periods = 6
    width = (right - left) / periods
    for index in range(periods):
        x0 = left + index * width
        x1 = x0 + width
        direction = 1 if index % 2 == 0 else -1
        commands.append(
            CubicCommand(
                control1=Point(x=x0 + width / 3, y=baseline + amplitude * direction),
                control2=Point(x=x0 + width * 2 / 3, y=baseline + amplitude * direction),
                point=Point(x=x1, y=baseline),
            )
        )
    return DesignPath(path_id=path_id, commands=commands, reversible=True)


def generate_test_design(
    recipe: ProjectRecipe,
    checkpoint: Callable[[str, int | None, int | None], None] | None = None,
) -> DesignDocument:
    """Compatibility wrapper for the vertical-slice generator."""
    from plotter_core.modes.builtin import test_pattern_plugin

    plugin = test_pattern_plugin()
    prepared = plugin.prepare_settings(recipe.mode)
    context = GenerationContext(
        recipe=recipe.model_copy(update={"mode": prepared}),
        quality=QualityLevel(prepared.quality),
        parameters=prepared.parameters,
        progress=checkpoint,
    )
    return generate_test_design_context(context)


def generate_test_design_context(context: GenerationContext) -> DesignDocument:
    """Generate deterministic, machine-independent geometry from a mode context."""
    recipe = context.recipe
    page = recipe.page
    safe = page.safe_min
    maximum = page.safe_max
    layout_rng = context.random.scalar("layout")
    detail_rng = context.random.scalar("detail")
    quality_scale = {
        QualityLevel.DRAFT: 0.5,
        QualityLevel.STANDARD: 0.75,
        QualityLevel.EXPORT: 1.0,
    }[context.quality]
    density = float(cast(int | float, context.parameters["density"]))
    frame_count_setting = cast(int, context.parameters["frame_count"])
    include_waves = cast(bool, context.parameters["include_waves"])
    accent_style = cast(str, context.parameters["accent_style"])
    orbit_band = cast(list[float], context.parameters["orbit_band_mm"])
    accent_color = cast(str, context.parameters["accent_color"])
    accent_role = cast(str, context.parameters["accent_role"])

    frame_gap = 8.0
    frame_count = max(1, round(frame_count_setting * quality_scale))
    corridor_count = max(1, round(8 * density * quality_scale))
    circle_count = (
        max(1, round(6 * density * quality_scale)) if accent_style in {"both", "orbits"} else 0
    )
    wave_count = (
        max(1, round(3 * density * quality_scale))
        if include_waves and accent_style in {"both", "signals"}
        else 0
    )
    total = frame_count + corridor_count + circle_count + wave_count
    structure_paths: list[DesignPath] = []
    for index in range(frame_count):
        context.checkpoint("structure", index, total)
        inset = index * frame_gap
        structure_paths.append(
            _rounded_rectangle(
                f"structure-frame-{index:02d}",
                safe.x + inset,
                safe.y + inset,
                maximum.x - inset,
                maximum.y - inset,
                4.0 + index,
            )
        )

    usable_width = maximum.x - safe.x - 2 * 44.0
    for index in range(corridor_count):
        context.checkpoint("structure", frame_count + index, total)
        x = safe.x + 44.0 + usable_width * index / max(corridor_count - 1, 1)
        jitter = layout_rng.uniform(-2.5, 2.5)
        low = safe.y + 35.0 + (index % 2) * 18.0
        high = maximum.y - 35.0 - ((index + 1) % 2) * 18.0
        structure_paths.append(
            DesignPath(
                path_id=f"structure-corridor-{index:02d}",
                reversible=True,
                commands=[
                    MoveCommand(point=Point(x=x + jitter, y=low)),
                    LineCommand(point=Point(x=x + jitter, y=high)),
                    LineCommand(
                        point=Point(
                            x=min(maximum.x - 18.0, x + 24.0 + jitter),
                            y=high + (8.0 if index % 2 == 0 else -8.0),
                        )
                    ),
                ],
            )
        )

    accent_paths: list[DesignPath] = []
    for index in range(circle_count):
        context.checkpoint("accent", frame_count + corridor_count + index, total)
        fraction = (index + 1) / (circle_count + 1)
        center = Point(
            x=safe.x + 35.0 + fraction * (maximum.x - safe.x - 70.0),
            y=(safe.y + maximum.y) / 2 + detail_rng.uniform(orbit_band[0], orbit_band[1]),
        )
        radius = 6.0 + detail_rng.uniform(0.0, 6.0)
        accent_paths.append(_circle(f"accent-orbit-{index:02d}", center, radius))

    for index in range(wave_count):
        context.checkpoint(
            "accent",
            frame_count + corridor_count + circle_count + index,
            total,
        )
        baseline = safe.y + (index + 1) * (maximum.y - safe.y) / (wave_count + 1)
        amplitude = 7.0 + 2.0 * math.sin(index + 1)
        accent_paths.append(
            _wave(
                f"accent-signal-{index:02d}",
                safe.x + 20.0,
                maximum.x - 20.0,
                baseline,
                amplitude,
            )
        )

    document = DesignDocument(
        document_id=f"{recipe.project_id}-design",
        page=page,
        layers=[
            DesignLayer(
                layer_id="layer-structure",
                name="Structure",
                semantic_role="structure",
                preview_color="#171717",
                paths=structure_paths,
                metadata={"stream": "layout"},
            ),
            DesignLayer(
                layer_id="layer-accent",
                name="Accent",
                semantic_role=accent_role,
                preview_color=accent_color,
                paths=accent_paths,
                metadata={"stream": "detail"},
            ),
        ],
        metadata=DesignMetadata(
            generator_id=GENERATOR_ID,
            generator_version=GENERATOR_VERSION,
            seed=recipe.mode.seed,
            quality=recipe.mode.quality,
        ),
    )
    digest = canonical_sha256(document)
    context.checkpoint("complete", total, total)
    return document.model_copy(
        update={"metadata": document.metadata.model_copy(update={"normalized_sha256": digest})}
    )
