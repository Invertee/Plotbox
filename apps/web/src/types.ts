export interface Point {
  x: number;
  y: number;
}

export interface PageSettings {
  schema_version: 1;
  preset: "A3" | "A4" | "custom";
  orientation: "landscape" | "portrait";
  width_mm: number;
  height_mm: number;
  margin_mm: number;
}

export type PathCommand =
  | { kind: "move"; point: Point }
  | { kind: "line"; point: Point }
  | { kind: "quadratic"; control: Point; point: Point }
  | { kind: "cubic"; control1: Point; control2: Point; point: Point }
  | { kind: "close" };

export interface DesignPath {
  path_id: string;
  commands: PathCommand[];
  closed: boolean;
  reversible: boolean;
}

export interface DesignLayer {
  layer_id: string;
  name: string;
  semantic_role: string;
  preview_color: string;
  visible: boolean;
  paths: DesignPath[];
}

export interface DesignDocument {
  schema_version: 1;
  document_id: string;
  page: PageSettings;
  layers: DesignLayer[];
  metadata: {
    generator_id: string;
    generator_version: string;
    seed: string;
    quality: "draft" | "standard" | "export";
    normalized_sha256: string;
    source_asset_sha256?: string;
    source_snapshot_sha256?: string;
    source_attribution?: string;
    source_date?: string;
    diagnostics?: {
      code: string;
      message: string;
      severity: "warning" | "error";
      element_id: string | null;
    }[];
  };
}

export interface PassSettings {
  pass_id: string;
  name: string;
  semantic_role: string;
  preview_color: string;
  pen_profile_id: string | null;
  draw_feed_mm_min: number;
  enabled: boolean;
  visible: boolean;
  source_layer_ids?: string[];
  pen_down_override?: number | null;
}

export interface SourceAsset {
  asset_id: string;
  original_filename: string;
  media_type: "image/svg+xml" | "image/png" | "image/jpeg";
  sha256: string;
  byte_count: number;
}

export interface PenProfile {
  pen_id: string;
  name: string;
  display_color: string;
  tip_width_mm: number;
  draw_feed_mm_min: number | null;
  pen_down_override: number | null;
  x_offset_mm: number;
  y_offset_mm: number;
  notes: string;
}

export type QualityLevel = "draft" | "standard" | "export";
export type ModeParameterValue = string | number | boolean | number[];

export interface ModeParameterOption {
  value: string;
  label: string;
}

export interface ModeParameterDefinition {
  key: string;
  label: string;
  kind: "number" | "integer" | "boolean" | "enum" | "seed" | "color" | "role" | "range";
  group: string;
  default: ModeParameterValue;
  description: string;
  unit: string;
  minimum: number | null;
  maximum: number | null;
  step: number | null;
  options: ModeParameterOption[];
}

export interface ModePreset {
  schema_version: 1;
  preset_id: string;
  version: number;
  mode_id: string;
  mode_version: string;
  name: string;
  description: string;
  parameter_schema_version: number;
  seed: string | null;
  parameters: Record<string, ModeParameterValue>;
}

export interface ModeManifest {
  schema_version: 1;
  kind: "generator" | "importer";
  id: string;
  version: string;
  name: string;
  description: string;
  category: string;
  quality_levels: QualityLevel[];
  semantic_roles: string[];
  parameter_schema_version: number;
  parameter_groups: {
    group_id: string;
    label: string;
    description: string;
  }[];
  parameters: ModeParameterDefinition[];
  presets: ModePreset[];
  quality_mappings?: Partial<
    Record<QualityLevel, { density_scale: number; sampling_scale: number; label: string }>
  >;
  default_complexity?: { paths: number; vertices: number; relative_work: number } | null;
  algorithms: string[];
  parameter_schema: Record<string, unknown> | null;
}

