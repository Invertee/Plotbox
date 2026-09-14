import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { api } from "./api";
import type { JobState, MachineProfile, ModeManifest, ProjectRecipe, RasterPreview } from "./types";

const project: ProjectRecipe = {
  schema_version: 1,
  project_id: "ui-project",
  name: "A3 two-pass test",
  revision: 1,
  page: {
    schema_version: 1,
    preset: "A3",
    orientation: "landscape",
    width_mm: 420,
    height_mm: 297,
    margin_mm: 10,
  },
  mode: {
    mode_id: "builtin.test-pattern",
    version: "1.0.0",
    seed: "codex-vertical-slice-1",
    quality: "export",
    parameter_schema_version: 1,
    parameters: {
      density: 1,
      frame_count: 4,
      include_waves: true,
      accent_style: "both",
      orbit_band_mm: [-38, 38],
      accent_color: "#00a6c8",
      accent_role: "accent",
    },
  },
  assets: [],
  source_asset_id: null,
  svg_import: {
    fill_mode: "outline",
    stroke_mode: "centerline",
    hatch_spacing_mm: 2,
    hatch_angle_degrees: 45,
    dot_spacing_mm: 2,
    dot_diameter_mm: 0.5,
    part_effects: {},
    part_order: [],
    fit_to_page: true,
  },
  raster_preprocess: {
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation_degrees: 0,
    fit_mode: "contain",
    scale_percent: 100,
    channel: "luminance",
    invert: false,
    contrast: 1,
    gamma: 1,
    blur_radius_px: 0,
    sharpen_amount: 0,
    threshold_mode: "none",
    threshold: 128,
    adaptive_window_px: 15,
    adaptive_offset: 5,
    morphology: "none",
    morphology_radius_px: 0,
    sampling_pixels_per_pen_width: 3,
    maximum_megapixels: 8,
  },
  raster_vectorize: {
    algorithm: "edge",
    minimum_segment_length_mm: 0.6,
    edge_threshold: 12,
    edge_min_component_length_mm: 1,
    centerline_threshold: 160,
    centerline_prune_length_mm: 1.5,
    hatch_spacing_mm: 1.2,
    hatch_angle_degrees: 45,
    hatch_tone_threshold: 210,
    crosshatch_thresholds: [210, 160, 110, 60],
    crosshatch_angle_step_degrees: 45,
    squiggle_spacing_mm: 1.5,
    squiggle_amplitude_mm: 1,
    squiggle_wavelength_mm: 5,
    squiggle_modulation: "both",
    squiggle_min_darkness: 0.03,
    spiral_spacing_mm: 2.0,
    spiral_amplitude_mm: 0.7,
    spiral_wavelength_mm: 8.0,
    spiral_frequency_gain: 4.0,
    single_line_ink_density: 1,
    arc_overlap: 0.7,
    single_line_point_count: 1200,
    single_line_gamma: 1.0,
    single_line_min_darkness: 0.02,
    single_line_edge_bias: 0.5,
    arc_min_radius_mm: 0.4,
    arc_max_radius_mm: 3.0,
    arc_loop_spacing_mm: 4.0,
    tsp_smoothing: 0.0,
    contour_levels: 6,
    color_count: 2,
    color_background_threshold: 248,
    dither_mark: "dots",
    dither_pass_mode: "single",
    dither_pass_count: 4,
    dither_spacing_mm: 2,
    dither_pen_thickness_mm: 0.5,
    dither_dot_gap_mm: 0.5,
    dither_min_mark_size_mm: 0.25,
    dither_max_mark_size_mm: 1.8,
    dither_contrast: 1,
    dither_gamma: 1,
    dither_threshold: 0.02,
    dither_angle_degrees: 45,
    stipple_layout: "natural",
    stipple_color_mode: "single",
    stipple_mark: "pen-dots",
    stipple_spacing_mm: 1.8,
    stipple_pen_thickness_mm: 0.5,
    stipple_dot_gap_mm: 0.4,
    stipple_min_dot_size_mm: 0.25,
    stipple_max_dot_size_mm: 1.5,
    stipple_contrast: 1,
    stipple_gamma: 1,
    stipple_threshold: 0.02,
    adaptive_stipple_color_mode: "single",
    adaptive_stipple_mark: "pen-dots",
    adaptive_stipple_spacing_mm: 1.4,
    adaptive_stipple_pen_thickness_mm: 0.5,
    adaptive_stipple_dot_gap_mm: 0.25,
    adaptive_stipple_min_dot_size_mm: 0.2,
    adaptive_stipple_max_dot_size_mm: 1.3,
    adaptive_stipple_contrast: 1,
    adaptive_stipple_gamma: 1,
    adaptive_stipple_threshold: 0.015,
    adaptive_stipple_local_radius_mm: 5,
    adaptive_stipple_local_contrast: 0.65,
    adaptive_stipple_light_density: 0.35,
    adaptive_stipple_dark_density: 1,
  },
  osm: {
    selection: {
      bounds: { south: 51.503, west: -0.1305, north: 51.507, east: -0.1235 },
      rotation_degrees: 0,
      lock_mode: "extent",
    },
    features: {
      roads: true,
      buildings: true,
      water: true,
      rail: true,
      parks: true,
      road_motorways: true,
      road_primary: true,
      road_secondary: true,
      road_residential: true,
      road_service: true,
      footpaths: true,
      pedestrian_paths: true,
      cycleways: true,
      tracks: true,
      water_areas: true,
      waterways: true,
      coastline: false,
      woodland: false,
      farmland: false,
      meadow: false,
      residential_landuse: false,
      industrial_landuse: false,
      cemetery: false,
      parking: false,
      wetlands: false,
      boundaries: false,
      power_lines: false,
      power_nodes: false,
      aeroway: false,
      maritime: false,
      points_of_interest: false,
      poi_worship: false,
      poi_stations: false,
      poi_peaks: false,
      poi_historic: false,
      poi_castles: false,
      poi_lighthouses: false,
      poi_wind_turbines: false,
      poi_schools: false,
      poi_hospitals: false,
      poi_trees: false,
      poi_monuments: false,
    },
    render: {
      road_line_treatment: "centerline",
      road_width_mm: 0.8,
      rail_treatment: "single",
      rail_width_mm: 1,
      rail_sleeper_spacing_mm: 2.5,
      building_treatment: "outline",
      water_treatment: "hatch",
      park_treatment: "outline",
      landuse_treatment: "outline",
      boundary_treatment: "dashed",
      polygon_hatch_spacing_mm: 2,
      polygon_hatch_angle_degrees: 45,
      dash_length_mm: 2,
      dash_gap_mm: 1,
      dot_length_mm: 0.2,
      dot_gap_mm: 1,
      bridge_tick_spacing_mm: 3,
      bridge_tick_width_mm: 1.2,
      building_shadow_enabled: false,
      building_shadow_offset_mm: 1,
      building_shadow_angle_degrees: 45,
      water_ripple_spacing_mm: 2,
      water_ripple_angle_degrees: 0,
      simplification_tolerance_mm: 0.08,
      minimum_feature_mm: 0.3,
    },
    poi: { symbol_size_mm: 2 },
    detail: {
      minimum_line_length_mm: 0.3,
      minimum_polygon_area_mm2: 0.5,
      minimum_poi_spacing_mm: 2,
      vertex_simplification_tolerance_mm: 0.08,
      minimum_gap_mm: 0,
    },
    terrain: {
      enabled: false,
      provider: "aws-terrarium",
      contour_interval_m: 10,
      index_contour_every: 5,
      sample_resolution: 128,
      contour_simplification_mm: 0.15,
      minimum_contour_length_mm: 2,
      elevation_min_m: null,
      elevation_max_m: null,
    },
    preset_id: null,
    snapshot: null,
  },
  pen_palette: [
    {
      pen_id: "black-05",
      name: "Black 0.5 mm",
      display_color: "#171717",
      tip_width_mm: 0.5,
      draw_feed_mm_min: 1800,
      pen_down_override: null,
      x_offset_mm: 0,
      y_offset_mm: 0,
      notes: "",
    },
    {
      pen_id: "cyan-05",
      name: "Cyan 0.5 mm",
      display_color: "#00a6c8",
      tip_width_mm: 0.5,
      draw_feed_mm_min: 1800,
      pen_down_override: null,
      x_offset_mm: 0,
      y_offset_mm: 0,
      notes: "",
    },
  ],
  passes: [
    {
      pass_id: "pass-black",
      name: "Black",
      semantic_role: "structure",
      preview_color: "#171717",
      pen_profile_id: "black-05",
      draw_feed_mm_min: 1800,
      enabled: true,
      visible: true,
    },
    {
      pass_id: "pass-cyan",
      name: "Cyan",
      semantic_role: "accent",
      preview_color: "#00a6c8",
      pen_profile_id: "cyan-05",
      draw_feed_mm_min: 1800,
      enabled: true,
      visible: true,
    },
  ],
  geometry: {
    curve_tolerance_mm: 0.05,
    simplification_tolerance_mm: 0.02,
    minimum_path_length_mm: 0.2,
    endpoint_snap_tolerance_mm: 0.05,
    ordering_quality: "standard",
  },
  export: {
    profile_id: "fluidnc-z-axis-a3",
    separate_pass_files: true,
    combined_file: true,
    dry_run: true,
    page_boundary: true,
  },
};

