from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from plotter_core.gcode import export_gcode_bundle
from plotter_core.glyphscape import (
    HYBRID_MODE_ID,
    LockedRoadEdge,
    LockedRoadGraph,
    LockedRoadNode,
    apply_geographic_fidelity,
    build_locked_road_graph,
    build_road_junction_candidates,
    connector_family_for_road_class,
    extract_building_cells,
    extract_landmark_candidates,
    extract_landscape_regions,
    filter_water_crossings,
    generate_map_glyphscape_composition,
    map_glyphscape_manifest,
    map_glyphscape_plugin,
)
from plotter_core.models import (
    MachineProfile,
    ModeSettings,
    OsmBounds,
    OsmSnapshotMetadata,
    PassSettings,
    Point,
    ProjectRecipe,
)
from plotter_core.modes import GenerationContext, QualityLevel
from plotter_core.planning import build_plot_plan
from pydantic import ValidationError

FIXTURE = (
    Path(__file__).resolve().parents[3] / "fixtures" / "maps" / "small-neighborhood-overpass.json"
)
BOUNDS = OsmBounds(south=51.5030, west=-0.1305, north=51.5070, east=-0.1235)


def _snapshot() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _recipe() -> ProjectRecipe:
    recipe = ProjectRecipe(project_id="hybrid-test", name="Hybrid test")
    metadata = OsmSnapshotMetadata(
        snapshot_id="osm-" + "a" * 16,
        sha256="a" * 64,
        query_sha256="b" * 64,
        fetched_at="2026-07-29T12:00:00Z",
        source_date="2026-07-01T12:00:00Z",
        element_count=len(_snapshot()["elements"]),
        byte_count=100,
        bounds=BOUNDS,
    )
    return recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "selection": recipe.osm.selection.model_copy(update={"bounds": BOUNDS}),
                    "snapshot": metadata,
                }
            )
        }
    )


def _hybrid_context(
    *,
    preset_id: str = "circuit-metropolis",
    overrides: dict[str, str | int | float | bool | list[float]] | None = None,
) -> GenerationContext:
    recipe = _recipe()
    plugin = map_glyphscape_plugin()
    preset = next(item for item in plugin.manifest.presets if item.preset_id == preset_id)
    settings = plugin.prepare_settings(
        ModeSettings(
            mode_id=plugin.manifest.id,
            version=plugin.manifest.version,
            quality="draft",
            seed=preset.seed or "hybrid-test",
            parameters={**preset.parameters, **(overrides or {})},
        )
    )
    recipe = recipe.model_copy(update={"mode": settings})
    return GenerationContext(
        recipe=recipe,
        quality=QualityLevel.DRAFT,
        parameters=settings.parameters,
    )


def test_locked_road_graph_is_deterministic_typed_and_page_bounded() -> None:
    recipe = _recipe()
    first = build_locked_road_graph(_snapshot(), recipe)
    second = build_locked_road_graph(_snapshot(), recipe)

    assert first == second
    assert first.normalized_sha256 == second.normalized_sha256
    assert {edge.source_way_id for edge in first.edges} == {101, 102}
    assert {edge.road_class for edge in first.edges} == {"major", "local"}
    assert all(edge.locked for edge in first.edges)
    assert all(edge.source_node_ids for edge in first.edges)
    assert LockedRoadGraph.model_validate_json(first.model_dump_json()) == first
    assert all(
        recipe.page.safe_min.x <= point.x <= recipe.page.safe_max.x
        and recipe.page.safe_min.y <= point.y <= recipe.page.safe_max.y
        for edge in first.edges
        for point in edge.points
    )


