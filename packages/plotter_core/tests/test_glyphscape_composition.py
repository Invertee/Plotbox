from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import pytest
from plotter_core.gcode import export_gcode_bundle
from plotter_core.glyphscape import (
    GlyphscapeComposition,
    PlacedGlyph,
    RoutedConnection,
    decorate_connections,
    generate_glyphscape_composition,
    glyphscape_manifest,
    junction_and_crossing_paths,
)
from plotter_core.models import (
    LineCommand,
    MachineProfile,
    ModeSettings,
    PageSettings,
    PassSettings,
    Point,
    ProjectRecipe,
    QuadraticCommand,
)
from plotter_core.modes import GenerationContext, QualityLevel, get_mode_registry
from plotter_core.planning import build_plot_plan
from plotter_core.projects import ProjectStore


def _context(
    *,
    preset_index: int = 0,
    quality: QualityLevel = QualityLevel.STANDARD,
    overrides: dict[str, str | int | float | bool | list[float]] | None = None,
) -> GenerationContext:
    plugin = get_mode_registry().get("builtin.glyphscape")
    preset = plugin.manifest.presets[preset_index]
    parameters = {**preset.parameters, **(overrides or {})}
    settings = plugin.prepare_settings(
        ModeSettings(
            mode_id=plugin.manifest.id,
            version=plugin.manifest.version,
            seed=preset.seed or "glyphscape-test",
            quality=quality.value,
            parameter_schema_version=plugin.manifest.parameter_schema_version,
            parameters=parameters,
        )
    )
    recipe = ProjectRecipe(
        project_id="glyphscape-test",
        name="Glyphscape test",
        page=PageSettings(
            preset="custom",
            orientation="landscape",
            width_mm=180,
            height_mm=130,
            margin_mm=8,
        ),
        mode=settings,
    )
    return GenerationContext(
        recipe=recipe,
        quality=quality,
        parameters=settings.parameters,
    )


def _box(glyph: PlacedGlyph) -> tuple[float, float, float, float]:
    return (
        min(point.x for point in glyph.clearance.vertices),
        min(point.y for point in glyph.clearance.vertices),
        max(point.x for point in glyph.clearance.vertices),
        max(point.y for point in glyph.clearance.vertices),
    )


def _strictly_inside(point: Point, box: tuple[float, float, float, float]) -> bool:
    return box[0] + 1e-7 < point.x < box[2] - 1e-7 and box[1] + 1e-7 < point.y < box[3] - 1e-7


def _samples(start: Point, end: Point) -> Iterable[Point]:
    for index in range(21):
        ratio = index / 20
        yield Point(
            x=start.x + (end.x - start.x) * ratio,
            y=start.y + (end.y - start.y) * ratio,
        )


def _distance_to_segment(point: Point, start: Point, end: Point) -> float:
    length_sq = (end.x - start.x) ** 2 + (end.y - start.y) ** 2
    if length_sq == 0:
        return math.hypot(point.x - start.x, point.y - start.y)
    ratio = max(
        0.0,
        min(
            1.0,
            ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y))
            / length_sq,
        ),
    )
    projection = Point(
        x=start.x + (end.x - start.x) * ratio,
        y=start.y + (end.y - start.y) * ratio,
    )
    return math.hypot(point.x - projection.x, point.y - projection.y)


def _path_points(path: object) -> list[Point]:
    return [
        command.point
        for command in path.commands
        if isinstance(command, LineCommand) or command.kind == "move"
    ]


def test_manifest_exposes_compositions_themes_generated_controls_and_presets() -> None:
    manifest = glyphscape_manifest()
    assert manifest.id == "builtin.glyphscape"
    assert [preset.preset_id for preset in manifest.presets] == [
        "city-circuit",
        "industrial-skyline",
        "fairground-island",
        "mixed-perimeter",
    ]
    assert {"city", "industrial", "fairground"} <= {
        str(preset.parameters["theme"]) for preset in manifest.presets
    }
    assert {
        "locked_region",
        "regeneration_step",
        "path_budget",
        "vertex_budget",
    } <= {parameter.key for parameter in manifest.parameters}
    assert "connector-secondary" in manifest.semantic_roles


@pytest.mark.parametrize(
    ("preset_index", "theme"),
    [(0, "city"), (1, "industrial"), (2, "fairground")],
)
def test_each_initial_theme_preset_generates_stable_semantic_geometry(
    preset_index: int,
    theme: str,
) -> None:
    result = generate_glyphscape_composition(
        _context(preset_index=preset_index, quality=QualityLevel.DRAFT)
    )
    assert result.glyphs
    assert {glyph.theme for glyph in result.glyphs} == {theme}
    assert {
        "glyph-structure",
        "glyph-detail",
        "glyph-accent",
        "connector-primary",
    } <= {layer.semantic_role for layer in result.document.layers}
    assert result.statistics.path_count <= 4000


