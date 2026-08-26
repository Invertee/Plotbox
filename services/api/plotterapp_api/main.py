from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from plotter_core.cache import node_cache_key
from plotter_core.gcode import export_gcode_bundle
from plotter_core.glyphscape.hybrid_mode import generate_map_glyphscape_for_recipe
from plotter_core.importers import import_svg, preprocess_raster, vectorize_raster
from plotter_core.importers.raster import effective_pen_width_mm
from plotter_core.maps import build_overpass_query, generate_osm_design
from plotter_core.maps.query import (
    OsmFetcher,
    OsmPlaceFetcher,
    fetch_osm_json,
    fetch_osm_places,
)
from plotter_core.models import (
    CachePruneReport,
    CacheStatistics,
    CompactGeometry,
    DesignDocument,
    ExportBundle,
    JobState,
    JobWarning,
    MachineProfile,
    PlotPlan,
    ProjectRecipe,
    RasterPreview,
    RasterVectorizeSettings,
    SvgExportBundle,
)
from plotter_core.modes import ModeManifest, QualityLevel, get_mode_registry
from plotter_core.planning import build_plot_plan
from plotter_core.projects import ProjectStore
from plotter_core.svg_export import export_svg_bundle
from plotter_core.transport import compact_design_geometry
from pydantic import ValidationError

from plotterapp_api.deployment import AllowedClientNetworksMiddleware
from plotterapp_api.fluidnc import (
    AxisCalibrationRequest,
    AxisCalibrationResult,
    FluidNCActionRequest,
    FluidNCActionResult,
    FluidNCGateway,
    FluidNCGatewayProtocol,
    FluidNCSettings,
    build_action_frames,
    calculate_axis_calibration,
)
from plotterapp_api.jobs import (
    CancellationToken,
    JobManager,
    JobResult,
    ProgressCallback,
    StaleJobError,
)
from plotterapp_api.schemas import (
    AssetUploadResponse,
    CreateProjectRequest,
    ExportRequest,
    GenerateRequest,
    HealthResponse,
    OsmPlaceResult,
    OsmPlaceSearchResponse,
    OsmSnapshotRequest,
    OsmSnapshotResponse,
    ProjectPatchRequest,
)

TERMINAL_JOB_STATES = {"succeeded", "cancelled", "failed", "stale"}
DesignOperation = Callable[
    [ProjectRecipe, ProgressCallback | None, CancellationToken | None],
    DesignDocument,
]


def _store() -> ProjectStore:
    return ProjectStore()


def _not_found(error: FileNotFoundError) -> HTTPException:
    return HTTPException(status_code=404, detail=str(error))


def _job_work(recipe: ProjectRecipe) -> tuple[str, str, DesignOperation]:
    store = _store()
    if recipe.mode.mode_id == "map.openstreetmap":
        snapshot = store.read_osm_snapshot(recipe)

        def run_map(
            current: ProjectRecipe,
            checkpoint: ProgressCallback | None = None,
            _: CancellationToken | None = None,
        ) -> DesignDocument:
            return generate_osm_design(snapshot, current, progress=checkpoint)

        return "map.openstreetmap", "1.0.0", run_map
    if recipe.mode.mode_id == "builtin.map-glyphscape":
        snapshot = store.read_osm_snapshot(recipe)

        def run_hybrid(
            current: ProjectRecipe,
            checkpoint: ProgressCallback | None = None,
            token: CancellationToken | None = None,
        ) -> DesignDocument:
            return generate_map_glyphscape_for_recipe(
                snapshot,
                current,
                progress=checkpoint,
                cancellation=token,
            )

        return "builtin.map-glyphscape", "1.0.0", run_hybrid
    if recipe.mode.mode_id not in {"import.svg", "import.raster"}:
        plugin = get_mode_registry().get(recipe.mode.mode_id)

        def run_mode(
            current: ProjectRecipe,
            checkpoint: ProgressCallback | None = None,
            token: CancellationToken | None = None,
        ) -> DesignDocument:
            return plugin.generate(
                current,
                progress=checkpoint,
                cancellation=token,
            )

        return plugin.manifest.id, plugin.manifest.version, run_mode
    if recipe.mode.mode_id == "import.svg":
        if recipe.source_asset_id is None:
            raise ValueError("the project has no selected SVG source asset")
        asset, content = store.read_asset(recipe, recipe.source_asset_id)
        if asset.media_type != "image/svg+xml":
            raise ValueError("the selected source asset is not SVG")

        def run_import(
            current: ProjectRecipe,
            checkpoint: ProgressCallback | None = None,
            _: CancellationToken | None = None,
        ) -> DesignDocument:
            return import_svg(
                content,
                current,
                source_sha256=asset.sha256,
                checkpoint=checkpoint,
            )

        return "import.svg", "1.0.0", run_import
    if recipe.mode.mode_id == "import.raster":
        if recipe.source_asset_id is None:
            raise ValueError("the project has no selected raster source asset")
        asset, content = store.read_asset(recipe, recipe.source_asset_id)
        if asset.media_type not in {"image/png", "image/jpeg"}:
            raise ValueError("the selected source asset is not PNG or JPEG")

        def run_vectorize(
            current: ProjectRecipe,
            checkpoint: ProgressCallback | None = None,
            _: CancellationToken | None = None,
        ) -> DesignDocument:
            preview = _execute_raster_preprocess(current, progress=checkpoint)[0]
            return vectorize_raster(
                content,
                asset.media_type,
                current,
                source_sha256=asset.sha256,
                preview=preview,
                checkpoint=checkpoint,
            )

        return "import.raster", "1.1.0", run_vectorize
    raise ValueError(f"unsupported project mode: {recipe.mode.mode_id}")