def test_shared_osm_nodes_split_ways_into_topological_edges() -> None:
    snapshot = {
        "elements": [
            {"type": "node", "id": 1, "lat": 51.5040, "lon": -0.1290},
            {"type": "node", "id": 2, "lat": 51.5050, "lon": -0.1270},
            {"type": "node", "id": 3, "lat": 51.5060, "lon": -0.1250},
            {"type": "node", "id": 4, "lat": 51.5050, "lon": -0.1290},
            {"type": "node", "id": 5, "lat": 51.5050, "lon": -0.1250},
            {
                "type": "way",
                "id": 201,
                "nodes": [1, 2, 3],
                "tags": {"highway": "primary", "name": "Main", "bridge": "yes"},
            },
            {
                "type": "way",
                "id": 202,
                "nodes": [4, 2, 5],
                "tags": {"highway": "secondary", "oneway": "yes"},
            },
        ]
    }

    graph = build_locked_road_graph(snapshot, _recipe())
    incidence = Counter(
        node_ref
        for edge in graph.edges
        for node_ref in (edge.source_node_ref, edge.target_node_ref)
    )

    assert len(graph.edges) == 4
    assert incidence["osm-node-2"] == 4
    assert next(edge for edge in graph.edges if edge.source_way_id == 201).bridge
    assert next(edge for edge in graph.edges if edge.source_way_id == 202).one_way
    assert {edge.road_class for edge in graph.edges} == {"major", "secondary"}
    junctions = build_road_junction_candidates(graph)
    assert len(junctions) == 1
    assert junctions[0].source_node_id == 2
    assert junctions[0].degree == 4
    assert junctions[0].kind == "cross"
    assert junctions[0].dominant_road_class == "major"
    assert junctions[0].incident_way_ids == [201, 202]
    assert junctions == build_road_junction_candidates(graph)


def test_clipped_roads_receive_stable_boundary_nodes() -> None:
    snapshot = {
        "elements": [
            {"type": "node", "id": 1, "lat": 51.501, "lon": -0.132},
            {"type": "node", "id": 2, "lat": 51.505, "lon": -0.127},
            {"type": "node", "id": 3, "lat": 51.509, "lon": -0.122},
            {
                "type": "way",
                "id": 301,
                "nodes": [1, 2, 3],
                "tags": {"highway": "residential"},
            },
        ]
    }

    graph = build_locked_road_graph(snapshot, _recipe())

    assert len(graph.edges) == 1
    endpoints = {
        graph.edges[0].source_node_ref,
        graph.edges[0].target_node_ref,
    }
    assert all("boundary" in endpoint for endpoint in endpoints)
    assert all(node.boundary for node in graph.nodes)


def test_disabled_roads_produce_an_explicit_empty_graph() -> None:
    recipe = _recipe()
    recipe = recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "features": recipe.osm.features.model_copy(update={"roads": False}),
                }
            )
        }
    )

    graph = build_locked_road_graph(_snapshot(), recipe)

    assert graph.nodes == []
    assert graph.edges == []
    assert [diagnostic.code for diagnostic in graph.diagnostics] == ["hybrid-roads-disabled"]


def test_graph_contract_rejects_mismatched_edge_endpoints() -> None:
    source = LockedRoadNode(node_id="source", point=Point(x=1, y=1))
    target = LockedRoadNode(node_id="target", point=Point(x=3, y=3))
    edge = LockedRoadEdge(
        edge_id="edge",
        source_way_id=1,
        source_node_ids=[1, 2],
        source_node_ref="source",
        target_node_ref="target",
        road_class="local",
        highway="residential",
        points=[Point(x=1, y=1), Point(x=2, y=2)],
    )

    with pytest.raises(ValidationError, match="final edge point"):
        LockedRoadGraph(
            snapshot_sha256="a" * 64,
            nodes=[source, target],
            edges=[edge],
            normalized_sha256="b" * 64,
        )


def test_map_features_become_cells_landmarks_and_landscape_regions() -> None:
    recipe = _recipe()

    cells = extract_building_cells(_snapshot(), recipe)
    landmarks = extract_landmark_candidates(_snapshot(), recipe)
    landscapes = extract_landscape_regions(
        _snapshot(),
        recipe,
        water_behavior="exclude",
        park_behavior="fill",
    )

    assert [cell.source_way_id for cell in cells] == [103]
    assert cells[0].area_mm2 > 0
    assert {candidate.source_element_id for candidate in landmarks} == {19, 20}
    assert {candidate.category for candidate in landmarks} == {
        "amenity:theatre",
        "tourism:attraction",
    }
    assert {(region.source_way_id, region.kind, region.behavior) for region in landscapes} == {
        (104, "water", "exclude"),
        (106, "park", "fill"),
    }


