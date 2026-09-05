from __future__ import annotations

import base64
import io
import json
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image
from plotter_core.generator import generate_test_design
from plotterapp_api.main import create_app


def test_home_assistant_entry_points_use_plotbox_brand() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    addon_config = (repository_root / "config.yaml").read_text(encoding="utf-8")

    assert "name: Plotbox" in addon_config
    assert "slug: plotbox" in addon_config
    assert "panel_title: Plotbox" in addon_config
    assert "ingress_port: 5616" in addon_config
    assert "5616/tcp: 5616" in addon_config
    assert "192.168.0.0/16" in addon_config
    assert "172.16.0.0/12" in addon_config
    assert "fc00::/7" in addon_config
    assert create_app().title == "Plotbox API"


def test_health_contract() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "plotterapp-api",
        "schema_version": 1,
    }


def test_allowed_client_networks_protect_home_assistant_ingress(monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_ALLOWED_CLIENT_NETWORKS", "172.30.32.2/32,127.0.0.0/8")
    application = create_app()
    with TestClient(application, client=("127.0.0.1", 50000)) as allowed_client:
        assert allowed_client.get("/api/health").status_code == 200
    with TestClient(application, client=("192.168.1.20", 50000)) as blocked_client:
        response = blocked_client.get("/api/health")
    assert response.status_code == 403
    assert response.json()["detail"] == "client address is not allowed"


def test_private_lan_and_container_proxy_clients_can_reach_packaged_app(monkeypatch) -> None:
    monkeypatch.setenv(
        "PLOTTERAPP_ALLOWED_CLIENT_NETWORKS",
        "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7",
    )
    application = create_app()
    for address in ("192.168.1.20", "172.30.33.4", "10.0.0.8"):
        with TestClient(application, client=(address, 50000)) as client:
            assert client.get("/api/health").status_code == 200


def test_production_web_root_is_served_without_shadowing_api(tmp_path: Path, monkeypatch) -> None:
    web_root = tmp_path / "web"
    web_root.mkdir()
    (web_root / "index.html").write_text("<!doctype html><title>Plotbox</title>", encoding="utf-8")
    (web_root / "asset.txt").write_text("relative asset", encoding="utf-8")
    monkeypatch.setenv("PLOTTERAPP_WEB_ROOT", str(web_root))

    with TestClient(create_app()) as client:
        assert client.get("/").text == "<!doctype html><title>Plotbox</title>"
        assert client.get("/asset.txt").text == "relative asset"
        assert client.get("/api/health").json()["status"] == "ok"


def test_project_list_rename_and_delete_contract(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    with TestClient(create_app()) as client:
        first = client.post("/api/projects", json={"name": "First name"}).json()
        second = client.post("/api/projects", json={"name": "Keep me"}).json()

        renamed = client.patch(
            f"/api/projects/{first['project_id']}",
            json={"changes": {"name": "Renamed project"}},
        )
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "Renamed project"
        assert renamed.json()["project_id"] == first["project_id"]

        deleted = client.delete(f"/api/projects/{first['project_id']}")
        assert deleted.status_code == 204
        assert client.get(f"/api/projects/{first['project_id']}").status_code == 404
        projects = client.get("/api/projects").json()

    assert [item["project_id"] for item in projects] == [second["project_id"]]


def test_modes_expose_versioned_generator_controls_presets_and_raster_schema() -> None:
    with TestClient(create_app()) as client:
        modes = client.get("/api/modes").json()
    generator = next(item for item in modes if item["id"] == "builtin.test-pattern")
    assert generator["schema_version"] == 1
    assert generator["parameter_schema_version"] == 1
    assert {item["kind"] for item in generator["parameters"]} == {
        "number",
        "integer",
        "boolean",
        "enum",
        "seed",
        "color",
        "role",
        "range",
    }
    assert [preset["preset_id"] for preset in generator["presets"]] == [
        "balanced",
        "quiet-signals",
    ]
    raster = next(item for item in modes if item["id"] == "import.raster")
    assert raster["algorithms"] == [
        "edge",
        "centerline",
        "hatch",
        "crosshatch",
        "squiggle",
        "circular-scribble",
        "tone-contour",
        "color-outline",
        "color-hatch",
        "dither",
        "stipple",
        "adaptive-stipple",
    ]
    assert raster["parameter_schema"]["properties"]["algorithm"]["enum"] == raster["algorithms"]
    hybrid = next(item for item in modes if item["id"] == "builtin.map-glyphscape")
    assert [preset["preset_id"] for preset in hybrid["presets"]] == [
        "circuit-metropolis",
        "fairground-atlas",
        "industrial-borough",
    ]


def test_invalid_mode_parameters_are_rejected_without_persisting(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    with TestClient(create_app()) as client:
        project = client.post("/api/projects", json={"name": "Mode validation"}).json()
        project_id = project["project_id"]
        response = client.patch(
            f"/api/projects/{project_id}",
            json={"changes": {"mode": {"parameters": {"density": 99.0}}}},
        )
        reopened = client.get(f"/api/projects/{project_id}").json()
    assert response.status_code == 422
    assert "density must be at most 2.0" in response.json()["detail"]
    assert reopened["mode"]["parameters"]["density"] == 1.0


def test_complete_a3_project_api_workflow(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    with TestClient(create_app()) as client:
        created_response = client.post(
            "/api/projects",
            json={"name": "API acceptance", "page_preset": "A3", "orientation": "landscape"},
        )
        assert created_response.status_code == 201
        recipe = created_response.json()
        project_id = recipe["project_id"]
        assert recipe["page"]["width_mm"] == 420

        patched = client.patch(
            f"/api/projects/{project_id}",
            json={"changes": {"mode": {"seed": "codex-vertical-slice-1"}}},
        )
        assert patched.status_code == 200

        design_response = client.post(
            f"/api/projects/{project_id}/generate", json={"quality": "export"}
        )
        assert design_response.status_code == 200
        design = design_response.json()
        assert [layer["layer_id"] for layer in design["layers"]] == [
            "layer-structure",
            "layer-accent",
        ]

        plan_response = client.post(f"/api/projects/{project_id}/plan")
        assert plan_response.status_code == 200
        plan = plan_response.json()
        assert [item["pass_id"] for item in plan["passes"]] == [
            "pass-black",
            "pass-cyan",
        ]

        export_response = client.post(f"/api/projects/{project_id}/export/gcode", json={})
        assert export_response.status_code == 200, export_response.text
        bundle = export_response.json()
        assert bundle["manifest"]["valid"] is True
        assert len(bundle["manifest"]["entries"]) == 5
        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["archive_base64"])))
        assert sorted(archive.namelist()) == [
            "01-black.nc",
            "02-cyan.nc",
            "combined.nc",
            "dry-run.nc",
            "manifest.json",
            "page-boundary.nc",
        ]

        reopened = client.get(f"/api/projects/{project_id}")
        assert reopened.status_code == 200
        assert reopened.json()["mode"]["seed"] == "codex-vertical-slice-1"
        second_export = client.post(f"/api/projects/{project_id}/export/gcode", json={}).json()
        assert second_export["manifest"] == bundle["manifest"]
        assert second_export["archive_base64"] == bundle["archive_base64"]


def test_too_small_work_area_is_blocked(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    with TestClient(create_app()) as client:
        project_id = client.post("/api/projects", json={}).json()["project_id"]
        client.post(f"/api/projects/{project_id}/generate", json={"quality": "export"})
        client.post(f"/api/projects/{project_id}/plan")
        profile = client.get("/api/export-profiles").json()[0]
        profile["work_width_mm"] = 300
        response = client.post(
            f"/api/projects/{project_id}/export/gcode",
            json={"profile": profile},
        )
    assert response.status_code == 422
    assert "does not fit" in response.json()["detail"]


def _wait_for_job(client: TestClient, job_id: str) -> dict:
    deadline = time.monotonic() + 5
    while True:
        state = client.get(f"/api/jobs/{job_id}").json()
        if state["status"] in {"succeeded", "cancelled", "failed", "stale"}:
            return state
        assert time.monotonic() < deadline
        time.sleep(0.01)


def _raster_fixture() -> bytes:
    image = Image.new("RGB", (64, 32), "white")
    for x in range(32):
        for y in range(32):
            image.putpixel((x, y), (20, 70, 140))
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def test_background_generation_cache_and_compact_transport(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    with TestClient(create_app()) as client:
        project_id = client.post("/api/projects", json={"name": "jobs"}).json()["project_id"]
        started = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft", "background": True},
        )
        assert started.status_code == 202
        first = _wait_for_job(client, started.json()["job_id"])
        assert first["status"] == "succeeded"
        assert first["cache_hit"] is False
        geometry = client.get(f"/api/projects/{project_id}/design/geometry").json()
        assert geometry["coordinate_type"] == "float32"
        assert len(geometry["path_offsets"]) == len(geometry["path_flags"]) + 1

        second_job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft", "background": True},
        ).json()
        second = _wait_for_job(client, second_job["job_id"])
        assert second["status"] == "succeeded"
        assert second["cache_hit"] is True
        statistics = client.get(f"/api/projects/{project_id}/cache").json()
        assert statistics["entry_count"] == 1
        pruned = client.delete(f"/api/projects/{project_id}/cache").json()
        assert pruned["remaining_entries"] == 0


def test_svg_asset_job_pass_plan_and_svg_export(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fixture = (
        Path(__file__).resolve().parents[3] / "fixtures" / "svg" / "two-layer-transforms.svg"
    ).read_bytes()
    with TestClient(create_app()) as client:
        project_id = client.post("/api/projects", json={"name": "svg API"}).json()["project_id"]
        upload = client.post(
            f"/api/projects/{project_id}/assets",
            params={"filename": "drawing.svg"},
            content=fixture,
            headers={"Content-Type": "image/svg+xml"},
        )
        assert upload.status_code == 201, upload.text
        assert upload.json()["asset"]["sha256"]
        job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "standard", "background": True},
        ).json()
        completed = _wait_for_job(client, job["job_id"])
        assert completed["status"] == "succeeded", completed
        assert {warning["code"] for warning in completed["warnings"]} == {
            "unsupported-filter",
        }
        project = client.get(f"/api/projects/{project_id}").json()
        assert [item["source_layer_ids"] for item in project["passes"]] == [
            ["layer-structure"],
            ["layer-accent"],
        ]
        design_hash = client.get(f"/api/projects/{project_id}/design").json()["metadata"][
            "normalized_sha256"
        ]
        plan = client.post(f"/api/projects/{project_id}/plan")
        assert plan.status_code == 200, plan.text
        assert plan.json()["source_design_sha256"] == design_hash
        svg_bundle = client.post(f"/api/projects/{project_id}/export/svg").json()
        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(svg_bundle["archive_base64"])))
        assert sorted(archive.namelist()) == [
            "01-black.svg",
            "02-cyan.svg",
            "combined.svg",
        ]


