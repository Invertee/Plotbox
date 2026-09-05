import type {
  DesignDocument,
  AssetUploadResponse,
  AxisCalibrationResult,
  ExportBundle,
  FluidNCActionRequest,
  FluidNCActionResult,
  FluidNCProgramResult,
  FluidNCSettings,
  JobState,
  MachineProfile,
  ModeManifest,
  OsmBounds,
  OsmPlaceSearchResponse,
  PlotPlan,
  ProjectRecipe,
  RasterPreview,
  SvgExportBundle,
} from "./types";

interface ApiErrorPayload {
  detail?: string;
}

export function apiUrl(path: string): string {
  const relativePath = path.replace(/^\/+/, "");
  const base = new URL(document.baseURI);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  const resolved = new URL(relativePath, base);
  return `${resolved.pathname}${resolved.search}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as ApiErrorPayload;
      message = payload.detail ?? message;
    } catch {
      // A non-JSON local-service error still has a useful HTTP status.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ status: "ok"; service: string }>("api/health"),
  modes: () => request<ModeManifest[]>("api/modes"),
  listProjects: () => request<ProjectRecipe[]>("api/projects"),
  createProject: (name: string) =>
    request<ProjectRecipe>("api/projects", {
      method: "POST",
      body: JSON.stringify({ name, page_preset: "A3", orientation: "landscape" }),
    }),
  getProject: (projectId: string) => request<ProjectRecipe>(`api/projects/${projectId}`),
  patchProject: (projectId: string, changes: object) =>
    request<ProjectRecipe>(`api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ changes }),
    }),
  startGeneration: (projectId: string, quality: "draft" | "standard" | "export") =>
    request<JobState>(`api/projects/${projectId}/generate`, {
      method: "POST",
      body: JSON.stringify({ quality, background: true }),
    }),
  watchJob: (jobId: string, onState: (state: JobState) => void) =>
    new Promise<JobState>((resolve, reject) => {
      const source = new EventSource(apiUrl(`api/jobs/${jobId}/events`));
      source.addEventListener("job", (event) => {
        const state = JSON.parse((event as MessageEvent<string>).data) as JobState;
        onState(state);
        if (["succeeded", "cancelled", "failed", "stale"].includes(state.status)) {
          source.close();
          resolve(state);
        }
      });
      source.onerror = () => {
        source.close();
        reject(new Error("Job progress stream disconnected"));
      };
    }),
  cancelJob: (jobId: string) =>
    request<JobState>(`api/jobs/${jobId}`, {
      method: "DELETE",
    }),
  startRasterPreprocess: (projectId: string, quality: "draft" | "standard" | "export") =>
    request<JobState>(`api/projects/${projectId}/raster/preprocess`, {
      method: "POST",
      body: JSON.stringify({ quality, background: true }),
    }),
  getRasterPreview: (projectId: string) =>
    request<RasterPreview>(`api/projects/${projectId}/raster/preview`),
  uploadAsset: (projectId: string, file: File) =>
    request<AssetUploadResponse>(
      `api/projects/${projectId}/assets?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    ),
  startOsmSnapshotDownload: (projectId: string, bounds: OsmBounds) =>
    request<JobState>(`api/projects/${projectId}/osm/snapshot`, {
      method: "POST",
      body: JSON.stringify({ bounds, background: true }),
    }),
  searchOsmPlaces: (query: string) =>
    request<OsmPlaceSearchResponse>(`api/osm/places?query=${encodeURIComponent(query)}`),
  getDesign: (projectId: string) => request<DesignDocument>(`api/projects/${projectId}/design`),
  plan: (projectId: string) =>
    request<PlotPlan>(`api/projects/${projectId}/plan`, {
      method: "POST",
    }),
  getPlan: (projectId: string) => request<PlotPlan>(`api/projects/${projectId}/plot-plan`),
  profiles: () => request<MachineProfile[]>("api/export-profiles"),
  exportGcode: (projectId: string, profile: MachineProfile) =>
    request<ExportBundle>(`api/projects/${projectId}/export/gcode`, {
      method: "POST",
      body: JSON.stringify({ profile }),
    }),
  sendGcode: (projectId: string, profile: MachineProfile, filename: string) =>
    request<FluidNCProgramResult>(`api/projects/${projectId}/send/gcode`, {
      method: "POST",
      body: JSON.stringify({ profile, filename, confirmed: true }),
    }),
  exportSvg: (projectId: string) =>
    request<SvgExportBundle>(`api/projects/${projectId}/export/svg`, {
      method: "POST",
    }),
  deleteProject: (projectId: string) =>
    request<void>(`api/projects/${projectId}`, { method: "DELETE" }),
  getFluidNCSettings: () => request<FluidNCSettings>("api/fluidnc/settings"),
  saveFluidNCSettings: (settings: FluidNCSettings) =>
    request<FluidNCSettings>("api/fluidnc/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  runFluidNCAction: (action: FluidNCActionRequest) =>
    request<FluidNCActionResult>("api/fluidnc/actions", {
      method: "POST",
      body: JSON.stringify(action),
    }),
  calculateAxisCalibration: (
    currentStepsPerMm: number,
    commandedDistanceMm: number,
    measuredDistanceMm: number,
  ) =>
    request<AxisCalibrationResult>("api/fluidnc/calibration/axis", {
      method: "POST",
      body: JSON.stringify({
        current_steps_per_mm: currentStepsPerMm,
        commanded_distance_mm: commandedDistanceMm,
        measured_distance_mm: measuredDistanceMm,
      }),
    }),
};
