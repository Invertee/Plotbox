import type { PlotGeometry, PlotPath, Point } from '@plotter/core';
import type { Bounds, ImagePlacement } from '@plotter/geometry';
import { traceRasterContours } from './rasterContours';

export type TonalAreaFillOptions = {
  bounds: Bounds;
  placement: ImagePlacement;
  passId: string;
  /** Optional colour/region membership mask. Fill and contour paths may not cross it. */
  eligibleMask?: ArrayLike<number>;
  penWidth?: number;
  levels?: number;
  highlightThreshold?: number;
  shadowThreshold?: number;
  spacing?: number;
  angle?: number;
  angleStep?: number;
  closeRadius?: number;
  minimumRegionPixels?: number;
  minimumStroke?: number;
  includeContours?: boolean;
  edgeThreshold?: number;
  minimumContourLength?: number;
  contourSimplification?: number;
  onProgress?: (value: number, message: string) => void;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function closeMask(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return source;
  const dilated = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let filled = false;
      for (let dy = -radius; dy <= radius && !filled; dy += 1) {
        const py = y + dy;
        if (py < 0 || py >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const px = x + dx;
          if (px >= 0 && px < width && source[py * width + px]) { filled = true; break; }
        }
      }
      if (filled) dilated[y * width + x] = 1;
    }
  }
  const closed = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let filled = true;
      for (let dy = -radius; dy <= radius && filled; dy += 1) {
        const py = y + dy;
        if (py < 0 || py >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const px = x + dx;
          if (px < 0 || px >= width) continue;
          if (!dilated[py * width + px]) { filled = false; break; }
        }
      }
      if (filled) closed[y * width + x] = 1;
    }
  }
  return closed;
}

function removeSmallRegions(mask: Uint8Array, width: number, height: number, minimumPixels: number): Uint8Array {
  if (minimumPixels <= 1) return mask;
  const cleaned = mask.slice();
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    seen[start] = 1;
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || px >= width || py < 0 || py >= height) continue;
          const next = py * width + px;
          if (mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
        }
      }
    }
    if (tail < minimumPixels) for (let index = 0; index < tail; index += 1) cleaned[queue[index]!] = 0;
  }
  return cleaned;
}

function intersectRect(bounds: Bounds, placement: ImagePlacement): Bounds | undefined {
  const result = {
    minX: Math.max(bounds.minX, placement.x),
    minY: Math.max(bounds.minY, placement.y),
    maxX: Math.min(bounds.maxX, placement.x + placement.width),
    maxY: Math.min(bounds.maxY, placement.y + placement.height),
  };
  return result.minX < result.maxX && result.minY < result.maxY ? result : undefined;
}

function clipLine(start: Point, end: Point, bounds: Bounds): [Point, Point] | undefined {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let from = 0;
  let to = 1;
  for (const [p, q] of [[-dx, start.x - bounds.minX], [dx, bounds.maxX - start.x], [-dy, start.y - bounds.minY], [dy, bounds.maxY - start.y]] as [number, number][]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return undefined; continue; }
    const ratio = q / p;
    if (p < 0) from = Math.max(from, ratio); else to = Math.min(to, ratio);
    if (from > to) return undefined;
  }
  return [
    { x: start.x + from * dx, y: start.y + from * dy },
    { x: start.x + to * dx, y: start.y + to * dy },
  ];
}