def test_raster_asset_preprocess_job_preview_and_separate_cache(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    with TestClient(create_app()) as client:
        project_id = client.post("/api/projects", json={"name": "raster API"}).json()["project_id"]
        upload = client.post(
            f"/api/projects/{project_id}/assets",
            params={"filename": "scan.png"},
            content=_raster_fixture(),
            headers={"Content-Type": "image/png"},
        )
        assert upload.status_code == 201, upload.text
        assert upload.json()["project"]["mode"]["mode_id"] == "import.raster"

        started = client.post(
            f"/api/projects/{project_id}/raster/preprocess",
            json={"quality": "draft", "background": True},
        )
        assert started.status_code == 202
        completed = _wait_for_job(client, started.json()["job_id"])
        assert completed["status"] == "succeeded"
        assert completed["cache_hit"] is False
        preview = client.get(f"/api/projects/{project_id}/raster/preview")
        assert preview.status_code == 200
        payload = preview.json()
        assert payload["source_width_px"] == 64
        assert payload["source_height_px"] == 32
        assert payload["processed_width_px"] > payload["source_width_px"]
        assert base64.b64decode(payload["preview_png_base64"]).startswith(b"\x89PNG")

        second = client.post(
            f"/api/projects/{project_id}/raster/preprocess",
            json={"quality": "draft", "background": True},
        ).json()
        assert _wait_for_job(client, second["job_id"])["cache_hit"] is True

        vector_job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft", "background": True},
        )
        assert vector_job.status_code == 202
        assert vector_job.json()["operation"] == "vectorize_raster"
        vectorized = _wait_for_job(client, vector_job.json()["job_id"])
        assert vectorized["status"] == "succeeded", vectorized
        design = client.get(f"/api/projects/{project_id}/design")
        assert design.status_code == 200
        assert design.json()["layers"][0]["layer_id"] == "layer-raster-edge"
        assert design.json()["layers"][0]["paths"]
        plan = client.post(f"/api/projects/{project_id}/plan")
        assert plan.status_code == 200, plan.text
        assert plan.json()["passes"][0]["ordered_paths"]
        exported = client.post(f"/api/projects/{project_id}/export/gcode", json={})
        assert exported.status_code == 200, exported.text
        assert exported.json()["manifest"]["valid"] is True

        dither_settings = client.patch(
            f"/api/projects/{project_id}",
            json={
                "changes": {
                    "raster_vectorize": {
                        "algorithm": "dither",
                        "dither_mark": "crosses",
                        "dither_pass_mode": "contrast-bands",
                        "dither_pass_count": 3,
                        "dither_spacing_mm": 20,
                    }
                }
            },
        )
        assert dither_settings.status_code == 200, dither_settings.text
        dither_job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft", "background": True},
        )
        assert dither_job.status_code == 202
        assert _wait_for_job(client, dither_job.json()["job_id"])["status"] == "succeeded"
        dither_design = client.get(f"/api/projects/{project_id}/design").json()
        assert [layer["semantic_role"] for layer in dither_design["layers"]] == [
            "dither-tone-1",
            "dither-tone-2",
            "dither-tone-3",
        ]
        dither_plan = client.post(f"/api/projects/{project_id}/plan")
        assert dither_plan.status_code == 200, dither_plan.text
        assert len(dither_plan.json()["passes"]) == 3
        dither_export = client.post(f"/api/projects/{project_id}/export/gcode", json={})
        assert dither_export.status_code == 200, dither_export.text
        assert dither_export.json()["manifest"]["valid"] is True

        vector_settings = client.patch(
            f"/api/projects/{project_id}",
            json={"changes": {"raster_vectorize": {"algorithm": "hatch"}}},
        )
        assert vector_settings.status_code == 200
        assert client.get(f"/api/projects/{project_id}/raster/preview").status_code == 200
        assert client.get(f"/api/projects/{project_id}/design").status_code == 404

        patched = client.patch(
            f"/api/projects/{project_id}",
            json={"changes": {"raster_preprocess": {"contrast": 1.5}}},
        )
        assert patched.status_code == 200
        assert client.get(f"/api/projects/{project_id}/raster/preview").status_code == 404
        assert client.get(f"/api/projects/{project_id}/design").status_code == 404


