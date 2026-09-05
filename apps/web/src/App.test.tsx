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
    features: { roads: true, buildings: true, water: true, rail: true, parks: true },
    render: {
      road_line_treatment: "centerline",
      road_width_mm: 0.8,
      building_treatment: "outline",
      water_treatment: "hatch",
      park_treatment: "outline",
      polygon_hatch_spacing_mm: 2,
      polygon_hatch_angle_degrees: 45,
      simplification_tolerance_mm: 0.08,
      minimum_feature_mm: 0.3,
    },
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
    expect(screen.getByLabelText("Include roads")).toBeChecked();
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