def test_composition_is_deterministic_bounded_dense_and_capacity_safe() -> None:
    first = generate_glyphscape_composition(_context())
    second = generate_glyphscape_composition(_context())
    assert first == second
    assert first.statistics.glyph_count >= 12
    assert first.statistics.landmark_count == 3
    assert first.statistics.routed_count == first.statistics.edge_count
    assert first.statistics.failed_route_count == 0
    assert first.statistics.occupied_area_ratio > 0.15
    assert first.statistics.layout_sha256 == second.statistics.layout_sha256
    assert first.statistics.geometry_sha256 == second.statistics.geometry_sha256

    boxes = [_box(glyph) for glyph in first.glyphs]
    for index, box in enumerate(boxes):
        for other in boxes[index + 1 :]:
            assert (
                box[2] <= other[0] or other[2] <= box[0] or box[3] <= other[1] or other[3] <= box[1]
            )

    capacity = {port.port_ref: port.capacity for glyph in first.glyphs for port in glyph.ports}
    usage = Counter(
        reference
        for connection in first.connections
        for reference in (connection.source_port_ref, connection.target_port_ref)
    )
    assert all(count <= capacity[reference] for reference, count in usage.items())


def test_quality_levels_reduce_work_without_changing_the_macro_partition() -> None:
    draft = generate_glyphscape_composition(_context(quality=QualityLevel.DRAFT))
    export = generate_glyphscape_composition(_context(quality=QualityLevel.EXPORT))
    assert [region.model_dump() for region in draft.regions] == [
        region.model_dump() for region in export.regions
    ]
    assert draft.statistics.glyph_count <= export.statistics.glyph_count
    assert draft.statistics.path_count <= export.statistics.path_count


def test_routes_avoid_unrelated_clearance_and_decoration_stays_in_corridor() -> None:
    composition = generate_glyphscape_composition(_context())
    glyph_by_id = {glyph.instance_id: glyph for glyph in composition.glyphs}
    for connection in composition.connections:
        unrelated = [
            _box(glyph)
            for glyph in composition.glyphs
            if glyph.instance_id not in {connection.source_glyph_id, connection.target_glyph_id}
        ]
        for start, end in zip(connection.points, connection.points[1:], strict=False):
            assert all(
                not _strictly_inside(sample, box)
                for sample in _samples(start, end)
                for box in unrelated
            )
        assert connection.source_glyph_id in glyph_by_id
        assert connection.target_glyph_id in glyph_by_id

    decorated = decorate_connections(composition.connections, 0.8)
    connection_by_edge = {connection.edge_id: connection for connection in composition.connections}
    for path in decorated:
        edge_id = str(path.metadata["edge_id"])
        connection = connection_by_edge[edge_id]
        maximum_distance = connection.corridor_width_mm / 2 + 1e-7
        for point in _path_points(path):
            distance = min(
                _distance_to_segment(point, start, end)
                for start, end in zip(
                    connection.points,
                    connection.points[1:],
                    strict=False,
                )
            )
            assert distance <= maximum_distance


def test_curved_route_cleanup_preserves_quadratics_until_planning() -> None:
    route = RoutedConnection(
        edge_id="edge-rounded",
        source_glyph_id="a",
        target_glyph_id="b",
        source_port_ref="a:east",
        target_port_ref="b:west",
        points=[Point(x=0, y=0), Point(x=10, y=0), Point(x=10, y=10)],
        hierarchy="backbone",
        is_loop=False,
        decoration="single",
        corridor_width_mm=4,
    )
    [path] = decorate_connections([route], 0.8, rounded_corners=True)
    assert any(isinstance(command, QuadraticCommand) for command in path.commands)
    assert path.metadata["edge_id"] == "edge-rounded"


def test_crossings_receive_explicit_treatment() -> None:
    routes = [
        RoutedConnection(
            edge_id="edge-a",
            source_glyph_id="a",
            target_glyph_id="b",
            source_port_ref="a:east",
            target_port_ref="b:west",
            points=[Point(x=0, y=5), Point(x=10, y=5)],
            hierarchy="backbone",
            is_loop=False,
            decoration="single",
            corridor_width_mm=4,
        ),
        RoutedConnection(
            edge_id="edge-b",
            source_glyph_id="c",
            target_glyph_id="d",
            source_port_ref="c:north",
            target_port_ref="d:south",
            points=[Point(x=5, y=0), Point(x=5, y=10)],
            hierarchy="loop",
            is_loop=True,
            decoration="wave",
            corridor_width_mm=4,
        ),
    ]
    paths, crossing_count = junction_and_crossing_paths(routes, {}, 0.8)
    assert crossing_count == 1
    assert [path.path_id for path in paths] == ["crossing-000"]


