from __future__ import annotations

import heapq
import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from functools import lru_cache
from itertools import pairwise
from typing import Literal, cast

from pydantic import Field, model_validator

from plotter_core.glyphscape.builtins import MINIMUM_FEATURE_MM, create_builtin_glyph_registry
from plotter_core.glyphscape.families import GlyphFamilyRegistry
from plotter_core.glyphscape.models import Glyph, GlyphPolygon
from plotter_core.models import (
    CloseCommand,
    CubicCommand,
    DesignDiagnostic,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    QuadraticCommand,
    StrictModel,
    canonical_sha256,
)
from plotter_core.modes import GenerationContext, QualityLevel

GLYPHSCAPE_VERSION = "1.0.0"
GLYPHSCAPE_SCHEMA_VERSION: Literal[1] = 1
_EPSILON = 1e-8


class CompositionField(StrictModel):
    """Macro-composition controls evaluated in page-space millimetres."""

    schema_version: Literal[1] = GLYPHSCAPE_SCHEMA_VERSION
    preset: Literal[
        "uniform-circuit",
        "bottom-skyline",
        "central-island",
        "dense-perimeter",
    ]
    density: float = Field(ge=0, le=1)
    connector_density: float = Field(ge=0, le=1)
    orientation_radians: float = Field(ge=-math.pi, le=math.pi)
    landmark_probability: float = Field(ge=0, le=1)
    whitespace: float = Field(ge=0, le=1)
    theme_weights: dict[str, float]

    @model_validator(mode="after")
    def weights_are_valid(self) -> CompositionField:
        if not self.theme_weights or any(
            not math.isfinite(value) or value < 0 for value in self.theme_weights.values()
        ):
            raise ValueError("composition theme weights must be finite and non-negative")
        if sum(self.theme_weights.values()) <= 0:
            raise ValueError("composition must enable at least one theme")
        return self


class MacroRegion(StrictModel):
    region_id: str
    min_point: Point
    max_point: Point
    density: float = Field(ge=0, le=1)
    connector_density: float = Field(ge=0, le=1)
    orientation_radians: float = Field(ge=-math.pi, le=math.pi)
    theme: Literal["city", "industrial", "fairground"]
    landmark_probability: float = Field(ge=0, le=1)
    excluded: bool = False
    locked: bool = False

    @model_validator(mode="after")
    def bounds_are_ordered(self) -> MacroRegion:
        if self.min_point.x >= self.max_point.x or self.min_point.y >= self.max_point.y:
            raise ValueError("macro region must have positive area")
        return self

    @property
    def width_mm(self) -> float:
        return self.max_point.x - self.min_point.x

    @property
    def height_mm(self) -> float:
        return self.max_point.y - self.min_point.y

    @property
    def center(self) -> Point:
        return Point(
            x=(self.min_point.x + self.max_point.x) / 2,
            y=(self.min_point.y + self.max_point.y) / 2,
        )


class RegionLockDescriptor(StrictModel):
    region_id: str
    locked: bool
    seed_stream: str


class PlacedPort(StrictModel):
    port_ref: str
    glyph_id: str
    port_id: str
    position: Point
    connection_type: str
    capacity: int = Field(ge=1)
    preferred_connector_family: str
    preferred_semantic_role: str


class PlacedGlyph(StrictModel):
    instance_id: str
    region_id: str
    family_id: str
    theme: str
    is_landmark: bool
    center: Point
    width_mm: float = Field(gt=0)
    height_mm: float = Field(gt=0)
    glyph: Glyph
    obstacle: GlyphPolygon
    clearance: GlyphPolygon
    ports: list[PlacedPort]


class CandidateConnection(StrictModel):
    candidate_id: str
    source_glyph_id: str
    target_glyph_id: str
    source_port_ref: str
    target_port_ref: str
    distance_mm: float = Field(ge=0)
    connection_type: str


class RoutedConnection(StrictModel):
    edge_id: str
    source_glyph_id: str
    target_glyph_id: str
    source_port_ref: str
    target_port_ref: str
    points: list[Point] = Field(min_length=2)
    hierarchy: Literal["backbone", "loop"]
    is_loop: bool
    decoration: Literal["single", "double", "wave", "zigzag", "ladder", "beads", "bundle"]
    corridor_width_mm: float = Field(gt=0)


class GlyphscapeStatistics(StrictModel):
    glyph_count: int = Field(ge=0)
    family_counts: dict[str, int]
    landmark_count: int = Field(ge=0)
    candidate_count: int = Field(ge=0)
    edge_count: int = Field(ge=0)
    loop_count: int = Field(ge=0)
    crossing_count: int = Field(ge=0)
    routed_count: int = Field(ge=0)
    failed_route_count: int = Field(ge=0)
    filler_count: int = Field(ge=0)
    occupied_area_ratio: float = Field(ge=0, le=1)
    path_count: int = Field(ge=0)
    vertex_count: int = Field(ge=0)
    draw_length_mm: float = Field(ge=0)
    layout_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    geometry_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class GlyphscapeComposition(StrictModel):
    schema_version: Literal[1] = GLYPHSCAPE_SCHEMA_VERSION
    field: CompositionField
    regions: list[MacroRegion]
    locks: list[RegionLockDescriptor]
    glyphs: list[PlacedGlyph]
    candidates: list[CandidateConnection]
    connections: list[RoutedConnection]
    statistics: GlyphscapeStatistics
    diagnostics: list[DesignDiagnostic] = Field(default_factory=list)
    document: DesignDocument


def _parameter_float(context: GenerationContext, key: str) -> float:
    value = context.parameters[key]
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TypeError(f"{key} must be numeric")
    return float(value)