def test_two_color_poster_quantizes_maps_pens_exports_and_reopens(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fixture = (
        Path(__file__).resolve().parents[3] / "fixtures" / "raster" / "two-color-poster.png"
    ).read_bytes()
    with TestClient(create_app()) as client:
        project_id = client.post("/api/projects", json={"name": "color poster"}).json()[
            "project_id"
        ]
        upload = client.post(
            f"/api/projects/{project_id}/assets",
            params={"filename": "two-color-poster.png"},
            content=fixture,
            headers={"Content-Type": "image/png"},
        )
        assert upload.status_code == 201
        configured = client.patch(
            f"/api/projects/{project_id}",
            json={
                "changes": {
                    "mode": {"quality": "draft"},
                    "raster_vectorize": {
                        "algorithm": "color-outline",
                        "color_count": 2,
                    },
                }
            },
        )
        assert configured.status_code == 200, configured.text
        job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft", "background": True},
        ).json()
        assert _wait_for_job(client, job["job_id"])["status"] == "succeeded"
        design = client.get(f"/api/projects/{project_id}/design").json()
        assert len(design["layers"]) == 2
        assert all(layer["semantic_role"].startswith("source-color-") for layer in design["layers"])
        design_hash = design["metadata"]["normalized_sha256"]

        project = client.get(f"/api/projects/{project_id}").json()
        for index, plot_pass in enumerate(project["passes"]):
            pen = project["pen_palette"][index]
            plot_pass.update(
                {
                    "pen_profile_id": pen["pen_id"],
                    "name": pen["name"],
                    "preview_color": pen["display_color"],
                }
            )
        mapped = client.patch(
            f"/api/projects/{project_id}",
            json={"changes": {"passes": project["passes"]}},
        )
        assert mapped.status_code == 200, mapped.text
        plan = client.post(f"/api/projects/{project_id}/plan")
        assert plan.status_code == 200, plan.text
        assert len(plan.json()["passes"]) == 2
        bundle = client.post(f"/api/projects/{project_id}/export/gcode", json={})
        assert bundle.status_code == 200, bundle.text
        assert bundle.json()["manifest"]["valid"] is True
        combined = next(
            program for program in bundle.json()["programs"] if program["filename"] == "combined.nc"
        )
        assert combined["statistics"]["pause_count"] == 1

        reopened = client.get(f"/api/projects/{project_id}").json()
        assert reopened["raster_vectorize"]["algorithm"] == "color-outline"
        assert [item["pen_profile_id"] for item in reopened["passes"]] == [
            item["pen_id"] for item in reopened["pen_palette"][:2]
        ]
        assert (
            client.get(f"/api/projects/{project_id}/design").json()["metadata"]["normalized_sha256"]
            == design_hash
        )


