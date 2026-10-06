import type { PlotGeometry, PlotPath, Point } from '@plotter/core';
import type { Bounds } from '@plotter/geometry';

type Settings = Record<string, number | string | boolean>;
type Pass = { id: string; penWidth: number };
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** Dense, independent two-point strokes. Image tone determines coverage, while
 * local gradients turn strokes along boundaries instead of across them. */
export function generateStraightLinePortrait(
  bounds: Bounds,
  settings: Settings,
  sample: (x: number, y: number) => number,
  primary: Pass,
  definition?: Pass,
  onProgress?: (value: number) => void,
): PlotGeometry {
  const result: PlotGeometry = { generator: 'raster.straight-lines', generatedAt: new Date().toISOString(), paths: [] };
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (![bounds.minX, bounds.minY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return result;
  const setting = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(settings[key] ?? fallback);
    return clamp(Number.isFinite(value) ? value : fallback, min, max);
  };
  const detail = setting('detailSize', 0.7, 0.35, 2);
  const lineLength = setting('lineLength', 2.8, 0.5, 10);
  const density = setting('lineDensity', 1.2, 0.2, 3);
  const tonePower = setting('tonePower', 1, 0.5, 2.5);
  const definitionStrength = setting('definitionStrength', 0.8, 0.2, 2);
  const paperCutoff = setting('paperCutoff', 245, 180, 255);
  const seedValue = setting('seed', 482923, 1, 999999) >>> 0;
  const columns = Math.max(1, Math.ceil(width / detail));
  const rows = Math.max(1, Math.ceil(height / detail));
  if (columns * rows > 1_000_000) throw new Error('This sheet is too large for Straight lines at the selected Fine detail size. Increase Fine detail size.');
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const cellArea = cellWidth * cellHeight;
  const maxPaths = 250_000;

  const pass = (target: Pass, overlay: boolean, progressOffset: number, progressScale: number) => {
    let seed = (seedValue ^ (overlay ? 0x9e3779b9 : 0)) >>> 0;
    const random = () => {
      seed += 0x6d2b79f5;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const penWidth = clamp(Number.isFinite(target.penWidth) ? target.penWidth : 0.3, 0.05, 2);
    const probe = Math.max(0.2, detail * 0.6);
    const brightness = (x: number, y: number) => clamp(sample(x, y), 0, 255);
    const edgeAt = (x: number, y: number) => {
      const gx = brightness(Math.min(bounds.maxX, x + probe), y) - brightness(Math.max(bounds.minX, x - probe), y);
      const gy = brightness(x, Math.min(bounds.maxY, y + probe)) - brightness(x, Math.max(bounds.minY, y - probe));
      return { gx, gy, strength: clamp(Math.hypot(gx, gy) / 100) };
    };
    const clippedEnd = (x: number, y: number, dx: number, dy: number, distance: number): Point => {
      const step = Math.min(0.2, detail / 3);
      let previous = 0;
      for (let travel = step; travel <= distance + step; travel += step) {
        const current = Math.min(distance, travel);
        const px = x + dx * current;
        const py = y + dy * current;
        if (px < bounds.minX || px > bounds.maxX || py < bounds.minY || py > bounds.maxY || brightness(px, py) >= paperCutoff) {
          let lo = previous;
          let hi = current;
          for (let i = 0; i < 5; i++) {
            const middle = (lo + hi) / 2;
            const mx = x + dx * middle;
            const my = y + dy * middle;
            if (mx >= bounds.minX && mx <= bounds.maxX && my >= bounds.minY && my <= bounds.maxY && brightness(mx, my) < paperCutoff) lo = middle;
            else hi = middle;
          }
          return { x: clamp(x + dx * lo, bounds.minX, bounds.maxX), y: clamp(y + dy * lo, bounds.minY, bounds.maxY) };
        }
        previous = current;
        if (current === distance) break;
      }
      return { x: clamp(x + dx * distance, bounds.minX, bounds.maxX), y: clamp(y + dy * distance, bounds.minY, bounds.maxY) };
    };

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = bounds.minX + (column + random()) * cellWidth;
        const y = bounds.minY + (row + random()) * cellHeight;
        const value = brightness(x, y);
        if (value >= paperCutoff) continue;
        const tone = Math.pow(clamp((paperCutoff - value) / paperCutoff), tonePower);
        const edge = edgeAt(x, y);
        // The overprint favours both deep shadows and high contrast details.
        const weight = overlay ? clamp(tone * tone * 0.8 + tone * edge.strength * 0.45) : tone;
        const coverage = -Math.log(Math.max(0.04, 1 - weight * 0.94));
        const expected = coverage * cellArea * density * (overlay ? definitionStrength : 1) * 0.6 / (penWidth * lineLength);
        const count = Math.floor(expected) + (random() < expected % 1 ? 1 : 0);
        for (let index = 0; index < count; index++) {
          const cx = clamp(x + (random() - 0.5) * cellWidth, bounds.minX, bounds.maxX);
          const cy = clamp(y + (random() - 0.5) * cellHeight, bounds.minY, bounds.maxY);
          if (brightness(cx, cy) >= paperCutoff) continue;
          const gradient = edgeAt(cx, cy);
          const aligned = random() < gradient.strength * (overlay ? 0.95 : 0.75);
          const angle = aligned ? Math.atan2(gradient.gy, gradient.gx) + Math.PI / 2 + (random() - 0.5) * 0.65 : random() * Math.PI;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          const half = lineLength * (0.35 + random() * 1.1) / 2;
          const start = clippedEnd(cx, cy, -dx, -dy, half);
          const end = clippedEnd(cx, cy, dx, dy, half);
          if (Math.hypot(end.x - start.x, end.y - start.y) < Math.max(0.12, penWidth * 0.6)) continue;
          const points = [start, end].map(point => ({ x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 }));
          const path: PlotPath = { id: `straight-lines-${result.paths.length}`, points, passId: target.id, layerId: 'layer-1', channel: overlay ? 'definition' : 'primary', preserveGaps: true };
          result.paths.push(path);
          if (result.paths.length > maxPaths) throw new Error('Straight lines exceeds 250,000 strokes. Reduce Lines or increase Fine detail size or pen width.');
        }
      }
      if (row % 16 === 0) onProgress?.(progressOffset + progressScale * row / rows);
    }
  };

  pass(primary, false, 0, definition ? 0.55 : 1);
  if (definition && definition.id !== primary.id) pass(definition, true, 0.55, 0.45);
  onProgress?.(1);
  return result;
}