def test_geographic_fidelity_preserves_topology_and_exact_high_fidelity_geometry() -> None:
    graph = build_locked_road_graph(_snapshot(), _recipe())

    faithful = apply_geographic_fidelity(graph, 100)
    stylized = apply_geographic_fidelity(graph, 0)

    assert faithful == graph
    assert stylized.normalized_sha256 != graph.normalized_sha256
    assert [
        (edge.source_node_ref, edge.target_node_ref, edge.source_way_id) for edge in stylized.edges
    ] == [(edge.source_node_ref, edge.target_node_ref, edge.source_way_id) for edge in graph.edges]
    assert {node.source_node_id for node in stylized.nodes} == {
        node.source_node_id for node in graph.nodes
    }
    assert all(
        point.x == pytest.approx(round(point.x / 6) * 6)
        and point.y == pytest.approx(round(point.y / 6) * 6)
        for node in stylized.nodes
        for point in [node.point]
    )


def test_building_replacement_probability_is_deterministic_and_can_disable_replacement() -> None:
    enabled = generate_map_glyphscape_composition(
        _snapshot(),
        _hybrid_context(overrides={"building_replacement_probability": 1.0}),
    )
    disabled = generate_map_glyphscape_composition(
        _snapshot(),
        _hybrid_context(overrides={"building_replacement_probability": 0.0}),
    )

    assert enabled.statistics.replaced_building_count == 1
    assert disabled.statistics.replaced_building_count == 0
    assert all(glyph.region_id != "osm-building-103" for glyph in disabled.glyphs)


def test_excluded_water_blocks_only_non_bridge_locked_roads() -> None:
    snapshot = {
        "elements": [
            {"type": "node", "id": 1, "lat": 51.5040, "lon": -0.1290},
            {"type": "node", "id": 2, "lat": 51.5060, "lon": -0.1250},
            {"type": "node", "id": 3, "lat": 51.5040, "lon": -0.1292},
            {"type": "node", "id": 4, "lat": 51.5060, "lon": -0.1252},
            {"type": "node", "id": 10, "lat": 51.5045, "lon": -0.1278},
            {"type": "node", "id": 11, "lat": 51.5045, "lon": -0.1265},
            {"type": "node", "id": 12, "lat": 51.5055, "lon": -0.1265},
            {"type": "node", "id": 13, "lat": 51.5055, "lon": -0.1278},
            {
                "type": "way",
                "id": 301,
                "nodes": [1, 2],
                "tags": {"highway": "primary"},
            },
            {
                "type": "way",
                "id": 302,
                "nodes": [3, 4],
                "tags": {"highway": "secondary", "bridge": "yes"},
            },
            {
                "type": "way",
                "id": 303,
                "nodes": [10, 11, 12, 13, 10],
                "tags": {"natural": "water"},
            },
        ]
    }
    recipe = _recipe()
    graph = build_locked_road_graph(snapshot, recipe)
    landscapes = extract_landscape_regions(
        snapshot,
        recipe,
        water_behavior="exclude",
        park_behavior="ignore",
    )

    filtered, removed = filter_water_crossings(
        graph,
        landscapes,
        allow_crossings=False,
    )

    assert removed == 1
    assert [edge.source_way_id for edge in filtered.edges] == [302]
    assert filtered.edges[0].bridge


def test_hybrid_manifest_exposes_three_presets_and_road_class_families() -> None:
    manifest = map_glyphscape_manifest()

    assert manifest.id == HYBRID_MODE_ID
    assert [preset.preset_id for preset in manifest.presets] == [
        "circuit-metropolis",
        "fairground-atlas",
        "industrial-borough",
    ]
    assert {
        road_class: connector_family_for_road_class(road_class)
        for road_class in ("major", "secondary", "local", "path")
    } == {
        "major": "bundle",
        "secondary": "double",
        "local": "single",
        "path": "beads",
    }