def test_stale_job_cannot_publish_over_newer_revision(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    started = threading.Event()
    release = threading.Event()

    def slow_design(recipe, checkpoint=None, token=None):
        del token
        started.set()
        assert release.wait(timeout=2)
        if checkpoint is not None:
            checkpoint("release", 1, 1)
        return generate_test_design(recipe)

    monkeypatch.setattr(
        "plotterapp_api.main._job_work",
        lambda recipe: (recipe.mode.mode_id, recipe.mode.version, slow_design),
    )
    with TestClient(create_app()) as client:
        project = client.post("/api/projects", json={"name": "stale"}).json()
        job = client.post(
            f"/api/projects/{project['project_id']}/generate",
            json={"quality": "export", "background": True},
        ).json()
        assert started.wait(timeout=1)
        patched = client.patch(
            f"/api/projects/{project['project_id']}",
            json={"changes": {"mode": {"seed": "newer-seed"}}},
        )
        assert patched.status_code == 200
        release.set()
        completed = _wait_for_job(client, job["job_id"])
        assert completed["status"] == "stale"
        missing = client.get(f"/api/projects/{project['project_id']}/design")
        assert missing.status_code == 404


def test_job_cancel_endpoint_stops_publish_at_checkpoint(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    started = threading.Event()
    release = threading.Event()

    def cancellable_design(recipe, checkpoint=None, token=None):
        del token
        started.set()
        assert release.wait(timeout=2)
        if checkpoint is not None:
            checkpoint("release", 1, 1)
        return generate_test_design(recipe)

    monkeypatch.setattr(
        "plotterapp_api.main._job_work",
        lambda recipe: (recipe.mode.mode_id, recipe.mode.version, cancellable_design),
    )
    with TestClient(create_app()) as client:
        project_id = client.post("/api/projects", json={"name": "cancel"}).json()["project_id"]
        job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "export", "background": True},
        ).json()
        assert started.wait(timeout=1)
        cancelling = client.delete(f"/api/jobs/{job['job_id']}")
        assert cancelling.status_code == 200
        assert cancelling.json()["cancel_requested"] is True
        release.set()
        completed = _wait_for_job(client, job["job_id"])
        assert completed["status"] == "cancelled"
        assert client.get(f"/api/projects/{project_id}/design").status_code == 404