def _parameter_int(context: GenerationContext, key: str) -> int:
    value = context.parameters[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{key} must be an integer")
    return value


def _parameter_text(context: GenerationContext, key: str) -> str:
    value = context.parameters[key]
    if not isinstance(value, str):
        raise TypeError(f"{key} must be text")
    return value


def composition_field(context: GenerationContext) -> CompositionField:
    theme = _parameter_text(context, "theme")
    return CompositionField(
        preset=cast(
            Literal[
                "uniform-circuit",
                "bottom-skyline",
                "central-island",
                "dense-perimeter",
            ],
            _parameter_text(context, "composition"),
        ),
        density=_parameter_float(context, "density"),
        connector_density=_parameter_float(context, "connector_density"),
        orientation_radians=math.radians(_parameter_float(context, "orientation_degrees")),
        landmark_probability=min(1.0, _parameter_int(context, "landmark_count") / 6),
        whitespace=_parameter_float(context, "whitespace"),
        theme_weights={
            "city": 1.0 if theme in {"city", "mixed"} else 0.0,
            "industrial": 1.0 if theme in {"industrial", "mixed"} else 0.0,
            "fairground": 1.0 if theme in {"fairground", "mixed"} else 0.0,
        },
    )


def _weighted_theme(
    field: CompositionField, index: int
) -> Literal["city", "industrial", "fairground"]:
    expanded = [
        theme
        for theme in ("city", "industrial", "fairground")
        if field.theme_weights.get(theme, 0) > 0
    ]
    return cast(Literal["city", "industrial", "fairground"], expanded[index % len(expanded)])


def partition_macro_regions(
    context: GenerationContext,
    field: CompositionField,
) -> tuple[list[MacroRegion], list[RegionLockDescriptor]]:
    low, high = context.recipe.page.safe_min, context.recipe.page.safe_max
    locked_region = _parameter_text(context, "locked_region")
    cells: list[tuple[float, float, float, float, float, bool]]
    if field.preset == "uniform-circuit":
        cells = [
            (0, 0, 0.5, 0.5, 1.0, False),
            (0.5, 0, 1, 0.5, 0.95, False),
            (0, 0.5, 0.5, 1, 0.9, False),
            (0.5, 0.5, 1, 1, 1.0, False),
        ]
    elif field.preset == "bottom-skyline":
        cells = [
            (0, 0, 0.25, 0.7, 1.0, False),
            (0.25, 0, 0.5, 0.7, 0.9, False),
            (0.5, 0, 0.75, 0.7, 1.0, False),
            (0.75, 0, 1, 0.7, 0.9, False),
            (0, 0.7, 1, 1, 0.2, field.whitespace >= 0.45),
        ]
    else:
        cells = []
        for row in range(3):
            for column in range(3):
                center = row == 1 and column == 1
                if field.preset == "central-island":
                    density_scale = 1.0 if center else 0.38
                    excluded = False
                else:
                    density_scale = 0.12 if center else 1.0
                    excluded = center and field.whitespace >= 0.25
                cells.append(
                    (
                        column / 3,
                        row / 3,
                        (column + 1) / 3,
                        (row + 1) / 3,
                        density_scale,
                        excluded,
                    )
                )
    regions: list[MacroRegion] = []
    locks: list[RegionLockDescriptor] = []
    for index, (x0, y0, x1, y1, density_scale, excluded) in enumerate(cells):
        region_id = f"region-{index}"
        locked = locked_region == region_id
        regeneration_step = _parameter_int(context, "regeneration_step")
        seed_suffix = "locked" if locked else f"regen-{regeneration_step}"
        stream = f"regions.{region_id}.{seed_suffix}"
        regions.append(
            MacroRegion(
                region_id=region_id,
                min_point=Point(
                    x=low.x + (high.x - low.x) * x0,
                    y=low.y + (high.y - low.y) * y0,
                ),
                max_point=Point(
                    x=low.x + (high.x - low.x) * x1,
                    y=low.y + (high.y - low.y) * y1,
                ),
                density=min(1.0, field.density * density_scale),
                connector_density=field.connector_density,
                orientation_radians=field.orientation_radians,
                theme=_weighted_theme(field, index),
                landmark_probability=field.landmark_probability,
                excluded=excluded,
                locked=locked,
            )
        )
        locks.append(RegionLockDescriptor(region_id=region_id, locked=locked, seed_stream=stream))
    return regions, locks


def _translate_point(point: Point, center: Point) -> Point:
    return Point(x=point.x + center.x, y=point.y + center.y)


def _translate_polygon(polygon: GlyphPolygon, center: Point) -> GlyphPolygon:
    return GlyphPolygon(vertices=[_translate_point(point, center) for point in polygon.vertices])


def _translate_path(path: DesignPath, center: Point, prefix: str) -> DesignPath:
    commands: list[MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand] = []
    for command in path.commands:
        if isinstance(command, MoveCommand):
            commands.append(MoveCommand(point=_translate_point(command.point, center)))
        elif isinstance(command, LineCommand):
            commands.append(LineCommand(point=_translate_point(command.point, center)))
        elif isinstance(command, QuadraticCommand):
            commands.append(
                QuadraticCommand(
                    control=_translate_point(command.control, center),
                    point=_translate_point(command.point, center),
                )
            )
        elif isinstance(command, CubicCommand):
            commands.append(
                CubicCommand(
                    control1=_translate_point(command.control1, center),
                    control2=_translate_point(command.control2, center),
                    point=_translate_point(command.point, center),
                )
            )
        else:
            commands.append(CloseCommand())
    return path.model_copy(update={"path_id": f"{prefix}-{path.path_id}", "commands": commands})


def _polygon_bounds(polygon: GlyphPolygon) -> tuple[float, float, float, float]:
    return (
        min(point.x for point in polygon.vertices),
        min(point.y for point in polygon.vertices),
        max(point.x for point in polygon.vertices),
        max(point.y for point in polygon.vertices),
    )


def _boxes_overlap(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
    gap: float = 0,
) -> bool:
    return not (
        first[2] + gap <= second[0]
        or second[2] + gap <= first[0]
        or first[3] + gap <= second[1]
        or second[3] + gap <= first[1]
    )


def _family_ids(theme: str, *, landmarks: bool) -> list[str]:
    manifests = _glyph_registry().manifests()
    selected = [
        manifest.family_id
        for manifest in manifests
        if theme in manifest.themes and (("landmark" in manifest.tags) == landmarks)
    ]
    if not selected and not landmarks:
        selected = [manifest.family_id for manifest in manifests if theme in manifest.themes]
    return selected


@lru_cache(maxsize=1)
def _glyph_registry() -> GlyphFamilyRegistry:
    return create_builtin_glyph_registry()


def _place_glyph(
    context: GenerationContext,
    *,
    instance_id: str,
    region: MacroRegion,
    family_id: str,
    center: Point,
    size_mm: float,
    is_landmark: bool,
    seed_stream: str,
) -> PlacedGlyph:
    registry = _glyph_registry()
    manifest = registry.get(family_id).manifest
    size = min(manifest.maximum_size_mm, max(manifest.minimum_size_mm, size_mm))
    glyph = registry.generate(
        family_id,
        instance_id,
        seed=f"{context.recipe.mode.seed}:{seed_stream}:{instance_id}",
        width_mm=size,
        height_mm=size,
        quality=context.quality,
        parameters={
            "detail_level": _parameter_int(context, "detail_level"),
            "variant": "ornate" if is_landmark else "classic",
        },
        cancellation=context.cancellation,
    )
    ports = [
        PlacedPort(
            port_ref=f"{instance_id}:{port.port_id}",
            glyph_id=instance_id,
            port_id=port.port_id,
            position=_translate_point(port.position, center),
            connection_type=port.connection_type,
            capacity=port.capacity,
            preferred_connector_family=port.preferred_connector_family,
            preferred_semantic_role=port.preferred_semantic_role,
        )
        for port in glyph.ports
    ]
    return PlacedGlyph(
        instance_id=instance_id,
        region_id=region.region_id,
        family_id=family_id,
        theme=region.theme,
        is_landmark=is_landmark,
        center=center,
        width_mm=size,
        height_mm=size,
        glyph=glyph,
        obstacle=_translate_polygon(glyph.obstacle.polygon, center),
        clearance=_translate_polygon(glyph.clearance.polygon, center),
        ports=ports,
    )


def place_glyphs(
    context: GenerationContext,
    regions: Sequence[MacroRegion],
    locks: Sequence[RegionLockDescriptor],
) -> tuple[list[PlacedGlyph], list[DesignDiagnostic]]:
    glyphs: list[PlacedGlyph] = []
    diagnostics: list[DesignDiagnostic] = []
    occupied: list[tuple[float, float, float, float]] = []
    landmark_target = _parameter_int(context, "landmark_count")
    size_min = _parameter_float(context, "minimum_glyph_size_mm")
    size_max = _parameter_float(context, "maximum_glyph_size_mm")
    if size_min > size_max:
        raise ValueError("minimum glyph size must not exceed maximum glyph size")
    minimum_gap = _parameter_float(context, "minimum_gap_mm")
    quality_scale = {
        QualityLevel.DRAFT: 0.55,
        QualityLevel.STANDARD: 0.78,
        QualityLevel.EXPORT: 1.0,
    }[context.quality]
    active_regions = [region for region in regions if not region.excluded and region.density > 0]
    lock_by_region = {lock.region_id: lock for lock in locks}

    landmark_regions = sorted(
        active_regions,
        key=lambda item: (-item.landmark_probability, item.region_id),
    )[:landmark_target]
    for region in landmark_regions:
        stream = lock_by_region[region.region_id].seed_stream
        rng = context.random.scalar(f"{stream}.landmark")
        families = _family_ids(region.theme, landmarks=True)
        family_id = families[rng.randrange(len(families))]
        size = min(
            size_max * 1.35,
            max(size_min, min(region.width_mm, region.height_mm) * rng.uniform(0.38, 0.52)),
        )
        jitter_x = max(0.0, region.width_mm - size) * rng.uniform(-0.12, 0.12)
        jitter_y = max(0.0, region.height_mm - size) * rng.uniform(-0.12, 0.12)
        center = Point(x=region.center.x + jitter_x, y=region.center.y + jitter_y)
        placement = _place_glyph(
            context,
            instance_id=f"{region.region_id}-landmark",
            region=region,
            family_id=family_id,
            center=center,
            size_mm=size,
            is_landmark=True,
            seed_stream=stream,
        )
        bounds = _polygon_bounds(placement.clearance)
        if any(_boxes_overlap(bounds, previous, minimum_gap) for previous in occupied):
            diagnostics.append(
                DesignDiagnostic(
                    code="glyphscape-landmark-rejected",
                    message=f"Landmark in {region.region_id} was rejected for clearance.",
                )
            )
            continue
        glyphs.append(placement)
        occupied.append(bounds)

    for region in active_regions:
        stream = lock_by_region[region.region_id].seed_stream
        rng = context.random.scalar(f"{stream}.packing")
        area = region.width_mm * region.height_mm
        target = max(
            1,
            round(area / max(size_min**2 * 4.5, 1) * region.density * quality_scale),
        )
        target = min(
            target,
            {
                QualityLevel.DRAFT: 5,
                QualityLevel.STANDARD: 7,
                QualityLevel.EXPORT: 10,
            }[context.quality],
        )
        attempts = max(12, target * 12)
        families = _family_ids(region.theme, landmarks=False)
        accepted = 0
        for _attempt in range(attempts):
            if accepted >= target:
                break
            context.checkpoint("packing secondary glyphs", len(glyphs), None)
            family_id = families[rng.randrange(len(families))]
            manifest = _glyph_registry().get(family_id).manifest
            upper = min(
                size_max,
                region.width_mm * 0.46,
                region.height_mm * 0.46,
            )
            lower = max(size_min, manifest.minimum_size_mm)
            if upper < lower:
                continue
            size = rng.uniform(lower, upper)
            half = size / 2
            if region.width_mm <= size or region.height_mm <= size:
                continue
            center = Point(
                x=rng.uniform(region.min_point.x + half, region.max_point.x - half),
                y=rng.uniform(region.min_point.y + half, region.max_point.y - half),
            )
            instance_id = f"{region.region_id}-glyph-{accepted:02d}"
            placement = _place_glyph(
                context,
                instance_id=instance_id,
                region=region,
                family_id=family_id,
                center=center,
                size_mm=size,
                is_landmark=False,
                seed_stream=stream,
            )
            bounds = _polygon_bounds(placement.clearance)
            if any(_boxes_overlap(bounds, previous, minimum_gap) for previous in occupied):
                continue
            glyphs.append(placement)
            occupied.append(bounds)
            accepted += 1
        if accepted < target:
            diagnostics.append(
                DesignDiagnostic(
                    code="glyphscape-packing-reduced",
                    message=(
                        f"{region.region_id} placed {accepted} of {target} requested glyphs "
                        "within its clearance and attempt budget."
                    ),
                )
            )
    return sorted(glyphs, key=lambda item: item.instance_id), diagnostics


def build_candidate_connections(glyphs: Sequence[PlacedGlyph]) -> list[CandidateConnection]:
    candidates: list[CandidateConnection] = []
    for index, source in enumerate(glyphs):
        neighbours = sorted(
            glyphs[index + 1 :],
            key=lambda target: (
                math.hypot(target.center.x - source.center.x, target.center.y - source.center.y),
                target.instance_id,
            ),
        )[:8]
        for target in neighbours:
            compatible = [
                (first, second)
                for first in source.ports
                for second in target.ports
                if first.connection_type == second.connection_type
            ]
            if not compatible:
                continue
            first, second = min(
                compatible,
                key=lambda pair: (
                    math.hypot(
                        pair[1].position.x - pair[0].position.x,
                        pair[1].position.y - pair[0].position.y,
                    ),
                    pair[0].port_ref,
                    pair[1].port_ref,
                ),
            )
            distance = math.hypot(
                second.position.x - first.position.x,
                second.position.y - first.position.y,
            )
            candidates.append(
                CandidateConnection(
                    candidate_id=f"candidate-{source.instance_id}-{target.instance_id}",
                    source_glyph_id=source.instance_id,
                    target_glyph_id=target.instance_id,
                    source_port_ref=first.port_ref,
                    target_port_ref=second.port_ref,
                    distance_mm=distance,
                    connection_type=first.connection_type,
                )
            )
    return sorted(candidates, key=lambda item: (item.distance_mm, item.candidate_id))


class _DisjointSet:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, first: str, second: str) -> bool:
        first_root, second_root = self.find(first), self.find(second)
        if first_root == second_root:
            return False
        self.parent[second_root] = first_root
        return True


