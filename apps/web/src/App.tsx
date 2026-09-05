import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import { nearestPen } from "./color";
import { validateProfile } from "./exportValidation";
import { GeneratedModeControls } from "./ModeControls";
import { ModeGallery } from "./ModeGallery";
import { MapControls } from "./maps/MapControls";
import { PlotterSetup } from "./PlotterSetup";
import { ProjectList } from "./ProjectList";
import type {
  DesignDocument,
  ExportBundle,
  FluidNCProgramResult,
  GcodeProgram,
  JobState,
  MachineProfile,
  ModeManifest,
  OsmPlaceResult,
  PassSettings,
  PlotPlan,
  ProjectRecipe,
  RasterPreview,
  SvgExportBundle,
} from "./types";
import { CanvasViewer, type ViewerMode } from "./viewer/CanvasViewer";

type Operation =
  | "idle"
  | "creating"
  | "generating"
  | "uploading"
  | "saving"
  | "searching"
  | "planning"
  | "exporting"
  | "sending"
  | "reopening"
  | "deleting";
type ToolWorkspace = "artwork" | "image" | "map";
type AppArea = "projects" | "editor" | "plotter";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected local-service error";
}

function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function readableJobStage(stage: string): string {
  const labels: Record<string, string> = {
    queued: "Waiting to start",
    starting: "Starting",
    "cache-lookup": "Checking saved work",
    "raster-cache-lookup": "Checking saved image work",
    "classify-osm": "Turning map data into lines",
    "preparing-plot-plan": "Preparing plot plan",
    "planning-toolpath": "Planning pen paths",
    "rendering-toolpath": "Drawing plot preview",
    complete: "Finished",
  };
  return labels[stage] ?? stage.replaceAll("-", " ");
}