def test_osm_snapshot_cache_generation_plan_and_frozen_reopen(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "fixtures"
            / "maps"
            / "small-neighborhood-overpass.json"
        ).read_text(encoding="utf-8")
    )
    fetch_count = 0

    def fetcher(_: str) -> dict[str, Any]:
        nonlocal fetch_count
        fetch_count += 1
        return fixture

    bounds = {"south": 51.503, "west": -0.1305, "north": 51.507, "east": -0.1235}
    with TestClient(create_app(osm_fetcher=fetcher)) as client:
        project_id = client.post("/api/projects", json={"name": "OSM API"}).json()["project_id"]
        first = client.post(
            f"/api/projects/{project_id}/osm/snapshot",
            json={"bounds": bounds},
        )
        assert first.status_code == 200, first.text
        assert first.json()["cache_hit"] is False
        assert first.json()["snapshot"]["element_count"] == len(fixture["elements"])
        assert fetch_count == 1

        second = client.post(
            f"/api/projects/{project_id}/osm/snapshot",
            json={"bounds": bounds},
        )
        assert second.status_code == 200
        assert second.json()["cache_hit"] is True
        assert fetch_count == 1

        job = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft", "background": True},
        )
        assert job.status_code == 202, job.text
        assert job.json()["operation"] == "generate_map"
        assert _wait_for_job(client, job.json()["job_id"])["status"] == "succeeded"
        design = client.get(f"/api/projects/{project_id}/design")
        assert design.status_code == 200
        assert design.json()["metadata"]["source_attribution"] == "© OpenStreetMap contributors"
        assert {layer["semantic_role"] for layer in design.json()["layers"]} >= {
            "road-major",
            "buildings",
            "water",
        }
        plan = client.post(f"/api/projects/{project_id}/plan")
        assert plan.status_code == 200, plan.text
        assert plan.json()["statistics"]["path_count"] > 0

        reopened = client.get(f"/api/projects/{project_id}")
        assert reopened.status_code == 200
    assert reopened.json()["osm"]["snapshot"]["sha256"]
    assert fetch_count == 1


