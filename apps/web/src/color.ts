import type { PenProfile } from "./types";

interface LabColor {
  lightness: number;
  a: number;
  b: number;
}

function hexToRgb(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match?.[1]) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function rgbToLab(rgb: [number, number, number]): LabColor {
  const linear = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const red = linear[0]!;
  const green = linear[1]!;
  const blue = linear[2]!;
  const pivot = (value: number) => {
    const delta = 6 / 29;
    return value > delta ** 3 ? Math.cbrt(value) : value / (3 * delta ** 2) + 4 / 29;
  };
  const x = pivot((0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047);
  const y = pivot(0.2126729 * red + 0.7151522 * green + 0.072175 * blue);
  const z = pivot((0.0193339 * red + 0.119192 * green + 0.9503041 * blue) / 1.08883);
  return { lightness: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

export function nearestPen(sourceColor: string, pens: PenProfile[]): PenProfile | null {
  const sourceRgb = hexToRgb(sourceColor);
  if (!sourceRgb) return null;
  const source = rgbToLab(sourceRgb);
  const candidates = pens
    .map((pen) => {
      const rgb = hexToRgb(pen.display_color);
      if (!rgb) return null;
      const candidate = rgbToLab(rgb);
      const distance = Math.hypot(
        source.lightness - candidate.lightness,
        source.a - candidate.a,
        source.b - candidate.b,
      );
      return { pen, distance };
    })
    .filter((item): item is { pen: PenProfile; distance: number } => item !== null);
  candidates.sort(
    (first, second) =>
      first.distance - second.distance || first.pen.pen_id.localeCompare(second.pen.pen_id),
  );
  return candidates[0]?.pen ?? null;
}
