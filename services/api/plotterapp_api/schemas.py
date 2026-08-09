from __future__ import annotations

from typing import Any, Literal

from plotter_core.models import (
    MachineProfile,
    OsmBounds,
    OsmSnapshotMetadata,
    ProjectRecipe,
    SourceAsset,
    StrictModel,
)
from pydantic import Field


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    service: Literal["plotterapp-api"] = "plotterapp-api"
    schema_version: Literal[1] = 1


class CreateProjectRequest(StrictModel):
    name: str = Field(default="A3 test project", min_length=1, max_length=120)
    page_preset: Literal["A3"] = "A3"
    orientation: Literal["landscape"] = "landscape"


class GenerateRequest(StrictModel):
    quality: Literal["draft", "standard", "export"] = "export"
    background: bool = False


class ProjectPatchRequest(StrictModel):
    changes: dict[str, Any]


class ExportRequest(StrictModel):
    profile: MachineProfile | None = None


class AssetUploadResponse(StrictModel):
    project: ProjectRecipe
    asset: SourceAsset


class OsmSnapshotRequest(StrictModel):
    bounds: OsmBounds


class OsmSnapshotResponse(StrictModel):
    project: ProjectRecipe
    snapshot: OsmSnapshotMetadata
    cache_hit: bool


class OsmPlaceResult(StrictModel):
    display_name: str = Field(min_length=1, max_length=500)
    latitude: float = Field(ge=-85, le=85)
    longitude: float = Field(ge=-180, le=180)
    osm_type: str | None = None
    osm_id: int | None = None


class OsmPlaceSearchResponse(StrictModel):
    results: list[OsmPlaceResult]
    cache_hit: bool