def test_osm_snapshot_background_job_reports_download_progress(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    started = threading.Event()
    release = threading.Event()

    def fetcher(_: str) -> dict[str, Any]:
        started.set()
        assert release.wait(timeout=2)
        return {"elements": []}

    bounds = {"south": 51.503, "west": -0.1305, "north": 51.507, "east": -0.1235}
    with TestClient(create_app(osm_fetcher=fetcher)) as client:
        project_id = client.post("/api/projects", json={}).json()["project_id"]
        started_job = client.post(
            f"/api/projects/{project_id}/osm/snapshot",
            json={"bounds": bounds, "background": True},
        )
        assert started_job.status_code == 202, started_job.text
        job_id = started_job.json()["job_id"]
        assert started.wait(timeout=1)
        progress = client.get(f"/api/jobs/{job_id}").json()
        assert progress["operation"] == "download_map"
        assert progress["stage"] == "downloading map data"
        assert progress["progress"] == 0.5
        release.set()
        completed = _wait_for_job(client, job_id)
        assert completed["status"] == "succeeded"
        assert completed["progress"] == 1
        assert client.get(f"/api/projects/{project_id}").json()["osm"]["snapshot"] is not None


def test_frozen_osm_snapshot_generates_hybrid_mode_and_plans(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "fixtures"
            / "maps"
            / "small-neighborhood-overpass.json"
        ).read_text(encoding="utf-8")
    )
    bounds = {"south": 51.503, "west": -0.1305, "north": 51.507, "east": -0.1235}

    with TestClient(create_app(osm_fetcher=lambda _: fixture)) as client:
        project_id = client.post("/api/projects", json={"name": "Hybrid API"}).json()["project_id"]
        snapshot = client.post(
            f"/api/projects/{project_id}/osm/snapshot",
            json={"bounds": bounds},
        )
        assert snapshot.status_code == 200, snapshot.text
        modes = client.get("/api/modes").json()
        hybrid = next(item for item in modes if item["id"] == "builtin.map-glyphscape")
        preset = next(
            item for item in hybrid["presets"] if item["preset_id"] == "circuit-metropolis"
        )
        patched = client.patch(
            f"/api/projects/{project_id}",
            json={
                "changes": {
                    "mode": {
                        "mode_id": hybrid["id"],
                        "version": hybrid["version"],
                        "quality": "draft",
                        "seed": preset["seed"],
                        "parameter_schema_version": hybrid["parameter_schema_version"],
                        "parameters": {
                            **preset["parameters"],
                            "building_replacement_probability": 1.0,
                            "path_budget": 3000,
                            "vertex_budget": 100000,
                        },
                    }
                }
            },
        )
        assert patched.status_code == 200, patched.text
        generated = client.post(
            f"/api/projects/{project_id}/generate",
            json={"quality": "draft"},
        )
        assert generated.status_code == 200, generated.text
        design = generated.json()
        assert design["metadata"]["generator_id"] == "builtin.map-glyphscape"
        assert design["metadata"]["source_snapshot_sha256"]
        assert {layer["semantic_role"] for layer in design["layers"]} >= {
            "hybrid-locked-road",
            "glyph-structure",
            "hybrid-landscape",
        }
        plan = client.post(f"/api/projects/{project_id}/plan")
        assert plan.status_code == 200, plan.text
        assert plan.json()["statistics"]["path_count"] > 0


