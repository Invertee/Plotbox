import { useId, type InputHTMLAttributes } from "react";

function controlHelp(label: string): string {
  const name = label.toLowerCase();
  const hints: [RegExp, string][] = [
    [/crop [xy]/, "Move the crop origin as a fraction of the source image."],
    [/crop (width|height)/, "Set the fraction of the source image included in the crop."],
    [/gamma/, "Adjust midtone brightness while retaining black and white endpoints."],
    [/contrast/, "Increase the difference between light and dark areas."],
    [/blur/, "Soften image detail before conversion. Larger values remove more fine texture."],
    [/sharpen/, "Emphasize image edges before conversion."],
    [
      /threshold window|local radius/,
      "Set the neighbourhood size used to measure local image tone.",
    ],
    [/threshold offset/, "Shift the local threshold to include more or fewer dark features."],
    [
      /threshold|minimum darkness/,
      "Set the tone cutoff that decides which image areas produce marks.",
    ],
    [/morphology radius/, "Set the pixel radius used to remove specks or close small gaps."],
    [
      /samples per pen/,
      "Increase sampling detail relative to pen width; higher values take longer to process.",
    ],
    [/megapixels/, "Limit preview resolution and memory use; higher values retain more detail."],
    [/scale/, "Adjust the size of the artwork relative to its fitted placement."],
    [/angle/, "Rotate the direction of the generated marks in degrees."],
    [/spacing|gap/, "Set the distance between marks. Smaller values create a denser drawing."],
    [/thickness|pen width/, "Set the physical pen stroke width in millimetres."],
    [/minimum.*(size|loop)/, "Set the smallest generated mark size in millimetres."],
    [/maximum.*(size|loop)|largest loop/, "Set the largest generated mark size in millimetres."],
    [/density/, "Adjust how many marks are placed in the corresponding tone region."],
    [/amplitude/, "Set how far each wave moves away from its centre line."],
    [/wavelength/, "Set the distance between successive wave peaks in millimetres."],
    [
      /component|prune|segment length/,
      "Remove features shorter or smaller than this limit to reduce tiny plot movements.",
    ],
    [
      /passes|color count|colour passes|contour levels/,
      "Set the number of tone or colour groups available for separate pen passes.",
    ],
    [/margin/, "Reserve a clear border around the page in millimetres."],
    [/page width|page height/, "Set the physical page dimension in millimetres."],
    [/feed|speed/, "Set the movement speed for this operation."],
    [
      /budget|vertices|paths/,
      "Limit generated geometry to control processing time and output size.",
    ],
  ];
  return (
    hints.find(([pattern]) => pattern.test(name))?.[1] ??
    `Adjust ${label.toLowerCase()} within the supported limits.`
  );
}

/** Version 0.3.2 — preserve numeric inputs only when no finite range is defined. */
export function NumericInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const bounded =
    props.type === "number" &&
    props.min !== undefined &&
    props.max !== undefined &&
    Number.isFinite(Number(props.min)) &&
    Number.isFinite(Number(props.max));
  if (!bounded) return <input {...props} />;
  const help = props.title || controlHelp(props["aria-label"] || "value");
  return (
    <span className="slider-control">
      <span className="slider-track">
        <input
          {...props}
          type="range"
          title={help}
          aria-describedby={[props["aria-describedby"], id].filter(Boolean).join(" ")}
          step={props.step ?? 1}
        />
        <span className="slider-value" aria-hidden="true">
          {props.value}
        </span>
      </span>
      <span id={id} role="tooltip" className="slider-tooltip">
        {help}
      </span>
    </span>
  );
}