def _execute_design(
    recipe: ProjectRecipe,
    *,
    token: CancellationToken | None = None,
    progress: ProgressCallback | None = None,
) -> JobResult:
    store = _store()
    operator_name, operator_version, operation = _job_work(recipe)
    input_hash = store.design_input_hash(recipe)
    cache_key = node_cache_key(
        operator_name=operator_name,
        operator_version=operator_version,
        input_content_hash=input_hash,
        parameters={
            "page": recipe.page.model_dump(mode="json"),
            "mode": recipe.mode.model_dump(mode="json"),
            "svg_import": recipe.svg_import.model_dump(mode="json"),
            "raster_preprocess": recipe.raster_preprocess.model_dump(mode="json"),
            "raster_vectorize": recipe.raster_vectorize.model_dump(mode="json"),
            "osm": recipe.osm.model_dump(mode="json"),
        },
        quality=recipe.mode.quality,
    )
    cache = store.node_cache(recipe.project_id)
    if progress is not None:
        progress("cache-lookup", 0, 1)
    cached = cache.get_json(cache_key)
    cache_hit = cached is not None
    if cached is not None:
        try:
            design = DesignDocument.model_validate(cached)
        except ValidationError:
            cache.remove(cache_key)
            cache_hit = False
            design = operation(recipe, progress, token)
    else:
        design = operation(recipe, progress, token)
    if token is not None:
        token.checkpoint()
    if store.read(recipe.project_id).revision != recipe.revision:
        raise StaleJobError(
            f"project advanced beyond revision {recipe.revision}; result was not published"
        )
    if not cache_hit:
        cache.put_json(cache_key, design.model_dump(mode="json"))
        cache.prune(max_age_seconds=30 * 24 * 60 * 60, max_bytes=512 * 1024 * 1024)
    updated = store.reconcile_passes(recipe, design)
    store.write_design(updated, design)
    warnings = tuple(
        JobWarning(code=item.code, message=item.message) for item in design.metadata.diagnostics
    )
    return JobResult(
        result_hash=design.metadata.normalized_sha256,
        cache_hit=cache_hit,
        warnings=warnings,
        result_project_revision=updated.revision,
    )


def _raster_cache_key(recipe: ProjectRecipe) -> str:
    if recipe.source_asset_id is None:
        raise ValueError("the project has no selected raster source asset")
    asset = next(
        (item for item in recipe.assets if item.asset_id == recipe.source_asset_id),
        None,
    )
    if asset is None or asset.media_type not in {"image/png", "image/jpeg"}:
        raise ValueError("the selected source asset is not PNG or JPEG")
    return node_cache_key(
        operator_name="raster.preprocess",
        operator_version="1.0.0",
        input_content_hash=asset.sha256,
        parameters={
            "page": recipe.page.model_dump(mode="json"),
            "raster_preprocess": recipe.raster_preprocess.model_dump(mode="json"),
            "effective_pen_width_mm": effective_pen_width_mm(recipe),
        },
        quality=recipe.mode.quality,
    )