def test_low_complexity_budget_reports_reduction_and_stops_filling() -> None:
    result = generate_glyphscape_composition(
        _context(
            quality=QualityLevel.EXPORT,
            overrides={"path_budget": 40, "vertex_budget": 400, "filler_density": 1.0},
        )
    )
    assert result.statistics.path_count <= 40
    assert result.statistics.vertex_count <= 400
    assert "glyphscape-budget-reduced" in {
        diagnostic.code for diagnostic in result.document.metadata.diagnostics
    }


def test_locked_region_survives_regeneration_while_unlocked_regions_change() -> None:
    first = generate_glyphscape_composition(
        _context(overrides={"locked_region": "region-0", "regeneration_step": 0})
    )
    second = generate_glyphscape_composition(
        _context(overrides={"locked_region": "region-0", "regeneration_step": 1})
    )

    def region_payload(
        composition: GlyphscapeComposition, region_id: str
    ) -> list[dict[str, object]]:
        return [
            glyph.model_dump(mode="json")
            for glyph in composition.glyphs
            if glyph.region_id == region_id
        ]

    assert region_payload(first, "region-0") == region_payload(second, "region-0")
    assert region_payload(first, "region-1") != region_payload(second, "region-1")
    assert next(lock for lock in second.locks if lock.region_id == "region-0").locked


def test_saved_glyphscape_recipe_reopens_and_reproduces_geometry(tmp_path: Path) -> None:
    context = _context(
        quality=QualityLevel.DRAFT,
        overrides={"locked_region": "region-0", "regeneration_step": 2},
    )
    store = ProjectStore(tmp_path)
    created = store.create(context.recipe.name, recipe=context.recipe)
    plugin = get_mode_registry().get(created.mode.mode_id)
    first = plugin.generate(created)
    store.write_design(created, first)

    reopened = store.read(created.project_id)
    second = plugin.generate(reopened)
    assert reopened.mode.parameters["locked_region"] == "region-0"
    assert reopened.mode.parameters["regeneration_step"] == 2
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert store.read_design(reopened) == first


def test_glyphscape_plans_and_round_trip_exports_without_exporter_special_cases() -> None:
    context = _context(
        quality=QualityLevel.DRAFT,
        overrides={"path_budget": 800, "vertex_budget": 20000},
    )
    recipe = context.recipe.model_copy(
        update={
            "passes": [
                PassSettings(
                    pass_id="pass-structure",
                    name="Structure",
                    semantic_role="glyph-structure",
                    preview_color="#20242b",
                ),
                PassSettings(
                    pass_id="pass-network",
                    name="Network",
                    semantic_role="connector-primary",
                    preview_color="#136f63",
                ),
                PassSettings(
                    pass_id="pass-accent",
                    name="Accent",
                    semantic_role="glyph-accent",
                    preview_color="#c64934",
                ),
            ]
        }
    )
    context = GenerationContext(
        recipe=recipe,
        quality=context.quality,
        parameters=context.parameters,
    )
    design = generate_glyphscape_composition(context).document
    design_hash = design.metadata.normalized_sha256
    plan = build_plot_plan(recipe, design)
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())
    assert plan.statistics.pass_count == 3
    assert bundle.manifest.valid
    assert all(program.validation.valid for program in bundle.programs)

    remapped = recipe.model_copy(
        update={
            "passes": [
                recipe.passes[1],
                recipe.passes[0],
                recipe.passes[2],
            ]
        }
    )
    assert design.metadata.normalized_sha256 == design_hash
    assert build_plot_plan(remapped, design).source_design_sha256 == design_hash


def test_invalid_glyph_size_range_is_rejected() -> None:
    with pytest.raises(ValueError, match="minimum glyph size"):
        generate_glyphscape_composition(
            _context(
                overrides={
                    "minimum_glyph_size_mm": 35,
                    "maximum_glyph_size_mm": 20,
                }
            )
        )


@dataclass
class _CancelAfter:
    calls: int = 0

    @property
    def cancelled(self) -> bool:
        return self.calls >= 6

    def checkpoint(self) -> None:
        self.calls += 1
        if self.cancelled:
            raise RuntimeError("cancelled fixture")


def test_generation_reaches_cooperative_cancellation_checkpoints() -> None:
    context = _context(quality=QualityLevel.EXPORT)
    cancellation = _CancelAfter()
    cancelled_context = GenerationContext(
        recipe=context.recipe,
        quality=context.quality,
        parameters=context.parameters,
        cancellation=cancellation,
    )
    with pytest.raises(RuntimeError, match="cancelled fixture"):
        generate_glyphscape_composition(cancelled_context)
