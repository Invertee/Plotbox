from __future__ import annotations

import hashlib
import json
import math
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION: Literal[1] = 1
type ModeParameterValue = str | int | float | bool | list[float]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class Point(StrictModel):
    x: float
    y: float

    @model_validator(mode="after")
    def coordinates_are_finite(self) -> Point:
        if not math.isfinite(self.x) or not math.isfinite(self.y):
            raise ValueError("point coordinates must be finite")
        return self


class PageSettings(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    preset: Literal["A3", "A4", "custom"] = "A3"
    orientation: Literal["landscape", "portrait"] = "landscape"
    width_mm: float = Field(default=420.0, gt=0)
    height_mm: float = Field(default=297.0, gt=0)
    margin_mm: float = Field(default=10.0, ge=0)

    @model_validator(mode="after")
    def margin_leaves_a_safe_area(self) -> PageSettings:
        if self.margin_mm * 2 >= min(self.width_mm, self.height_mm):
            raise ValueError("margin must leave a non-empty safe drawing area")
        return self

    @property
    def safe_min(self) -> Point:
        return Point(x=self.margin_mm, y=self.margin_mm)

    @property
    def safe_max(self) -> Point:
        return Point(x=self.width_mm - self.margin_mm, y=self.height_mm - self.margin_mm)


class MoveCommand(StrictModel):
    kind: Literal["move"] = "move"
    point: Point


class LineCommand(StrictModel):
    kind: Literal["line"] = "line"
    point: Point


class QuadraticCommand(StrictModel):
    kind: Literal["quadratic"] = "quadratic"
    control: Point
    point: Point


class CubicCommand(StrictModel):
    kind: Literal["cubic"] = "cubic"
    control1: Point
    control2: Point
    point: Point


class CloseCommand(StrictModel):
    kind: Literal["close"] = "close"


PathCommand = Annotated[
    MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand,
    Field(discriminator="kind"),
]


class DesignPath(StrictModel):
    path_id: str = Field(min_length=1)
    commands: list[PathCommand] = Field(min_length=2)
    closed: bool = False
    reversible: bool = True
    metadata: dict[str, str | float | int | bool] = Field(default_factory=dict)

    @model_validator(mode="after")
    def path_begins_with_move(self) -> DesignPath:
        if self.commands[0].kind != "move":
            raise ValueError("a design path must begin with a move command")
        return self


class DesignLayer(StrictModel):
    layer_id: str
    name: str
    semantic_role: str
    preview_color: str
    visible: bool = True
    locked: bool = False
    paths: list[DesignPath]
    metadata: dict[str, str | float | int | bool] = Field(default_factory=dict)


class DesignDiagnostic(StrictModel):
    code: str
    message: str
    severity: Literal["warning", "error"] = "warning"
    element_id: str | None = None


class DesignMetadata(StrictModel):
    generator_id: str
    generator_version: str
    seed: str
    quality: Literal["draft", "standard", "export"]
    normalized_sha256: str = ""
    source_asset_sha256: str | None = Field(default=None, exclude_if=lambda value: value is None)
    source_snapshot_sha256: str | None = Field(default=None, exclude_if=lambda value: value is None)
    source_attribution: str | None = Field(default=None, exclude_if=lambda value: value is None)
    source_date: str | None = Field(default=None, exclude_if=lambda value: value is None)
    diagnostics: list[DesignDiagnostic] = Field(
        default_factory=list,
        exclude_if=lambda value: not value,
    )


class DesignDocument(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    document_id: str
    page: PageSettings
    layers: list[DesignLayer]
    metadata: DesignMetadata


class PenProfile(StrictModel):
    pen_id: str
    name: str
    display_color: str
    tip_width_mm: float = Field(gt=0)
    draw_feed_mm_min: float | None = Field(default=None, gt=0)
    pen_down_override: float | None = None
    x_offset_mm: float = 0
    y_offset_mm: float = 0
    notes: str = ""


class PassSettings(StrictModel):
    pass_id: str
    name: str
    semantic_role: str
    preview_color: str
    pen_profile_id: str | None = None
    draw_feed_mm_min: float = Field(default=1800.0, gt=0)
    enabled: bool = True
    visible: bool = True
    source_layer_ids: list[str] = Field(default_factory=list, exclude_if=lambda value: not value)
    pen_down_override: float | None = Field(default=None, exclude_if=lambda value: value is None)


class GeometrySettings(StrictModel):
    curve_tolerance_mm: float = Field(default=0.05, gt=0)
    simplification_tolerance_mm: float = Field(default=0.02, ge=0)
    minimum_path_length_mm: float = Field(default=0.2, ge=0)
    endpoint_snap_tolerance_mm: float = Field(default=0.05, ge=0)
    ordering_quality: Literal["draft", "standard"] = "standard"


class ModeSettings(StrictModel):
    mode_id: str = "builtin.test-pattern"
    version: str = "1.0.0"
    seed: str = "codex-vertical-slice-1"
    quality: Literal["draft", "standard", "export"] = "export"
    parameter_schema_version: int = Field(default=1, ge=1)
    parameters: dict[str, ModeParameterValue] = Field(default_factory=dict)


class SourceAsset(StrictModel):
    asset_id: str
    original_filename: str
    media_type: Literal["image/svg+xml", "image/png", "image/jpeg"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_count: int = Field(ge=1)


class SvgImportSettings(StrictModel):
    fill_mode: Literal["ignore", "outline", "hatch", "crosshatch"] = "outline"
    stroke_mode: Literal["centerline", "outline", "parallel"] = "centerline"
    hatch_spacing_mm: float = Field(default=2.0, gt=0)
    hatch_angle_degrees: float = 45.0
    fit_to_page: bool = True


class NormalizedCrop(StrictModel):
    """Source crop in normalized image coordinates with a top-left origin."""

    x: float = Field(default=0.0, ge=0, lt=1)
    y: float = Field(default=0.0, ge=0, lt=1)
    width: float = Field(default=1.0, gt=0, le=1)
    height: float = Field(default=1.0, gt=0, le=1)

    @model_validator(mode="after")
    def stays_inside_source(self) -> NormalizedCrop:
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("normalized raster crop must remain inside the source image")
        return self


class RasterPreprocessSettings(StrictModel):
    crop: NormalizedCrop = Field(default_factory=NormalizedCrop)
    rotation_degrees: Literal[0, 90, 180, 270] = 0
    fit_mode: Literal["contain", "cover", "stretch"] = "contain"
    scale_percent: float = Field(default=100.0, gt=0, le=400)
    channel: Literal["luminance", "red", "green", "blue"] = "luminance"
    invert: bool = False
    contrast: float = Field(default=1.0, gt=0, le=4)
    gamma: float = Field(default=1.0, ge=0.1, le=5)
    blur_radius_px: float = Field(default=0.0, ge=0, le=20)
    sharpen_amount: float = Field(default=0.0, ge=0, le=5)
    threshold_mode: Literal["none", "global", "adaptive"] = "none"
    threshold: int = Field(default=128, ge=0, le=255)
    adaptive_window_px: int = Field(default=15, ge=3, le=101)
    adaptive_offset: int = Field(default=5, ge=-64, le=64)
    morphology: Literal["none", "open", "close"] = "none"
    morphology_radius_px: int = Field(default=0, ge=0, le=5)
    sampling_pixels_per_pen_width: float = Field(default=3.0, ge=1, le=8)
    maximum_megapixels: float = Field(default=8.0, ge=0.1, le=25)

    @model_validator(mode="after")
    def adaptive_window_is_odd(self) -> RasterPreprocessSettings:
        if self.adaptive_window_px % 2 == 0:
            raise ValueError("adaptive threshold window must be odd")
        return self


class RasterVectorizeSettings(StrictModel):
    """Physically meaningful controls shared by the raster-to-vector algorithms."""

    algorithm: Literal[
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
    ] = "edge"
    minimum_segment_length_mm: float = Field(default=0.6, ge=0)
    edge_threshold: int = Field(default=12, ge=1, le=255)
    edge_min_component_length_mm: float = Field(default=1.0, ge=0)
    centerline_threshold: int = Field(default=160, ge=0, le=255)
    centerline_prune_length_mm: float = Field(default=1.5, ge=0)
    hatch_spacing_mm: float = Field(default=1.2, gt=0, le=50)
    hatch_angle_degrees: float = Field(default=45.0, ge=-360, le=360)
    hatch_tone_threshold: int = Field(default=210, ge=0, le=255)
    crosshatch_thresholds: tuple[int, int, int, int] = (210, 160, 110, 60)
    crosshatch_angle_step_degrees: float = Field(default=45.0, gt=0, le=180)
    squiggle_spacing_mm: float = Field(default=1.5, gt=0, le=50)
    squiggle_amplitude_mm: float = Field(default=1.0, ge=0, le=20)
    squiggle_wavelength_mm: float = Field(default=5.0, gt=0, le=100)
    squiggle_modulation: Literal["amplitude", "frequency", "both"] = "both"
    squiggle_min_darkness: float = Field(default=0.03, ge=0, le=1)
    contour_levels: int = Field(default=6, ge=1, le=32)
    color_count: int = Field(default=2, ge=2, le=8)
    color_background_threshold: int = Field(default=248, ge=0, le=255)
    dither_mark: Literal["dots", "crosses", "pen-dots"] = "dots"
    dither_pass_mode: Literal["single", "contrast-bands"] = "single"
    dither_pass_count: int = Field(default=4, ge=1, le=8)
    dither_spacing_mm: float = Field(default=2.0, gt=0, le=50)
    dither_pen_thickness_mm: float = Field(default=0.5, gt=0, le=25)
    dither_dot_gap_mm: float = Field(default=0.5, ge=0, le=50)
    dither_min_mark_size_mm: float = Field(default=0.25, ge=0, le=25)
    dither_max_mark_size_mm: float = Field(default=1.8, gt=0, le=25)
    dither_contrast: float = Field(default=1.0, gt=0, le=4)
    dither_gamma: float = Field(default=1.0, ge=0.1, le=5)
    dither_threshold: float = Field(default=0.02, ge=0, le=1)
    dither_angle_degrees: float = Field(default=45.0, ge=-360, le=360)
    stipple_layout: Literal["even", "natural"] = "natural"
    stipple_color_mode: Literal["single", "separate"] = "single"
    stipple_mark: Literal["drawn-dots", "pen-dots"] = "pen-dots"
    stipple_spacing_mm: float = Field(default=1.8, gt=0, le=50)
    stipple_pen_thickness_mm: float = Field(default=0.5, gt=0, le=25)
    stipple_dot_gap_mm: float = Field(default=0.4, ge=0, le=50)
    stipple_min_dot_size_mm: float = Field(default=0.25, ge=0, le=25)
    stipple_max_dot_size_mm: float = Field(default=1.5, gt=0, le=25)
    stipple_contrast: float = Field(default=1.0, gt=0, le=4)
    stipple_gamma: float = Field(default=1.0, ge=0.1, le=5)
    stipple_threshold: float = Field(default=0.02, ge=0, le=1)
    adaptive_stipple_color_mode: Literal["single", "separate"] = "single"
    adaptive_stipple_mark: Literal["drawn-dots", "pen-dots"] = "pen-dots"
    adaptive_stipple_spacing_mm: float = Field(default=1.4, gt=0, le=50)
    adaptive_stipple_pen_thickness_mm: float = Field(default=0.5, gt=0, le=25)
    adaptive_stipple_dot_gap_mm: float = Field(default=0.25, ge=0, le=50)
    adaptive_stipple_min_dot_size_mm: float = Field(default=0.2, ge=0, le=25)
    adaptive_stipple_max_dot_size_mm: float = Field(default=1.3, gt=0, le=25)
    adaptive_stipple_contrast: float = Field(default=1.0, gt=0, le=4)
    adaptive_stipple_gamma: float = Field(default=1.0, ge=0.1, le=5)
    adaptive_stipple_threshold: float = Field(default=0.015, ge=0, le=1)
    adaptive_stipple_local_radius_mm: float = Field(default=5.0, gt=0, le=100)
    adaptive_stipple_local_contrast: float = Field(default=0.65, ge=0, le=2)
    adaptive_stipple_light_density: float = Field(default=0.35, ge=0, le=2)
    adaptive_stipple_dark_density: float = Field(default=1.0, ge=0, le=2)

    @model_validator(mode="after")
    def crosshatch_thresholds_descend(self) -> RasterVectorizeSettings:
        if any(
            first <= second
            for first, second in zip(
                self.crosshatch_thresholds,
                self.crosshatch_thresholds[1:],
                strict=False,
            )
        ):
            raise ValueError("crosshatch thresholds must be strictly descending")
        if self.dither_min_mark_size_mm > self.dither_max_mark_size_mm:
            raise ValueError("dither minimum mark size must not exceed maximum mark size")
        if self.dither_pen_thickness_mm + self.dither_dot_gap_mm > 50:
            raise ValueError("dither pen thickness plus dot gap must not exceed 50 mm")
        if self.stipple_min_dot_size_mm > self.stipple_max_dot_size_mm:
            raise ValueError("stipple minimum dot size must not exceed maximum dot size")
        if self.stipple_pen_thickness_mm + self.stipple_dot_gap_mm > 50:
            raise ValueError("stipple pen thickness plus dot gap must not exceed 50 mm")
        if self.adaptive_stipple_min_dot_size_mm > self.adaptive_stipple_max_dot_size_mm:
            raise ValueError("adaptive stipple minimum dot size must not exceed maximum dot size")
        if self.adaptive_stipple_pen_thickness_mm + self.adaptive_stipple_dot_gap_mm > 50:
            raise ValueError("adaptive stipple pen thickness plus dot gap must not exceed 50 mm")
        return self


class RasterPlacement(StrictModel):
    """Processed raster placement in lower-left-origin page millimetres."""

    x_mm: float
    y_mm: float
    width_mm: float = Field(gt=0)
    height_mm: float = Field(gt=0)


class RasterPreviewWarning(StrictModel):
    code: str
    message: str


class RasterPreview(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    project_id: str
    source_asset_sha256: str
    source_width_px: int = Field(gt=0)
    source_height_px: int = Field(gt=0)
    frame_count: int = Field(default=1, ge=1)
    crop_box_px: tuple[int, int, int, int]
    processed_width_px: int = Field(gt=0)
    processed_height_px: int = Field(gt=0)
    mm_per_pixel_x: float = Field(gt=0)
    mm_per_pixel_y: float = Field(gt=0)
    pen_width_mm: float = Field(gt=0)
    placement: RasterPlacement
    preview_png_base64: str
    preview_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    warnings: list[RasterPreviewWarning] = Field(default_factory=list)


class OsmBounds(StrictModel):
    south: float = Field(ge=-85, le=85)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-85, le=85)
    east: float = Field(ge=-180, le=180)

    @model_validator(mode="after")
    def is_non_empty(self) -> OsmBounds:
        if self.south >= self.north:
            raise ValueError("OSM south bound must be below north bound")
        if self.west >= self.east:
            raise ValueError("OSM west bound must be left of east bound")
        return self


class OsmSelection(StrictModel):
    bounds: OsmBounds = Field(
        default_factory=lambda: OsmBounds(
            south=51.5030,
            west=-0.1305,
            north=51.5070,
            east=-0.1235,
        )
    )
    rotation_degrees: float = Field(default=0, ge=-180, le=180)
    lock_mode: Literal["extent", "scale"] = "extent"


class OsmFeatureToggles(StrictModel):
    roads: bool = True
    buildings: bool = True
    water: bool = True
    rail: bool = True
    parks: bool = True


class OsmRenderRules(StrictModel):
    road_line_treatment: Literal["centerline", "casing", "parallel"] = "centerline"
    road_width_mm: float = Field(default=0.8, gt=0, le=10)
    building_treatment: Literal["outline", "hatch"] = "outline"
    water_treatment: Literal["outline", "hatch"] = "hatch"
    park_treatment: Literal["outline", "hatch"] = "outline"
    polygon_hatch_spacing_mm: float = Field(default=2.0, gt=0, le=30)
    polygon_hatch_angle_degrees: float = Field(default=45, ge=-360, le=360)
    simplification_tolerance_mm: float = Field(default=0.08, ge=0, le=10)
    minimum_feature_mm: float = Field(default=0.3, ge=0, le=20)


class OsmSnapshotMetadata(StrictModel):
    snapshot_id: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    query_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    fetched_at: str
    source_date: str
    attribution: str = "© OpenStreetMap contributors"
    provider: str = "OpenStreetMap Overpass API"
    element_count: int = Field(ge=0)
    byte_count: int = Field(gt=0)
    bounds: OsmBounds


class OsmSettings(StrictModel):
    selection: OsmSelection = Field(default_factory=OsmSelection)
    features: OsmFeatureToggles = Field(default_factory=OsmFeatureToggles)
    render: OsmRenderRules = Field(default_factory=OsmRenderRules)
    snapshot: OsmSnapshotMetadata | None = None


class ExportSelection(StrictModel):
    profile_id: str = "fluidnc-z-axis-a3"
    separate_pass_files: bool = True
    combined_file: bool = True
    dry_run: bool = True
    page_boundary: bool = True


class ProjectRecipe(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    project_id: str
    name: str
    revision: int = Field(default=1, ge=1)
    page: PageSettings = Field(default_factory=PageSettings)
    mode: ModeSettings = Field(default_factory=ModeSettings)
    assets: list[SourceAsset] = Field(default_factory=list)
    source_asset_id: str | None = None
    svg_import: SvgImportSettings = Field(default_factory=SvgImportSettings)
    raster_preprocess: RasterPreprocessSettings = Field(default_factory=RasterPreprocessSettings)
    raster_vectorize: RasterVectorizeSettings = Field(default_factory=RasterVectorizeSettings)
    osm: OsmSettings = Field(default_factory=OsmSettings)
    pen_palette: list[PenProfile] = Field(
        default_factory=lambda: [
            PenProfile(
                pen_id="black-05",
                name="Black 0.5 mm",
                display_color="#171717",
                tip_width_mm=0.5,
                draw_feed_mm_min=1800,
            ),
            PenProfile(
                pen_id="cyan-05",
                name="Cyan 0.5 mm",
                display_color="#00a6c8",
                tip_width_mm=0.5,
                draw_feed_mm_min=1800,
            ),
        ]
    )
    passes: list[PassSettings] = Field(
        default_factory=lambda: [
            PassSettings(
                pass_id="pass-black",
                name="Black",
                semantic_role="structure",
                preview_color="#171717",
                pen_profile_id="black-05",
            ),
            PassSettings(
                pass_id="pass-cyan",
                name="Cyan",
                semantic_role="accent",
                preview_color="#00a6c8",
                pen_profile_id="cyan-05",
            ),
        ]
    )
    geometry: GeometrySettings = Field(default_factory=GeometrySettings)
    export: ExportSelection = Field(default_factory=ExportSelection)

    @model_validator(mode="after")
    def roles_and_passes_are_unique(self) -> ProjectRecipe:
        pass_ids = [item.pass_id for item in self.passes]
        if len(pass_ids) != len(set(pass_ids)):
            raise ValueError("pass IDs must be unique")
        assigned_layers = [layer_id for item in self.passes for layer_id in item.source_layer_ids]
        if len(assigned_layers) != len(set(assigned_layers)):
            raise ValueError("a design layer can map to at most one pass")
        asset_ids = [asset.asset_id for asset in self.assets]
        if len(asset_ids) != len(set(asset_ids)):
            raise ValueError("asset IDs must be unique")
        if self.source_asset_id is not None and self.source_asset_id not in set(asset_ids):
            raise ValueError("source_asset_id must reference a project asset")
        pen_ids = [pen.pen_id for pen in self.pen_palette]
        if len(pen_ids) != len(set(pen_ids)):
            raise ValueError("pen profile IDs must be unique")
        missing_pens = {
            item.pen_profile_id
            for item in self.passes
            if item.pen_profile_id is not None and item.pen_profile_id not in set(pen_ids)
        }
        if missing_pens:
            raise ValueError(f"passes reference missing pen profiles: {sorted(missing_pens)}")
        return self


class MotionSettings(StrictModel):
    travel_command: Literal["G0"] = "G0"
    draw_command: Literal["G1"] = "G1"
    draw_feed_mm_min: float = Field(default=1800.0, gt=0)
    travel_feed_mm_min: float = Field(default=6000.0, gt=0)


class ZAxisActuator(StrictModel):
    kind: Literal["z_axis"] = "z_axis"
    up_mm: float = 5.0
    down_mm: float = 0.0
    lift_feed_mm_min: float = Field(default=900.0, gt=0)
    lower_feed_mm_min: float = Field(default=400.0, gt=0)
    dwell_after_up_ms: int = Field(default=80, ge=0)
    dwell_after_down_ms: int = Field(default=120, ge=0)

    @model_validator(mode="after")
    def up_and_down_are_distinct(self) -> ZAxisActuator:
        if self.up_mm <= self.down_mm:
            raise ValueError("Z-axis pen-up value must be above pen-down")
        return self


class ParkSettings(StrictModel):
    enabled: bool = False
    x_mm: float = 0.0
    y_mm: float = 0.0


class MacroSettings(StrictModel):
    header: list[str] = Field(default_factory=lambda: ["G21", "G90", "G17", "G94"])
    pause: str = "M0 ({message})"
    footer: list[str] = Field(default_factory=lambda: ["M2"])


class MachineProfile(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    profile_id: str = "fluidnc-z-axis-a3"
    name: str = "FluidNC/Grbl A3 - Z-axis pen"
    dialect: Literal["fluidnc-grbl"] = "fluidnc-grbl"
    work_width_mm: float = Field(default=430.0, gt=0)
    work_height_mm: float = Field(default=310.0, gt=0)
    origin_corner: Literal["lower-left"] = "lower-left"
    invert_x: bool = False
    invert_y: bool = False
    precision_decimals: int = Field(default=3, ge=0, le=6)
    motion: MotionSettings = Field(default_factory=MotionSettings)
    pen_actuator: ZAxisActuator = Field(default_factory=ZAxisActuator)
    park: ParkSettings = Field(default_factory=ParkSettings)
    macros: MacroSettings = Field(default_factory=MacroSettings)
    allowed_commands: list[str] = Field(
        default_factory=lambda: ["G0", "G1", "G4", "G17", "G21", "G90", "G94", "M0", "M2"]
    )


class PlannedPath(StrictModel):
    path_id: str
    source_layer_id: str
    points: list[Point] = Field(min_length=1)
    reversible: bool
    closed: bool
    kind: Literal["stroke", "dot"] = "stroke"
    dot_diameter_mm: float | None = None

    @model_validator(mode="after")
    def has_geometry_for_kind(self) -> PlannedPath:
        if self.kind == "dot":
            if len(self.points) != 1 or self.dot_diameter_mm is None or self.dot_diameter_mm <= 0:
                raise ValueError("dot paths require one point and a positive dot diameter")
        elif len(self.points) < 2:
            raise ValueError("stroke paths require at least two points")
        return self


class TravelSegment(StrictModel):
    start: Point
    end: Point
    pass_id: str


class PlotPass(StrictModel):
    pass_id: str
    name: str
    semantic_role: str
    preview_color: str
    pen_profile_id: str | None
    draw_feed_mm_min: float
    enabled: bool
    ordered_paths: list[PlannedPath]
    source_layer_ids: list[str] = Field(default_factory=list, exclude_if=lambda value: not value)
    pen_down_override: float | None = Field(default=None, exclude_if=lambda value: value is None)


class PlotAction(StrictModel):
    kind: Literal["pen_up", "travel", "pen_down", "draw", "pause_for_pen"]
    pass_id: str
    path_id: str | None = None
    start: Point | None = None
    end: Point | None = None
    message: str | None = None


class PlotStatistics(StrictModel):
    layer_count: int = Field(ge=0)
    pass_count: int = Field(ge=0)
    path_count: int = Field(ge=0)
    vertex_count: int = Field(ge=0)
    draw_length_mm: float = Field(ge=0)
    travel_length_mm: float = Field(ge=0)
    lift_count: int = Field(ge=0)
    estimated_seconds: float = Field(ge=0)


class PlanWarning(StrictModel):
    code: str
    message: str
    blocking: bool = False


class RemovedGeometryReport(StrictModel):
    non_finite_paths: int = 0
    degenerate_paths: int = 0
    short_paths: int = 0
    clipped_paths: int = 0


class PlotPlan(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    project_id: str
    page: PageSettings
    passes: list[PlotPass]
    travel_segments: list[TravelSegment]
    actions: list[PlotAction]
    statistics: PlotStatistics
    warnings: list[PlanWarning]
    removed_geometry: RemovedGeometryReport
    source_design_sha256: str
    normalized_sha256: str = ""


class GcodeInstruction(StrictModel):
    line_number: int
    command: str
    parameters: dict[str, float] = Field(default_factory=dict)
    source: str


class ReconstructedSegment(StrictModel):
    start: Point
    end: Point
    pen_down: bool


class ReconstructedToolpath(StrictModel):
    segments: list[ReconstructedSegment]
    draw_paths: list[list[Point]]
    draw_dots: list[Point] = Field(default_factory=list)
    final_position: Point
    final_z_mm: float
    pause_count: int


class ValidationIssue(StrictModel):
    code: str
    message: str
    blocking: bool


class GcodeValidationReport(StrictModel):
    valid: bool
    tolerance_mm: float
    max_xy_error_mm: float
    issues: list[ValidationIssue]


class GcodeStatistics(StrictModel):
    instruction_count: int
    draw_segment_count: int
    travel_segment_count: int
    pause_count: int
    byte_count: int


class GcodeProgram(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    filename: str
    text: str
    parsed_instructions: list[GcodeInstruction]
    reconstructed_toolpath: ReconstructedToolpath
    validation: GcodeValidationReport
    statistics: GcodeStatistics
    sha256: str


class ExportManifestEntry(StrictModel):
    filename: str
    sha256: str
    byte_count: int
    kind: Literal["pass", "combined", "dry-run", "page-boundary"]
    pass_id: str | None = None


class ExportManifest(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    project_id: str
    design_sha256: str
    plot_plan_sha256: str
    profile_id: str
    round_trip_tolerance_mm: float
    valid: bool
    entries: list[ExportManifestEntry]
    manifest_sha256: str = ""


class ExportBundle(StrictModel):
    manifest: ExportManifest
    programs: list[GcodeProgram]
    archive_base64: str


class SvgExportManifestEntry(StrictModel):
    filename: str
    sha256: str
    byte_count: int
    kind: Literal["pass", "combined"]
    pass_id: str | None = None


class SvgExportBundle(StrictModel):
    project_id: str
    design_sha256: str
    entries: list[SvgExportManifestEntry]
    archive_base64: str


class JobWarning(StrictModel):
    code: str
    message: str


class JobTiming(StrictModel):
    queued_ms: float = Field(default=0, ge=0)
    run_ms: float = Field(default=0, ge=0)


class JobState(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    job_id: str
    project_id: str
    project_revision: int = Field(ge=1)
    result_project_revision: int | None = Field(default=None, ge=1)
    operation: Literal[
        "generate",
        "generate_map",
        "download_map",
        "import_svg",
        "preprocess_raster",
        "vectorize_raster",
    ]
    stage: str
    status: Literal["queued", "running", "succeeded", "cancelled", "failed", "stale"]
    quality: Literal["draft", "standard", "export"]
    progress: float = Field(ge=0, le=1)
    completed_items: int | None = Field(default=None, ge=0)
    total_items: int | None = Field(default=None, ge=0)
    input_hash: str
    result_hash: str | None = None
    cache_hit: bool = False
    cancel_requested: bool = False
    warnings: list[JobWarning] = Field(default_factory=list)
    timing: JobTiming = Field(default_factory=JobTiming)
    error: str | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None


class CacheStatistics(StrictModel):
    entry_count: int = Field(ge=0)
    byte_count: int = Field(ge=0)


class CachePruneReport(StrictModel):
    removed_entries: int = Field(ge=0)
    removed_bytes: int = Field(ge=0)
    remaining_entries: int = Field(ge=0)
    remaining_bytes: int = Field(ge=0)


class CompactGeometryLayer(StrictModel):
    layer_id: str
    name: str
    preview_color: str
    first_path: int = Field(ge=0)
    path_count: int = Field(ge=0)


class CompactGeometry(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    coordinate_type: Literal["float32"] = "float32"
    vertices_xy: list[float]
    path_offsets: list[int]
    path_flags: list[int]
    layers: list[CompactGeometryLayer]
    source_design_sha256: str


def canonical_json(value: BaseModel | dict[str, Any] | list[Any]) -> str:
    if isinstance(value, BaseModel):
        data: Any = value.model_dump(mode="json", exclude_none=False)
    else:
        data = value
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_sha256(value: BaseModel | dict[str, Any] | list[Any]) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