def _execute_raster_preprocess(
    recipe: ProjectRecipe,
    *,
    token: CancellationToken | None = None,
    progress: ProgressCallback | None = None,
) -> tuple[RasterPreview, JobResult]:
    if recipe.source_asset_id is None:
        raise ValueError("the project has no selected raster source asset")
    store = _store()
    asset, content = store.read_asset(recipe, recipe.source_asset_id)
    if asset.media_type not in {"image/png", "image/jpeg"}:
        raise ValueError("the selected source asset is not PNG or JPEG")
    cache = store.node_cache(recipe.project_id)
    cache_key = _raster_cache_key(recipe)
    if progress is not None:
        progress("raster-cache-lookup", 0, 1)
    cached = cache.get_json(cache_key)
    cache_hit = cached is not None
    if cached is not None:
        try:
            preview = RasterPreview.model_validate(cached)
        except ValidationError:
            cache.remove(cache_key)
            cache_hit = False
            preview = preprocess_raster(
                content,
                asset.media_type,
                recipe,
                source_sha256=asset.sha256,
                checkpoint=progress,
            )
    else:
        preview = preprocess_raster(
            content,
            asset.media_type,
            recipe,
            source_sha256=asset.sha256,
            checkpoint=progress,
        )
    if token is not None:
        token.checkpoint()
    if store.read(recipe.project_id).revision != recipe.revision:
        raise StaleJobError(
            f"project advanced beyond revision {recipe.revision}; result was not published"
        )
    if not cache_hit:
        cache.put_json(cache_key, preview.model_dump(mode="json"))
        cache.prune(max_age_seconds=30 * 24 * 60 * 60, max_bytes=512 * 1024 * 1024)
    return preview, JobResult(
        result_hash=preview.preview_sha256,
        cache_hit=cache_hit,
        warnings=tuple(
            JobWarning(code=item.code, message=item.message) for item in preview.warnings
        ),
        result_project_revision=recipe.revision,
    )