def select_connection_graph(
    context: GenerationContext,
    glyphs: Sequence[PlacedGlyph],
    candidates: Sequence[CandidateConnection],
) -> tuple[list[tuple[CandidateConnection, bool]], list[DesignDiagnostic]]:
    port_capacity = {port.port_ref: port.capacity for glyph in glyphs for port in glyph.ports}
    usage: Counter[str] = Counter()
    components = _DisjointSet(glyph.instance_id for glyph in glyphs)
    selected: list[tuple[CandidateConnection, bool]] = []
    diagnostics: list[DesignDiagnostic] = []
    for candidate in candidates:
        if components.find(candidate.source_glyph_id) == components.find(candidate.target_glyph_id):
            continue
        if (
            usage[candidate.source_port_ref] >= port_capacity[candidate.source_port_ref]
            or usage[candidate.target_port_ref] >= port_capacity[candidate.target_port_ref]
        ):
            continue
        components.union(candidate.source_glyph_id, candidate.target_glyph_id)
        usage[candidate.source_port_ref] += 1
        usage[candidate.target_port_ref] += 1
        selected.append((candidate, False))
    component_count = len({components.find(glyph.instance_id) for glyph in glyphs})
    if component_count > 1:
        diagnostics.append(
            DesignDiagnostic(
                code="glyphscape-connectivity-reduced",
                message=f"Capacity-compatible backbone contains {component_count} components.",
            )
        )
    loop_target = round(
        max(0, len(glyphs) - 1)
        * _parameter_float(context, "loopiness")
        * _parameter_float(context, "connector_density")
    )
    selected_ids = {item.candidate_id for item, _ in selected}
    for candidate in candidates:
        if loop_target <= 0:
            break
        if candidate.candidate_id in selected_ids:
            continue
        if (
            usage[candidate.source_port_ref] >= port_capacity[candidate.source_port_ref]
            or usage[candidate.target_port_ref] >= port_capacity[candidate.target_port_ref]
        ):
            continue
        usage[candidate.source_port_ref] += 1
        usage[candidate.target_port_ref] += 1
        selected.append((candidate, True))
        loop_target -= 1
    return selected, diagnostics


