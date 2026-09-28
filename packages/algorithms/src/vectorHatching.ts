import type { Point, SourcePath } from '@plotter/core';

/** Even/odd scanline fill, shared by vector layers and coloured city glyphs. */
export function hatchSourcePath(source: SourcePath, angleDegrees: number, spacing: number): Point[][] {
  if (!source.closed || source.points.length < 3 || !Number.isFinite(spacing) || spacing <= 0) return [];
  const angle = angleDegrees * Math.PI / 180;
  const rotate = (p: Point, a: number): Point => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
  const rotated = source.points.map(p => rotate(p, -angle));
  const minY = Math.min(...rotated.map(p => p.y)), maxY = Math.max(...rotated.map(p => p.y));
  const lines: Point[][] = [];
  for (let y = Math.ceil(minY / spacing) * spacing; y <= maxY; y += spacing) {
    const intersections: number[] = [];
    for (let i = 0; i < rotated.length; i++) {
      const a = rotated[i]!, b = rotated[(i + 1) % rotated.length]!;
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) intersections.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) lines.push([rotate({ x: intersections[i]!, y }, angle), rotate({ x: intersections[i + 1]!, y }, angle)]);
  }
  return lines;
}
