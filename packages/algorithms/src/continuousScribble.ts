import type { PlotGeometry, Point } from '@plotter/core';
import type { Bounds } from '@plotter/geometry';

type Settings = Record<string, number | string | boolean>;
type Anchor = Point & { tone: number; radius: number; order: number };
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const TAU = Math.PI * 2;

// Locality ordering only: no cells are drawn, and no loop stops at an anchor.
function hilbertOrder(x: number, y: number): number {
  let order = 0;
  for (let scale = 32768; scale > 0; scale >>= 1) {
    const rx = (x & scale) > 0 ? 1 : 0;
    const ry = (y & scale) > 0 ? 1 : 0;
    order += scale * scale * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = 65535 - x; y = 65535 - y; }
      [x, y] = [y, x];
    }
  }
  return order;
}

/** One drifting, continuously rotating curve over a tone-weighted point cloud.
 * Sparse coverage anchors keep highlights drawn. Additional stochastic anchors
 * follow the full-resolution tone field; they never quantise it into tile sizes.
 */
export function generateContinuousScribble(
  bounds: Bounds, settings: Settings, sample: (x: number, y: number) => number,
  passId = 'pass-1', onProgress?: (value: number) => void,
): PlotGeometry {
  const result: PlotGeometry = { generator: 'raster.continuous-scribble', generatedAt: new Date().toISOString(), paths: [] };
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (![width, height, bounds.minX, bounds.minY].every(Number.isFinite) || width <= 0 || height <= 0) return result;
  const setting = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(settings[key] ?? fallback);
    return clamp(Number.isFinite(value) ? value : fallback, min, max);
  };
  const detail = setting('detailSize', 0.8, 0.25, 3);
  const looseSize = Math.max(detail * 2, setting('highlightSize', 3.5, 1, 10));
  const density = setting('shadowDensity', 1.5, 0.5, 4);
  const power = setting('tonePower', 1, 0.35, 3);
  const edgeSensitivity = setting('detailSensitivity', 0.15, 0.03, 0.5);
  const curveStep = setting('curveStep', 0.18, 0.05, 0.5);
  const penWidth = setting('penWidth', 0.3, 0.03, 2);
  const skipWhite = settings.skipWhite === true;
  // Apply the mask to preprocessed brightness, independently of tone response.
  const hasInk = (x: number, y: number) => sample(x, y) < 240;
  let seed = setting('seed', 482923, 1, 999999) >>> 0;
  const random = () => {
    seed += 0x6d2b79f5;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const toneAt = (x: number, y: number) => {
    const value = sample(clamp(x, bounds.minX, bounds.maxX), clamp(y, bounds.minY, bounds.maxY));
    return Number.isFinite(value) ? Math.pow(clamp(1 - value / 255), power) : 0;
  };
  // At least two samples across the requested feature size; no tone pyramid.
  const columns = Math.max(1, Math.ceil(width / (detail * 0.5)));
  const rows = Math.max(1, Math.ceil(height / (detail * 0.5)));
  if (columns * rows > 4_000_000) throw new Error('This sheet is too large for the selected detail size. Increase Fine detail size.');
  const anchors: Anchor[] = [];
  const radiusAt = (x: number, y: number, tone: number) => {
    let radius = (looseSize * (1 - tone) ** 2 + detail * tone) * 0.5;
    // Probe the orbit and shrink near tonal boundaries, keeping highlights from
    // flooding dark details and keeping dense shadow loops inside silhouettes.
    let contrast = 0;
    for (let k = 0; k < 8; k++) {
      const angle = k * TAU / 8;
      contrast = Math.max(contrast, Math.abs(tone - toneAt(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)));
    }
    radius *= 1 - 0.8 * clamp(contrast / edgeSensitivity);
    return Math.max(detail * 0.18, penWidth * 0.6, radius);
  };
  const addAnchor = (x: number, y: number, tone: number, radius = radiusAt(x, y, tone)) => {
    if (skipWhite && !hasInk(x, y)) return;
    anchors.push({ x, y, tone, radius, order: hilbertOrder(Math.floor((x - bounds.minX) / width * 65535), Math.floor((y - bounds.minY) / height * 65535)) });
  };
  // Jittered coverage has a bounded gap even in completely white images.
  const coverageX = Math.max(1, Math.ceil(width / (looseSize * 1.15)));
  const coverageY = Math.max(1, Math.ceil(height / (looseSize * 1.15)));
  for (let y = 0; y < coverageY; y++) for (let x = 0; x < coverageX; x++) {
    const px = bounds.minX + (x + 0.15 + random() * 0.7) / coverageX * width;
    const py = bounds.minY + (y + 0.15 + random() * 0.7) / coverageY * height;
    addAnchor(px, py, toneAt(px, py));
  }
  const cellArea = width * height / (columns * rows);
  // Optical density estimates the line length needed for the selected pen.
  // Highlights have their own coverage floor, so this field adds shadow ink only.
  const inkScale = density * 0.75 / penWidth;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const px = bounds.minX + (x + random()) / columns * width;
      const py = bounds.minY + (y + random()) / rows * height;
      const tone = toneAt(px, py);
      if (skipWhite && !hasInk(px, py)) continue;
      const targetInk = -Math.log(Math.max(0.025, 1 - tone * 0.975)) * inkScale;
      const radius = radiusAt(px, py, tone);
      const probability = targetInk * cellArea / Math.max(0.2, TAU * radius * 0.8);
      if (random() < probability) addAnchor(px, py, tone, radius);
    }
    if (y % 32 === 0) onProgress?.(0.3 * y / rows);
  }
  anchors.sort((a, b) => a.order - b.order);
  onProgress?.(0.35);
  const points: Point[] = [];
  let phase = random() * TAU;
  const emit = (x: number, y: number) => {
    // Reflect rather than clamp: curves turn at the boundary without dark frames.
    const reflect = (v: number, min: number, size: number) => {
      const p = ((v - min) % (2 * size) + 2 * size) % (2 * size);
      return min + (p > size ? 2 * size - p : p);
    };
    const point = {
      x: clamp(Math.round(reflect(x, bounds.minX, width) * 1000) / 1000, bounds.minX, bounds.maxX),
      y: clamp(Math.round(reflect(y, bounds.minY, height) * 1000) / 1000, bounds.minY, bounds.maxY),
    };
    const previous = points.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) points.push(point);
  };
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i]!;
    const end = anchors[Math.min(anchors.length - 1, i + 1)]!;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const meanRadius = (start.radius + end.radius) / 2;
    const turns = 0.65 + random() * 0.45;
    const phaseChange = turns * TAU;
    const count = Math.max(12, Math.ceil((distance + phaseChange * meanRadius) / Math.max(curveStep, meanRadius * 0.22)));
    if (points.length + count + 1 > 4_000_000) throw new Error('Continuous scribble exceeds 4 million points. Increase Fine detail size or Curve step, or reduce Shadow density.');
    const bend = (random() - 0.5) * Math.min(distance, looseSize) * 0.6;
    const nx = distance ? -(end.y - start.y) / distance : 0;
    const ny = distance ? (end.x - start.x) / distance : 0;
    for (let j = 0; j < count; j++) {
      const t = j / count;
      const ease = t * t * (3 - 2 * t);
      const angle = phase + phaseChange * t;
      const radius = start.radius + (end.radius - start.radius) * ease;
      const wobble = 1 + 0.18 * Math.sin(angle * 0.73) + 0.1 * Math.sin(angle * 1.31);
      const offset = Math.sin(Math.PI * t) ** 2 * bend;
      emit(start.x + (end.x - start.x) * ease + nx * offset + radius * wobble * Math.cos(angle),
        start.y + (end.y - start.y) * ease + ny * offset + radius * wobble * Math.sin(angle) * (0.85 + 0.15 * Math.sin(angle * 0.41)));
    }
    phase += phaseChange;
    if (i % 256 === 0) onProgress?.(0.35 + (skipWhite ? 0.6 : 0.65) * i / anchors.length);
  }
  if (skipWhite && points.length > 1) {
    // Mask the actual curve and its connecting segments, not only the anchors.
    // Subdivide long edges so a narrow white gap cannot be bridged accidentally.
    const step = Math.min(0.1, detail / 4);
    let visible: Point[] = [];
    const flush = () => {
      if (visible.length > 1) result.paths.push({ id: `continuous-scribble-${result.paths.length}`, points: visible, passId, layerId: 'layer-1', channel: 'primary', closed: false, preserveGaps: true });
      visible = [];
    };
    let previous = points[0]!;
    let previousInk = hasInk(previous.x, previous.y);
    if (previousInk) visible.push(previous);
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1]!;
      const end = points[i]!;
      const samples = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / step));
      for (let j = 1; j <= samples; j++) {
        const t = j / samples;
        const point = j === samples ? end : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
        const ink = hasInk(point.x, point.y);
        if (ink !== previousInk) {
          let a = previous; let b = point;
          for (let k = 0; k < 8; k++) {
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (hasInk(mid.x, mid.y) === previousInk) a = mid;
            else b = mid;
          }
          // Keep the endpoint just inside the foreground side of the boundary.
          const boundary = previousInk ? a : b;
          if (ink) visible = [boundary];
          else { visible.push(boundary); flush(); }
        }
        if (ink && j === samples) visible.push(point);
        previous = point; previousInk = ink;
      }
      if (i % 8192 === 0) onProgress?.(0.95 + 0.05 * i / points.length);
    }
    flush();
  } else if (points.length > 1) result.paths.push({ id: 'continuous-scribble', points, passId, layerId: 'layer-1', channel: 'primary', closed: false });
  onProgress?.(1);
  return result;
}