def _point_in_box(point: Point, box: tuple[float, float, float, float], padding: float = 0) -> bool:
    return (
        box[0] - padding <= point.x <= box[2] + padding
        and box[1] - padding <= point.y <= box[3] + padding
    )


def _route_grid(
    start: Point,
    goal: Point,
    *,
    low: Point,
    high: Point,
    obstacle_boxes: Sequence[tuple[float, float, float, float]],
    cell_mm: float,
    diagonal: bool,
    cancellation: object | None,
) -> list[Point] | None:
    columns = max(2, math.floor((high.x - low.x) / cell_mm) + 1)
    rows = max(2, math.floor((high.y - low.y) / cell_mm) + 1)

    def cell(point: Point) -> tuple[int, int]:
        return (
            min(columns - 1, max(0, round((point.x - low.x) / cell_mm))),
            min(rows - 1, max(0, round((point.y - low.y) / cell_mm))),
        )

    def point(value: tuple[int, int]) -> Point:
        return Point(x=low.x + value[0] * cell_mm, y=low.y + value[1] * cell_mm)

    start_cell, goal_cell = cell(start), cell(goal)
    blocked: set[tuple[int, int]] = set()
    padding = cell_mm * 0.72
    for box in obstacle_boxes:
        first_column = max(0, math.floor((box[0] - padding - low.x) / cell_mm))
        last_column = min(columns - 1, math.ceil((box[2] + padding - low.x) / cell_mm))
        first_row = max(0, math.floor((box[1] - padding - low.y) / cell_mm))
        last_row = min(rows - 1, math.ceil((box[3] + padding - low.y) / cell_mm))
        blocked.update(
            (column, row)
            for column in range(first_column, last_column + 1)
            for row in range(first_row, last_row + 1)
        )
    blocked.discard(start_cell)
    blocked.discard(goal_cell)
    directions = [(1, 0), (-1, 0), (0, 1), (0, -1)]
    if diagonal:
        directions.extend([(1, 1), (1, -1), (-1, 1), (-1, -1)])
    frontier: list[tuple[float, int, tuple[int, int]]] = [(0, 0, start_cell)]
    previous: dict[tuple[int, int], tuple[int, int]] = {}
    cost = {start_cell: 0.0}
    counter = 0
    while frontier:
        _, _, current = heapq.heappop(frontier)
        if current == goal_cell:
            break
        if cancellation is not None and counter % 256 == 0:
            checkpoint = getattr(cancellation, "checkpoint", None)
            if callable(checkpoint):
                checkpoint()
        for dx, dy in directions:
            neighbour = (current[0] + dx, current[1] + dy)
            if (
                neighbour[0] < 0
                or neighbour[0] >= columns
                or neighbour[1] < 0
                or neighbour[1] >= rows
                or neighbour in blocked
            ):
                continue
            step = math.sqrt(2) if dx and dy else 1.0
            turn_penalty = 0.0
            parent = previous.get(current)
            if parent is not None:
                old_direction = (current[0] - parent[0], current[1] - parent[1])
                if old_direction != (dx, dy):
                    turn_penalty = 0.18
            next_cost = cost[current] + step + turn_penalty
            if next_cost >= cost.get(neighbour, math.inf):
                continue
            cost[neighbour] = next_cost
            previous[neighbour] = current
            heuristic = math.hypot(goal_cell[0] - neighbour[0], goal_cell[1] - neighbour[1])
            counter += 1
            heapq.heappush(frontier, (next_cost + heuristic, counter, neighbour))
    if goal_cell not in cost:
        return None
    cells = [goal_cell]
    while cells[-1] != start_cell:
        cells.append(previous[cells[-1]])
    cells.reverse()
    points = [start, *(point(item) for item in cells[1:-1]), goal]
    return simplify_route(points)


