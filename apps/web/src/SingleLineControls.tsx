import { NumericInput } from "./NumericInput";
import type { ProjectRecipe } from "./types";

type Settings = ProjectRecipe["raster_vectorize"];
const controls = [
  {
    key: "spiral_spacing_mm",
    label: "Spiral turn spacing",
    minimum: 0.5,
    maximum: 12,
    step: 0.1,
    help: "Distance between turns in millimetres. Smaller spacing adds more detail and drawing time.",
  },
  {
    key: "spiral_amplitude_mm",
    label: "Spiral wave height",
    minimum: 0,
    maximum: 5,
    step: 0.1,
    help: "Maximum radial wave height in millimetres. Automatically limited to 45% of turn spacing.",
  },
  {
    key: "spiral_wavelength_mm",
    label: "Spiral wavelength",
    minimum: 1,
    maximum: 30,
    step: 0.5,
    help: "Length of a wave in light areas. Smaller values make finer ripples.",
  },
  {
    key: "spiral_frequency_gain",
    label: "Spiral dark frequency",
    minimum: 0,
    maximum: 12,
    step: 0.5,
    help: "Increase wave frequency in darker areas to build up shading.",
  },
  {
    key: "single_line_point_count",
    label: "Single-line point count",
    minimum: 100,
    maximum: 4000,
    step: 100,
    help: "Number of image-weighted route points. More points improve detail and take longer to optimize.",
  },
  {
    key: "single_line_gamma",
    label: "Single-line tone gamma",
    minimum: 0.2,
    maximum: 3,
    step: 0.1,
    help: "Higher values concentrate marks in the darkest tones; lower values include more midtones.",
  },
  {
    key: "single_line_min_darkness",
    label: "Single-line minimum darkness",
    minimum: 0,
    maximum: 1,
    step: 0.01,
    help: "Ignore route points in areas lighter than this darkness threshold.",
  },
  {
    key: "single_line_edge_bias",
    label: "Single-line edge detail",
    minimum: 0,
    maximum: 2,
    step: 0.1,
    help: "Place extra route points near changes in tone to preserve image features.",
  },
  {
    key: "arc_min_radius_mm",
    label: "Arc dark radius",
    minimum: 0.1,
    maximum: 5,
    step: 0.1,
    help: "Radius of the smaller, tighter loops used in dark areas, in millimetres.",
  },
  {
    key: "arc_max_radius_mm",
    label: "Arc light radius",
    minimum: 0.1,
    maximum: 12,
    step: 0.1,
    help: "Radius of the larger overlapping loops used in light areas, in millimetres.",
  },
  {
    key: "arc_loop_spacing_mm",
    label: "Arc loop spacing",
    minimum: 0.5,
    maximum: 12,
    step: 0.1,
    help: "Travel per loop in light areas. Dark areas use one tenth of this spacing for tighter shading.",
  },
  {
    key: "tsp_smoothing",
    label: "TSP corner smoothing",
    minimum: 0,
    maximum: 1,
    step: 0.05,
    help: "Round angular turns into curves. Rounding is reduced when necessary to keep the line from crossing itself.",
  },
] as const;

export function SingleLineControls({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (changes: Partial<Settings>) => void;
}) {
  const spiral = settings.algorithm === "spiral-wave";
  const arcs = settings.algorithm === "arc-scribble";
  return (
    <div className="single-line-controls">
      <p className="field-help">
        {spiral
          ? "One spiral grows from the centre. Darker areas create stronger, faster waves. The image is fitted inside a circular drawing."
          : arcs
            ? "One image-guided line creates overlapping loops. Dark regions use smaller, more tightly packed arcs."
            : "One continuous route visits tone-weighted points. Crossings are removed before optional corner rounding."}
      </p>
      {controls
        .filter(
          ({ key }) =>
            key === "single_line_gamma" ||
            (spiral
              ? key.startsWith("spiral_")
              : key.startsWith("single_line_") ||
                (arcs ? key.startsWith("arc_") : key === "tsp_smoothing")),
        )
        .map((control) => (
          <label key={control.key}>
            {control.label}
            <NumericInput
              type="number"
              aria-label={control.label}
              title={control.help}
              min={
                control.key === "arc_max_radius_mm" ? settings.arc_min_radius_mm : control.minimum
              }
              max={
                control.key === "arc_min_radius_mm" ? settings.arc_max_radius_mm : control.maximum
              }
              step={control.step}
              value={settings[control.key]}
              onChange={(event) => onChange({ [control.key]: Number(event.target.value) })}
            />
          </label>
        ))}
      <p className="field-help">
        Use preprocessing contrast and gamma for broad tone correction, then select Vectorize and
        plan.
        {spiral
          ? " Increase turn spacing if the drawing is too dense."
          : " Higher point counts take longer to optimize."}
      </p>
    </div>
  );
}