def create_app(
    *,
    osm_fetcher: OsmFetcher = fetch_osm_json,
    osm_place_fetcher: OsmPlaceFetcher = fetch_osm_places,
    fluidnc_gateway: FluidNCGatewayProtocol | None = None,
) -> FastAPI:
    jobs = JobManager()
    controller = fluidnc_gateway or FluidNCGateway()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            jobs.shutdown()

    application = FastAPI(
        title="Plotbox API",
        version="0.3.0",
        lifespan=lifespan,
    )
    allowed_clients = [
        item.strip()
        for item in os.environ.get("PLOTTERAPP_ALLOWED_CLIENT_NETWORKS", "").split(",")
        if item.strip()
    ]
    if allowed_clients:
        application.add_middleware(AllowedClientNetworksMiddleware, networks=allowed_clients)
    application.state.jobs = jobs
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:4173",
        ],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse()

    @application.get("/api/modes", response_model=list[ModeManifest])
    def modes() -> list[ModeManifest]:
        quality_levels = [
            QualityLevel.DRAFT,
            QualityLevel.STANDARD,
            QualityLevel.EXPORT,
        ]
        return [
            *get_mode_registry().manifests(),
            ModeManifest(
                kind="importer",
                id="import.svg",
                version="1.0.0",
                name="SVG import",
                category="convert",
                quality_levels=quality_levels,
            ),
            ModeManifest(
                kind="importer",
                id="import.raster",
                version="1.0.0",
                name="PNG/JPEG vectorization",
                category="convert",
                quality_levels=quality_levels,
                algorithms=[
                    "edge",
                    "centerline",
                    "hatch",
                    "crosshatch",
                    "squiggle",
                    "tone-contour",
                    "color-outline",
                    "color-hatch",
                    "dither",
                ],
                parameter_schema=RasterVectorizeSettings.model_json_schema(),
            ),
            ModeManifest(
                kind="importer",
                id="map.openstreetmap",
                version="1.0.0",
                name="OpenStreetMap",
                description="Semantic vector map artwork from a frozen OSM snapshot.",
                category="map",
                quality_levels=quality_levels,
                semantic_roles=[
                    "road-major",
                    "road-secondary",
                    "road-local",
                    "road-path",
                    "buildings",
                    "water",
                    "rail",
                    "parks",
                ],
            ),
        ]

    @application.get("/api/export-profiles", response_model=list[MachineProfile])
    def export_profiles() -> list[MachineProfile]:
        return [MachineProfile()]

    @application.get("/api/fluidnc/settings", response_model=FluidNCSettings)
    def fluidnc_settings() -> FluidNCSettings:
        try:
            return controller.settings()
        except (OSError, ValueError, ValidationError) as error:
            raise HTTPException(
                status_code=500,
                detail=f"FluidNC settings are invalid: {error}",
            ) from error

    @application.put("/api/fluidnc/settings", response_model=FluidNCSettings)
    def save_fluidnc_settings(settings: FluidNCSettings) -> FluidNCSettings:
        try:
            return controller.save_settings(settings)
        except OSError as error:
            raise HTTPException(
                status_code=500,
                detail=f"could not save FluidNC settings: {error}",
            ) from error

    @application.post("/api/fluidnc/actions", response_model=FluidNCActionResult)
    async def run_fluidnc_action(request: FluidNCActionRequest) -> FluidNCActionResult:
        try:
            build_action_frames(request)
            return await controller.execute(request)
        except ConnectionError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/api/fluidnc/calibration/axis",
        response_model=AxisCalibrationResult,
    )
    def calculate_fluidnc_axis_calibration(
        request: AxisCalibrationRequest,
    ) -> AxisCalibrationResult:
        try:
            return calculate_axis_calibration(request)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.get("/api/projects", response_model=list[ProjectRecipe])
    def list_projects() -> list[ProjectRecipe]:
        return _store().list_projects()

    @application.post("/api/projects", response_model=ProjectRecipe, status_code=201)
    def create_project(request: CreateProjectRequest) -> ProjectRecipe:
        return _store().create(request.name)

    @application.get("/api/projects/{project_id}", response_model=ProjectRecipe)
    def read_project(project_id: str) -> ProjectRecipe:
        try:
            return _store().read(project_id)
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @application.patch("/api/projects/{project_id}", response_model=ProjectRecipe)
    def patch_project(project_id: str, request: ProjectPatchRequest) -> ProjectRecipe:
        try:
            return _store().update(project_id, request.changes)
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: str) -> Response:
        try:
            _store().delete(project_id)
            return Response(status_code=204)
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/api/projects/{project_id}/assets",
        response_model=AssetUploadResponse,
        status_code=201,
    )
    async def upload_asset(
        project_id: str,
        request: Request,
        filename: str = Query(min_length=1, max_length=255),
    ) -> AssetUploadResponse:
        try:
            content = await request.body()
            project, asset = _store().add_asset(
                project_id,
                original_filename=filename,
                media_type=request.headers.get("content-type", "application/octet-stream").split(
                    ";", 1
                )[0],
                content=content,
            )
            return AssetUploadResponse(project=project, asset=asset)
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/api/projects/{project_id}/osm/snapshot",
        response_model=OsmSnapshotResponse,
    )
    def fetch_osm_snapshot(
        project_id: str,
        request: OsmSnapshotRequest,
    ) -> OsmSnapshotResponse:
        try:
            store = _store()
            query = build_overpass_query(request.bounds)
            query_sha256 = hashlib.sha256(query.encode("utf-8")).hexdigest()
            cache_key = node_cache_key(
                operator_name="osm.query",
                operator_version="1.0.0",
                input_content_hash=query_sha256,
                parameters={"bounds": request.bounds.model_dump(mode="json")},
                quality="source",
            )
            cache = store.osm_query_cache()
            payload = cache.get_json(cache_key)
            cache_hit = payload is not None
            if payload is None:
                payload = osm_fetcher(query)
                if not isinstance(payload.get("elements"), list):
                    raise ValueError("OSM provider returned an invalid snapshot")
                cache.put_json(cache_key, payload)
            store.update(
                project_id,
                {"osm": {"selection": {"bounds": request.bounds.model_dump(mode="json")}}},
            )
            project = store.write_osm_snapshot(
                project_id,
                payload=payload,
                query_sha256=query_sha256,
                bounds=request.bounds,
            )
            if project.osm.snapshot is None:
                raise RuntimeError("snapshot metadata was not persisted")
            return OsmSnapshotResponse(
                project=project,
                snapshot=project.osm.snapshot,
                cache_hit=cache_hit,
            )
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except (OSError, json.JSONDecodeError) as error:
            raise HTTPException(
                status_code=502,
                detail=f"OSM provider request failed: {error}",
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.get("/api/osm/places", response_model=OsmPlaceSearchResponse)
    def search_osm_places(
        query: str = Query(min_length=2, max_length=200),
    ) -> OsmPlaceSearchResponse:
        normalized_query = " ".join(query.split())
        if len(normalized_query) < 2:
            raise HTTPException(status_code=422, detail="enter at least two non-space characters")
        try:
            cache_key = node_cache_key(
                operator_name="osm.place-search",
                operator_version="1.0.0",
                input_content_hash=hashlib.sha256(
                    normalized_query.casefold().encode("utf-8")
                ).hexdigest(),
                parameters={"query": normalized_query.casefold(), "limit": 5},
                quality="source",
            )
            cache = _store().osm_query_cache()
            payload = cache.get_json(cache_key)
            cache_hit = payload is not None
            if payload is None:
                places = osm_place_fetcher(normalized_query)
                payload = {"results": places}
                cache.put_json(cache_key, payload)
            raw_results = payload.get("results")
            if not isinstance(raw_results, list):
                raise ValueError("cached OSM place-search response is invalid")
            results = [OsmPlaceResult.model_validate(item) for item in raw_results[:5]]
            return OsmPlaceSearchResponse(results=results, cache_hit=cache_hit)
        except (OSError, json.JSONDecodeError) as error:
            raise HTTPException(
                status_code=502,
                detail=f"OSM place search failed: {error}",
            ) from error
        except (ValueError, ValidationError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/api/projects/{project_id}/generate",
        response_model=JobState | DesignDocument,
    )
    def generate(
        project_id: str,
        request: GenerateRequest,
        response: Response,
    ) -> JobState | DesignDocument:
        try:
            store = _store()
            recipe = store.read(project_id)
            if recipe.mode.quality != request.quality:
                recipe = store.update(project_id, {"mode": {"quality": request.quality}})
            if not request.background:
                _execute_design(recipe)
                return store.read_design(store.read(project_id))
            input_hash = store.design_input_hash(recipe)
            state = jobs.submit(
                project_id=project_id,
                project_revision=recipe.revision,
                operation=(
                    "import_svg"
                    if recipe.mode.mode_id == "import.svg"
                    else "vectorize_raster"
                    if recipe.mode.mode_id == "import.raster"
                    else "generate_map"
                    if recipe.mode.mode_id in {"map.openstreetmap", "builtin.map-glyphscape"}
                    else "generate"
                ),
                quality=recipe.mode.quality,
                input_hash=input_hash,
                work=lambda token, progress: _execute_design(
                    recipe,
                    token=token,
                    progress=progress,
                ),
            )
            response.status_code = 202
            return state
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/api/projects/{project_id}/raster/preprocess",
        response_model=JobState | RasterPreview,
    )
    def raster_preprocess(
        project_id: str,
        request: GenerateRequest,
        response: Response,
    ) -> JobState | RasterPreview:
        try:
            store = _store()
            recipe = store.read(project_id)
            if recipe.mode.mode_id != "import.raster":
                raise ValueError("the project is not using a raster source")
            if recipe.mode.quality != request.quality:
                recipe = store.update(project_id, {"mode": {"quality": request.quality}})
            if not request.background:
                return _execute_raster_preprocess(recipe)[0]
            state = jobs.submit(
                project_id=project_id,
                project_revision=recipe.revision,
                operation="preprocess_raster",
                quality=recipe.mode.quality,
                input_hash=store.design_input_hash(recipe),
                work=lambda token, progress: _execute_raster_preprocess(
                    recipe,
                    token=token,
                    progress=progress,
                )[1],
            )
            response.status_code = 202
            return state
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.get(
        "/api/projects/{project_id}/raster/preview",
        response_model=RasterPreview,
    )
    def read_raster_preview(project_id: str) -> RasterPreview:
        try:
            store = _store()
            recipe = store.read(project_id)
            cached = store.node_cache(project_id).get_json(_raster_cache_key(recipe))
            if cached is None:
                raise FileNotFoundError("the current raster settings have not been preprocessed")
            return RasterPreview.model_validate(cached)
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.get("/api/jobs/{job_id}", response_model=JobState)
    def read_job(job_id: str) -> JobState:
        try:
            return jobs.get(job_id)
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.delete("/api/jobs/{job_id}", response_model=JobState)
    def cancel_job(job_id: str) -> JobState:
        try:
            return jobs.cancel(job_id)
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.get("/api/jobs/{job_id}/events")
    async def job_events(job_id: str) -> StreamingResponse:
        try:
            jobs.get(job_id)
        except FileNotFoundError as error:
            raise _not_found(error) from error

        async def stream() -> AsyncIterator[str]:
            previous = ""
            while True:
                state = jobs.get(job_id)
                payload = json.dumps(state.model_dump(mode="json"), separators=(",", ":"))
                if payload != previous:
                    yield f"event: job\ndata: {payload}\n\n"
                    previous = payload
                if state.status in TERMINAL_JOB_STATES:
                    break
                await asyncio.sleep(0.05)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @application.get("/api/projects/{project_id}/design", response_model=DesignDocument)
    def read_design(project_id: str) -> DesignDocument:
        try:
            store = _store()
            recipe = store.read(project_id)
            return store.read_design(recipe)
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.get(
        "/api/projects/{project_id}/design/geometry",
        response_model=CompactGeometry,
    )
    def read_compact_geometry(project_id: str) -> CompactGeometry:
        try:
            store = _store()
            recipe = store.read(project_id)
            design = store.read_design(recipe)
            return compact_design_geometry(
                design,
                curve_tolerance_mm=recipe.geometry.curve_tolerance_mm,
            )
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.post("/api/projects/{project_id}/plan", response_model=PlotPlan)
    def plan(project_id: str) -> PlotPlan:
        try:
            store = _store()
            recipe = store.read(project_id)
            design = store.read_design(recipe)
            plot_plan = build_plot_plan(recipe, design)
            store.write_plan(recipe, design, plot_plan)
            return plot_plan
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.get("/api/projects/{project_id}/plot-plan", response_model=PlotPlan)
    def read_plot_plan(project_id: str) -> PlotPlan:
        try:
            store = _store()
            recipe = store.read(project_id)
            design = store.read_design(recipe)
            return store.read_plan(recipe, design)
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.get("/api/projects/{project_id}/cache", response_model=CacheStatistics)
    def cache_statistics(project_id: str) -> CacheStatistics:
        try:
            store = _store()
            store.read(project_id)
            return store.node_cache(project_id).statistics()
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.delete("/api/projects/{project_id}/cache", response_model=CachePruneReport)
    def prune_cache(
        project_id: str,
        max_age_seconds: float | None = Query(default=None, ge=0),
        max_bytes: int | None = Query(default=0, ge=0),
    ) -> CachePruneReport:
        try:
            store = _store()
            store.read(project_id)
            return store.node_cache(project_id).prune(
                max_age_seconds=max_age_seconds,
                max_bytes=max_bytes,
            )
        except FileNotFoundError as error:
            raise _not_found(error) from error

    @application.post("/api/projects/{project_id}/export/gcode", response_model=ExportBundle)
    def export_gcode(project_id: str, request: ExportRequest) -> ExportBundle:
        try:
            store = _store()
            recipe = store.read(project_id)
            design = store.read_design(recipe)
            plot_plan = store.read_plan(recipe, design)
            profile = request.profile or MachineProfile()
            bundle = export_gcode_bundle(recipe, plot_plan, profile)
            store.write_export_bundle(recipe, bundle)
            return bundle
        except FileNotFoundError as error:
            raise _not_found(error) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post("/api/projects/{project_id}/export/svg", response_model=SvgExportBundle)
    def export_svg(project_id: str) -> SvgExportBundle:
        try:
            store = _store()
            recipe = store.read(project_id)
            return export_svg_bundle(recipe, store.read_design(recipe))
        except FileNotFoundError as error:
            raise _not_found(error) from error

    web_root = Path(os.environ.get("PLOTTERAPP_WEB_ROOT", "/app/web"))
    if (web_root / "index.html").is_file():
        application.mount("/", StaticFiles(directory=web_root, html=True), name="web")

    return application


app = create_app()