def simplify_route(points: Sequence[Point]) -> list[Point]:
    if len(points) <= 2:
        return list(points)
    simplified = [points[0]]
    for index in range(1, len(points) - 1):
        previous, current, following = simplified[-1], points[index], points[index + 1]
        first = (current.x - previous.x, current.y - previous.y)
        second = (following.x - current.x, following.y - current.y)
        if abs(first[0] * second[1] - first[1] * second[0]) <= _EPSILON:
            continue
        simplified.append(current)
    simplified.append(points[-1])
    return simplified


def route_connections(
    context: GenerationContext,
    glyphs: Sequence[PlacedGlyph],
    selected: Sequence[tuple[CandidateConnection, bool]],
) -> tuple[list[RoutedConnection], list[DesignDiagnostic]]:
    by_port = {port.port_ref: port for glyph in glyphs for port in glyph.ports}
    low, high = context.recipe.page.safe_min, context.recipe.page.safe_max
    routing_style = _parameter_text(context, "routing_style")
    corridor = _parameter_float(context, "route_corridor_mm")
    minimum_gap = _parameter_float(context, "minimum_gap_mm")
    cell_mm = max(1.4, min(4.0, minimum_gap * 1.6))
    requested_decoration = _parameter_text(context, "connector_style")
    allowed_decorations = {"single", "double", "wave", "zigzag", "ladder", "beads", "bundle"}
    routes: list[RoutedConnection] = []
    diagnostics: list[DesignDiagnostic] = []
    for index, (candidate, is_loop) in enumerate(selected):
        context.checkpoint("routing connectors", index, len(selected))
        excluded = {candidate.source_glyph_id, candidate.target_glyph_id}
        obstacles = [
            _polygon_bounds(glyph.clearance)
            for glyph in glyphs
            if glyph.instance_id not in excluded
        ]
        points = _route_grid(
            by_port[candidate.source_port_ref].position,
            by_port[candidate.target_port_ref].position,
            low=low,
            high=high,
            obstacle_boxes=obstacles,
            cell_mm=cell_mm,
            diagonal=routing_style == "eight-direction",
            cancellation=context.cancellation,
        )
        if points is None:
            diagnostics.append(
                DesignDiagnostic(
                    code="glyphscape-route-failed",
                    message=(
                        f"No clearance-safe route was found between "
                        f"{candidate.source_glyph_id} and {candidate.target_glyph_id}."
                    ),
                    element_id=candidate.candidate_id,
                )
            )
            continue
        preferred = by_port[candidate.source_port_ref].preferred_connector_family
        decoration = requested_decoration if requested_decoration != "mixed" else preferred
        if decoration not in allowed_decorations:
            decoration = "single"
        routes.append(
            RoutedConnection(
                edge_id=f"edge-{index:03d}",
                source_glyph_id=candidate.source_glyph_id,
                target_glyph_id=candidate.target_glyph_id,
                source_port_ref=candidate.source_port_ref,
                target_port_ref=candidate.target_port_ref,
                points=points,
                hierarchy="loop" if is_loop else "backbone",
                is_loop=is_loop,
                decoration=cast(
                    Literal[
                        "single",
                        "double",
                        "wave",
                        "zigzag",
                        "ladder",
                        "beads",
                        "bundle",
                    ],
                    decoration,
                ),
                corridor_width_mm=corridor,
            )
        )
    return routes, diagnostics


def _polyline(
    path_id: str, points: Sequence[Point], **metadata: str | float | int | bool
) -> DesignPath:
    return DesignPath(
        path_id=path_id,
        commands=[
            MoveCommand(point=points[0]),
            *(LineCommand(point=point) for point in points[1:]),
        ],
        metadata=metadata,
    )


def _rounded_polyline(
    path_id: str,
    points: Sequence[Point],
    radius_mm: float,
    **metadata: str | float | int | bool,
) -> DesignPath:
    if len(points) <= 2:
        return _polyline(path_id, points, **metadata)
    commands: list[MoveCommand | LineCommand | QuadraticCommand] = [MoveCommand(point=points[0])]
    for previous, corner, following in zip(
        points,
        points[1:],
        points[2:],
        strict=False,
    ):
        incoming = math.hypot(corner.x - previous.x, corner.y - previous.y)
        outgoing = math.hypot(following.x - corner.x, following.y - corner.y)
        cut = min(radius_mm, incoming / 3, outgoing / 3)
        if cut <= _EPSILON:
            commands.append(LineCommand(point=corner))
            continue
        entry = Point(
            x=corner.x + (previous.x - corner.x) * cut / incoming,
            y=corner.y + (previous.y - corner.y) * cut / incoming,
        )
        exit_point = Point(
            x=corner.x + (following.x - corner.x) * cut / outgoing,
            y=corner.y + (following.y - corner.y) * cut / outgoing,
        )
        commands.append(LineCommand(point=entry))
        commands.append(QuadraticCommand(control=corner, point=exit_point))
    commands.append(LineCommand(point=points[-1]))
    return DesignPath(path_id=path_id, commands=commands, metadata=metadata)


