import type { BorderSettings, CanvasSettings, PlotGeometry, PlotPath, Point } from '@plotter/core';

const BORDER_LAYER_ID = 'plot-border';
const EPSILON = 1e-7;

type Rect = { left: number; top: number; right: number; bottom: number };

function pointAt(a: Point, b: Point, t: number): Point {
  const point: Point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  if (a.pressure !== undefined || b.pressure !== undefined) point.pressure = (a.pressure ?? 0) + ((b.pressure ?? 0) - (a.pressure ?? 0)) * t;
  return point;
}

function inWhitespaceBand(point: Point, outer: Rect, inner: Rect): boolean {
  const inOuter = point.x >= outer.left - EPSILON && point.x <= outer.right + EPSILON && point.y >= outer.top - EPSILON && point.y <= outer.bottom + EPSILON;
  const inInner = point.x > inner.left + EPSILON && point.x < inner.right - EPSILON && point.y > inner.top + EPSILON && point.y < inner.bottom - EPSILON;
  return inOuter && !inInner;
}

function segmentCuts(a: Point, b: Point, outer: Rect, inner: Rect): number[] {
  const cuts = [0, 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) > EPSILON) for (const x of [outer.left, outer.right, inner.left, inner.right]) {
    const t = (x - a.x) / dx;
    if (t > EPSILON && t < 1 - EPSILON) cuts.push(t);
  }
  if (Math.abs(dy) > EPSILON) for (const y of [outer.top, outer.bottom, inner.top, inner.bottom]) {
    const t = (y - a.y) / dy;
    if (t > EPSILON && t < 1 - EPSILON) cuts.push(t);
  }
  return [...new Set(cuts.map(value => Math.round(value * 1e9) / 1e9))].sort((aValue, bValue) => aValue - bValue);
}

function knockOutPath(path: PlotPath, outer: Rect, inner: Rect): PlotPath[] {
  const points = path.closed ? [...path.points, path.points[0]!] : path.points;
  const pieces: Point[][] = [];
  let active: Point[] = [];
  const flush = () => {
    if (active.length > 1) pieces.push(active);
    active = [];
  };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const cuts = segmentCuts(start, end, outer, inner);
    for (let cutIndex = 1; cutIndex < cuts.length; cutIndex += 1) {
      const from = pointAt(start, end, cuts[cutIndex - 1]!);
      const to = pointAt(start, end, cuts[cutIndex]!);
      const midpoint = pointAt(from, to, 0.5);
      if (inWhitespaceBand(midpoint, outer, inner)) { flush(); continue; }
      if (!active.length) active.push(from);
      else if (Math.hypot(active[active.length - 1]!.x - from.x, active[active.length - 1]!.y - from.y) > EPSILON) active.push(from);
      active.push(to);
    }
  }
  flush();
  return pieces.map((piece, index) => ({ ...path, id: `${path.id}-border-mask-${index}`, points: piece, closed: false, preserveGaps: true }));
}

function rectanglePerimeter(rect: Rect, step: number): Array<{ point: Point; distance: number }> {
  const width = Math.max(0, rect.right - rect.left);
  const height = Math.max(0, rect.bottom - rect.top);
  const perimeter = 2 * (width + height);
  const count = Math.max(4, Math.ceil(perimeter / Math.max(0.35, step)));
  const result: Array<{ point: Point; distance: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const distance = perimeter * index / count;
    let point: Point;
    if (distance < width) point = { x: rect.left + distance, y: rect.top };
    else if (distance < width + height) point = { x: rect.right, y: rect.top + distance - width };
    else if (distance < width * 2 + height) point = { x: rect.right - (distance - width - height), y: rect.bottom };
    else point = { x: rect.left, y: rect.bottom - (distance - width * 2 - height) };
    result.push({ point, distance });
  }
  return result;
}

function wavyBorder(rect: Rect, settings: BorderSettings, scallops: boolean): Point[] {
  const sampleStep = Math.max(0.35, settings.spacingMm / 16);
  return rectanglePerimeter(rect, sampleStep).map(({ point, distance }) => {
    const phase = distance / Math.max(1, settings.spacingMm) * Math.PI * 2;
    const offset = settings.amplitudeMm * (scallops ? (1 - Math.cos(phase)) / 2 : Math.sin(phase));
    if (Math.abs(point.y - rect.top) < EPSILON) return { x: point.x, y: point.y + offset };
    if (Math.abs(point.x - rect.right) < EPSILON) return { x: point.x - offset, y: point.y };
    if (Math.abs(point.y - rect.bottom) < EPSILON) return { x: point.x, y: point.y - offset };
    return { x: point.x + offset, y: point.y };
  });
}

function borderPaths(canvas: CanvasSettings, settings: BorderSettings): PlotPath[] {
  if (!settings.enabled) return [];
  const bandWidth = settings.whitespace ? Math.max(0, settings.whitespaceWidthMm) : 0;
  const position = Math.max(0, settings.insetMm) + bandWidth / 2;
  const rect: Rect = { left: position, top: position, right: canvas.widthMm - position, bottom: canvas.heightMm - position };
  if (rect.right <= rect.left || rect.bottom <= rect.top) return [];
  const base = { layerId: BORDER_LAYER_ID, passId: settings.passId, channel: 'plot-border' };
  if (settings.pattern === 'dotted') {
    const radius = Math.max(0.18, Math.min(settings.amplitudeMm, settings.spacingMm * 0.3) / 2);
    const dots = rectanglePerimeter(rect, Math.max(1, settings.spacingMm));
    return dots.map(({ point }, index) => {
      const segments = 10;
      return { ...base, id: `plot-border-dot-${index}`, closed: true, points: Array.from({ length: segments }, (_, pointIndex) => {
        const angle = pointIndex / segments * Math.PI * 2;
        return { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius };
      }) };
    });
  }
  const points = settings.pattern === 'straight'
    ? [{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }]
    : wavyBorder(rect, settings, settings.pattern === 'scallops');
  return [{ ...base, id: 'plot-border-line', points, closed: true }];
}

/** Applies an optional untouched rectangular band and then adds its plotted border. */
export function applyPlotBorder(geometry: PlotGeometry, canvas: CanvasSettings, settings?: BorderSettings): PlotGeometry {
  if (!settings || (!settings.enabled && !settings.whitespace)) return geometry;
  let paths = geometry.paths.filter(path => path.layerId !== BORDER_LAYER_ID);
  if (settings.whitespace && settings.whitespaceWidthMm > 0) {
    const inset = Math.max(0, settings.insetMm);
    const width = Math.max(0, settings.whitespaceWidthMm);
    const outer = { left: inset, top: inset, right: canvas.widthMm - inset, bottom: canvas.heightMm - inset };
    const inner = { left: inset + width, top: inset + width, right: canvas.widthMm - inset - width, bottom: canvas.heightMm - inset - width };
    if (outer.right > outer.left && outer.bottom > outer.top && inner.right > inner.left && inner.bottom > inner.top) paths = paths.flatMap(path => knockOutPath(path, outer, inner));
  }
  return { ...geometry, paths: [...paths, ...borderPaths(canvas, settings)] };
}

export { BORDER_LAYER_ID };