def test_osm_snapshot_rejects_large_area_without_fetching(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fetch_count = 0

    def fetcher(_: str) -> dict[str, Any]:
        nonlocal fetch_count
        fetch_count += 1
        return {"elements": []}

    with TestClient(create_app(osm_fetcher=fetcher)) as client:
        project_id = client.post("/api/projects", json={"name": "large OSM"}).json()["project_id"]
        response = client.post(
            f"/api/projects/{project_id}/osm/snapshot",
            json={"bounds": {"south": 50, "west": -1, "north": 51, "east": 0}},
        )
        assert response.status_code == 422
    assert "maximum request area" in response.json()["detail"]
    assert fetch_count == 0


def test_osm_snapshot_accepts_larger_supported_areas(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fetch_count = 0

    def fetcher(_: str) -> dict[str, Any]:
        nonlocal fetch_count
        fetch_count += 1
        return {"elements": []}

    with TestClient(create_app(osm_fetcher=fetcher)) as client:
        project_id = client.post("/api/projects", json={}).json()["project_id"]
        response = client.post(
            f"/api/projects/{project_id}/osm/snapshot",
            json={"bounds": {"south": 51.5, "west": -0.15, "north": 51.55, "east": -0.08}},
        )

    assert response.status_code == 200, response.text
    assert fetch_count == 1


def test_osm_place_search_is_submitted_cached_and_limited(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    fetch_count = 0

    def place_fetcher(query: str) -> list[dict[str, Any]]:
        nonlocal fetch_count
        fetch_count += 1
        assert query == "Cambridge"
        return [
            {
                "display_name": "Cambridge, Cambridgeshire, England",
                "latitude": 52.2053,
                "longitude": 0.1218,
                "osm_type": "relation",
                "osm_id": 295355,
            }
        ]

    with TestClient(create_app(osm_place_fetcher=place_fetcher)) as client:
        first = client.get("/api/osm/places", params={"query": "Cambridge"})
        assert first.status_code == 200
        assert first.json()["cache_hit"] is False
        assert first.json()["results"][0]["latitude"] == 52.2053

        second = client.get("/api/osm/places", params={"query": "cambridge"})
        assert second.status_code == 200
        assert second.json()["cache_hit"] is True
        assert fetch_count == 1

        blank = client.get("/api/osm/places", params={"query": "  "})
        assert blank.status_code == 422