def _circle(path_id: str, center: Point, radius: float) -> DesignPath:
    points = [
        Point(
            x=center.x + math.cos(math.tau * index / 8) * radius,
            y=center.y + math.sin(math.tau * index / 8) * radius,
        )
        for index in range(8)
    ]
    return DesignPath(
        path_id=path_id,
        commands=[
            MoveCommand(point=points[0]),
            *(LineCommand(point=point) for point in points[1:]),
            CloseCommand(),
        ],
        closed=True,
        metadata={"glyphscape_kind": "junction"},
    )


def _segment_offset(start: Point, end: Point, offset: float) -> tuple[Point, Point]:
    length = math.hypot(end.x - start.x, end.y - start.y)
    if length <= _EPSILON:
        return start, end
    normal_x, normal_y = -(end.y - start.y) / length, (end.x - start.x) / length
    return (
        Point(x=start.x + normal_x * offset, y=start.y + normal_y * offset),
        Point(x=end.x + normal_x * offset, y=end.y + normal_y * offset),
    )


def decorate_connections(
    connections: Sequence[RoutedConnection],
    minimum_feature_mm: float,
    *,
    rounded_corners: bool = False,
) -> list[DesignPath]:
    paths: list[DesignPath] = []
    for connection in connections:
        semantic_role = (
            "connector-secondary" if connection.hierarchy == "loop" else "connector-primary"
        )
        connector_metadata: dict[str, str | float | int | bool] = {
            "glyphscape_kind": "connector",
            "corridor_width_mm": connection.corridor_width_mm,
            "semantic_role": semantic_role,
            "edge_id": connection.edge_id,
        }
        amplitude = max(
            minimum_feature_mm * 0.55,
            min(connection.corridor_width_mm * 0.32, minimum_feature_mm * 1.5),
        )
        if connection.decoration == "single":
            if rounded_corners:
                connector_path = _rounded_polyline(
                    f"{connection.edge_id}-single",
                    connection.points,
                    connection.corridor_width_mm * 0.35,
                    **connector_metadata,
                )
            else:
                connector_path = _polyline(
                    f"{connection.edge_id}-single",
                    connection.points,
                    **connector_metadata,
                )
            paths.append(connector_path)
            continue
        for segment_index, (start, end) in enumerate(
            zip(connection.points, connection.points[1:], strict=False)
        ):
            prefix = f"{connection.edge_id}-{segment_index:02d}"
            if connection.decoration in {"double", "ladder", "bundle"}:
                offsets = (
                    [-amplitude, amplitude]
                    if connection.decoration != "bundle"
                    else [-amplitude, 0.0, amplitude]
                )
                for offset_index, offset in enumerate(offsets):
                    first, second = _segment_offset(start, end, offset)
                    paths.append(
                        _polyline(
                            f"{prefix}-rail-{offset_index}",
                            [first, second],
                            **connector_metadata,
                        )
                    )
                if connection.decoration == "ladder":
                    length = math.hypot(end.x - start.x, end.y - start.y)
                    rung_count = max(1, int(length / max(minimum_feature_mm * 3, 2.4)))
                    for rung in range(1, rung_count + 1):
                        t = rung / (rung_count + 1)
                        center = Point(
                            x=start.x + (end.x - start.x) * t,
                            y=start.y + (end.y - start.y) * t,
                        )
                        first, _ = _segment_offset(center, end, -amplitude)
                        second, _ = _segment_offset(center, end, amplitude)
                        paths.append(
                            _polyline(
                                f"{prefix}-rung-{rung}",
                                [first, second],
                                **connector_metadata,
                            )
                        )
                continue
            length = math.hypot(end.x - start.x, end.y - start.y)
            sample_count = max(4, round(length / max(minimum_feature_mm, 0.5)))
            normal_x = -(end.y - start.y) / max(length, _EPSILON)
            normal_y = (end.x - start.x) / max(length, _EPSILON)
            if connection.decoration == "beads":
                bead_count = max(1, int(length / max(minimum_feature_mm * 4, 3.2)))
                for bead in range(1, bead_count + 1):
                    t = bead / (bead_count + 1)
                    center = Point(
                        x=start.x + (end.x - start.x) * t,
                        y=start.y + (end.y - start.y) * t,
                    )
                    bead_path = _circle(
                        f"{prefix}-bead-{bead}",
                        center,
                        amplitude * 0.55,
                    )
                    paths.append(bead_path.model_copy(update={"metadata": connector_metadata}))
                continue
            values: list[Point] = []
            for sample in range(sample_count + 1):
                t = sample / sample_count
                taper = math.sin(math.pi * t)
                if connection.decoration == "wave":
                    offset = math.sin(math.tau * t * max(1, round(length / 8))) * amplitude * taper
                else:
                    phase = (t * max(2, round(length / 6))) % 1
                    offset = (4 * abs(phase - 0.5) - 1) * amplitude * taper
                values.append(
                    Point(
                        x=start.x + (end.x - start.x) * t + normal_x * offset,
                        y=start.y + (end.y - start.y) * t + normal_y * offset,
                    )
                )
            paths.append(
                _polyline(
                    f"{prefix}-{connection.decoration}",
                    values,
                    **connector_metadata,
                )
            )
    return paths


def _orientation(first: Point, second: Point, third: Point) -> float:
    return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)


def _segment_intersection(
    first: Point,
    second: Point,
    third: Point,
    fourth: Point,
) -> Point | None:
    denominator = (first.x - second.x) * (third.y - fourth.y) - (first.y - second.y) * (
        third.x - fourth.x
    )
    if abs(denominator) <= _EPSILON:
        return None
    t = (
        (first.x - third.x) * (third.y - fourth.y) - (first.y - third.y) * (third.x - fourth.x)
    ) / denominator
    u = (
        -((first.x - second.x) * (first.y - third.y) - (first.y - second.y) * (first.x - third.x))
        / denominator
    )
    if _EPSILON < t < 1 - _EPSILON and _EPSILON < u < 1 - _EPSILON:
        return Point(
            x=first.x + t * (second.x - first.x),
            y=first.y + t * (second.y - first.y),
        )
    return None


