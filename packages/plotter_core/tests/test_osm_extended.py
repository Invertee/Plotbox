from __future__ import annotations

from typing import Any

from plotter_core.maps.osm import build_overpass_query, generate_osm_design
from plotter_core.maps.terrain import ElevationGrid
from plotter_core.models import OsmBounds, OsmSnapshotMetadata, ProjectRecipe

BOUNDS = OsmBounds(south=51.0, west=-1.0, north=51.01, east=-0.98)


def _recipe() -> ProjectRecipe:
    recipe = ProjectRecipe(project_id="osm-extended-test", name="OSM extended")
    metadata = OsmSnapshotMetadata(
        snapshot_id="osm-" + "a" * 16,
        sha256="a" * 64,
        query_sha256="b" * 64,
        fetched_at="2026-09-06T12:00:00Z",
        source_date="2026-09-06T12:00:00Z",
        element_count=0,
        byte_count=100,
        bounds=BOUNDS,
    )
    return recipe.model_copy(
        update={
            "mode": recipe.mode.model_copy(update={"mode_id": "map.openstreetmap"}),
            "osm": recipe.osm.model_copy(
                update={
                    "selection": recipe.osm.selection.model_copy(update={"bounds": BOUNDS}),
                    "snapshot": metadata,
                }
            ),
        }
    )


def test_extended_query_requests_new_feature_families() -> None:
    query = build_overpass_query(BOUNDS)
    assert 'way["boundary"="administrative"]' in query
    assert 'way["power"]' in query
    assert 'way["aeroway"]' in query
    assert 'way["man_made"]' in query
    assert 'node["railway"]' in query
    assert 'node["natural"]' in query


def test_transport_water_landuse_and_bridge_treatments_emit_vector_layers() -> None:
    snapshot: dict[str, Any] = {
        "elements": [
            {"type": "node", "id": 1, "lat": 51.001, "lon": -0.999},
            {"type": "node", "id": 2, "lat": 51.009, "lon": -0.981},
            {"type": "node", "id": 3, "lat": 51.002, "lon": -0.998},
            {"type": "node", "id": 4, "lat": 51.002, "lon": -0.990},
            {"type": "node", "id": 5, "lat": 51.006, "lon": -0.990},
            {"type": "node", "id": 6, "lat": 51.006, "lon": -0.998},
            {
                "type": "way",
                "id": 101,
                "nodes": [1, 2],
                "tags": {"highway": "cycleway", "bridge": "yes"},
            },
            {
                "type": "way",
                "id": 102,
                "nodes": [3, 4, 5, 6, 3],
                "tags": {"landuse": "forest"},
            },
            {
                "type": "way",
                "id": 103,
                "nodes": [1, 2],
                "tags": {"waterway": "stream"},
            },
        ]
    }
    recipe = _recipe()
    recipe = recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "features": recipe.osm.features.model_copy(
                        update={"woodland": True, "waterways": True, "cycleways": True}
                    ),
                    "render": recipe.osm.render.model_copy(
                        update={"road_line_treatment": "classified", "landuse_treatment": "hatch"}
                    ),
                }
            )
        }
    )
    design = generate_osm_design(snapshot, recipe)
    roles = {layer.semantic_role for layer in design.layers}
    assert "road-path" in roles
    assert "waterway" in roles
    assert "forest" in roles
    road = next(layer for layer in design.layers if layer.semantic_role == "road-path")
    assert any(path.metadata.get("treatment") == "bridge-tick" for path in road.paths)
    forest = next(layer for layer in design.layers if layer.semantic_role == "forest")
    assert any(path.metadata.get("treatment") == "hatch" for path in forest.paths)


def test_poi_symbols_are_deduplicated_in_page_millimetres() -> None:
    snapshot = {
        "elements": [
            {
                "type": "node",
                "id": 1,
                "lat": 51.005,
                "lon": -0.990,
                "tags": {"amenity": "hospital"},
            },
            {
                "type": "node",
                "id": 2,
                "lat": 51.005001,
                "lon": -0.990001,
                "tags": {"amenity": "hospital"},
            },
        ]
    }
    recipe = _recipe()
    recipe = recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "features": recipe.osm.features.model_copy(
                        update={"points_of_interest": True, "poi_hospitals": True}
                    ),
                    "detail": recipe.osm.detail.model_copy(update={"minimum_poi_spacing_mm": 5.0}),
                }
            )
        }
    )
    design = generate_osm_design(snapshot, recipe)
    hospital = next(layer for layer in design.layers if layer.semantic_role == "poi-hospital")
    assert len(hospital.paths) == 2  # one plus symbol, not two overlapping symbols


class _FakeTerrainProvider:
    def get_elevation_grid(self, bounds, resolution, *, progress=None, cancel=None):
        values = tuple(
            tuple(float(x + y) * 5.0 for x in range(16))
            for y in range(16)
        )
        return ElevationGrid(bounds=bounds, width=16, height=16, values=values)


def test_terrain_provider_generates_standard_and_index_contour_layers() -> None:
    recipe = _recipe()
    recipe = recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "terrain": recipe.osm.terrain.model_copy(
                        update={
                            "enabled": True,
                            "contour_interval_m": 10.0,
                            "index_contour_every": 2,
                            "sample_resolution": 16,
                            "minimum_contour_length_mm": 0.0,
                        }
                    )
                }
            )
        }
    )
    design = generate_osm_design(
        {"elements": []},
        recipe,
        terrain_provider=_FakeTerrainProvider(),
    )
    roles = {layer.semantic_role for layer in design.layers}
    assert "terrain-contour" in roles
    assert "terrain-index-contour" in roles
