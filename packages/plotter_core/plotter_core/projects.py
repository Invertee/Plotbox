from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from plotter_core.cache import NodeCache
from plotter_core.migrations import migrate_project
from plotter_core.models import (
    DesignDocument,
    ExportBundle,
    OsmBounds,
    OsmSnapshotMetadata,
    PassSettings,
    PlotPlan,
    ProjectRecipe,
    SourceAsset,
    canonical_sha256,
)
from plotter_core.modes import get_mode_registry

PROJECT_ROOT_ENV = "PLOTTERAPP_PROJECTS_ROOT"


def default_projects_root() -> Path:
    configured = os.environ.get(PROJECT_ROOT_ENV)
    if configured:
        return Path(configured).resolve()
    return (Path.cwd() / ".plotterapp-data" / "projects").resolve()


def _slug(value: str) -> str:
    candidate = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return candidate[:48] or "project"


def _project_name(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("project name must be text")
    normalized = " ".join(value.split())
    if not normalized:
        raise ValueError("project name must not be blank")
    if len(normalized) > 120:
        raise ValueError("project name must be at most 120 characters")
    return normalized


def _atomic_json(path: Path, value: BaseModel | dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value.model_dump(mode="json") if isinstance(value, BaseModel) else value
    payload = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _deep_merge(original: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    merged = dict(original)
    for key, value in changes.items():
        if key == "parameters" and isinstance(value, dict):
            merged[key] = dict(value)
        elif isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _prepare_procedural_mode(recipe: ProjectRecipe) -> ProjectRecipe:
    if recipe.mode.mode_id in {"import.svg", "import.raster", "map.openstreetmap"}:
        return recipe
    settings = get_mode_registry().prepare_settings(recipe.mode)
    return recipe.model_copy(update={"mode": settings})


class ProjectStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or default_projects_root()).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def project_directory(self, project_id: str) -> Path:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", project_id):
            raise ValueError("invalid project ID")
        directory = (self.root / f"{project_id}.plotter").resolve()
        if self.root not in directory.parents:
            raise ValueError("project path escapes configured root")
        return directory

    def create(self, name: str, recipe: ProjectRecipe | None = None) -> ProjectRecipe:
        if recipe is None:
            name = _project_name(name)
            project_id = f"{_slug(name)}-{uuid.uuid4().hex[:8]}"
            recipe = ProjectRecipe(project_id=project_id, name=name)
        recipe = _prepare_procedural_mode(recipe)
        directory = self.project_directory(recipe.project_id)
        if directory.exists():
            raise FileExistsError(f"project {recipe.project_id} already exists")
        for relative in ("assets", "map-data", "cache", "previews", "exports"):
            (directory / relative).mkdir(parents=True, exist_ok=True)
        _atomic_json(directory / "project.json", recipe)
        return recipe

    def read(self, project_id: str) -> ProjectRecipe:
        project_file = self.project_directory(project_id) / "project.json"
        if not project_file.exists():
            raise FileNotFoundError(f"project {project_id} does not exist")
        payload = json.loads(project_file.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("project.json must contain an object")
        return migrate_project(payload)

    def update(self, project_id: str, changes: dict[str, Any]) -> ProjectRecipe:
        current = self.read(project_id)
        if "name" in changes:
            changes = {**changes, "name": _project_name(changes["name"])}
        protected = {"schema_version", "project_id", "revision"}
        invalid = protected.intersection(changes)
        if invalid:
            raise ValueError(f"cannot patch protected fields: {', '.join(sorted(invalid))}")
        merged = _deep_merge(current.model_dump(mode="json"), changes)
        candidate = _prepare_procedural_mode(ProjectRecipe.model_validate(merged))
        if candidate == current:
            return current
        merged["mode"] = candidate.mode.model_dump(mode="json")
        merged["revision"] = current.revision + 1
        updated = _prepare_procedural_mode(ProjectRecipe.model_validate(merged))
        _atomic_json(self.project_directory(project_id) / "project.json", updated)
        return updated

    def list_projects(self) -> list[ProjectRecipe]:
        projects: list[tuple[float, ProjectRecipe]] = []
        for project_file in self.root.glob("*.plotter/project.json"):
            try:
                recipe = self.read(project_file.parent.name.removesuffix(".plotter"))
            except (ValueError, FileNotFoundError, json.JSONDecodeError):
                continue
            projects.append((project_file.stat().st_mtime, recipe))
        projects.sort(key=lambda item: item[0], reverse=True)
        return [recipe for _, recipe in projects]

    def delete(self, project_id: str) -> None:
        directory = self.project_directory(project_id)
        self.read(project_id)
        expected_name = f"{project_id}.plotter"
        if (
            directory.parent != self.root
            or directory == self.root
            or directory.name != expected_name
        ):
            raise ValueError("project deletion target is outside the configured root")
        shutil.rmtree(directory)

    def design_cache_path(self, recipe: ProjectRecipe) -> Path:
        digest = self.design_input_hash(recipe)
        return self.project_directory(recipe.project_id) / "cache" / f"design-{digest}.json"

    def design_input_hash(self, recipe: ProjectRecipe) -> str:
        return canonical_sha256(
            {
                "page": recipe.page.model_dump(mode="json"),
                "mode": recipe.mode.model_dump(mode="json"),
                "source_asset_id": recipe.source_asset_id,
                "source_asset": next(
                    (
                        asset.model_dump(mode="json")
                        for asset in recipe.assets
                        if asset.asset_id == recipe.source_asset_id
                    ),
                    None,
                ),
                "svg_import": recipe.svg_import.model_dump(mode="json"),
                "raster_preprocess": recipe.raster_preprocess.model_dump(mode="json"),
                "raster_vectorize": recipe.raster_vectorize.model_dump(mode="json"),
                "osm": recipe.osm.model_dump(mode="json"),
            }
        )

    def write_design(self, recipe: ProjectRecipe, design: DesignDocument) -> None:
        _atomic_json(self.design_cache_path(recipe), design)

    def read_design(self, recipe: ProjectRecipe) -> DesignDocument:
        path = self.design_cache_path(recipe)
        if not path.exists():
            raise FileNotFoundError("the current project revision has not been generated")
        return DesignDocument.model_validate_json(path.read_text(encoding="utf-8"))

    def plan_cache_path(self, recipe: ProjectRecipe, design: DesignDocument) -> Path:
        recipe_digest = canonical_sha256(
            {
                "page": recipe.page.model_dump(mode="json"),
                "passes": [item.model_dump(mode="json") for item in recipe.passes],
                "geometry": recipe.geometry.model_dump(mode="json"),
            }
        )
        return (
            self.project_directory(recipe.project_id)
            / "cache"
            / f"plot-plan-{recipe_digest}-{design.metadata.normalized_sha256}.json"
        )

    def write_plan(self, recipe: ProjectRecipe, design: DesignDocument, plan: PlotPlan) -> None:
        _atomic_json(self.plan_cache_path(recipe, design), plan)

    def read_plan(self, recipe: ProjectRecipe, design: DesignDocument) -> PlotPlan:
        path = self.plan_cache_path(recipe, design)
        if not path.exists():
            raise FileNotFoundError("the current project revision has not been planned")
        return PlotPlan.model_validate_json(path.read_text(encoding="utf-8"))

    def write_export_bundle(self, recipe: ProjectRecipe, bundle: ExportBundle) -> None:
        export_directory = self.project_directory(recipe.project_id) / "exports"
        for program in bundle.programs:
            program_path = export_directory / program.filename
            program_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = program_path.with_name(f".{program_path.name}.tmp")
            temporary.write_text(program.text, encoding="utf-8", newline="\n")
            os.replace(temporary, program_path)
        _atomic_json(export_directory / "manifest.json", bundle.manifest)

    def node_cache(self, project_id: str) -> NodeCache:
        return NodeCache(self.project_directory(project_id) / "cache" / "nodes")

    def osm_query_cache(self) -> NodeCache:
        return NodeCache(self.root / "_osm-query-cache")

    def write_osm_snapshot(
        self,
        project_id: str,
        *,
        payload: dict[str, Any],
        query_sha256: str,
        bounds: OsmBounds,
        fetched_at: str | None = None,
    ) -> ProjectRecipe:
        compact = (
            json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
        ).encode("utf-8")
        digest = hashlib.sha256(compact).hexdigest()
        snapshot_id = f"osm-{digest[:16]}"
        path = self.project_directory(project_id) / "map-data" / f"{digest}.json"
        if not path.exists():
            _atomic_bytes(path, compact)
        timestamp = fetched_at or datetime.now(UTC).isoformat().replace("+00:00", "Z")
        osm3s = payload.get("osm3s")
        source_date = (
            str(osm3s.get("timestamp_osm_base"))
            if isinstance(osm3s, dict) and osm3s.get("timestamp_osm_base")
            else timestamp
        )
        elements = payload.get("elements")
        metadata = OsmSnapshotMetadata(
            snapshot_id=snapshot_id,
            sha256=digest,
            query_sha256=query_sha256,
            fetched_at=timestamp,
            source_date=source_date,
            element_count=len(elements) if isinstance(elements, list) else 0,
            byte_count=len(compact),
            bounds=bounds,
        )
        return self.update(
            project_id,
            {
                "mode": {
                    "mode_id": "map.openstreetmap",
                    "version": "1.0.0",
                    "parameter_schema_version": 1,
                    "parameters": {},
                },
                "osm": {"snapshot": metadata.model_dump(mode="json")},
            },
        )

    def read_osm_snapshot(self, recipe: ProjectRecipe) -> dict[str, Any]:
        metadata = recipe.osm.snapshot
        if metadata is None:
            raise FileNotFoundError("the project has no frozen OSM snapshot")
        path = self.project_directory(recipe.project_id) / "map-data" / f"{metadata.sha256}.json"
        if not path.exists():
            raise FileNotFoundError("the frozen OSM snapshot file is missing")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != metadata.sha256:
            raise ValueError("OSM snapshot content hash mismatch")
        payload = json.loads(content)
        if not isinstance(payload, dict):
            raise ValueError("OSM snapshot must contain a JSON object")
        return payload

    def add_asset(
        self,
        project_id: str,
        *,
        original_filename: str,
        media_type: str,
        content: bytes,
    ) -> tuple[ProjectRecipe, SourceAsset]:
        if not content:
            raise ValueError("source asset is empty")
        if len(content) > 25 * 1024 * 1024:
            raise ValueError("source asset exceeds the 25 MiB limit")
        detected_media_type, extension = _detect_asset_type(content)
        if media_type and media_type not in {"application/octet-stream", detected_media_type}:
            raise ValueError(
                f"declared media type {media_type!r} does not match {detected_media_type!r}"
            )
        current = self.read(project_id)
        digest = hashlib.sha256(content).hexdigest()
        asset_id = f"asset-{digest[:16]}"
        existing = next((asset for asset in current.assets if asset.sha256 == digest), None)
        asset = existing or SourceAsset(
            asset_id=asset_id,
            original_filename=Path(original_filename).name or f"source{extension}",
            media_type=detected_media_type,
            sha256=digest,
            byte_count=len(content),
        )
        asset_path = self.project_directory(project_id) / "assets" / f"{digest}{extension}"
        if not asset_path.exists():
            _atomic_bytes(asset_path, content)
        assets = current.assets if existing else [*current.assets, asset]
        mode_id = "import.svg" if detected_media_type == "image/svg+xml" else "import.raster"
        mode_version = "1.0.0"
        updated = self.update(
            project_id,
            {
                "assets": [item.model_dump(mode="json") for item in assets],
                "source_asset_id": asset.asset_id,
                "mode": {
                    "mode_id": mode_id,
                    "version": mode_version,
                    "parameter_schema_version": 1,
                    "parameters": {},
                },
            },
        )
        return updated, asset

    def read_asset(self, recipe: ProjectRecipe, asset_id: str) -> tuple[SourceAsset, bytes]:
        asset = next((item for item in recipe.assets if item.asset_id == asset_id), None)
        if asset is None:
            raise FileNotFoundError(f"asset {asset_id} does not exist in project")
        extension = {
            "image/svg+xml": ".svg",
            "image/png": ".png",
            "image/jpeg": ".jpg",
        }[asset.media_type]
        path = self.project_directory(recipe.project_id) / "assets" / f"{asset.sha256}{extension}"
        if not path.exists():
            raise FileNotFoundError(f"asset content for {asset_id} is missing")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != asset.sha256:
            raise ValueError(f"asset content hash mismatch for {asset_id}")
        return asset, content

    def reconcile_passes(
        self,
        recipe: ProjectRecipe,
        design: DesignDocument,
    ) -> ProjectRecipe:
        layer_to_pass = {
            layer_id: plot_pass
            for plot_pass in recipe.passes
            for layer_id in plot_pass.source_layer_ids
        }
        role_to_pass = {plot_pass.semantic_role: plot_pass for plot_pass in recipe.passes}
        passes: list[PassSettings] = []
        for index, layer in enumerate(design.layers):
            existing = layer_to_pass.get(layer.layer_id) or role_to_pass.get(layer.semantic_role)
            if existing is not None:
                passes.append(
                    existing.model_copy(
                        update={
                            "source_layer_ids": [layer.layer_id],
                            "semantic_role": layer.semantic_role,
                        }
                    )
                )
                continue
            slug = _slug(layer.name)
            passes.append(
                PassSettings(
                    pass_id=f"pass-{slug}-{index + 1}",
                    name=layer.name,
                    semantic_role=layer.semantic_role,
                    preview_color=layer.preview_color,
                    source_layer_ids=[layer.layer_id],
                )
            )
        payload = [item.model_dump(mode="json") for item in passes]
        return self.update(recipe.project_id, {"passes": payload})


def _detect_asset_type(content: bytes) -> tuple[str, str]:
    stripped = content.lstrip()
    if stripped.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if stripped.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    prefix = stripped[:4096].lower()
    if b"<svg" in prefix and not prefix.startswith((b"\x89png", b"\xff\xd8")):
        return "image/svg+xml", ".svg"
    raise ValueError("unsupported asset content; expected SVG, PNG, or JPEG")