function JobProgress({ job, onCancel }: { job: JobState; onCancel: () => void }) {
  const isActive = ["queued", "running"].includes(job.status);
  const itemCount =
    job.completed_items !== null && job.total_items !== null
      ? `${job.completed_items.toLocaleString()} of ${job.total_items.toLocaleString()} items`
      : null;
  return (
    <div className="job-progress" aria-live="polite" aria-label="Work progress">
      <div>
        <strong>{readableJobStage(job.stage)}</strong>
        <span>{Math.round(job.progress * 100)}%</span>
      </div>
      <progress aria-label="Work complete" value={job.progress} max={1} />
      {itemCount && <small>{itemCount}</small>}
      {isActive && <small>Updates as the work continues.</small>}
      {isActive && (
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
      {job.cache_hit && <small>Used saved work for this request.</small>}
    </div>
  );
}

function downloadArchive(archiveBase64: string, filename: string): void {
  const binary = window.atob(archiveBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface RasterControlsProps {
  project: ProjectRecipe;
  onChange: (project: ProjectRecipe) => void;
}

function RasterControls({ project, onChange }: RasterControlsProps) {
  const settings = project.raster_preprocess;
  const update = (changes: Partial<ProjectRecipe["raster_preprocess"]>) =>
    onChange({
      ...project,
      raster_preprocess: { ...settings, ...changes },
    });
  const updateCrop = (field: keyof ProjectRecipe["raster_preprocess"]["crop"], value: number) =>
    update({ crop: { ...settings.crop, [field]: value } });
  const sourceName =
    project.assets.find((item) => item.asset_id === project.source_asset_id)?.original_filename ??
    "No raster selected";

  return (
    <fieldset>
      <legend>Raster preprocessing</legend>
      <p className="source-name">{sourceName}</p>
      <div className="field-row">
        <label>
          Crop X
          <input
            aria-label="Raster crop X"
            type="number"
            min="0"
            max="0.99"
            step="0.01"
            value={settings.crop.x}
            onChange={(event) => updateCrop("x", Number(event.target.value))}
          />
        </label>
        <label>
          Crop Y
          <input
            aria-label="Raster crop Y"
            type="number"
            min="0"
            max="0.99"
            step="0.01"
            value={settings.crop.y}
            onChange={(event) => updateCrop("y", Number(event.target.value))}
          />
        </label>
      </div>
      <div className="field-row">
        <label>
          Crop width
          <input
            aria-label="Raster crop width"
            type="number"
            min="0.01"
            max="1"
            step="0.01"
            value={settings.crop.width}
            onChange={(event) => updateCrop("width", Number(event.target.value))}
          />
        </label>
        <label>
          Crop height
          <input
            aria-label="Raster crop height"
            type="number"
            min="0.01"
            max="1"
            step="0.01"
            value={settings.crop.height}
            onChange={(event) => updateCrop("height", Number(event.target.value))}
          />
        </label>
      </div>
      <div className="field-row">
        <label>
          Rotation
          <select
            aria-label="Raster rotation"
            value={settings.rotation_degrees}
            onChange={(event) =>
              update({
                rotation_degrees: Number(
                  event.target.value,
                ) as ProjectRecipe["raster_preprocess"]["rotation_degrees"],
              })
            }
          >
            <option value={0}>0°</option>
            <option value={90}>90° clockwise</option>
            <option value={180}>180°</option>
            <option value={270}>270° clockwise</option>
          </select>
        </label>
        <label>
          Fit
          <select
            aria-label="Raster fit mode"
            value={settings.fit_mode}
            onChange={(event) =>
              update({
                fit_mode: event.target.value as ProjectRecipe["raster_preprocess"]["fit_mode"],
              })
            }
          >
            <option value="contain">Contain</option>
            <option value="cover">Cover</option>
            <option value="stretch">Stretch</option>
          </select>
        </label>
      </div>
      <label>
        Scale %
        <input
          aria-label="Raster scale percent"
          type="number"
          min="1"
          max="400"
          value={settings.scale_percent}
          onChange={(event) => update({ scale_percent: Number(event.target.value) })}
        />
      </label>
      <div className="field-row">
        <label>
          Grayscale channel
          <select
            aria-label="Raster grayscale channel"
            value={settings.channel}
            onChange={(event) =>
              update({
                channel: event.target.value as ProjectRecipe["raster_preprocess"]["channel"],
              })
            }
          >
            <option value="luminance">Luminance</option>
            <option value="red">Red</option>
            <option value="green">Green</option>
            <option value="blue">Blue</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            aria-label="Invert raster"
            type="checkbox"
            checked={settings.invert}
            onChange={(event) => update({ invert: event.target.checked })}
          />
          Invert
        </label>
      </div>
      <div className="field-row">
        <label>
          Contrast
          <input
            aria-label="Raster contrast"
            type="number"
            min="0.1"
            max="4"
            step="0.1"
            value={settings.contrast}
            onChange={(event) => update({ contrast: Number(event.target.value) })}
          />
        </label>
        <label>
          Gamma
          <input
            aria-label="Raster gamma"
            type="number"
            min="0.1"
            max="5"
            step="0.1"
            value={settings.gamma}
            onChange={(event) => update({ gamma: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="field-row">
        <label>
          Blur px
          <input
            aria-label="Raster blur"
            type="number"
            min="0"
            max="20"
            step="0.25"
            value={settings.blur_radius_px}
            onChange={(event) => update({ blur_radius_px: Number(event.target.value) })}
          />
        </label>
        <label>
          Sharpen
          <input
            aria-label="Raster sharpen"
            type="number"
            min="0"
            max="5"
            step="0.1"
            value={settings.sharpen_amount}
            onChange={(event) => update({ sharpen_amount: Number(event.target.value) })}
          />
        </label>
      </div>
      <label>
        Threshold
        <select
          aria-label="Raster threshold mode"
          value={settings.threshold_mode}
          onChange={(event) =>
            update({
              threshold_mode: event.target
                .value as ProjectRecipe["raster_preprocess"]["threshold_mode"],
            })
          }
        >
          <option value="none">None</option>
          <option value="global">Global</option>
          <option value="adaptive">Adaptive</option>
        </select>
      </label>
      {settings.threshold_mode === "global" && (
        <label>
          Threshold level
          <input
            aria-label="Raster threshold level"
            type="number"
            min="0"
            max="255"
            value={settings.threshold}
            onChange={(event) => update({ threshold: Number(event.target.value) })}
          />
        </label>
      )}
      {settings.threshold_mode === "adaptive" && (
        <div className="field-row">
          <label>
            Window px
            <input
              aria-label="Adaptive threshold window"
              type="number"
              min="3"
              max="101"
              step="2"
              value={settings.adaptive_window_px}
              onChange={(event) => update({ adaptive_window_px: Number(event.target.value) })}
            />
          </label>
          <label>
            Offset
            <input
              aria-label="Adaptive threshold offset"
              type="number"
              min="-64"
              max="64"
              value={settings.adaptive_offset}
              onChange={(event) => update({ adaptive_offset: Number(event.target.value) })}
            />
          </label>
        </div>
      )}
      <div className="field-row">
        <label>
          Morphology
          <select
            aria-label="Raster morphology"
            value={settings.morphology}
            onChange={(event) =>
              update({
                morphology: event.target.value as ProjectRecipe["raster_preprocess"]["morphology"],
              })
            }
          >
            <option value="none">None</option>
            <option value="open">Open</option>
            <option value="close">Close</option>
          </select>
        </label>
        <label>
          Radius px
          <input
            aria-label="Raster morphology radius"
            type="number"
            min="0"
            max="5"
            value={settings.morphology_radius_px}
            disabled={settings.morphology === "none"}
            onChange={(event) => update({ morphology_radius_px: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="field-row">
        <label>
          Samples / pen width
          <input
            aria-label="Raster samples per pen width"
            type="number"
            min="1"
            max="8"
            step="0.5"
            value={settings.sampling_pixels_per_pen_width}
            onChange={(event) =>
              update({ sampling_pixels_per_pen_width: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Max megapixels
          <input
            aria-label="Raster maximum megapixels"
            type="number"
            min="0.1"
            max="25"
            step="0.1"
            value={settings.maximum_megapixels}
            onChange={(event) => update({ maximum_megapixels: Number(event.target.value) })}
          />
        </label>
      </div>
      <p className="field-help">
        Processing resolution follows page size, active pen width, and selected quality.
      </p>
    </fieldset>
  );
}

function RasterVectorControls({ project, onChange }: RasterControlsProps) {
  const settings = project.raster_vectorize;
  const update = (changes: Partial<ProjectRecipe["raster_vectorize"]>) =>
    onChange({
      ...project,
      raster_vectorize: { ...settings, ...changes },
    });

  return (
    <fieldset>
      <legend>Raster vectorization</legend>
      <label>
        Algorithm
        <select
          aria-label="Raster vectorization algorithm"
          value={settings.algorithm}
          onChange={(event) =>
            update({
              algorithm: event.target.value as ProjectRecipe["raster_vectorize"]["algorithm"],
            })
          }
        >
          <option value="edge">Edge drawing</option>
          <option value="centerline">Centerline skeleton</option>
          <option value="hatch">Hatch</option>
          <option value="crosshatch">Crosshatch</option>
          <option value="squiggle">Squiggle scanlines</option>
          <option value="circular-scribble">Circular scribble</option>
          <option value="tone-contour">Tone contours</option>
          <option value="color-outline">Color region outline</option>
          <option value="color-hatch">Color region hatch</option>
          <option value="dither">Dithered halftone</option>
          <option value="stipple">Stippled dots</option>
          <option value="adaptive-stipple">Adaptive stipple dots</option>
        </select>
      </label>
      <label>
        Minimum segment mm
        <input
          aria-label="Raster minimum segment length"
          type="number"
          min="0"
          step="0.1"
          value={settings.minimum_segment_length_mm}
          onChange={(event) => update({ minimum_segment_length_mm: Number(event.target.value) })}
        />
      </label>
      {settings.algorithm === "edge" && (
        <div className="field-row">
          <label>
            Edge threshold
            <input
              aria-label="Raster edge threshold"
              type="number"
              min="1"
              max="255"
              value={settings.edge_threshold}
              onChange={(event) => update({ edge_threshold: Number(event.target.value) })}
            />
          </label>
          <label>
            Min component mm
            <input
              aria-label="Raster edge minimum component"
              type="number"
              min="0"
              step="0.1"
              value={settings.edge_min_component_length_mm}
              onChange={(event) =>
                update({ edge_min_component_length_mm: Number(event.target.value) })
              }
            />
          </label>
        </div>
      )}
      {settings.algorithm === "centerline" && (
        <div className="field-row">
          <label>
            Ink threshold
            <input
              aria-label="Raster centerline threshold"
              type="number"
              min="0"
              max="255"
              value={settings.centerline_threshold}
              onChange={(event) => update({ centerline_threshold: Number(event.target.value) })}
            />
          </label>
          <label>
            Prune branches mm
            <input
              aria-label="Raster centerline prune length"
              type="number"
              min="0"
              step="0.1"
              value={settings.centerline_prune_length_mm}
              onChange={(event) =>
                update({ centerline_prune_length_mm: Number(event.target.value) })
              }
            />
          </label>
        </div>
      )}
      {settings.algorithm === "hatch" && (
        <>
          <div className="field-row">
            <label>
              Hatch spacing mm
              <input
                aria-label="Raster hatch spacing"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.hatch_spacing_mm}
                onChange={(event) => update({ hatch_spacing_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Hatch angle
              <input
                aria-label="Raster hatch angle"
                type="number"
                value={settings.hatch_angle_degrees}
                onChange={(event) => update({ hatch_angle_degrees: Number(event.target.value) })}
              />
            </label>
          </div>
          <label>
            Tone threshold
            <input
              aria-label="Raster hatch tone threshold"
              type="number"
              min="0"
              max="255"
              value={settings.hatch_tone_threshold}
              onChange={(event) => update({ hatch_tone_threshold: Number(event.target.value) })}
            />
          </label>
        </>
      )}
      {settings.algorithm === "crosshatch" && (
        <>
          <div className="field-row">
            <label>
              Hatch spacing mm
              <input
                aria-label="Raster crosshatch spacing"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.hatch_spacing_mm}
                onChange={(event) => update({ hatch_spacing_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Base angle
              <input
                aria-label="Raster crosshatch angle"
                type="number"
                value={settings.hatch_angle_degrees}
                onChange={(event) => update({ hatch_angle_degrees: Number(event.target.value) })}
              />
            </label>
          </div>
          <label>
            Angle step
            <input
              aria-label="Raster crosshatch angle step"
              type="number"
              min="1"
              max="180"
              value={settings.crosshatch_angle_step_degrees}
              onChange={(event) =>
                update({ crosshatch_angle_step_degrees: Number(event.target.value) })
              }
            />
          </label>
        </>
      )}
      {settings.algorithm === "squiggle" && (
        <>
          <div className="field-row">
            <label>
              Scan spacing mm
              <input
                aria-label="Raster squiggle spacing"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.squiggle_spacing_mm}
                onChange={(event) => update({ squiggle_spacing_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Amplitude mm
              <input
                aria-label="Raster squiggle amplitude"
                type="number"
                min="0"
                step="0.1"
                value={settings.squiggle_amplitude_mm}
                onChange={(event) => update({ squiggle_amplitude_mm: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Wavelength mm
              <input
                aria-label="Raster squiggle wavelength"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.squiggle_wavelength_mm}
                onChange={(event) => update({ squiggle_wavelength_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Modulation
              <select
                aria-label="Raster squiggle modulation"
                value={settings.squiggle_modulation}
                onChange={(event) =>
                  update({
                    squiggle_modulation: event.target
                      .value as ProjectRecipe["raster_vectorize"]["squiggle_modulation"],
                  })
                }
              >
                <option value="amplitude">Amplitude</option>
                <option value="frequency">Frequency</option>
                <option value="both">Both</option>
              </select>
            </label>
          </div>
        </>
      )}
      {settings.algorithm === "circular-scribble" && (
        <>
          <div className="field-row">
            <label>
              Row spacing mm
              <input
                aria-label="Circular scribble row spacing"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.squiggle_spacing_mm}
                onChange={(event) => update({ squiggle_spacing_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Largest loop mm
              <input
                aria-label="Circular scribble largest loop"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.squiggle_amplitude_mm}
                onChange={(event) => update({ squiggle_amplitude_mm: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Light-area loop spacing mm
              <input
                aria-label="Circular scribble light loop spacing"
                type="number"
                min="0.2"
                step="0.1"
                value={settings.squiggle_wavelength_mm}
                onChange={(event) => update({ squiggle_wavelength_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Dark areas change
              <select
                aria-label="Circular scribble tone modulation"
                value={settings.squiggle_modulation}
                onChange={(event) =>
                  update({
                    squiggle_modulation: event.target
                      .value as ProjectRecipe["raster_vectorize"]["squiggle_modulation"],
                  })
                }
              >
                <option value="amplitude">Loop size</option>
                <option value="frequency">Loop spacing</option>
                <option value="both">Both</option>
              </select>
            </label>
          </div>
          <label>
            Minimum darkness
            <input
              aria-label="Circular scribble minimum darkness"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={settings.squiggle_min_darkness}
              onChange={(event) => update({ squiggle_min_darkness: Number(event.target.value) })}
            />
          </label>
          <p className="field-help">
            Draws one continuous organic line. Dark areas use tighter, smaller curls without lifting
            the pen; raise minimum darkness to leave light areas more open.
          </p>
        </>
      )}
      {settings.algorithm === "tone-contour" && (
        <label>
          Contour levels
          <input
            aria-label="Raster contour levels"
            type="number"
            min="1"
            max="32"
            value={settings.contour_levels}
            onChange={(event) => update({ contour_levels: Number(event.target.value) })}
          />
        </label>
      )}
      {settings.algorithm === "dither" && (
        <>
          <div className="field-row">
            <label>
              Mark shape
              <select
                aria-label="Dither mark shape"
                value={settings.dither_mark}
                onChange={(event) =>
                  update({
                    dither_mark: event.target
                      .value as ProjectRecipe["raster_vectorize"]["dither_mark"],
                  })
                }
              >
                <option value="dots">Dots</option>
                <option value="crosses">Crosses</option>
                <option value="pen-dots">Pen-tip dots</option>
              </select>
            </label>
            <label>
              Pass split
              <select
                aria-label="Dither pass split"
                value={settings.dither_pass_mode}
                onChange={(event) =>
                  update({
                    dither_pass_mode: event.target
                      .value as ProjectRecipe["raster_vectorize"]["dither_pass_mode"],
                  })
                }
              >
                <option value="single">Single tone</option>
                <option value="contrast-bands">Contrast bands</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              Tone passes
              <input
                aria-label="Dither tone passes"
                type="number"
                min="1"
                max="8"
                value={settings.dither_pass_count}
                disabled={settings.dither_pass_mode !== "contrast-bands"}
                onChange={(event) => update({ dither_pass_count: Number(event.target.value) })}
              />
            </label>
            {settings.dither_mark === "pen-dots" ? (
              <label>
                Clear gap between dots mm
                <input
                  aria-label="Dither dot gap"
                  type="number"
                  min="0"
                  max="50"
                  step="0.05"
                  value={settings.dither_dot_gap_mm}
                  onChange={(event) => update({ dither_dot_gap_mm: Number(event.target.value) })}
                />
              </label>
            ) : (
              <label>
                Grid spacing mm
                <input
                  aria-label="Dither spacing"
                  type="number"
                  min="0.1"
                  max="50"
                  step="0.1"
                  value={settings.dither_spacing_mm}
                  onChange={(event) => update({ dither_spacing_mm: Number(event.target.value) })}
                />
              </label>
            )}
          </div>
          {settings.dither_mark === "pen-dots" ? (
            <label>
              Pen-tip thickness mm
              <input
                aria-label="Dither pen thickness"
                type="number"
                min="0.05"
                max="25"
                step="0.05"
                value={settings.dither_pen_thickness_mm}
                onChange={(event) =>
                  update({ dither_pen_thickness_mm: Number(event.target.value) })
                }
              />
            </label>
          ) : (
            <div className="field-row">
              <label>
                Minimum mark mm
                <input
                  aria-label="Dither minimum mark size"
                  type="number"
                  min="0"
                  max="25"
                  step="0.05"
                  value={settings.dither_min_mark_size_mm}
                  onChange={(event) =>
                    update({ dither_min_mark_size_mm: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Maximum mark mm
                <input
                  aria-label="Dither maximum mark size"
                  type="number"
                  min="0.05"
                  max="25"
                  step="0.05"
                  value={settings.dither_max_mark_size_mm}
                  onChange={(event) =>
                    update({ dither_max_mark_size_mm: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
          <div className="field-row">
            <label>
              Dither contrast
              <input
                aria-label="Dither contrast"
                type="number"
                min="0.1"
                max="4"
                step="0.1"
                value={settings.dither_contrast}
                onChange={(event) => update({ dither_contrast: Number(event.target.value) })}
              />
            </label>
            <label>
              Dither gamma
              <input
                aria-label="Dither gamma"
                type="number"
                min="0.1"
                max="5"
                step="0.1"
                value={settings.dither_gamma}
                onChange={(event) => update({ dither_gamma: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Mark threshold
              <input
                aria-label="Dither mark threshold"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={settings.dither_threshold}
                onChange={(event) => update({ dither_threshold: Number(event.target.value) })}
              />
            </label>
            {settings.dither_mark === "crosses" && (
              <label>
                Cross angle °
                <input
                  aria-label="Dither cross angle"
                  type="number"
                  value={settings.dither_angle_degrees}
                  onChange={(event) => update({ dither_angle_degrees: Number(event.target.value) })}
                />
              </label>
            )}
          </div>
          <p className="field-help">
            Ordered dithering varies mark density from the processed image. Pen-tip dots lower and
            lift at each selected cell; their pitch is pen thickness plus the clear gap. Contrast
            bands create separate logical layers for different pens; assign them in Pen passes.
          </p>
        </>
      )}
      {settings.algorithm === "stipple" && (
        <>
          <div className="field-row">
            <label>
              Dot layout
              <select
                aria-label="Stipple dot layout"
                value={settings.stipple_layout}
                onChange={(event) =>
                  update({
                    stipple_layout: event.target
                      .value as ProjectRecipe["raster_vectorize"]["stipple_layout"],
                  })
                }
              >
                <option value="natural">Natural dots</option>
                <option value="even">Even dots</option>
              </select>
            </label>
            <label>
              Colours
              <select
                aria-label="Stipple colour mode"
                value={settings.stipple_color_mode}
                onChange={(event) =>
                  update({
                    stipple_color_mode: event.target
                      .value as ProjectRecipe["raster_vectorize"]["stipple_color_mode"],
                  })
                }
              >
                <option value="single">One pen</option>
                <option value="separate">Separate source colours</option>
              </select>
            </label>
          </div>
          {settings.stipple_color_mode === "separate" && (
            <div className="field-row">
              <label>
                Colour passes
                <input
                  aria-label="Stipple colour passes"
                  type="number"
                  min="2"
                  max="8"
                  value={settings.color_count}
                  onChange={(event) => update({ color_count: Number(event.target.value) })}
                />
              </label>
              <label>
                Ignore near-white
                <input
                  aria-label="Stipple colour background threshold"
                  type="number"
                  min="0"
                  max="255"
                  value={settings.color_background_threshold}
                  onChange={(event) =>
                    update({ color_background_threshold: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
          <div className="field-row">
            <label>
              Dot type
              <select
                aria-label="Stipple dot type"
                value={settings.stipple_mark}
                onChange={(event) =>
                  update({
                    stipple_mark: event.target
                      .value as ProjectRecipe["raster_vectorize"]["stipple_mark"],
                  })
                }
              >
                <option value="pen-dots">Pen-tip dots</option>
                <option value="drawn-dots">Drawn circles</option>
              </select>
            </label>
            {settings.stipple_mark === "pen-dots" ? (
              <label>
                Clear gap mm
                <input
                  aria-label="Stipple dot gap"
                  type="number"
                  min="0"
                  max="50"
                  step="0.05"
                  value={settings.stipple_dot_gap_mm}
                  onChange={(event) => update({ stipple_dot_gap_mm: Number(event.target.value) })}
                />
              </label>
            ) : (
              <label>
                Dot spacing mm
                <input
                  aria-label="Stipple spacing"
                  type="number"
                  min="0.1"
                  max="50"
                  step="0.1"
                  value={settings.stipple_spacing_mm}
                  onChange={(event) => update({ stipple_spacing_mm: Number(event.target.value) })}
                />
              </label>
            )}
          </div>
          {settings.stipple_mark === "pen-dots" ? (
            <label>
              Pen-tip thickness mm
              <input
                aria-label="Stipple pen thickness"
                type="number"
                min="0.05"
                max="25"
                step="0.05"
                value={settings.stipple_pen_thickness_mm}
                onChange={(event) =>
                  update({ stipple_pen_thickness_mm: Number(event.target.value) })
                }
              />
            </label>
          ) : (
            <div className="field-row">
              <label>
                Smallest dot mm
                <input
                  aria-label="Stipple minimum dot size"
                  type="number"
                  min="0"
                  max="25"
                  step="0.05"
                  value={settings.stipple_min_dot_size_mm}
                  onChange={(event) =>
                    update({ stipple_min_dot_size_mm: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Largest dot mm
                <input
                  aria-label="Stipple maximum dot size"
                  type="number"
                  min="0.05"
                  max="25"
                  step="0.05"
                  value={settings.stipple_max_dot_size_mm}
                  onChange={(event) =>
                    update({ stipple_max_dot_size_mm: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
          <div className="field-row">
            <label>
              Contrast
              <input
                aria-label="Stipple contrast"
                type="number"
                min="0.1"
                max="4"
                step="0.1"
                value={settings.stipple_contrast}
                onChange={(event) => update({ stipple_contrast: Number(event.target.value) })}
              />
            </label>
            <label>
              Gamma
              <input
                aria-label="Stipple gamma"
                type="number"
                min="0.1"
                max="5"
                step="0.1"
                value={settings.stipple_gamma}
                onChange={(event) => update({ stipple_gamma: Number(event.target.value) })}
              />
            </label>
          </div>
          <label>
            Minimum darkness
            <input
              aria-label="Stipple minimum darkness"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={settings.stipple_threshold}
              onChange={(event) => update({ stipple_threshold: Number(event.target.value) })}
            />
          </label>
          <p className="field-help">
            Stippling makes dots more common in dark parts of the image. Separate source colours
            creates one layer and pen pass for each colour, ready to assign in Pen passes.
          </p>
        </>
      )}
      {settings.algorithm === "adaptive-stipple" && (
        <>
          <div className="field-row">
            <label>
              Colours
              <select
                aria-label="Adaptive stipple colour mode"
                value={settings.adaptive_stipple_color_mode}
                onChange={(event) =>
                  update({
                    adaptive_stipple_color_mode: event.target
                      .value as ProjectRecipe["raster_vectorize"]["adaptive_stipple_color_mode"],
                  })
                }
              >
                <option value="single">One pen</option>
                <option value="separate">Separate source colours</option>
              </select>
            </label>
            <label>
              Dot type
              <select
                aria-label="Adaptive stipple dot type"
                value={settings.adaptive_stipple_mark}
                onChange={(event) =>
                  update({
                    adaptive_stipple_mark: event.target
                      .value as ProjectRecipe["raster_vectorize"]["adaptive_stipple_mark"],
                  })
                }
              >
                <option value="pen-dots">Pen-tip dots</option>
                <option value="drawn-dots">Drawn circles</option>
              </select>
            </label>
          </div>
          {settings.adaptive_stipple_color_mode === "separate" && (
            <div className="field-row">
              <label>
                Colour passes
                <input
                  aria-label="Adaptive stipple colour passes"
                  type="number"
                  min="2"
                  max="8"
                  value={settings.color_count}
                  onChange={(event) => update({ color_count: Number(event.target.value) })}
                />
              </label>
              <label>
                Ignore near-white
                <input
                  aria-label="Adaptive stipple colour background threshold"
                  type="number"
                  min="0"
                  max="255"
                  value={settings.color_background_threshold}
                  onChange={(event) =>
                    update({ color_background_threshold: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
          {settings.adaptive_stipple_mark === "pen-dots" ? (
            <div className="field-row">
              <label>
                Pen-tip thickness mm
                <input
                  aria-label="Adaptive stipple pen thickness"
                  type="number"
                  min="0.05"
                  max="25"
                  step="0.05"
                  value={settings.adaptive_stipple_pen_thickness_mm}
                  onChange={(event) =>
                    update({ adaptive_stipple_pen_thickness_mm: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Clear gap mm
                <input
                  aria-label="Adaptive stipple dot gap"
                  type="number"
                  min="0"
                  max="50"
                  step="0.05"
                  value={settings.adaptive_stipple_dot_gap_mm}
                  onChange={(event) =>
                    update({ adaptive_stipple_dot_gap_mm: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          ) : (
            <>
              <label>
                Candidate spacing mm
                <input
                  aria-label="Adaptive stipple spacing"
                  type="number"
                  min="0.1"
                  max="50"
                  step="0.1"
                  value={settings.adaptive_stipple_spacing_mm}
                  onChange={(event) =>
                    update({ adaptive_stipple_spacing_mm: Number(event.target.value) })
                  }
                />
              </label>
              <div className="field-row">
                <label>
                  Light dot size mm
                  <input
                    aria-label="Adaptive stipple minimum dot size"
                    type="number"
                    min="0"
                    max="25"
                    step="0.05"
                    value={settings.adaptive_stipple_min_dot_size_mm}
                    onChange={(event) =>
                      update({ adaptive_stipple_min_dot_size_mm: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Dark dot size mm
                  <input
                    aria-label="Adaptive stipple maximum dot size"
                    type="number"
                    min="0.05"
                    max="25"
                    step="0.05"
                    value={settings.adaptive_stipple_max_dot_size_mm}
                    onChange={(event) =>
                      update({ adaptive_stipple_max_dot_size_mm: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </>
          )}
          <div className="field-row">
            <label>
              Local area radius mm
              <input
                aria-label="Adaptive stipple local radius"
                type="number"
                min="0.1"
                max="100"
                step="0.5"
                value={settings.adaptive_stipple_local_radius_mm}
                onChange={(event) =>
                  update({ adaptive_stipple_local_radius_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Local contrast
              <input
                aria-label="Adaptive stipple local contrast"
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={settings.adaptive_stipple_local_contrast}
                onChange={(event) =>
                  update({ adaptive_stipple_local_contrast: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Light-area density
              <input
                aria-label="Adaptive stipple light density"
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={settings.adaptive_stipple_light_density}
                onChange={(event) =>
                  update({ adaptive_stipple_light_density: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Dark-area density
              <input
                aria-label="Adaptive stipple dark density"
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={settings.adaptive_stipple_dark_density}
                onChange={(event) =>
                  update({ adaptive_stipple_dark_density: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Contrast
              <input
                aria-label="Adaptive stipple contrast"
                type="number"
                min="0.1"
                max="4"
                step="0.1"
                value={settings.adaptive_stipple_contrast}
                onChange={(event) =>
                  update({ adaptive_stipple_contrast: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Gamma
              <input
                aria-label="Adaptive stipple gamma"
                type="number"
                min="0.1"
                max="5"
                step="0.1"
                value={settings.adaptive_stipple_gamma}
                onChange={(event) => update({ adaptive_stipple_gamma: Number(event.target.value) })}
              />
            </label>
          </div>
          <label>
            Minimum darkness
            <input
              aria-label="Adaptive stipple minimum darkness"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={settings.adaptive_stipple_threshold}
              onChange={(event) =>
                update({ adaptive_stipple_threshold: Number(event.target.value) })
              }
            />
          </label>
          <p className="field-help">
            Adaptive stippling compares each sample with its surrounding area, then varies dot
            density—and drawn-circle size—between light and dark regions. Colour separation emits
            one stable layer per source colour for independent pen passes.
          </p>
        </>
      )}
      {settings.algorithm.startsWith("color-") && (
        <div className="field-row">
          <label>
            Source colors
            <input
              aria-label="Raster source color count"
              type="number"
              min="2"
              max="8"
              value={settings.color_count}
              onChange={(event) => update({ color_count: Number(event.target.value) })}
            />
          </label>
          <label>
            Ignore near-white
            <input
              aria-label="Raster color background threshold"
              type="number"
              min="0"
              max="255"
              value={settings.color_background_threshold}
              onChange={(event) =>
                update({ color_background_threshold: Number(event.target.value) })
              }
            />
          </label>
        </div>
      )}
      <p className="field-help">
        Geometry is generated in page millimetres and can be planned and exported like any design.
      </p>
    </fieldset>
  );
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [appArea, setAppArea] = useState<AppArea>("projects");
  const [operation, setOperation] = useState<Operation>("idle");
  const [project, setProject] = useState<ProjectRecipe | null>(null);
  const projectRef = useRef<ProjectRecipe | null>(null);
  projectRef.current = project;
  const [modes, setModes] = useState<ModeManifest[]>([]);
  const [recentProjects, setRecentProjects] = useState<ProjectRecipe[]>([]);
  const [design, setDesign] = useState<DesignDocument | null>(null);
  const [plan, setPlan] = useState<PlotPlan | null>(null);
  const [profile, setProfile] = useState<MachineProfile | null>(null);
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [sendResult, setSendResult] = useState<FluidNCProgramResult | null>(null);
  const [selectedProgramFilename, setSelectedProgramFilename] = useState("combined.nc");
  const [svgBundle, setSvgBundle] = useState<SvgExportBundle | null>(null);
  const [rasterPreview, setRasterPreview] = useState<RasterPreview | null>(null);
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [previewRenderToken, setPreviewRenderToken] = useState(0);
  const nextPreviewRenderToken = useRef(0);
  const previewRenderWaiters = useRef(new Map<number, () => void>());
  const [soloPassId, setSoloPassId] = useState<string | null>(null);
  const [draggingPassIndex, setDraggingPassIndex] = useState<number | null>(null);
  const [viewerMode, setViewerMode] = useState<ViewerMode>("design");
  const [showTravel, setShowTravel] = useState(true);
  const [showOverprint, setShowOverprint] = useState(false);
  const [showSourceOverlay, setShowSourceOverlay] = useState(true);
  const [toolWorkspace, setToolWorkspace] = useState<ToolWorkspace>("artwork");
  const [lastMapFetchUsedCache, setLastMapFetchUsedCache] = useState<boolean | null>(null);
  const [mapPlaces, setMapPlaces] = useState<OsmPlaceResult[]>([]);
  const [lastPlaceSearchUsedCache, setLastPlaceSearchUsedCache] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.health(), api.profiles(), api.listProjects(), api.modes()])
      .then(([health, profiles, projects, availableModes]) => {
        setConnected(health.status === "ok");
        setProfile(profiles[0] ?? null);
        setRecentProjects(projects);
        setModes(availableModes);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const combined = useMemo<GcodeProgram | null>(
    () => bundle?.programs.find((program) => program.filename === "combined.nc") ?? null,
    [bundle],
  );
  const activeMode = project
    ? modes.find((mode) => mode.id === project.mode.mode_id && mode.kind === "generator")
    : undefined;

  const run = async (nextOperation: Operation, action: () => Promise<void>) => {
    setOperation(nextOperation);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setOperation("idle");
    }
  };

  const waitForPreviewRender = () =>
    new Promise<void>((resolve) => {
      const token = ++nextPreviewRenderToken.current;
      previewRenderWaiters.current.set(token, resolve);
      setPreviewRenderToken(token);
    });

  const completePreviewRender = (token: number) => {
    const resolve = previewRenderWaiters.current.get(token);
    if (!resolve) return;
    previewRenderWaiters.current.delete(token);
    resolve();
  };

  const setPlanningProgress = (job: JobState, stage: string, progress: number) => {
    setActiveJob({
      ...job,
      status: "running",
      stage,
      progress,
      completed_items: null,
      total_items: null,
      finished_at: null,
    });
  };

  const createProject = (name = "A3 two-pass test") =>
    run("creating", async () => {
      const created = await api.createProject(name);
      setProject(created);
      setDesign(null);
      setPlan(null);
      setBundle(null);
      setSendResult(null);
      setSvgBundle(null);
      setRasterPreview(null);
      setActiveJob(null);
      setViewerMode("design");
      setMapPlaces([]);
      setLastPlaceSearchUsedCache(null);
      setAppArea("editor");
      setRecentProjects((current) => [
        created,
        ...current.filter((item) => item.project_id !== created.project_id),
      ]);
    });

  const persistedChanges = (current: ProjectRecipe) => ({
    page: current.page,
    mode: current.mode,
    assets: current.assets,
    source_asset_id: current.source_asset_id,
    svg_import: current.svg_import,
    raster_preprocess: current.raster_preprocess,
    raster_vectorize: current.raster_vectorize,
    osm: current.osm,
    pen_palette: current.pen_palette,
    passes: current.passes,
    geometry: current.geometry,
    export: current.export,
  });

  const saveProject = () => {
    if (!project) return Promise.resolve();
    return run("saving", async () => {
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      setProject(saved);
      setRecentProjects((current) => [
        saved,
        ...current.filter((item) => item.project_id !== saved.project_id),
      ]);
    });
  };

  const generateAndPlan = () => {
    if (!project) return Promise.resolve();
    return run("generating", async () => {
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      setProject(saved);
      const started = await api.startGeneration(saved.project_id, saved.mode.quality);
      setActiveJob(started);
      const completed = await api.watchJob(started.job_id, (job) => {
        if (job.status === "succeeded") {
          setPlanningProgress(job, "preparing-plot-plan", 0.85);
        } else {
          setActiveJob(job);
        }
      });
      if (completed.status === "cancelled") return;
      if (completed.status !== "succeeded") {
        throw new Error(completed.error ?? `Generation ended as ${completed.status}`);
      }
      const current = await api.getProject(saved.project_id);
      const generated = await api.getDesign(saved.project_id);
      setPlanningProgress(completed, "planning-toolpath", 0.9);
      const planned = await api.plan(saved.project_id);
      setProject(current);
      setDesign(generated);
      setPlan(planned);
      setBundle(null);
      setSvgBundle(null);
      if (saved.mode.mode_id === "import.raster") {
        try {
          setRasterPreview(await api.getRasterPreview(saved.project_id));
        } catch {
          setRasterPreview(null);
        }
      } else {
        setRasterPreview(null);
      }
      setViewerMode("toolpath");
      setPlanningProgress(completed, "rendering-toolpath", 0.99);
      await waitForPreviewRender();
      setActiveJob(completed);
    });
  };

  const preprocessRaster = () => {
    if (!project) return Promise.resolve();
    return run("generating", async () => {
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      setProject(saved);
      const started = await api.startRasterPreprocess(saved.project_id, saved.mode.quality);
      setActiveJob(started);
      const completed = await api.watchJob(started.job_id, setActiveJob);
      if (completed.status === "cancelled") return;
      if (completed.status !== "succeeded") {
        throw new Error(completed.error ?? `Preprocessing ended as ${completed.status}`);
      }
      const preview = await api.getRasterPreview(saved.project_id);
      setProject(await api.getProject(saved.project_id));
      setRasterPreview(preview);
      setDesign(null);
      setPlan(null);
      setBundle(null);
      setSendResult(null);
      setSvgBundle(null);
      setViewerMode("design");
    });
  };

  const uploadSource = (file: File) => {
    if (!project) return Promise.resolve();
    return run("uploading", async () => {
      const uploaded = await api.uploadAsset(project.project_id, file);
      setProject(uploaded.project);
      setDesign(null);
      setPlan(null);
      setBundle(null);
      setSendResult(null);
      setSvgBundle(null);
      setRasterPreview(null);
      setToolWorkspace("image");
    });
  };

  const fetchMapSnapshot = () => {
    const current = projectRef.current;
    if (!current) return Promise.resolve();
    return run("uploading", async () => {
      const saved = await api.patchProject(current.project_id, persistedChanges(current));
      setProject(saved);
      const started = await api.startOsmSnapshotDownload(
        saved.project_id,
        current.osm.selection.bounds,
      );
      setActiveJob(started);
      const completed = await api.watchJob(started.job_id, setActiveJob);
      if (completed.status === "cancelled") return;
      if (completed.status !== "succeeded") {
        throw new Error(completed.error ?? `Map download ended as ${completed.status}`);
      }
      setProject(await api.getProject(saved.project_id));
      setLastMapFetchUsedCache(completed.cache_hit);
      setDesign(null);
      setPlan(null);
      setBundle(null);
      setSendResult(null);
      setSvgBundle(null);
    });
  };

  const searchMapPlaces = (query: string) =>
    run("searching", async () => {
      const result = await api.searchOsmPlaces(query);
      setMapPlaces(result.results);
      setLastPlaceSearchUsedCache(result.cache_hit);
    });

  const reopenProject = (projectId = project?.project_id) => {
    if (!projectId) return Promise.resolve();
    return run("reopening", async () => {
      const reopened = await api.getProject(projectId);
      setProject(reopened);
      setToolWorkspace(
        reopened.mode.mode_id === "map.openstreetmap"
          ? "map"
          : reopened.mode.mode_id.startsWith("import.")
            ? "image"
            : "artwork",
      );
      setBundle(null);
      setSendResult(null);
      setSvgBundle(null);
      setRasterPreview(null);
      setDesign(null);
      setPlan(null);
      if (reopened.mode.mode_id === "import.raster") {
        try {
          setRasterPreview(await api.getRasterPreview(projectId));
        } catch {
          setRasterPreview(null);
        }
      }
      try {
        const [cachedDesign, cachedPlan] = await Promise.all([
          api.getDesign(projectId),
          api.getPlan(projectId),
        ]);
        setDesign(cachedDesign);
        setPlan(cachedPlan);
      } catch {
        setDesign(null);
        setPlan(null);
      }
      setViewerMode("design");
      setAppArea("editor");
    });
  };

  const renameProject = (projectId: string, name: string) =>
    run("saving", async () => {
      const renamed = await api.patchProject(projectId, { name });
      setRecentProjects((current) =>
        current.map((item) => (item.project_id === projectId ? renamed : item)),
      );
      setProject((current) =>
        current?.project_id === projectId
          ? { ...current, name: renamed.name, revision: renamed.revision }
          : current,
      );
    });

  const deleteProject = (projectId: string) =>
    run("deleting", async () => {
      await api.deleteProject(projectId);
      setRecentProjects((current) => current.filter((item) => item.project_id !== projectId));
      if (project?.project_id === projectId) {
        setProject(null);
        setDesign(null);
        setPlan(null);
        setBundle(null);
        setSvgBundle(null);
        setRasterPreview(null);
      }
    });

  const exportFiles = () => {
    if (!project || !plan || !profile) return Promise.resolve();
    return run("exporting", async () => {
      const validationError = validateProfile(profile, project.page);
      if (validationError) throw new Error(validationError);
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      const planned = await api.plan(project.project_id);
      const exported = await api.exportGcode(saved.project_id, profile);
      setProject(saved);
      setPlan(planned);
      setBundle(exported);
      setSendResult(null);
      setSelectedProgramFilename(
        exported.programs.some((program) => program.filename === "combined.nc")
          ? "combined.nc"
          : (exported.programs[0]?.filename ?? ""),
      );
      setViewerMode("reconstruction");
    });
  };

  const sendGcode = () => {
    if (!project || !plan || !profile || !bundle || !selectedProgramFilename) {
      return Promise.resolve();
    }
    const selectedProgram = bundle.programs.find(
      (program) => program.filename === selectedProgramFilename,
    );
    if (!selectedProgram) return Promise.resolve();
    const confirmed = window.confirm(
      `Send ${selectedProgram.filename} to the configured FluidNC machine?\n\n` +
        "The controller must be Idle. This queues real motion and cannot start from the current pen position yet.",
    );
    if (!confirmed) return Promise.resolve();
    return run("sending", async () => {
      const validationError = validateProfile(profile, project.page);
      if (validationError) throw new Error(validationError);
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      const planned = await api.plan(saved.project_id);
      const result = await api.sendGcode(saved.project_id, profile, selectedProgramFilename);
      setProject(saved);
      setPlan(planned);
      setSendResult(result);
    });
  };

  const exportSvg = () => {
    if (!project || !design) return Promise.resolve();
    return run("exporting", async () => {
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      const exported = await api.exportSvg(saved.project_id);
      setProject(saved);
      setSvgBundle(exported);
      downloadArchive(exported.archive_base64, "plotbox-svg-passes.zip");
    });
  };

  const applyPassChanges = () => {
    if (!project || !design) return Promise.resolve();
    return run("planning", async () => {
      const saved = await api.patchProject(project.project_id, persistedChanges(project));
      const planned = await api.plan(saved.project_id);
      setProject(saved);
      setPlan(planned);
      setBundle(null);
      setSendResult(null);
      setSvgBundle(null);
      setViewerMode("toolpath");
    });
  };

  const updatePass = (index: number, changes: Partial<PassSettings>) => {
    setProject((current) => {
      if (!current) return current;
      return {
        ...current,
        passes: current.passes.map((item, itemIndex) =>
          itemIndex === index ? { ...item, ...changes } : item,
        ),
      };
    });
  };

  const movePass = (index: number, direction: -1 | 1) => {
    setProject((current) => {
      if (!current) return current;
      const destination = index + direction;
      if (destination < 0 || destination >= current.passes.length) return current;
      const passes = [...current.passes];
      const selected = passes[index];
      const displaced = passes[destination];
      if (!selected || !displaced) return current;
      passes[index] = displaced;
      passes[destination] = selected;
      return { ...current, passes };
    });
  };

  const movePassTo = (source: number, destination: number) => {
    setProject((current) => {
      if (!current || source === destination) return current;
      const passes = [...current.passes];
      const [selected] = passes.splice(source, 1);
      if (!selected) return current;
      passes.splice(destination, 0, selected);
      return { ...current, passes };
    });
  };

  const layerIdsForPass = (plotPass: PassSettings): string[] => {
    if (plotPass.source_layer_ids?.length) return plotPass.source_layer_ids;
    return (
      design?.layers
        .filter((layer) => layer.semantic_role === plotPass.semantic_role)
        .map((layer) => layer.layer_id) ?? []
    );
  };

  const mergePass = (index: number) => {
    if (index <= 0) return;
    setProject((current) => {
      if (!current) return current;
      const previous = current.passes[index - 1];
      const selected = current.passes[index];
      if (!previous || !selected) return current;
      const merged = {
        ...previous,
        name: `${previous.name} + ${selected.name}`,
        source_layer_ids: [
          ...new Set([...layerIdsForPass(previous), ...layerIdsForPass(selected)]),
        ],
      };
      return {
        ...current,
        passes: current.passes
          .map((item, itemIndex) => (itemIndex === index - 1 ? merged : item))
          .filter((_, itemIndex) => itemIndex !== index),
      };
    });
  };

  const splitPass = (index: number) => {
    setProject((current) => {
      if (!current) return current;
      const selected = current.passes[index];
      if (!selected) return current;
      const layerIds = layerIdsForPass(selected);
      if (layerIds.length < 2) return current;
      const split = layerIds.map((layerId, layerIndex) => {
        const layer = design?.layers.find((item) => item.layer_id === layerId);
        return {
          ...selected,
          pass_id: `${selected.pass_id}-split-${layerIndex + 1}`,
          name: layer?.name ?? `${selected.name} ${layerIndex + 1}`,
          semantic_role: layer?.semantic_role ?? selected.semantic_role,
          preview_color: layer?.preview_color ?? selected.preview_color,
          source_layer_ids: [layerId],
        };
      });
      return {
        ...current,
        passes: [...current.passes.slice(0, index), ...split, ...current.passes.slice(index + 1)],
      };
    });
  };

  const previewDesign = useMemo<DesignDocument | null>(() => {
    if (!design || !project) return design;
    const layers = design.layers.map((layer) => {
      const plotPass = project.passes.find(
        (item) =>
          item.source_layer_ids?.includes(layer.layer_id) ||
          (!item.source_layer_ids?.length && item.semantic_role === layer.semantic_role),
      );
      return {
        ...layer,
        preview_color: showOverprint && plotPass ? plotPass.preview_color : layer.preview_color,
        visible:
          plotPass === undefined
            ? layer.visible
            : soloPassId !== null
              ? plotPass.pass_id === soloPassId
              : plotPass.visible,
      };
    });
    if (showOverprint) {
      layers.sort((first, second) => {
        const passIndex = (layerId: string) =>
          project.passes.findIndex((item) => (item.source_layer_ids ?? []).includes(layerId));
        return passIndex(first.layer_id) - passIndex(second.layer_id);
      });
    }
    return {
      ...design,
      layers,
    };
  }, [design, project, showOverprint, soloPassId]);

  const passDrawLength = (passId: string): number =>
    plan?.passes
      .find((item) => item.pass_id === passId)
      ?.ordered_paths.reduce(
        (passTotal, path) =>
          passTotal +
          path.points.slice(1).reduce((pathTotal, point, pointIndex) => {
            const previous = path.points[pointIndex];
            return previous
              ? pathTotal + Math.hypot(point.x - previous.x, point.y - previous.y)
              : pathTotal;
          }, 0),
        0,
      ) ?? 0;

  const page = project?.page ?? {
    schema_version: 1 as const,
    preset: "A3" as const,
    orientation: "landscape" as const,
    width_mm: 420,
    height_mm: 297,
    margin_mm: 10,
  };
  const busy = operation !== "idle";

  return (
    <main className={appArea === "editor" && project ? "app-shell workspace-active" : "app-shell"}>
      <header className="app-header">
        <div>
          <p className="eyebrow">LOCAL ARTWORK → VALIDATED FILES</p>
          <h1>Plotbox</h1>
        </div>
        <div className="header-actions">
          <nav className="app-navigation" aria-label="Main navigation">
            <button
              type="button"
              aria-current={appArea === "projects" ? "page" : undefined}
              onClick={() => setAppArea("projects")}
            >
              Projects
            </button>
            <button
              type="button"
              disabled={!project}
              aria-current={appArea === "editor" ? "page" : undefined}
              onClick={() => setAppArea("editor")}
            >
              Editor
            </button>
            <button
              type="button"
              aria-current={appArea === "plotter" ? "page" : undefined}
              onClick={() => setAppArea("plotter")}
            >
              Plotter setup
            </button>
          </nav>
          <div className={`connection ${connected ? "online" : ""}`} data-testid="connection-state">
            <span />
            {connected ? "API ready" : "Connecting…"}
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <strong>Action blocked</strong>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {appArea === "projects" ? (
        <ProjectList
          projects={recentProjects}
          activeProjectId={project?.project_id ?? null}
          connected={connected}
          busy={busy}
          onCreate={(name) => void createProject(name)}
          onOpen={(projectId) => void reopenProject(projectId)}
          onRename={(projectId, name) => void renameProject(projectId, name)}
          onDelete={(projectId) => void deleteProject(projectId)}
        />
      ) : appArea === "plotter" ? (
        <PlotterSetup />
      ) : !project ? (
        <section className="welcome-card">
          <h2>No project is open</h2>
          <button type="button" onClick={() => setAppArea("projects")}>
            Back to projects
          </button>
        </section>
      ) : (
        <>
          <section className="workspace">
            <aside className="panel controls-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">PROJECT RECIPE</p>
                  <h2>{project.name}</h2>
                </div>
                <span className="revision">r{project.revision}</span>
              </div>

              <nav className="tool-workspace-tabs" aria-label="Source mode">
                {(["artwork", "image", "map"] as const).map((workspace) => (
                  <button
                    type="button"
                    key={workspace}
                    aria-pressed={toolWorkspace === workspace}
                    onClick={() => {
                      setToolWorkspace(workspace);
                      if (workspace === "map") {
                        setDesign(null);
                        setPlan(null);
                        setBundle(null);
                        setProject({
                          ...project,
                          mode: {
                            ...project.mode,
                            mode_id: "map.openstreetmap",
                            version: "1.0.0",
                            parameter_schema_version: 1,
                            parameters: {},
                          },
                        });
                      }
                    }}
                  >
                    {workspace === "artwork"
                      ? "Generative"
                      : workspace === "image"
                        ? "Image import"
                        : "Mapping"}
                  </button>
                ))}
              </nav>

              <fieldset>
                <legend>Page</legend>
                <label>
                  Preset
                  <select value={project.page.preset} disabled>
                    <option>A3</option>
                  </select>
                </label>
                <div className="field-row">
                  <label>
                    Width mm
                    <input
                      aria-label="Page width"
                      type="number"
                      value={project.page.width_mm}
                      onChange={(event) =>
                        (() => {
                          setRasterPreview(null);
                          setProject({
                            ...project,
                            page: { ...project.page, width_mm: Number(event.target.value) },
                          });
                        })()
                      }
                    />
                  </label>
                  <label>
                    Height mm
                    <input
                      aria-label="Page height"
                      type="number"
                      value={project.page.height_mm}
                      onChange={(event) =>
                        (() => {
                          setRasterPreview(null);
                          setProject({
                            ...project,
                            page: { ...project.page, height_mm: Number(event.target.value) },
                          });
                        })()
                      }
                    />
                  </label>
                </div>
                <label>
                  Safe margin mm
                  <input
                    aria-label="Safe margin"
                    type="number"
                    value={project.page.margin_mm}
                    onChange={(event) =>
                      (() => {
                        setRasterPreview(null);
                        setProject({
                          ...project,
                          page: { ...project.page, margin_mm: Number(event.target.value) },
                        });
                      })()
                    }
                  />
                </label>
              </fieldset>

              {toolWorkspace === "artwork" && (
                <>
                  <ModeGallery
                    modes={modes.filter((mode) => mode.kind === "generator")}
                    activeModeId={project.mode.mode_id}
                    onSelect={(mode) => {
                      setDesign(null);
                      setPlan(null);
                      setBundle(null);
                      setProject({ ...project, mode });
                    }}
                  />
                  {activeMode && (
                    <GeneratedModeControls
                      manifest={activeMode}
                      settings={project.mode}
                      onChange={(mode) => {
                        setDesign(null);
                        setPlan(null);
                        setProject({ ...project, mode });
                      }}
                    />
                  )}
                </>
              )}

              {toolWorkspace === "image" &&
                (project.mode.mode_id === "import.svg" ? (
                  <fieldset>
                    <legend>SVG conversion</legend>
                    <p className="source-name">
                      {project.assets.find((item) => item.asset_id === project.source_asset_id)
                        ?.original_filename ?? "No SVG selected"}
                    </p>
                    <label>
                      Fill treatment
                      <select
                        aria-label="Fill treatment"
                        value={project.svg_import.fill_mode}
                        onChange={(event) =>
                          setProject({
                            ...project,
                            svg_import: {
                              ...project.svg_import,
                              fill_mode: event.target
                                .value as ProjectRecipe["svg_import"]["fill_mode"],
                            },
                          })
                        }
                      >
                        <option value="ignore">Ignore</option>
                        <option value="outline">Outline</option>
                        <option value="hatch">Hatch</option>
                        <option value="crosshatch">Crosshatch</option>
                      </select>
                    </label>
                    <label>
                      Stroke treatment
                      <select
                        aria-label="Stroke treatment"
                        value={project.svg_import.stroke_mode}
                        onChange={(event) =>
                          setProject({
                            ...project,
                            svg_import: {
                              ...project.svg_import,
                              stroke_mode: event.target
                                .value as ProjectRecipe["svg_import"]["stroke_mode"],
                            },
                          })
                        }
                      >
                        <option value="centerline">Centerline</option>
                        <option value="outline">Outline</option>
                        <option value="parallel">Parallel approximation</option>
                      </select>
                    </label>
                    <div className="field-row">
                      <label>
                        Hatch spacing
                        <input
                          aria-label="Hatch spacing"
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={project.svg_import.hatch_spacing_mm}
                          onChange={(event) =>
                            setProject({
                              ...project,
                              svg_import: {
                                ...project.svg_import,
                                hatch_spacing_mm: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Hatch angle
                        <input
                          aria-label="Hatch angle"
                          type="number"
                          value={project.svg_import.hatch_angle_degrees}
                          onChange={(event) =>
                            setProject({
                              ...project,
                              svg_import: {
                                ...project.svg_import,
                                hatch_angle_degrees: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                  </fieldset>
                ) : project.mode.mode_id === "import.raster" ? (
                  <>
                    <RasterControls
                      project={project}
                      onChange={(updated) => {
                        setRasterPreview(null);
                        setDesign(null);
                        setPlan(null);
                        setProject(updated);
                      }}
                    />
                    <RasterVectorControls
                      project={project}
                      onChange={(updated) => {
                        setDesign(null);
                        setPlan(null);
                        setProject(updated);
                      }}
                    />
                  </>
                ) : (
                  <p className="workspace-prompt">
                    Choose an SVG, PNG, or JPEG below to reveal its conversion tools.
                  </p>
                ))}

              {toolWorkspace === "map" && (
                <>
                  <MapControls
                    project={project}
                    busy={busy}
                    lastFetchUsedCache={lastMapFetchUsedCache}
                    places={mapPlaces}
                    lastPlaceSearchUsedCache={lastPlaceSearchUsedCache}
                    searchBusy={operation === "searching"}
                    onChange={(updated) => {
                      setDesign(null);
                      setPlan(null);
                      setBundle(null);
                      setProject(updated);
                    }}
                    onFetch={() => void fetchMapSnapshot()}
                    onSearch={(query) => void searchMapPlaces(query)}
                    onGenerate={() => void generateAndPlan()}
                  />
                  {activeJob && (
                    <JobProgress
                      job={activeJob}
                      onCancel={() => void api.cancelJob(activeJob.job_id)}
                    />
                  )}
                </>
              )}

              {toolWorkspace !== "map" && (
                <fieldset>
                  <legend>Source and quality</legend>
                  {toolWorkspace === "image" && (
                    <label className="file-button">
                      {operation === "uploading" ? "Storing source…" : "Choose SVG, PNG, or JPG"}
                      <input
                        aria-label="Choose source file"
                        type="file"
                        accept=".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg"
                        disabled={busy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadSource(file);
                        }}
                      />
                    </label>
                  )}
                  <label>
                    Quality
                    <select
                      aria-label="Generation quality"
                      value={project.mode.quality}
                      onChange={(event) =>
                        (() => {
                          setRasterPreview(null);
                          setProject({
                            ...project,
                            mode: {
                              ...project.mode,
                              quality: event.target.value as ProjectRecipe["mode"]["quality"],
                            },
                          });
                        })()
                      }
                    >
                      <option value="draft">Draft</option>
                      <option value="standard">Standard</option>
                      <option value="export">Export</option>
                    </select>
                  </label>
                  {toolWorkspace === "artwork" && activeMode && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDesign(null);
                        setPlan(null);
                        setProject({
                          ...project,
                          mode: {
                            ...project.mode,
                            seed: `${project.mode.seed.split("-r")[0]}-r${Date.now().toString(36)}`,
                          },
                        });
                      }}
                    >
                      Regenerate seed
                    </button>
                  )}
                  {project.mode.mode_id === "import.raster" ? (
                    <div className="action-row">
                      <button type="button" disabled={busy} onClick={() => void preprocessRaster()}>
                        {operation === "generating" ? "Working…" : "Preview raster preprocessing"}
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void generateAndPlan()}
                      >
                        {operation === "generating" ? "Vectorizing…" : "Vectorize and plan"}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="primary-button full"
                      type="button"
                      disabled={busy}
                      onClick={() => void generateAndPlan()}
                    >
                      {operation === "generating"
                        ? "Generating and planning…"
                        : project.mode.mode_id === "import.svg"
                          ? "Convert SVG"
                          : "Generate design"}
                    </button>
                  )}
                  {activeJob && (
                    <JobProgress
                      job={activeJob}
                      onCancel={() => void api.cancelJob(activeJob.job_id)}
                    />
                  )}
                </fieldset>
              )}

              {(design?.metadata.diagnostics?.length ?? 0) > 0 && (
                <section
                  className="diagnostics"
                  aria-label={
                    project.mode.mode_id === "map.openstreetmap"
                      ? "OSM map warnings"
                      : project.mode.mode_id === "import.raster"
                        ? "Raster vectorization warnings"
                        : "SVG import warnings"
                  }
                >
                  <strong>
                    {project.mode.mode_id === "map.openstreetmap"
                      ? "Map generation report"
                      : "Conversion report"}
                  </strong>
                  <ul>
                    {design?.metadata.diagnostics?.map((item) => (
                      <li key={`${item.code}-${item.element_id ?? ""}`}>{item.message}</li>
                    ))}
                  </ul>
                </section>
              )}
              {(rasterPreview?.warnings.length ?? 0) > 0 && (
                <section className="diagnostics" aria-label="Raster preprocessing warnings">
                  <strong>Preprocessing warnings</strong>
                  <ul>
                    {rasterPreview?.warnings.map((item) => (
                      <li key={item.code}>{item.message}</li>
                    ))}
                  </ul>
                </section>
              )}
              {plan && (
                <section
                  className={`plan-summary ${
                    plan.statistics.path_count === 0 ||
                    plan.warnings.some((warning) => warning.blocking)
                      ? "blocked"
                      : ""
                  }`}
                  aria-label="Plot plan summary"
                >
                  <div className="plan-summary-heading">
                    <strong>
                      {plan.statistics.path_count > 0 ? "Plot plan ready" : "Plot plan blocked"}
                    </strong>
                    <span>{plan.statistics.path_count.toLocaleString()} paths</span>
                  </div>
                  <p>
                    {plan.statistics.vertex_count.toLocaleString()} vertices ·{" "}
                    {plan.statistics.draw_length_mm.toFixed(1)} mm draw ·{" "}
                    {plan.statistics.estimated_seconds.toFixed(1)} s estimate
                  </p>
                  {Object.values(plan.removed_geometry).some((count) => count > 0) && (
                    <p>
                      Removed geometry: {plan.removed_geometry.non_finite_paths} non-finite,{" "}
                      {plan.removed_geometry.degenerate_paths} degenerate,{" "}
                      {plan.removed_geometry.short_paths} short,{" "}
                      {plan.removed_geometry.clipped_paths} clipped.
                    </p>
                  )}
                  {plan.warnings.length > 0 && (
                    <ul>
                      {plan.warnings.map((warning) => (
                        <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>
                      ))}
                    </ul>
                  )}
                  {plan.statistics.path_count > 0 && (
                    <button type="button" onClick={() => setViewerMode("toolpath")}>
                      Review toolpath and travel
                    </button>
                  )}
                </section>
              )}

              <div className="action-row">
                <button type="button" disabled={busy} onClick={() => void saveProject()}>
                  {operation === "saving" ? "Saving…" : "Save project"}
                </button>
                <button type="button" disabled={busy} onClick={() => void reopenProject()}>
                  {operation === "reopening" ? "Reopening…" : "Reopen"}
                </button>
              </div>
            </aside>

            <section className="viewer-column">
              <nav className="view-tabs" aria-label="Viewer mode">
                {(["design", "toolpath", "reconstruction"] as const).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    aria-pressed={viewerMode === mode}
                    disabled={
                      mode === "toolpath" ? !plan : mode === "reconstruction" ? !combined : false
                    }
                    onClick={() => setViewerMode(mode)}
                  >
                    {mode === "design"
                      ? "Design"
                      : mode === "toolpath"
                        ? "Toolpath + travel"
                        : "G-code reconstruction"}
                  </button>
                ))}
                <label className="travel-toggle">
                  <input
                    type="checkbox"
                    checked={showTravel}
                    onChange={(event) => setShowTravel(event.target.checked)}
                  />
                  Show pen-up travel
                </label>
                <label className="travel-toggle">
                  <input
                    aria-label="Preview physical pen overprint"
                    type="checkbox"
                    checked={showOverprint}
                    onChange={(event) => setShowOverprint(event.target.checked)}
                  />
                  Physical pen overprint
                </label>
                {rasterPreview && (
                  <label className="travel-toggle">
                    <input
                      aria-label="Show raster source overlay"
                      type="checkbox"
                      checked={showSourceOverlay}
                      onChange={(event) => setShowSourceOverlay(event.target.checked)}
                    />
                    Source before overlay
                  </label>
                )}
              </nav>
              <CanvasViewer
                page={page}
                mode={viewerMode}
                design={previewDesign}
                plan={plan}
                reconstructed={combined}
                rasterPreview={showSourceOverlay ? rasterPreview : null}
                showTravel={showTravel}
                overprint={showOverprint}
                renderToken={previewRenderToken}
                onRendered={completePreviewRender}
              />
              <div className="hash-strip">
                <span>
                  Design{" "}
                  <code data-testid="design-hash">
                    {shortHash(design?.metadata.normalized_sha256)}
                  </code>
                </span>
                <span>
                  PlotPlan <code data-testid="plan-hash">{shortHash(plan?.normalized_sha256)}</code>
                </span>
                <span>
                  Manifest{" "}
                  <code data-testid="manifest-hash">
                    {shortHash(bundle?.manifest.manifest_sha256)}
                  </code>
                </span>
                {rasterPreview && (
                  <span data-testid="raster-preview-stats">
                    Raster {rasterPreview.processed_width_px} × {rasterPreview.processed_height_px}{" "}
                    px ·{" "}
                    {Math.max(rasterPreview.mm_per_pixel_x, rasterPreview.mm_per_pixel_y).toFixed(
                      3,
                    )}{" "}
                    mm/px
                  </span>
                )}
              </div>
            </section>

            <aside className="panel passes-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">SEMANTIC → PHYSICAL</p>
                  <h2>Pen passes</h2>
                </div>
                <span className="count-badge">{project.passes.length}</span>
              </div>
              <div className="pass-list">
                {project.passes.map((plotPass, index) => {
                  const sourceLayer = design?.layers.find((layer) =>
                    (plotPass.source_layer_ids ?? []).includes(layer.layer_id),
                  );
                  const suggestedPen = sourceLayer?.semantic_role.startsWith("source-color-")
                    ? nearestPen(sourceLayer.preview_color, project.pen_palette)
                    : null;
                  return (
                    <article
                      className={`pass-card ${draggingPassIndex === index ? "dragging" : ""}`}
                      key={plotPass.pass_id}
                      draggable
                      onDragStart={() => setDraggingPassIndex(index)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => {
                        if (draggingPassIndex !== null) movePassTo(draggingPassIndex, index);
                        setDraggingPassIndex(null);
                      }}
                      onDragEnd={() => setDraggingPassIndex(null)}
                    >
                      <div className="pass-title">
                        <span style={{ background: plotPass.preview_color }} />
                        <strong>{plotPass.semantic_role}</strong>
                        <label className="switch">
                          <input
                            aria-label={`Enable ${plotPass.name}`}
                            type="checkbox"
                            checked={plotPass.enabled}
                            onChange={(event) =>
                              updatePass(index, { enabled: event.target.checked })
                            }
                          />
                        </label>
                      </div>
                      <label>
                        Physical pen
                        <select
                          aria-label={`${plotPass.semantic_role} physical pen`}
                          value={plotPass.pen_profile_id ?? ""}
                          onChange={(event) => {
                            const pen = project.pen_palette.find(
                              (item) => item.pen_id === event.target.value,
                            );
                            updatePass(index, {
                              pen_profile_id: pen?.pen_id ?? null,
                              name: pen?.name ?? plotPass.name,
                              preview_color: pen?.display_color ?? plotPass.preview_color,
                              draw_feed_mm_min: pen?.draw_feed_mm_min ?? plotPass.draw_feed_mm_min,
                              pen_down_override: pen?.pen_down_override ?? null,
                            });
                          }}
                        >
                          <option value="">Unassigned</option>
                          {project.pen_palette.map((pen) => (
                            <option key={pen.pen_id} value={pen.pen_id}>
                              {pen.name} · {pen.tip_width_mm} mm
                            </option>
                          ))}
                        </select>
                      </label>
                      {suggestedPen && suggestedPen.pen_id !== plotPass.pen_profile_id && (
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`Use suggested ${suggestedPen.name} for ${plotPass.semantic_role}`}
                          onClick={() =>
                            updatePass(index, {
                              pen_profile_id: suggestedPen.pen_id,
                              name: suggestedPen.name,
                              preview_color: suggestedPen.display_color,
                              draw_feed_mm_min:
                                suggestedPen.draw_feed_mm_min ?? plotPass.draw_feed_mm_min,
                              pen_down_override: suggestedPen.pen_down_override,
                            })
                          }
                        >
                          Suggested: {suggestedPen.name}
                        </button>
                      )}
                      <div className="pass-toggles">
                        <label>
                          <input
                            aria-label={`Preview ${plotPass.name}`}
                            type="checkbox"
                            checked={plotPass.visible}
                            onChange={(event) =>
                              updatePass(index, { visible: event.target.checked })
                            }
                          />
                          Preview
                        </label>
                        <label>
                          <input
                            aria-label={`Solo ${plotPass.name}`}
                            type="checkbox"
                            checked={soloPassId === plotPass.pass_id}
                            onChange={(event) =>
                              setSoloPassId(event.target.checked ? plotPass.pass_id : null)
                            }
                          />
                          Solo
                        </label>
                      </div>
                      <label>
                        Pen name
                        <input
                          aria-label={`${plotPass.semantic_role} pen name`}
                          value={plotPass.name}
                          onChange={(event) => updatePass(index, { name: event.target.value })}
                        />
                      </label>
                      <div className="field-row compact">
                        <label>
                          Preview
                          <input
                            aria-label={`${plotPass.name} preview color`}
                            type="color"
                            value={plotPass.preview_color}
                            onChange={(event) =>
                              updatePass(index, { preview_color: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Draw feed
                          <input
                            aria-label={`${plotPass.name} draw feed`}
                            type="number"
                            value={plotPass.draw_feed_mm_min}
                            onChange={(event) =>
                              updatePass(index, { draw_feed_mm_min: Number(event.target.value) })
                            }
                          />
                        </label>
                      </div>
                      <div className="order-buttons">
                        <button
                          type="button"
                          aria-label={`Move ${plotPass.name} earlier`}
                          disabled={index === 0}
                          onClick={() => movePass(index, -1)}
                        >
                          ↑ Earlier
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${plotPass.name} later`}
                          disabled={index === project.passes.length - 1}
                          onClick={() => movePass(index, 1)}
                        >
                          ↓ Later
                        </button>
                      </div>
                      <div className="order-buttons pass-structure-actions">
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => mergePass(index)}
                        >
                          Merge ↑
                        </button>
                        <button
                          type="button"
                          disabled={layerIdsForPass(plotPass).length < 2}
                          onClick={() => splitPass(index)}
                        >
                          Split layers
                        </button>
                      </div>
                      {plan?.passes.find((item) => item.pass_id === plotPass.pass_id) && (
                        <p className="pass-statistics">
                          {
                            plan.passes.find((item) => item.pass_id === plotPass.pass_id)
                              ?.ordered_paths.length
                          }{" "}
                          paths ·{" "}
                          {plan.passes
                            .find((item) => item.pass_id === plotPass.pass_id)
                            ?.ordered_paths.reduce(
                              (total, path) => total + Math.max(0, path.points.length - 1),
                              0,
                            )}{" "}
                          segments · {passDrawLength(plotPass.pass_id).toFixed(1)} mm
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>

              <button
                className="secondary-button full"
                type="button"
                disabled={!design || busy}
                onClick={() => void applyPassChanges()}
              >
                {operation === "planning" ? "Replanning…" : "Apply pass changes"}
              </button>

              {profile && (
                <fieldset className="profile-form">
                  <legend>FluidNC Z-axis profile</legend>
                  <div className="field-row">
                    <label>
                      Work width
                      <input
                        aria-label="Work width"
                        type="number"
                        value={profile.work_width_mm}
                        onChange={(event) =>
                          setProfile({ ...profile, work_width_mm: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label>
                      Work height
                      <input
                        aria-label="Work height"
                        type="number"
                        value={profile.work_height_mm}
                        onChange={(event) =>
                          setProfile({ ...profile, work_height_mm: Number(event.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <div className="field-row">
                    <label>
                      Z up
                      <input
                        aria-label="Z up"
                        type="number"
                        value={profile.pen_actuator.up_mm}
                        onChange={(event) =>
                          setProfile({
                            ...profile,
                            pen_actuator: {
                              ...profile.pen_actuator,
                              up_mm: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Z down
                      <input
                        aria-label="Z down"
                        type="number"
                        value={profile.pen_actuator.down_mm}
                        onChange={(event) =>
                          setProfile({
                            ...profile,
                            pen_actuator: {
                              ...profile.pen_actuator,
                              down_mm: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="field-row">
                    <label>
                      Travel feed
                      <input
                        aria-label="Travel feed"
                        type="number"
                        value={profile.motion.travel_feed_mm_min}
                        onChange={(event) =>
                          setProfile({
                            ...profile,
                            motion: {
                              ...profile.motion,
                              travel_feed_mm_min: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Precision
                      <input
                        aria-label="Precision"
                        type="number"
                        value={profile.precision_decimals}
                        onChange={(event) =>
                          setProfile({
                            ...profile,
                            precision_decimals: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Combined pass pause
                    <input
                      aria-label="Combined pass pause"
                      value={profile.macros.pause}
                      onChange={(event) =>
                        setProfile({
                          ...profile,
                          macros: { ...profile.macros, pause: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={profile.park.enabled}
                      onChange={(event) =>
                        setProfile({
                          ...profile,
                          park: { ...profile.park, enabled: event.target.checked },
                        })
                      }
                    />
                    Park before pen change
                  </label>
                </fieldset>
              )}

              <button
                className="export-button"
                type="button"
                disabled={!plan || !profile || busy}
                onClick={() => void exportFiles()}
              >
                {operation === "exporting" ? "Parsing and validating…" : "Export validated bundle"}
              </button>
              <button
                className="secondary-button full svg-export-button"
                type="button"
                disabled={!design || busy}
                onClick={() => void exportSvg()}
              >
                Export SVG pass bundle
              </button>
              {svgBundle && (
                <p className="field-help">
                  Exported {svgBundle.entries.length} SVG files from the unchanged design geometry.
                </p>
              )}
              {bundle && (
                <div className="export-result" data-testid="export-result">
                  <strong>Round trip verified</strong>
                  <span>
                    {bundle.manifest.entries.length} G-code files · tolerance{" "}
                    {bundle.manifest.round_trip_tolerance_mm} mm
                  </span>
                  <button
                    type="button"
                    onClick={() => downloadArchive(bundle.archive_base64, "plotbox-a3-gcode.zip")}
                  >
                    Download .zip
                  </button>
                  <label>
                    Validated file to send
                    <select
                      aria-label="Validated file to send"
                      value={selectedProgramFilename}
                      disabled={busy}
                      onChange={(event) => setSelectedProgramFilename(event.target.value)}
                    >
                      {bundle.programs.map((program) => (
                        <option key={program.filename} value={program.filename}>
                          {program.filename}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="field-help">
                    Sent files are regenerated and round-trip validated again. The configured
                    controller must report Idle; acceptance means queued, not physically complete.
                  </p>
                  <p className="field-help">
                    Placement currently uses the machine work origin. Starting from the current pen
                    position and calibrated work-origin selection are the next safety controls.
                  </p>
                  <button
                    className="send-button"
                    type="button"
                    disabled={busy || !selectedProgramFilename}
                    onClick={() => void sendGcode()}
                  >
                    {operation === "sending" ? "Sending to FluidNC…" : "Send to configured FluidNC"}
                  </button>
                  {sendResult && (
                    <div
                      className={sendResult.success ? "send-result" : "send-result failed"}
                      role="status"
                    >
                      <strong>
                        {sendResult.success ? "Program accepted" : "Controller rejected program"}
                      </strong>
                      <span>
                        {sendResult.accepted_command_count} / {sendResult.command_count} commands
                        accepted
                      </span>
                      <code>{shortHash(sendResult.sha256)}</code>
                    </div>
                  )}
                  <ul>
                    {bundle.manifest.entries.map((entry) => (
                      <li key={entry.filename}>
                        <span>{entry.filename}</span>
                        <code>{entry.sha256.slice(0, 9)}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </section>

          <footer className="statistics-bar">
            <span>
              <strong>{plan?.statistics.path_count ?? 0}</strong> paths
            </span>
            <span>
              <strong>{plan?.statistics.vertex_count ?? 0}</strong> vertices
            </span>
            <span>
              <strong>{plan?.statistics.draw_length_mm.toFixed(1) ?? "0.0"}</strong> mm draw
            </span>
            <span>
              <strong>{plan?.statistics.travel_length_mm.toFixed(1) ?? "0.0"}</strong> mm travel
            </span>
            <span>
              <strong>{plan?.statistics.lift_count ?? 0}</strong> lifts
            </span>
            <span>
              <strong>{plan?.statistics.estimated_seconds.toFixed(1) ?? "0.0"}</strong> s estimate
            </span>
            <span className={plan?.warnings.some((warning) => warning.blocking) ? "warn" : "valid"}>
              {plan?.warnings.length ?? 0} warnings
            </span>
          </footer>
        </>
      )}
    </main>
  );
}
