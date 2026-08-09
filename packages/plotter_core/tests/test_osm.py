from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from typing import Any

import pytest
from plotter_core.maps import (
    MAX_QUERY_AREA_KM2,
    build_overpass_query,
    generate_osm_design,
    selection_area_km2,
)
from plotter_core.maps import query as map_query
from plotter_core.models import OsmBounds, OsmSnapshotMetadata, ProjectRecipe
from plotter_core.projects import ProjectStore

FIXTURE = (
    Path(__file__).resolve().parents[3] / "fixtures" / "maps" / "small-neighborhood-overpass.json"
)
BOUNDS = OsmBounds(south=51.5030, west=-0.1305, north=51.5070, east=-0.1235)


def _snapshot() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _recipe() -> ProjectRecipe:
    recipe = ProjectRecipe(project_id="osm-test", name="OSM test")
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
            "mode": recipe.mode.model_copy(update={"mode_id": "map.openstreetmap"}),
            "osm": recipe.osm.model_copy(
                update={
                    "selection": recipe.osm.selection.model_copy(update={"bounds": BOUNDS}),
                    "snapshot": metadata,
                }
            ),
        }
    )


def test_overpass_fetch_fails_over_after_provider_error(monkeypatch) -> None:
    calls: list[str] = []

    def post(endpoint: str, _: bytes) -> dict[str, Any]:
        calls.append(endpoint)
        if len(calls) == 1:
            raise OSError("HTTP Error 502: Bad Gateway")
        return {"elements": []}

    monkeypatch.delenv("PLOTTERAPP_OVERPASS_ENDPOINTS", raising=False)
    monkeypatch.setattr(map_query, "_post_overpass", post)

    assert map_query.fetch_osm_json("[out:json];out;") == {"elements": []}
    assert calls == list(map_query.DEFAULT_OVERPASS_ENDPOINTS[:2])


def test_overpass_fetch_attempts_every_provider_before_failing(monkeypatch) -> None:
    calls: list[str] = []

    def post(endpoint: str, _: bytes) -> dict[str, Any]:
        calls.append(endpoint)
        raise TimeoutError("timed out")

    monkeypatch.delenv("PLOTTERAPP_OVERPASS_ENDPOINTS", raising=False)
    monkeypatch.setattr(map_query, "_post_overpass", post)

    with pytest.raises(OSError, match="all configured Overpass providers failed"):
        map_query.fetch_osm_json("[out:json];out;")
    assert calls == list(map_query.DEFAULT_OVERPASS_ENDPOINTS)


def test_overpass_request_uses_bounded_extended_timeout(monkeypatch) -> None:
    captured_timeout = 0
    captured_headers: dict[str, str] = {}

    def urlopen(request, timeout: int):
        nonlocal captured_timeout, captured_headers
        captured_timeout = timeout
        captured_headers = dict(request.headers)
        return io.BytesIO(b'{"elements":[]}')

    monkeypatch.setattr(map_query.urllib.request, "urlopen", urlopen)

    assert map_query._post_overpass("https://example.test/interpreter", b"data=query") == {
        "elements": []
    }
    assert captured_timeout == map_query.OVERPASS_HTTP_TIMEOUT_SECONDS
    assert captured_timeout > 90
    assert captured_headers["Accept"] == "application/json"