export interface ProjectRecipe {
  schema_version: 1;
  project_id: string;
  name: string;
  revision: number;
  page: PageSettings;
  mode: {
    mode_id: string;
    version: string;
    seed: string;
    quality: QualityLevel;
    parameter_schema_version: number;
    parameters: Record<string, ModeParameterValue>;
  };
  assets: SourceAsset[];
  source_asset_id: string | null;
  svg_import: {
    fill_mode: "ignore" | "outline" | "hatch" | "crosshatch";
    stroke_mode: "centerline" | "outline" | "parallel";
    hatch_spacing_mm: number;
    hatch_angle_degrees: number;
    fit_to_page: boolean;
  };
  raster_preprocess: {
    crop: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    rotation_degrees: 0 | 90 | 180 | 270;
    fit_mode: "contain" | "cover" | "stretch";
    scale_percent: number;
    channel: "luminance" | "red" | "green" | "blue";
    invert: boolean;
    contrast: number;
    gamma: number;
    blur_radius_px: number;
    sharpen_amount: number;
    threshold_mode: "none" | "global" | "adaptive";
    threshold: number;
    adaptive_window_px: number;
    adaptive_offset: number;
    morphology: "none" | "open" | "close";
    morphology_radius_px: number;
    sampling_pixels_per_pen_width: number;
    maximum_megapixels: number;
  };
  raster_vectorize: {
    algorithm:
      | "edge"
      | "centerline"
      | "hatch"
      | "crosshatch"
      | "squiggle"
      | "tone-contour"
      | "color-outline"
      | "color-hatch";
    minimum_segment_length_mm: number;
    edge_threshold: number;
    edge_min_component_length_mm: number;
    centerline_threshold: number;
    centerline_prune_length_mm: number;
    hatch_spacing_mm: number;
    hatch_angle_degrees: number;
    hatch_tone_threshold: number;
    crosshatch_thresholds: [number, number, number, number];
    crosshatch_angle_step_degrees: number;
    squiggle_spacing_mm: number;
    squiggle_amplitude_mm: number;
    squiggle_wavelength_mm: number;
    squiggle_modulation: "amplitude" | "frequency" | "both";
    squiggle_min_darkness: number;
    contour_levels: number;
    color_count: number;
    color_background_threshold: number;
  };
  osm: OsmSettings;
  pen_palette: PenProfile[];
  passes: PassSettings[];
  geometry: {
    curve_tolerance_mm: number;
    simplification_tolerance_mm: number;
    minimum_path_length_mm: number;
    endpoint_snap_tolerance_mm: number;
    ordering_quality: "draft" | "standard";
  };
  export: {
    profile_id: string;
    separate_pass_files: boolean;
    combined_file: boolean;
    dry_run: boolean;
    page_boundary: boolean;
  };
}

export interface OsmBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OsmSnapshotMetadata {
  snapshot_id: string;
  sha256: string;
  query_sha256: string;
  fetched_at: string;
  source_date: string;
  attribution: string;
  provider: string;
  element_count: number;
  byte_count: number;
  bounds: OsmBounds;
}

export interface OsmSettings {
  selection: {
    bounds: OsmBounds;
    rotation_degrees: number;
    lock_mode: "extent" | "scale";
  };
  features: {
    roads: boolean;
    buildings: boolean;
    water: boolean;
    rail: boolean;
    parks: boolean;
  };
  render: {
    road_line_treatment: "centerline" | "casing" | "parallel";
    road_width_mm: number;
    building_treatment: "outline" | "hatch";
    water_treatment: "outline" | "hatch";
    park_treatment: "outline" | "hatch";
    polygon_hatch_spacing_mm: number;
    polygon_hatch_angle_degrees: number;
    simplification_tolerance_mm: number;
    minimum_feature_mm: number;
  };
  snapshot: OsmSnapshotMetadata | null;
}

export interface OsmSnapshotResponse {
  project: ProjectRecipe;
  snapshot: OsmSnapshotMetadata;
  cache_hit: boolean;
}

export interface OsmPlaceResult {
  display_name: string;
  latitude: number;
  longitude: number;
  osm_type: string | null;
  osm_id: number | null;
}

export interface OsmPlaceSearchResponse {
  results: OsmPlaceResult[];
  cache_hit: boolean;
}

export interface PlannedPath {
  path_id: string;
  source_layer_id: string;
  points: Point[];
  reversible: boolean;
  closed: boolean;
}

export interface PlotPass {
  pass_id: string;
  name: string;
  semantic_role: string;
  preview_color: string;
  pen_profile_id: string | null;
  draw_feed_mm_min: number;
  enabled: boolean;
  ordered_paths: PlannedPath[];
}

export interface PlotPlan {
  schema_version: 1;
  project_id: string;
  page: PageSettings;
  passes: PlotPass[];
  travel_segments: { start: Point; end: Point; pass_id: string }[];
  statistics: {
    layer_count: number;
    pass_count: number;
    path_count: number;
    vertex_count: number;
    draw_length_mm: number;
    travel_length_mm: number;
    lift_count: number;
    estimated_seconds: number;
  };
  warnings: { code: string; message: string; blocking: boolean }[];
  removed_geometry: {
    non_finite_paths: number;
    degenerate_paths: number;
    short_paths: number;
    clipped_paths: number;
  };
  source_design_sha256: string;
  normalized_sha256: string;
}

