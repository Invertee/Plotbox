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
    key: "single_line_ink_density",
    label: "Single-line ink density",
    minimum: 0.25,
    maximum: 2,
    step: 0.05,
    help: "At 1, line density follows image tone and the selected pen width. Increase to deepen shadows; decrease for a lighter drawing.",
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
    help: "Leave areas lighter than this threshold unshaded. The continuous line may still pass through them.",
  },
  {
    key: "single_line_edge_bias",
    label: "Single-line edge detail",
    minimum: 0,
    maximum: 2,
    step: 0.1,
    help: "Use smaller routing regions around tonal edges to preserve facial features and fine detail.",
  },
  {
    key: "arc_min_radius_mm",
    label: "Arc dark radius",
    minimum: 0.1,
    maximum: 5,
    step: 0.1,
    help: "Radius of shadow loops in millimetres. Very small loops are enlarged to suit the selected pen width.",
  },
  {
    key: "arc_max_radius_mm",
    label: "Arc light radius",
    minimum: 0.1,
    maximum: 12,
    step: 0.1,
    help: "Largest radius of lighter loops in millimetres. Lower this to preserve small features; loops fade out in highlights.",
  },
  {
    key: "arc_overlap",
    label: "Arc overlap",
    minimum: 0,
    maximum: 1,
    step: 0.05,
    help: "Higher values pack loops closer together so shadows can become nearly solid. Density also adapts to image tone and pen width.",
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
            ? "One continuous line fills the image with overlapping arcs. Shadow coverage follows image tone and pen width, with smaller loops in dark areas."
            : "One continuous, non-crossing route uses closely spaced marks in shadows and wider spacing in highlights. Optional smoothing rounds the corners."}
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
          : " Set the pen width to match your actual pen. Dense drawings automatically reduce fine detail if needed to finish the whole image."}
      </p>
    </div>
  );
}