def junction_and_crossing_paths(
    connections: Sequence[RoutedConnection],
    ports: Mapping[str, PlacedPort],
    minimum_feature_mm: float,
) -> tuple[list[DesignPath], int]:
    paths: list[DesignPath] = []
    usage = Counter(
        reference
        for connection in connections
        for reference in (connection.source_port_ref, connection.target_port_ref)
    )
    for reference, count in sorted(usage.items()):
        if count > 1:
            paths.append(
                _circle(
                    f"junction-{reference.replace(':', '-')}",
                    ports[reference].position,
                    minimum_feature_mm,
                )
            )
    crossings: list[Point] = []
    for first_index, first in enumerate(connections):
        for second in connections[first_index + 1 :]:
            if {
                first.source_glyph_id,
                first.target_glyph_id,
            } & {second.source_glyph_id, second.target_glyph_id}:
                continue
            for first_start, first_end in zip(first.points, first.points[1:], strict=False):
                for second_start, second_end in zip(second.points, second.points[1:], strict=False):
                    point = _segment_intersection(
                        first_start,
                        first_end,
                        second_start,
                        second_end,
                    )
                    if point is not None and all(
                        math.hypot(point.x - existing.x, point.y - existing.y) > minimum_feature_mm
                        for existing in crossings
                    ):
                        crossings.append(point)
    for index, point in enumerate(crossings):
        paths.append(_circle(f"crossing-{index:03d}", point, minimum_feature_mm * 0.72))
    return paths, len(crossings)


def negative_space_fillers(
    context: GenerationContext,
    regions: Sequence[MacroRegion],
    glyphs: Sequence[PlacedGlyph],
    connections: Sequence[RoutedConnection],
    maximum_count: int,
) -> list[DesignPath]:
    density = _parameter_float(context, "filler_density")
    if density <= 0 or maximum_count <= 0:
        return []
    low, high = context.recipe.page.safe_min, context.recipe.page.safe_max
    spacing = max(6.0, _parameter_float(context, "minimum_feature_mm") * 8)
    candidates: list[Point] = []
    for row in range(1, max(1, int((high.y - low.y) / spacing))):
        for column in range(1, max(1, int((high.x - low.x) / spacing))):
            candidates.append(Point(x=low.x + column * spacing, y=low.y + row * spacing))
    rng = context.random.scalar("negative-space.fillers")
    rng.shuffle(candidates)
    clearance_boxes = [_polygon_bounds(glyph.clearance) for glyph in glyphs]
    excluded_regions = [region for region in regions if region.excluded]

    def near_route(point: Point) -> bool:
        for connection in connections:
            for start, end in zip(connection.points, connection.points[1:], strict=False):
                length_sq = (end.x - start.x) ** 2 + (end.y - start.y) ** 2
                if length_sq <= _EPSILON:
                    continue
                t = max(
                    0.0,
                    min(
                        1.0,
                        (
                            (point.x - start.x) * (end.x - start.x)
                            + (point.y - start.y) * (end.y - start.y)
                        )
                        / length_sq,
                    ),
                )
                projection = Point(
                    x=start.x + (end.x - start.x) * t,
                    y=start.y + (end.y - start.y) * t,
                )
                if math.hypot(point.x - projection.x, point.y - projection.y) < spacing * 0.55:
                    return True
        return False

    target = min(maximum_count, round(len(candidates) * density * 0.18))
    radius = max(MINIMUM_FEATURE_MM, _parameter_float(context, "minimum_feature_mm"))
    fillers: list[DesignPath] = []
    for point in candidates:
        if len(fillers) >= target:
            break
        if any(_point_in_box(point, box, spacing * 0.4) for box in clearance_boxes):
            continue
        if any(
            region.min_point.x <= point.x <= region.max_point.x
            and region.min_point.y <= point.y <= region.max_point.y
            for region in excluded_regions
        ):
            continue
        if near_route(point):
            continue
        fillers.append(
            _polyline(
                f"filler-{len(fillers):03d}",
                [
                    Point(x=point.x - radius, y=point.y),
                    Point(x=point.x, y=point.y + radius),
                    Point(x=point.x + radius, y=point.y),
                    Point(x=point.x, y=point.y - radius),
                    Point(x=point.x - radius, y=point.y),
                ],
                glyphscape_kind="filler",
            )
        )
    return fillers


def _path_points(path: DesignPath) -> list[Point]:
    points: list[Point] = []
    for command in path.commands:
        if isinstance(command, MoveCommand | LineCommand):
            points.append(command.point)
        elif isinstance(command, QuadraticCommand):
            points.extend((command.control, command.point))
        elif isinstance(command, CubicCommand):
            points.extend((command.control1, command.control2, command.point))
    return points


def _path_length(path: DesignPath) -> float:
    points = _path_points(path)
    return sum(
        math.hypot(second.x - first.x, second.y - first.y) for first, second in pairwise(points)
    )


def _apply_budgets(
    layers: Sequence[DesignLayer],
    path_budget: int,
    vertex_budget: int,
) -> tuple[list[DesignLayer], int]:
    used_paths = 0
    used_vertices = 0
    removed = 0
    bounded: list[DesignLayer] = []
    for layer in layers:
        paths: list[DesignPath] = []
        for path in layer.paths:
            command_count = len(path.commands)
            if used_paths + 1 > path_budget or used_vertices + command_count > vertex_budget:
                removed += 1
                continue
            paths.append(path)
            used_paths += 1
            used_vertices += command_count
        bounded.append(layer.model_copy(update={"paths": paths}))
    return bounded, removed