def test_place_fetch_normalizes_and_limits_provider_results(monkeypatch) -> None:
    payload = [
        {
            "display_name": f"Place {index}",
            "lat": "52.2053",
            "lon": "0.1218",
            "osm_type": "relation",
            "osm_id": index,
        }
        for index in range(7)
    ]
    payload.append({"display_name": "Invalid", "lat": "not-a-number", "lon": "0"})
    captured_url = ""

    def urlopen(request, timeout: int):
        nonlocal captured_url
        captured_url = request.full_url
        assert timeout == 15
        return io.BytesIO(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(map_query.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(map_query, "_last_nominatim_request", 0.0)

    results = map_query.fetch_osm_places("Cambridge")

    assert len(results) == 5
    assert results[0]["display_name"] == "Place 0"
    assert results[0]["latitude"] == pytest.approx(52.2053)
    assert "q=Cambridge" in captured_url
    assert "limit=5" in captured_url


def test_query_is_bounded_and_stable() -> None:
    area = selection_area_km2(BOUNDS)
    assert 0 < area < MAX_QUERY_AREA_KM2
    query = build_overpass_query(BOUNDS)
    assert query == build_overpass_query(BOUNDS)
    assert "[timeout:90]" in query
    assert 'node["amenity"]' in query
    assert 'node["tourism"]' in query
    assert 'node["historic"]' in query
    with pytest.raises(ValueError, match="maximum request area"):
        build_overpass_query(OsmBounds(south=50, west=-1, north=51, east=0))


def test_fixture_projects_classifies_and_hatches_deterministically() -> None:
    recipe = _recipe()
    first = generate_osm_design(_snapshot(), recipe)
    second = generate_osm_design(_snapshot(), recipe)
    roles = {layer.semantic_role for layer in first.layers}
    assert {"road-major", "road-local", "buildings", "water", "rail", "parks"} <= roles
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.metadata.source_attribution == "© OpenStreetMap contributors"
    safe_min = recipe.page.safe_min
    safe_max = recipe.page.safe_max
    points = [
        command.point
        for layer in first.layers
        for path in layer.paths
        for command in path.commands
        if command.kind in {"move", "line"}
    ]
    assert points
    assert all(safe_min.x - 1e-6 <= point.x <= safe_max.x + 1e-6 for point in points)
    assert all(safe_min.y - 1e-6 <= point.y <= safe_max.y + 1e-6 for point in points)
    water = next(layer for layer in first.layers if layer.semantic_role == "water")
    assert any(path.metadata.get("treatment") == "hatch" for path in water.paths)


def test_feature_toggles_and_line_treatments_change_only_relevant_layers() -> None:
    recipe = _recipe()
    baseline = generate_osm_design(_snapshot(), recipe)
    hidden_buildings = recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "features": recipe.osm.features.model_copy(update={"buildings": False}),
                }
            )
        }
    )
    hidden = generate_osm_design(_snapshot(), hidden_buildings)
    assert "buildings" not in {layer.semantic_role for layer in hidden.layers}
    unchanged_roles = {layer.semantic_role for layer in baseline.layers} - {"buildings"}
    assert unchanged_roles == {layer.semantic_role for layer in hidden.layers}

    casing = recipe.model_copy(
        update={
            "osm": recipe.osm.model_copy(
                update={
                    "render": recipe.osm.render.model_copy(update={"road_line_treatment": "casing"})
                }
            )
        }
    )
    cased = generate_osm_design(_snapshot(), casing)
    baseline_roads = sum(
        len(layer.paths) for layer in baseline.layers if layer.semantic_role.startswith("road")
    )
    cased_roads = sum(
        len(layer.paths) for layer in cased.layers if layer.semantic_role.startswith("road")
    )
    assert cased_roads == baseline_roads * 2


def test_page_selection_clips_a_way_whose_nodes_extend_beyond_the_bounds() -> None:
    snapshot = {
        "elements": [
            {"type": "node", "id": 1, "lat": 51.501, "lon": -0.132},
            {"type": "node", "id": 2, "lat": 51.509, "lon": -0.122},
            {"type": "way", "id": 201, "nodes": [1, 2], "tags": {"highway": "primary"}},
        ]
    }
    recipe = _recipe()
    document = generate_osm_design(snapshot, recipe)
    road = next(layer for layer in document.layers if layer.semantic_role == "road-major")
    points = [
        command.point for command in road.paths[0].commands if command.kind in {"move", "line"}
    ]
    assert len(points) == 2
    assert all(recipe.page.safe_min.x <= point.x <= recipe.page.safe_max.x for point in points)
    assert all(recipe.page.safe_min.y <= point.y <= recipe.page.safe_max.y for point in points)
    assert any(
        abs(point.x - recipe.page.safe_min.x) < 1e-6
        or abs(point.x - recipe.page.safe_max.x) < 1e-6
        or abs(point.y - recipe.page.safe_min.y) < 1e-6
        or abs(point.y - recipe.page.safe_max.y) < 1e-6
        for point in points
    )


def test_project_store_freezes_and_validates_snapshot(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("OSM persistence")
    query = build_overpass_query(BOUNDS)
    query_hash = hashlib.sha256(query.encode()).hexdigest()
    updated = store.write_osm_snapshot(
        project.project_id,
        payload=_snapshot(),
        query_sha256=query_hash,
        bounds=BOUNDS,
        fetched_at="2026-07-29T12:00:00Z",
    )
    assert updated.osm.snapshot is not None
    assert store.read_osm_snapshot(updated) == _snapshot()
    assert (store.project_directory(project.project_id) / "map-data").is_dir()