@pytest.mark.parametrize(
    ("preset_id", "theme"),
    [
        ("circuit-metropolis", "city"),
        ("fairground-atlas", "fairground"),
        ("industrial-borough", "industrial"),
    ],
)
def test_hybrid_presets_generate_stable_source_backed_designs(
    preset_id: str,
    theme: str,
) -> None:
    context = _hybrid_context(
        preset_id=preset_id,
        overrides={
            "building_replacement_probability": 1.0,
            "road_attachment_distance_mm": 60,
            "path_budget": 3000,
            "vertex_budget": 100000,
        },
    )

    first = generate_map_glyphscape_composition(_snapshot(), context)
    second = generate_map_glyphscape_composition(_snapshot(), context)

    assert first.statistics == second.statistics
    assert first.document.metadata.normalized_sha256 == second.document.metadata.normalized_sha256
    assert first.document.metadata.source_snapshot_sha256 == "a" * 64
    assert first.statistics.locked_edge_count == 1
    assert first.statistics.blocked_water_edge_count == 1
    assert first.statistics.building_cell_count == 1
    assert first.statistics.replaced_building_count == 1
    assert first.statistics.poi_candidate_count == 2
    assert first.statistics.poi_landmark_count == 2
    assert first.statistics.landscape_region_count == 2
    assert first.statistics.attachment_count == 1
    assert first.statistics.secondary_connector_count == 2
    assert all(glyph.theme == theme for glyph in first.glyphs)
    assert {layer.semantic_role for layer in first.document.layers} >= {
        "hybrid-locked-road",
        "hybrid-road-decoration",
        "glyph-structure",
        "hybrid-road-attachment",
        "hybrid-secondary-connector",
        "hybrid-landscape",
    }
    landscape = next(
        layer for layer in first.document.layers if layer.semantic_role == "hybrid-landscape"
    )
    if any(region.behavior == "fill" for region in first.landscapes):
        assert any(
            path.metadata.get("hybrid_kind") == "landscape-filler" for path in landscape.paths
        )


def test_hybrid_design_plans_and_round_trip_exports_without_exporter_special_cases() -> None:
    context = _hybrid_context(
        overrides={
            "building_replacement_probability": 1.0,
            "allow_water_crossings": True,
            "path_budget": 3000,
            "vertex_budget": 100000,
        }
    )
    recipe = context.recipe.model_copy(
        update={
            "passes": [
                PassSettings(
                    pass_id="pass-roads",
                    name="Roads",
                    semantic_role="hybrid-locked-road",
                    preview_color="#1f4b44",
                ),
                PassSettings(
                    pass_id="pass-glyphs",
                    name="Glyphs",
                    semantic_role="glyph-structure",
                    preview_color="#20242b",
                ),
                PassSettings(
                    pass_id="pass-landscape",
                    name="Landscape",
                    semantic_role="hybrid-landscape",
                    preview_color="#187a91",
                ),
            ]
        }
    )
    context = GenerationContext(
        recipe=recipe,
        quality=context.quality,
        parameters=context.parameters,
    )

    design = generate_map_glyphscape_composition(_snapshot(), context).document
    plan = build_plot_plan(recipe, design)
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())

    assert plan.statistics.pass_count == 3
    assert bundle.manifest.valid
    assert all(program.validation.valid for program in bundle.programs)


def test_circuit_metropolis_matches_reviewed_golden_fixture() -> None:
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "fixtures"
            / "maps"
            / "map-glyphscape-circuit-metropolis.json"
        ).read_text(encoding="utf-8")
    )
    context = _hybrid_context(
        overrides={
            "building_replacement_probability": 1.0,
            "road_attachment_distance_mm": 60,
            "path_budget": 3000,
            "vertex_budget": 100000,
        }
    )

    composition = generate_map_glyphscape_composition(_snapshot(), context)

    assert fixture["preset_id"] == "circuit-metropolis"
    assert fixture["seed"] == context.recipe.mode.seed
    assert fixture["statistics"] == composition.statistics.model_dump(mode="json")