export interface MachineProfile {
  schema_version: 1;
  profile_id: string;
  name: string;
  dialect: "fluidnc-grbl";
  work_width_mm: number;
  work_height_mm: number;
  origin_corner: "lower-left";
  invert_x: boolean;
  invert_y: boolean;
  precision_decimals: number;
  motion: {
    travel_command: "G0";
    draw_command: "G1";
    draw_feed_mm_min: number;
    travel_feed_mm_min: number;
  };
  pen_actuator: {
    kind: "z_axis";
    up_mm: number;
    down_mm: number;
    lift_feed_mm_min: number;
    lower_feed_mm_min: number;
    dwell_after_up_ms: number;
    dwell_after_down_ms: number;
  };
  park: { enabled: boolean; x_mm: number; y_mm: number };
  macros: { header: string[]; pause: string; footer: string[] };
  allowed_commands: string[];
}

export interface ReconstructedSegment {
  start: Point;
  end: Point;
  pen_down: boolean;
}

export interface GcodeProgram {
  filename: string;
  text: string;
  reconstructed_toolpath: {
    segments: ReconstructedSegment[];
    draw_paths: Point[][];
    final_position: Point;
    final_z_mm: number;
    pause_count: number;
  };
  validation: {
    valid: boolean;
    tolerance_mm: number;
    max_xy_error_mm: number;
    issues: { code: string; message: string; blocking: boolean }[];
  };
  statistics: {
    instruction_count: number;
    draw_segment_count: number;
    travel_segment_count: number;
    pause_count: number;
    byte_count: number;
  };
  sha256: string;
}

export interface ExportBundle {
  manifest: {
    schema_version: 1;
    project_id: string;
    design_sha256: string;
    plot_plan_sha256: string;
    profile_id: string;
    round_trip_tolerance_mm: number;
    valid: boolean;
    manifest_sha256: string;
    entries: {
      filename: string;
      sha256: string;
      byte_count: number;
      kind: "pass" | "combined" | "dry-run" | "page-boundary";
      pass_id: string | null;
    }[];
  };
  programs: GcodeProgram[];
  archive_base64: string;
}

export interface JobState {
  schema_version: 1;
  job_id: string;
  project_id: string;
  project_revision: number;
  result_project_revision: number | null;
  operation: "generate" | "import_svg" | "preprocess_raster" | "vectorize_raster";
  stage: string;
  status: "queued" | "running" | "succeeded" | "cancelled" | "failed" | "stale";
  quality: "draft" | "standard" | "export";
  progress: number;
  completed_items: number | null;
  total_items: number | null;
  input_hash: string;
  result_hash: string | null;
  cache_hit: boolean;
  cancel_requested: boolean;
  warnings: { code: string; message: string }[];
  timing: { queued_ms: number; run_ms: number };
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AssetUploadResponse {
  project: ProjectRecipe;
  asset: SourceAsset;
}

export interface RasterPreview {
  schema_version: 1;
  project_id: string;
  source_asset_sha256: string;
  source_width_px: number;
  source_height_px: number;
  frame_count: number;
  crop_box_px: [number, number, number, number];
  processed_width_px: number;
  processed_height_px: number;
  mm_per_pixel_x: number;
  mm_per_pixel_y: number;
  pen_width_mm: number;
  placement: {
    x_mm: number;
    y_mm: number;
    width_mm: number;
    height_mm: number;
  };
  preview_png_base64: string;
  preview_sha256: string;
  warnings: { code: string; message: string }[];
}

export interface SvgExportBundle {
  project_id: string;
  design_sha256: string;
  entries: {
    filename: string;
    sha256: string;
    byte_count: number;
    kind: "pass" | "combined";
    pass_id: string | null;
  }[];
  archive_base64: string;
}

export interface FluidNCSettings {
  schema_version: 1;
  host: string;
  port: number;
  tls: boolean;
  command_timeout_seconds: number;
}

export type FluidNCAction =
  "identify" | "status" | "modal" | "config" | "limits" | "hold" | "home" | "jog" | "pen_test";

export interface FluidNCActionRequest {
  action: FluidNCAction;
  confirmed?: boolean;
  axis?: "X" | "Y" | "Z" | "ALL" | null;
  distance_mm?: number | null;
  feed_mm_min?: number | null;
  pen_up_mm?: number | null;
  pen_down_mm?: number | null;
}

export interface FluidNCActionResult {
  schema_version: 1;
  action: FluidNCAction;
  success: boolean;
  command_summary: string[];
  response_lines: string[];
  controller_state: string | null;
}

export interface AxisCalibrationResult {
  schema_version: 1;
  corrected_steps_per_mm: number;
  distance_error_percent: number;
}