function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const ranges: [number, number][] = [[0, points.length - 1]];
  const squaredTolerance = tolerance * tolerance;
  while (ranges.length) {
    const [first, last] = ranges.pop()!;
    const start = points[first]!;
    const end = points[last]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    let furthest = first;
    let maximumDistance = squaredTolerance;
    for (let index = first + 1; index < last; index += 1) {
      const point = points[index]!;
      const progress = lengthSquared ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1) : 0;
      const offsetX = point.x - start.x - progress * dx;
      const offsetY = point.y - start.y - progress * dy;
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (distance > maximumDistance) { maximumDistance = distance; furthest = index; }
    }
    if (furthest !== first) {
      keep[furthest] = 1;
      ranges.push([first, furthest], [furthest, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function pathLength(points: Point[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
  return length;
}

/**
 * Converts nested darkness masks into clipped fill strokes. Every darker mask
 * adds another hatch direction, so broad regions remain coherent while their
 * line density still carries tone. A contour pass restores narrow details that
 * are too small to be crossed by a fill line.
 */
export function generateTonalAreaFill(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  options: TonalAreaFillOptions,
): PlotGeometry {
  const paths: PlotPath[] = [];
  const generatedAt = new Date().toISOString();
  if (width < 1 || height < 1 || luminance.length < width * height) return { generator: 'raster.tonal-area-fill', generatedAt, paths };
  const visible = intersectRect(options.bounds, options.placement);
  if (!visible) return { generator: 'raster.tonal-area-fill', generatedAt, paths };
  const eligible = options.eligibleMask?.length === width * height ? options.eligibleMask : undefined;

  const levels = Math.round(clamp(options.levels ?? 3, 1, 6));
  const highlight = clamp(options.highlightThreshold ?? 225, 1, 255);
  const shadow = clamp(options.shadowThreshold ?? 70, 0, highlight - 1);
  const spacing = clamp(options.spacing ?? 0.55, 0.1, 20);
  const baseAngle = options.angle ?? 45;
  const angleStep = options.angleStep ?? 60;
  const closeRadius = Math.round(clamp(options.closeRadius ?? 1, 0, 4));
  const minimumRegionPixels = Math.round(clamp(options.minimumRegionPixels ?? 6, 1, 10000));
  const minimumStroke = clamp(options.minimumStroke ?? 0.2, 0, 20);
  const centre = { x: (visible.minX + visible.maxX) / 2, y: (visible.minY + visible.maxY) / 2 };
  const corners = [
    { x: visible.minX, y: visible.minY }, { x: visible.maxX, y: visible.minY },
    { x: visible.maxX, y: visible.maxY }, { x: visible.minX, y: visible.maxY },
  ];
  const pushPath = (points: Point[], channel: string, closed = false) => {
    if (points.length < 2 || pathLength(points) < minimumStroke) return;
    paths.push({ id: `tonal-area-${paths.length}`, points, passId: options.passId, layerId: 'layer-1', channel, closed, preserveGaps: true });
    if (paths.length > 300_000) throw new Error('Too many tonal fill paths. Increase fill spacing or minimum area.');
  };

  for (let level = 0; level < levels; level += 1) {
    const mix = levels === 1 ? 0 : level / (levels - 1);
    const threshold = highlight + (shadow - highlight) * mix;
    let mask: Uint8Array = new Uint8Array(width * height);
    for (let index = 0; index < mask.length; index += 1) if ((!eligible || eligible[index]) && luminance[index]! <= threshold) mask[index] = 1;
    mask = closeMask(mask, width, height, closeRadius);
    // Closing can bridge a tiny tonal break, but a colour fill must never grow
    // across the colour separation boundary into another pen's region.
    if (eligible) for (let index = 0; index < mask.length; index += 1) if (!eligible[index]) mask[index] = 0;
    mask = removeSmallRegions(mask, width, height, minimumRegionPixels);

    const radians = (baseAngle + angleStep * level) * Math.PI / 180;
    const direction = { x: Math.cos(radians), y: Math.sin(radians) };
    const normal = { x: -direction.y, y: direction.x };
    const project = (point: Point, axis: Point) => (point.x - centre.x) * axis.x + (point.y - centre.y) * axis.y;
    const offsets = corners.map(point => project(point, normal));
    const distances = corners.map(point => project(point, direction));
    const firstOffset = Math.ceil(Math.min(...offsets) / spacing) * spacing;
    const lastOffset = Math.max(...offsets);
    const fromDistance = Math.min(...distances) - spacing;
    const toDistance = Math.max(...distances) + spacing;

    for (let offset = firstOffset; offset <= lastOffset + 1e-8; offset += spacing) {
      const lineStart = { x: centre.x + normal.x * offset + direction.x * fromDistance, y: centre.y + normal.y * offset + direction.y * fromDistance };
      const lineEnd = { x: centre.x + normal.x * offset + direction.x * toDistance, y: centre.y + normal.y * offset + direction.y * toDistance };
      const clipped = clipLine(lineStart, lineEnd, visible);
      if (!clipped) continue;
      const [start, end] = clipped;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const stops = [0, 1];
      if (Math.abs(dx) > 1e-10) for (let x = 1; x < width; x += 1) {
        const progress = (options.placement.x + x / width * options.placement.width - start.x) / dx;
        if (progress > 1e-8 && progress < 1 - 1e-8) stops.push(progress);
      }
      if (Math.abs(dy) > 1e-10) for (let y = 1; y < height; y += 1) {
        const progress = (options.placement.y + y / height * options.placement.height - start.y) / dy;
        if (progress > 1e-8 && progress < 1 - 1e-8) stops.push(progress);
      }
      stops.sort((a, b) => a - b);
      let runStart: number | undefined;
      let runEnd = 0;
      for (let stopIndex = 0; stopIndex + 1 < stops.length; stopIndex += 1) {
        const from = stops[stopIndex]!;
        const to = stops[stopIndex + 1]!;
        if (to - from < 1e-9) continue;
        const middle = (from + to) / 2;
        const pageX = start.x + dx * middle;
        const pageY = start.y + dy * middle;
        const pixelX = clamp(Math.floor((pageX - options.placement.x) / options.placement.width * width), 0, width - 1);
        const pixelY = clamp(Math.floor((pageY - options.placement.y) / options.placement.height * height), 0, height - 1);
        if (mask[pixelY * width + pixelX]) {
          if (runStart === undefined) runStart = from;
          runEnd = to;
        } else if (runStart !== undefined) {
          pushPath([
            { x: start.x + dx * runStart, y: start.y + dy * runStart },
            { x: start.x + dx * runEnd, y: start.y + dy * runEnd },
          ], `fill-${level + 1}`);
          runStart = undefined;
        }
      }
      if (runStart !== undefined) pushPath([
        { x: start.x + dx * runStart, y: start.y + dy * runStart },
        { x: start.x + dx * runEnd, y: start.y + dy * runEnd },
      ], `fill-${level + 1}`);
    }
    options.onProgress?.(0.08 + (level + 1) / levels * 0.68, `Filling tonal area ${level + 1} of ${levels}`);
  }

  if (options.includeContours !== false) {
    const contourLuminance = eligible
      ? Float32Array.from({ length: width * height }, (_, index) => eligible[index] ? luminance[index]! : 255)
      : luminance;
    const contours = traceRasterContours(contourLuminance, width, height, {
      threshold: clamp(options.edgeThreshold ?? 55, 1, 255),
      minimumPoints: 2,
    });
    const minimumContourLength = clamp(options.minimumContourLength ?? 0.5, 0, 100);
    const simplification = clamp(options.contourSimplification ?? 0.12, 0, 5);
    for (const contour of contours) {
      const page = contour.map(point => ({
        x: options.placement.x + point.x / Math.max(1, width - 1) * options.placement.width,
        y: options.placement.y + point.y / Math.max(1, height - 1) * options.placement.height,
      }));
      let visiblePath: Point[] = [];
      const flush = () => {
        const simplified = simplifyPath(visiblePath, simplification);
        if (simplified.length > 1 && pathLength(simplified) >= minimumContourLength) {
          const first = simplified[0]!;
          const last = simplified[simplified.length - 1]!;
          pushPath(simplified, 'contour', Math.hypot(first.x - last.x, first.y - last.y) < 0.001);
        }
        visiblePath = [];
      };
      for (let index = 1; index < page.length; index += 1) {
        const segment = clipLine(page[index - 1]!, page[index]!, visible);
        if (!segment) { flush(); continue; }
        const [start, end] = segment;
        const previous = visiblePath[visiblePath.length - 1];
        if (!previous || Math.hypot(previous.x - start.x, previous.y - start.y) > 0.001) { flush(); visiblePath = [start]; }
        visiblePath.push(end);
      }
      flush();
    }
    options.onProgress?.(0.92, 'Adding detail contours');
  }

  return { generator: 'raster.tonal-area-fill', generatedAt, paths };
}