def _make_document(
    context: GenerationContext,
    glyphs: Sequence[PlacedGlyph],
    connector_paths: Sequence[DesignPath],
    junction_paths: Sequence[DesignPath],
    filler_paths: Sequence[DesignPath],
    diagnostics: list[DesignDiagnostic],
) -> tuple[DesignDocument, int]:
    grouped: dict[str, list[DesignPath]] = {
        "glyph-structure": [],
        "glyph-detail": [],
        "glyph-accent": [],
    }
    for placement in glyphs:
        for role_group in placement.glyph.role_paths:
            grouped[role_group.semantic_role].extend(
                _translate_path(path, placement.center, placement.instance_id)
                for path in role_group.paths
            )
    primary_connectors = [
        path
        for path in connector_paths
        if path.metadata.get("semantic_role") != "connector-secondary"
    ]
    secondary_connectors = [
        path
        for path in connector_paths
        if path.metadata.get("semantic_role") == "connector-secondary"
    ]
    layers = [
        DesignLayer(
            layer_id="glyph-structure",
            name="Glyph structures",
            semantic_role="glyph-structure",
            preview_color="#20242b",
            paths=grouped["glyph-structure"],
        ),
        DesignLayer(
            layer_id="glyph-detail",
            name="Glyph details",
            semantic_role="glyph-detail",
            preview_color="#536878",
            paths=grouped["glyph-detail"],
        ),
        DesignLayer(
            layer_id="glyph-accent",
            name="Glyph accents",
            semantic_role="glyph-accent",
            preview_color="#c64934",
            paths=grouped["glyph-accent"],
        ),
        DesignLayer(
            layer_id="connector-primary",
            name="Connector network",
            semantic_role="connector-primary",
            preview_color="#136f63",
            paths=primary_connectors,
        ),
        DesignLayer(
            layer_id="connector-secondary",
            name="Loop connectors",
            semantic_role="connector-secondary",
            preview_color="#2d9c86",
            paths=secondary_connectors,
        ),
        DesignLayer(
            layer_id="connector-junction",
            name="Junctions and crossings",
            semantic_role="connector-junction",
            preview_color="#d18f00",
            paths=list(junction_paths),
        ),
        DesignLayer(
            layer_id="filler",
            name="Negative-space detail",
            semantic_role="filler",
            preview_color="#7b4f96",
            paths=list(filler_paths),
        ),
    ]
    layers, removed = _apply_budgets(
        layers,
        _parameter_int(context, "path_budget"),
        _parameter_int(context, "vertex_budget"),
    )
    if removed:
        diagnostics.append(
            DesignDiagnostic(
                code="glyphscape-budget-reduced",
                message=f"Complexity limits removed {removed} lower-priority paths.",
            )
        )
    document = DesignDocument(
        document_id=f"{context.recipe.project_id}-glyphscape",
        page=context.recipe.page,
        layers=layers,
        metadata=DesignMetadata(
            generator_id="builtin.glyphscape",
            generator_version=GLYPHSCAPE_VERSION,
            seed=context.recipe.mode.seed,
            quality=context.recipe.mode.quality,
            diagnostics=diagnostics,
        ),
    )
    digest = canonical_sha256(document)
    return (
        document.model_copy(
            update={"metadata": document.metadata.model_copy(update={"normalized_sha256": digest})}
        ),
        removed,
    )


def generate_glyphscape_composition(context: GenerationContext) -> GlyphscapeComposition:
    context.checkpoint("building composition fields", 0, 8)
    field = composition_field(context)
    regions, locks = partition_macro_regions(context, field)
    context.checkpoint("placing landmarks", 1, 8)
    glyphs, diagnostics = place_glyphs(context, regions, locks)
    context.checkpoint("building connection graph", 2, 8)
    candidates = build_candidate_connections(glyphs)
    selected, graph_diagnostics = select_connection_graph(context, glyphs, candidates)
    diagnostics.extend(graph_diagnostics)
    context.checkpoint("routing connectors", 3, 8)
    connections, route_diagnostics = route_connections(context, glyphs, selected)
    diagnostics.extend(route_diagnostics)
    minimum_feature = _parameter_float(context, "minimum_feature_mm")
    context.checkpoint("decorating connectors", 4, 8)
    connector_paths = decorate_connections(
        connections,
        minimum_feature,
        rounded_corners=_parameter_text(context, "corner_style") == "rounded",
    )
    port_lookup = {port.port_ref: port for glyph in glyphs for port in glyph.ports}
    junction_paths, crossing_count = junction_and_crossing_paths(
        connections,
        port_lookup,
        minimum_feature,
    )
    context.checkpoint("filling negative space", 5, 8)
    path_budget = _parameter_int(context, "path_budget")
    current_paths = (
        sum(len(group.paths) for glyph in glyphs for group in glyph.glyph.role_paths)
        + len(connector_paths)
        + len(junction_paths)
    )
    filler_paths = negative_space_fillers(
        context,
        regions,
        glyphs,
        connections,
        max(0, path_budget - current_paths),
    )
    context.checkpoint("assembling semantic layers", 6, 8)
    document, _ = _make_document(
        context,
        glyphs,
        connector_paths,
        junction_paths,
        filler_paths,
        diagnostics,
    )
    all_paths = [path for layer in document.layers for path in layer.paths]
    occupied_area = sum(glyph.clearance.area_mm2 for glyph in glyphs)
    safe_area = (context.recipe.page.safe_max.x - context.recipe.page.safe_min.x) * (
        context.recipe.page.safe_max.y - context.recipe.page.safe_min.y
    )
    layout_payload = [
        {
            "instance_id": glyph.instance_id,
            "family_id": glyph.family_id,
            "region_id": glyph.region_id,
            "center": glyph.center.model_dump(mode="json"),
            "width_mm": round(glyph.width_mm, 6),
            "is_landmark": glyph.is_landmark,
        }
        for glyph in glyphs
    ]
    statistics = GlyphscapeStatistics(
        glyph_count=len(glyphs),
        family_counts=dict(sorted(Counter(glyph.family_id for glyph in glyphs).items())),
        landmark_count=sum(glyph.is_landmark for glyph in glyphs),
        candidate_count=len(candidates),
        edge_count=len(connections),
        loop_count=sum(connection.is_loop for connection in connections),
        crossing_count=crossing_count,
        routed_count=len(connections),
        failed_route_count=sum(
            diagnostic.code == "glyphscape-route-failed" for diagnostic in diagnostics
        ),
        filler_count=len(filler_paths),
        occupied_area_ratio=min(1.0, occupied_area / max(safe_area, _EPSILON)),
        path_count=len(all_paths),
        vertex_count=sum(len(path.commands) for path in all_paths),
        draw_length_mm=sum(_path_length(path) for path in all_paths),
        layout_sha256=canonical_sha256(layout_payload),
        geometry_sha256=document.metadata.normalized_sha256,
    )
    context.checkpoint("complete", 8, 8)
    return GlyphscapeComposition(
        field=field,
        regions=regions,
        locks=locks,
        glyphs=glyphs,
        candidates=candidates,
        connections=connections,
        statistics=statistics,
        diagnostics=diagnostics,
        document=document,
    )


def generate_glyphscape(context: GenerationContext) -> DesignDocument:
    return generate_glyphscape_composition(context).document