const testMode: ModeManifest = {
  schema_version: 1,
  kind: "generator",
  id: "builtin.test-pattern",
  version: "1.0.0",
  name: "Deterministic two-layer test pattern",
  description: "",
  category: "procedural",
  quality_levels: ["draft", "standard", "export"],
  semantic_roles: ["structure", "accent"],
  parameter_schema_version: 1,
  parameter_groups: [{ group_id: "composition", label: "Composition", description: "" }],
  parameters: [
    {
      key: "seed",
      label: "Deterministic seed",
      kind: "seed",
      group: "composition",
      default: "codex-vertical-slice-1",
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [],
    },
  ],
  presets: [],
  algorithms: [],
  parameter_schema: null,
};

const profile: MachineProfile = {
  schema_version: 1,
  profile_id: "fluidnc-z-axis-a3",
  name: "FluidNC",
  dialect: "fluidnc-grbl",
  work_width_mm: 430,
  work_height_mm: 310,
  origin_corner: "lower-left",
  invert_x: false,
  invert_y: false,
  precision_decimals: 3,
  motion: {
    travel_command: "G0",
    draw_command: "G1",
    draw_feed_mm_min: 1800,
    travel_feed_mm_min: 6000,
  },
  pen_actuator: {
    kind: "z_axis",
    up_mm: 5,
    down_mm: 0,
    lift_feed_mm_min: 900,
    lower_feed_mm_min: 400,
    dwell_after_up_ms: 80,
    dwell_after_down_ms: 120,
  },
  park: { enabled: false, x_mm: 0, y_mm: 0 },
  macros: { header: [], pause: "M0 ({message})", footer: [] },
  allowed_commands: [],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace shell", () => {
  it("connects, creates an A3 project, and exposes the pass editor", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/health") {
        return Promise.resolve(response({ status: "ok", service: "plotterapp-api" }));
      }
      if (path === "/api/export-profiles") return Promise.resolve(response([profile]));
      if (path === "/api/modes") return Promise.resolve(response([testMode]));
      if (path === "/api/projects") {
        return Promise.resolve(init?.method === "POST" ? response(project, 201) : response([]));
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("connection-state")).toHaveTextContent("ready"));
    expect(screen.getByRole("heading", { name: "Plotbox" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create A3 project" }));
    expect(await screen.findByRole("heading", { name: "Pen passes" })).toBeVisible();
    expect(screen.getByLabelText("Deterministic seed")).toHaveValue("codex-vertical-slice-1");
    expect(screen.getByLabelText("structure pen name")).toHaveValue("Black");
    expect(screen.getByLabelText("accent pen name")).toHaveValue("Cyan");
    expect(screen.getByLabelText("structure physical pen")).toHaveValue("black-05");
    expect(screen.getByLabelText("Show pen-up travel")).toBeChecked();
    await user.selectOptions(screen.getByLabelText("Page preset"), "A4");
    expect(screen.getByLabelText("Page width")).toHaveValue(297);
    expect(screen.getByLabelText("Page height")).toHaveValue(210);
  });

  it("accepts a PNG source and exposes physical raster preprocessing controls", async () => {
    const rasterAsset = {
      asset_id: "asset-raster",
      original_filename: "scan.png",
      media_type: "image/png" as const,
      sha256: "a".repeat(64),
      byte_count: 8,
    };
    const rasterProject: ProjectRecipe = {
      ...project,
      revision: 2,
      mode: { ...project.mode, mode_id: "import.raster" },
      assets: [rasterAsset],
      source_asset_id: rasterAsset.asset_id,
    };
    const job = { job_id: "preview-job", status: "succeeded" } as JobState;
    vi.spyOn(api, "patchProject").mockResolvedValue(rasterProject);
    const startPreview = vi.spyOn(api, "startRasterPreprocess").mockResolvedValue(job);
    vi.spyOn(api, "watchJob").mockResolvedValue(job);
    vi.spyOn(api, "cancelJob").mockResolvedValue(job);
    vi.spyOn(api, "getRasterPreview").mockResolvedValue({
      processed_width_px: 32,
      processed_height_px: 24,
      mm_per_pixel_x: 1,
      mm_per_pixel_y: 1,
      placement: { x_mm: 10, y_mm: 10, width_mm: 32, height_mm: 24 },
      preview_png_base64: "",
      warnings: [],
    } as unknown as RasterPreview);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/health") {
        return Promise.resolve(response({ status: "ok", service: "plotterapp-api" }));
      }
      if (path === "/api/export-profiles") return Promise.resolve(response([profile]));
      if (path === "/api/modes") return Promise.resolve(response([testMode]));
      if (path === "/api/projects") {
        return Promise.resolve(init?.method === "POST" ? response(project, 201) : response([]));
      }
      if (path.startsWith("/api/projects/ui-project/assets")) {
        return Promise.resolve(response({ project: rasterProject, asset: rasterAsset }, 201));
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("connection-state")).toHaveTextContent("ready"));
    await user.click(screen.getByRole("button", { name: "Create A3 project" }));
    await user.click(screen.getByRole("button", { name: "Image import" }));
    await user.upload(
      screen.getByLabelText("Choose source file"),
      new File(["png-data"], "scan.png", { type: "image/png" }),
    );

    expect(await screen.findByRole("group", { name: "Raster preprocessing" })).toBeVisible();
    expect(screen.getByText("scan.png")).toBeVisible();
    expect(screen.getByLabelText("Raster fit mode")).toHaveValue("contain");
    expect(screen.getByLabelText("Raster samples per pen width")).toHaveValue("3");
    expect(screen.getByLabelText("Raster vectorization algorithm")).toHaveValue("edge");
    await user.selectOptions(screen.getByLabelText("Raster vectorization algorithm"), "squiggle");
    expect(screen.getByLabelText("Raster squiggle wavelength")).toHaveValue(5);
    await user.selectOptions(
      screen.getByLabelText("Raster vectorization algorithm"),
      "circular-scribble",
    );
    expect(screen.getByLabelText("Circular scribble row spacing")).toHaveValue(1.5);
    expect(screen.getByLabelText("Circular scribble largest loop")).toHaveValue(1);
    expect(screen.getByLabelText("Circular scribble minimum darkness")).toHaveValue("0.03");
    await user.selectOptions(
      screen.getByLabelText("Raster vectorization algorithm"),
      "spiral-wave",
    );
    const spiralSpacing = screen.getByRole("slider", { name: "Spiral turn spacing" });
    expect(spiralSpacing).toHaveAttribute("title", expect.stringContaining("millimetres"));
    fireEvent.change(spiralSpacing, { target: { value: "2.4" } });
    expect(spiralSpacing).toHaveValue("2.4");
    expect(
      screen.queryByRole("slider", { name: "Single-line ink density" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Raster minimum segment length")).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText("Raster vectorization algorithm"),
      "arc-scribble",
    );
    expect(screen.getByRole("slider", { name: "Single-line ink density" })).toHaveValue("1");
    const overlap = screen.getByRole("slider", { name: "Arc overlap" });
    fireEvent.change(overlap, { target: { value: "1" } });
    expect(overlap).toHaveValue("1");
    expect(screen.getByRole("slider", { name: "Arc dark radius" })).toHaveValue("0.4");
    expect(screen.getByRole("slider", { name: "Arc dark radius" })).toHaveAttribute("max", "3");
    await user.selectOptions(
      screen.getByLabelText("Raster vectorization algorithm"),
      "travelling-salesman",
    );
    const smoothing = screen.getByRole("slider", { name: "TSP corner smoothing" });
    fireEvent.change(smoothing, { target: { value: "0.7" } });
    expect(smoothing).toHaveValue("0.7");

    await user.selectOptions(screen.getByLabelText("Raster vectorization algorithm"), "dither");
    expect(screen.getByLabelText("Dither mark shape")).toHaveValue("dots");
    await user.selectOptions(screen.getByLabelText("Dither mark shape"), "crosses");
    await user.selectOptions(screen.getByLabelText("Dither pass split"), "contrast-bands");
    expect(screen.getByLabelText("Dither tone passes")).toHaveValue("4");
    expect(screen.getByLabelText("Dither cross angle")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Dither mark shape"), "pen-dots");
    expect(screen.getByLabelText("Dither pen thickness")).toHaveValue("0.5");
    expect(screen.getByLabelText("Dither dot gap")).toHaveValue("0.5");
    await user.selectOptions(screen.getByLabelText("Raster vectorization algorithm"), "stipple");
    expect(screen.getByLabelText("Stipple dot layout")).toHaveValue("natural");
    expect(screen.getByLabelText("Stipple colour mode")).toHaveValue("single");
    expect(screen.getByLabelText("Stipple pen thickness")).toHaveValue("0.5");
    await user.selectOptions(screen.getByLabelText("Stipple colour mode"), "separate");
    expect(screen.getByLabelText("Stipple colour passes")).toHaveValue("2");
    await user.selectOptions(
      screen.getByLabelText("Raster vectorization algorithm"),
      "adaptive-crosshatch",
    );
    expect(screen.getByLabelText("Adaptive crosshatch spacing")).toHaveValue("1.2");
    expect(screen.getByLabelText("Adaptive crosshatch base angle")).toHaveValue("45");
    expect(screen.getByLabelText("Adaptive crosshatch angle step")).toHaveValue("45");
    expect(screen.getByLabelText("Adaptive crosshatch layer 1 threshold")).toHaveValue("210");
    expect(screen.getByLabelText("Adaptive crosshatch layer 4 threshold")).toHaveValue("60");
    await user.selectOptions(
      screen.getByLabelText("Raster vectorization algorithm"),
      "adaptive-stipple",
    );
    expect(screen.getByLabelText("Adaptive stipple colour mode")).toHaveValue("single");
    expect(screen.getByLabelText("Adaptive stipple local radius")).toHaveValue("5");
    expect(screen.getByLabelText("Adaptive stipple light density")).toHaveValue("0.35");
    expect(screen.getByLabelText("Adaptive stipple dark density")).toHaveValue("1");
    await user.selectOptions(screen.getByLabelText("Adaptive stipple colour mode"), "separate");
    expect(screen.getByLabelText("Adaptive stipple colour passes")).toHaveValue("2");
    expect(
      screen.queryByRole("button", { name: "Preview raster preprocessing" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vectorize and plan" })).toBeEnabled();
    await waitFor(() => expect(startPreview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("raster-preview-stats")).toHaveTextContent("32"));
    fireEvent.change(screen.getByRole("slider", { name: "Raster contrast" }), {
      target: { value: "1.5" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Raster contrast" }), {
      target: { value: "2" },
    });
    await waitFor(() => expect(startPreview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.patchProject).mock.lastCall?.[1]).toMatchObject({
      raster_preprocess: { contrast: 2 },
    });
    await waitFor(() => expect(api.getRasterPreview).toHaveBeenCalledTimes(2));
    let finishOldJob!: (state: JobState) => void;
    vi.mocked(api.watchJob).mockImplementationOnce(
      () =>
        new Promise<JobState>((resolve) => {
          finishOldJob = resolve;
        }),
    );
    fireEvent.change(screen.getByRole("slider", { name: "Raster contrast" }), {
      target: { value: "3" },
    });
    await waitFor(() => expect(api.watchJob).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByRole("slider", { name: "Raster contrast" }), {
      target: { value: "4" },
    });
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith("preview-job"));
    finishOldJob(job);
    await waitFor(() => expect(startPreview).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(api.getRasterPreview).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("slider", { name: "Raster contrast" })).toHaveValue("4");
  }, 10_000);

  it("edits SVG part details and persists their drawing order", async () => {
    const sourceAsset = {
      asset_id: "asset-svg",
      original_filename: "landscape.svg",
      media_type: "image/svg+xml" as const,
      sha256: "c".repeat(64),
      byte_count: 128,
    };
    const svgProject: ProjectRecipe = {
      ...project,
      revision: 2,
      mode: { ...project.mode, mode_id: "import.svg" },
      assets: [sourceAsset],
      source_asset_id: sourceAsset.asset_id,
      svg_import: {
        ...project.svg_import,
        part_effects: { background: {}, sun: {}, mountains: {} },
      },
    };
    const patchProject = vi
      .spyOn(api, "patchProject")
      .mockImplementation((_projectId, changes) =>
        Promise.resolve({ ...svgProject, ...changes, revision: 3 } as ProjectRecipe),
      );
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/health") {
        return Promise.resolve(response({ status: "ok", service: "plotterapp-api" }));
      }
      if (path === "/api/export-profiles") return Promise.resolve(response([profile]));
      if (path === "/api/modes") return Promise.resolve(response([testMode]));
      if (path === "/api/projects") return Promise.resolve(response([svgProject]));
      if (path === "/api/projects/ui-project") return Promise.resolve(response(svgProject));
      if (path.endsWith("/design") || path.endsWith("/plot-plan")) {
        return Promise.resolve(response({ detail: "not generated" }, 404));
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open project" }));
    expect(await screen.findByLabelText("Effect for mountains")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("Effect for mountains"), "crosshatch");
    await user.selectOptions(screen.getByLabelText("Stroke treatment for mountains"), "parallel");
    await user.clear(screen.getByLabelText("Hatch spacing for mountains"));
    await user.type(screen.getByLabelText("Hatch spacing for mountains"), "1.2");
    await user.click(screen.getByRole("button", { name: "Move mountains earlier" }));
    await user.click(screen.getByRole("button", { name: "Save project" }));

    expect(patchProject.mock.lastCall?.[1]).toMatchObject({
      svg_import: {
        part_order: ["background", "mountains", "sun"],
        part_effects: {
          mountains: {
            fill_mode: "crosshatch",
            stroke_mode: "parallel",
            hatch_spacing_mm: 1.2,
          },
        },
      },
    });
  });

  it("switches to focused mapping tools and freezes an explicit OSM snapshot", async () => {
    let requestedSnapshotBounds: ProjectRecipe["osm"]["selection"]["bounds"] | null = null;
    let fetchedProject: ProjectRecipe | null = null;
    const mapProject: ProjectRecipe = {
      ...project,
      revision: 3,
      mode: { ...project.mode, mode_id: "map.openstreetmap", parameters: {} },
      osm: {
        ...project.osm,
        snapshot: {
          snapshot_id: "osm-aaaaaaaaaaaaaaaa",
          sha256: "a".repeat(64),
          query_sha256: "b".repeat(64),
          fetched_at: "2026-07-29T12:00:00Z",
          source_date: "2026-07-01T12:00:00Z",
          attribution: "© OpenStreetMap contributors",
          provider: "OpenStreetMap Overpass API",
          element_count: 42,
          byte_count: 2048,
          bounds: project.osm.selection.bounds,
        },
      },
    };
    const downloadJob: JobState = {
      schema_version: 1,
      job_id: "map-download-job",
      project_id: project.project_id,
      project_revision: 3,
      result_project_revision: null,
      operation: "download_map",
      stage: "queued",
      status: "queued",
      quality: "export",
      progress: 0,
      completed_items: null,
      total_items: null,
      input_hash: "a".repeat(64),
      result_hash: null,
      cache_hit: false,
      cancel_requested: false,
      warnings: [],
      timing: { queued_ms: 0, run_ms: 0 },
      error: null,
      created_at: "2026-07-29T12:00:00Z",
      started_at: null,
      finished_at: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/health") {
        return Promise.resolve(response({ status: "ok", service: "plotterapp-api" }));
      }
      if (path === "/api/export-profiles") return Promise.resolve(response([profile]));
      if (path === "/api/modes") return Promise.resolve(response([testMode]));
      if (path === "/api/projects") {
        return Promise.resolve(init?.method === "POST" ? response(project, 201) : response([]));
      }
      if (path === "/api/projects/ui-project" && init?.method === "PATCH") {
        return Promise.resolve(response({ ...project, mode: mapProject.mode }));
      }
      if (path === "/api/projects/ui-project/osm/snapshot") {
        if (typeof init?.body !== "string") {
          return Promise.reject(new Error("Map snapshot body must be JSON text"));
        }
        const requestedBounds = (
          JSON.parse(init.body) as { bounds: ProjectRecipe["osm"]["selection"]["bounds"] }
        ).bounds;
        requestedSnapshotBounds = requestedBounds;
        fetchedProject = {
          ...mapProject,
          osm: {
            ...mapProject.osm,
            selection: { ...mapProject.osm.selection, bounds: requestedBounds },
            snapshot: { ...mapProject.osm.snapshot!, bounds: requestedBounds },
          },
        };
        return Promise.resolve(response(downloadJob, 202));
      }
      if (path === "/api/projects/ui-project") {
        return Promise.resolve(response(fetchedProject ?? mapProject));
      }
      if (path === "/api/osm/places?query=Cambridge") {
        return Promise.resolve(
          response({
            results: [
              {
                display_name: "Cambridge, Cambridgeshire, England",
                latitude: 52.2053,
                longitude: 0.1218,
                osm_type: "relation",
                osm_id: 295355,
              },
            ],
            cache_hit: false,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(api, "watchJob").mockImplementation((_jobId, onState) => {
      onState({
        ...downloadJob,
        status: "running",
        stage: "downloading map data",
        progress: 0.5,
        completed_items: 2,
        total_items: 4,
      });
      const complete = {
        ...downloadJob,
        status: "succeeded" as const,
        stage: "complete",
        progress: 1,
        result_project_revision: 4,
        result_hash: "b".repeat(64),
        finished_at: "2026-07-29T12:00:01Z",
      };
      onState(complete);
      return Promise.resolve(complete);
    });
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("connection-state")).toHaveTextContent("ready"));
    await user.click(screen.getByRole("button", { name: "Create A3 project" }));
    await user.click(screen.getByRole("button", { name: "Mapping" }));

    expect(screen.getByRole("group", { name: "Map extent" })).toBeVisible();
    expect(screen.getByLabelText("Enable roads and paths")).toBeChecked();
    expect(screen.getByLabelText("Motorways / trunk")).toBeChecked();
    expect(
      screen.queryByRole("group", { name: "Procedural mode gallery" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Map centre latitude")).toBeVisible();
    expect(screen.getByLabelText("Map centre longitude")).toBeVisible();
    expect(screen.queryByLabelText("Map north latitude")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Search for a place"), "Cambridge");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Cambridge, Cambridgeshire, England",
      }),
    );
    expect(screen.getByLabelText("Map centre latitude")).toHaveValue("52.2053");
    expect(screen.getByLabelText("Map centre longitude")).toHaveValue("0.1218");
    expect(screen.getByText("New search results")).toBeVisible();
    expect(screen.getByText("Map area changed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download map data first" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Download and freeze map data" }));
    expect(await screen.findByText("Map data is ready")).toBeVisible();
    expect(screen.getByText("42 elements")).toBeVisible();
    expect(screen.getByText("Downloaded new snapshot")).toBeVisible();
    expect(screen.getByText("Finished")).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate map and plan" })).toBeEnabled();
    expect(requestedSnapshotBounds).not.toBeNull();
    if (!requestedSnapshotBounds) throw new Error("Map request bounds were not captured");
    const capturedBounds = requestedSnapshotBounds as ProjectRecipe["osm"]["selection"]["bounds"];
    expect((capturedBounds.south + capturedBounds.north) / 2).toBeCloseTo(52.2053, 5);
    expect((capturedBounds.west + capturedBounds.east) / 2).toBeCloseTo(0.1218, 5);
  });

  it("renames, opens, returns to, and deletes projects from the project list", async () => {
    const renamedProject = { ...project, name: "Renamed plot", revision: 2 };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/health") {
        return Promise.resolve(response({ status: "ok", service: "plotterapp-api" }));
      }
      if (path === "/api/export-profiles") return Promise.resolve(response([profile]));
      if (path === "/api/modes") return Promise.resolve(response([testMode]));
      if (path === "/api/projects") return Promise.resolve(response([project]));
      if (path === "/api/projects/ui-project" && init?.method === "PATCH") {
        return Promise.resolve(response(renamedProject));
      }
      if (path === "/api/projects/ui-project" && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path === "/api/projects/ui-project") return Promise.resolve(response(renamedProject));
      if (path.endsWith("/design") || path.endsWith("/plot-plan")) {
        return Promise.resolve(response({ detail: "not generated" }, 404));
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "A3 two-pass test" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Rename project"));
    await user.type(screen.getByLabelText("Rename project"), "Renamed plot");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("heading", { name: "Renamed plot" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("heading", { name: "Pen passes" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("heading", { name: "Your plotter projects" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/Delete “Renamed plot” permanently/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.getByText("No projects yet")).toBeVisible());
  });

  it("runs guarded FluidNC checks and calculates axis correction", async () => {
    const settings = {
      schema_version: 1 as const,
      host: "fluidnc.local",
      port: 81,
      tls: false,
      command_timeout_seconds: 15,
      safe_z_min_mm: -10,
      safe_z_max_mm: 0,
      pen_up_z_mm: 0,
      pen_down_z_mm: -5,
      skew_calibration: {
        enabled: false,
        square_width_mm: 100,
        square_height_mm: 100,
        rising_diagonal_mm: Math.sqrt(20_000),
        falling_diagonal_mm: Math.sqrt(20_000),
        axis_angle_degrees: 90,
      },
    };
    const actionRequests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/health") {
        return Promise.resolve(response({ status: "ok", service: "plotterapp-api" }));
      }
      if (path === "/api/export-profiles") return Promise.resolve(response([profile]));
      if (path === "/api/modes") return Promise.resolve(response([testMode]));
      if (path === "/api/projects") return Promise.resolve(response([]));
      if (path === "/api/fluidnc/settings") return Promise.resolve(response(settings));
      if (path === "/api/fluidnc/actions") {
        if (typeof init?.body !== "string") {
          return Promise.reject(new Error("FluidNC action body must be JSON text"));
        }
        const parsed: unknown = JSON.parse(init.body);
        if (typeof parsed !== "object" || parsed === null || !("action" in parsed)) {
          return Promise.reject(new Error("FluidNC action payload is invalid"));
        }
        const body = parsed as Record<string, unknown>;
        const action = typeof body.action === "string" ? body.action : "unknown";
        actionRequests.push(body);
        return Promise.resolve(
          response({
            schema_version: 1,
            action,
            success: true,
            command_summary: [action],
            response_lines: ["<Idle|MPos:0.000,0.000,0.000>", "ok"],
            controller_state: "Idle",
          }),
        );
      }
      if (path === "/api/fluidnc/calibration/axis") {
        return Promise.resolve(
          response({
            schema_version: 1,
            corrected_steps_per_mm: 81.632653,
            distance_error_percent: -2,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Plotter setup" }));
    expect(await screen.findByLabelText("FluidNC hostname")).toHaveValue("fluidnc.local");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("LATEST CONTROLLER RESPONSE")).toBeVisible();
    expect(screen.getAllByText("Idle")[0]).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Run guarded jog" }));
    await waitFor(() => expect(actionRequests.some((body) => body.action === "jog")).toBe(true));

    await user.clear(screen.getByLabelText("Measured calibration distance"));
    await user.type(screen.getByLabelText("Measured calibration distance"), "98");
    await user.click(screen.getByRole("button", { name: "Calculate correction" }));
    expect(await screen.findByText("81.632653")).toBeVisible();
    expect(screen.getByText(/does not write this value/)).toBeVisible();
  });
});
