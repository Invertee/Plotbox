import type { CanvasSettings, PlotLayer, Point, SourcePath } from '@plotter/core';
import { algorithmDefaults } from '@plotter/algorithms';
import { drawableBounds } from '@plotter/geometry';

type RawLayer = { name: string; category: string; paths: SourcePath[] };

export type MapSearchResult = {
  id: string;
  displayName: string;
  latitude: number;
  longitude: number;
  type: string;
};

export type ImportedMap = {
  name: string;
  attribution: string;
  bounds?: { north: number; south: number; east: number; west: number };
  layers: Array<{
    name: string;
    category: string;
    features: Array<{ id: string; closed: boolean; points: Array<[number, number]> }>;
  }>;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';
}

function transformPoint(point: DOMPoint, matrix: DOMMatrix | SVGMatrix | null): Point {
  if (!matrix) return { x: point.x, y: point.y };
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
}

function sourceLayerName(element: Element, root: Element, fallbackIndex: number): string {
  let current: Element | null = element;
  while (current && current !== root) {
    const label = current.getAttribute('data-name') ?? current.getAttribute('aria-label') ?? current.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label');
    if (label) return label;
    if (current.tagName.toLowerCase() === 'g' && current.id) return current.id;
    current = current.parentElement;
  }
  return element.id || `${element.tagName.toLowerCase()} ${fallbackIndex}`;
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

function samePoint(a: Point, b: Point) {
  return Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
}

function clipSegment(start: Point, end: Point, bounds: Rect): [Point, Point] | undefined {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const p = [-dx, dx, -dy, dy];
  const q = [start.x - bounds.minX, bounds.maxX - start.x, start.y - bounds.minY, bounds.maxY - start.y];
  let enter = 0;
  let leave = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index]! < 0) return undefined;
      continue;
    }
    const ratio = q[index]! / p[index]!;
    if (p[index]! < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave) return undefined;
  }
  return [
    { x: start.x + enter * dx, y: start.y + enter * dy },
    { x: start.x + leave * dx, y: start.y + leave * dy },
  ];
}

function clipOpenPath(path: SourcePath, bounds: Rect): SourcePath[] {
  const clipped: SourcePath[] = [];
  let current: Point[] = [];
  const flush = () => {
    if (current.length > 1) clipped.push({ id: `${path.id}-clip-${clipped.length}`, points: current, closed: false });
    current = [];
  };
  for (let index = 0; index + 1 < path.points.length; index += 1) {
    const segment = clipSegment(path.points[index]!, path.points[index + 1]!, bounds);
    if (!segment) { flush(); continue; }
    if (current.length && !samePoint(current[current.length - 1]!, segment[0])) flush();
    if (!current.length) current.push(segment[0]);
    if (!samePoint(current[current.length - 1]!, segment[1])) current.push(segment[1]);
  }
  flush();
  return clipped;
}

function clipPolygon(points: Point[], bounds: Rect): Point[] {
  const edges: Array<{ inside: (point: Point) => boolean; intersect: (a: Point, b: Point) => Point }> = [
    { inside: (point) => point.x >= bounds.minX, intersect: (a, b) => ({ x: bounds.minX, y: a.y + (b.y - a.y) * (bounds.minX - a.x) / (b.x - a.x) }) },
    { inside: (point) => point.x <= bounds.maxX, intersect: (a, b) => ({ x: bounds.maxX, y: a.y + (b.y - a.y) * (bounds.maxX - a.x) / (b.x - a.x) }) },
    { inside: (point) => point.y >= bounds.minY, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (bounds.minY - a.y) / (b.y - a.y), y: bounds.minY }) },
    { inside: (point) => point.y <= bounds.maxY, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (bounds.maxY - a.y) / (b.y - a.y), y: bounds.maxY }) },
  ];
  let output = points;
  for (const edge of edges) {
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input[input.length - 1]!;
    for (const current of input) {
      const currentInside = edge.inside(current);
      const previousInside = edge.inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(edge.intersect(previous, current));
        output.push(current);
      } else if (previousInside) output.push(edge.intersect(previous, current));
      previous = current;
    }
  }
  return output;
}

function cropRawLayers(rawLayers: RawLayer[], bounds: Rect): RawLayer[] {
  return rawLayers.map((layer) => ({
    ...layer,
    paths: layer.paths.flatMap((path) => {
      if (!path.closed) return clipOpenPath(path, bounds);
      const points = clipPolygon(path.points, bounds);
      return points.length >= 3 ? [{ ...path, points }] : [];
    }),
  }));
}

function fitRawLayers(rawLayers: RawLayer[], canvas: CanvasSettings, selectedBounds?: Rect): RawLayer[] {
  // Large OSM regions can contain hundreds of thousands of coordinates. Passing
  // all of them to Math.min/Math.max as arguments overflows the JS call stack.
  const source = selectedBounds ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let pointCount = 0;
  if (!selectedBounds) for (const layer of rawLayers) {
    for (const path of layer.paths) for (const point of path.points) {
      pointCount += 1;
      if (point.x < source.minX) source.minX = point.x;
      if (point.y < source.minY) source.minY = point.y;
      if (point.x > source.maxX) source.maxX = point.x;
      if (point.y > source.maxY) source.maxY = point.y;
    }
  }
  if (!selectedBounds && !pointCount) return rawLayers;
  const target = drawableBounds(canvas.widthMm, canvas.heightMm, canvas.marginMm);
  const sourceWidth = Math.max(0.000001, source.maxX - source.minX);
  const sourceHeight = Math.max(0.000001, source.maxY - source.minY);
  const targetWidth = target.maxX - target.minX;
  const targetHeight = target.maxY - target.minY;
  const scaleX = selectedBounds ? targetWidth / sourceWidth : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const scaleY = selectedBounds ? targetHeight / sourceHeight : scaleX;
  const offsetX = target.minX + (targetWidth - sourceWidth * scaleX) / 2;
  const offsetY = target.minY + (targetHeight - sourceHeight * scaleY) / 2;
  const fitted = rawLayers.map((layer) => ({
    ...layer,
    paths: layer.paths.map((path) => ({
      ...path,
      points: path.points.map((point) => ({ x: offsetX + (point.x - source.minX) * scaleX, y: offsetY + (point.y - source.minY) * scaleY })),
    })),
  }));
  return selectedBounds ? cropRawLayers(fitted, target) : fitted;
}

function toPlotLayers(rawLayers: RawLayer[], passIds: string[]): PlotLayer[] {
  const used = new Map<string, number>();
  return rawLayers.filter((layer) => layer.paths.length).map((layer, index) => {
    const base = slug(layer.name);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const algorithmId = layer.category === 'water' ? 'vector.hatch' : layer.category === 'parks' ? 'vector.stipple' : layer.category === 'buildings' ? 'vector.hatch' : 'vector.outline';
    return {
      id: `layer-${base}-${count}`,
      name: layer.name,
      sourceCategory: layer.category,
      visible: true,
      algorithmId,
      algorithmSettings: algorithmDefaults(algorithmId),
      passId: passIds[index % Math.max(1, passIds.length)] ?? 'pass-1',
      secondaryPassId: passIds[(index + 1) % Math.max(1, passIds.length)] ?? passIds[0] ?? 'pass-1',
      sourcePaths: layer.paths,
    };
  });
}

export function parseSvgLayers(svgText: string, canvas: CanvasSettings, passIds: string[]): PlotLayer[] {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const parserError = parsed.querySelector('parsererror');
  if (parserError) throw new Error('The selected file is not valid SVG.');
  const sourceRoot = parsed.documentElement;
  if (sourceRoot.tagName.toLowerCase() !== 'svg') throw new Error('The selected file does not contain an SVG root element.');
  sourceRoot.querySelectorAll('script, foreignObject, image, use, style').forEach((element) => element.remove());
  const root = document.importNode(sourceRoot, true) as unknown as SVGSVGElement;
  root.setAttribute('width', '1000');
  root.setAttribute('height', '1000');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '-10000px';
  root.style.visibility = 'hidden';
  document.body.appendChild(root);
  try {
    const grouped = new Map<string, RawLayer>();
    const graphics = [...root.querySelectorAll<SVGGeometryElement>('path, rect, circle, ellipse, line, polyline, polygon')];
    graphics.forEach((element, elementIndex) => {
      let length = 0;
      try { length = element.getTotalLength(); } catch { return; }
      if (!Number.isFinite(length) || length <= 0) return;
      const sampleCount = Math.max(2, Math.min(600, Math.ceil(length / 3)));
      const matrix = element.getCTM();
      const points = Array.from({ length: sampleCount + 1 }, (_, pointIndex) => transformPoint(element.getPointAtLength(length * pointIndex / sampleCount), matrix));
      const tag = element.tagName.toLowerCase();
      const closed = ['rect', 'circle', 'ellipse', 'polygon'].includes(tag) || (tag === 'path' && /z\s*$/i.test(element.getAttribute('d')?.trim() ?? ''));
      if (closed && points.length > 2 && Math.hypot(points[0]!.x - points[points.length - 1]!.x, points[0]!.y - points[points.length - 1]!.y) < 0.001) points.pop();
      const name = sourceLayerName(element, root, elementIndex + 1);
      const layer = grouped.get(name) ?? { name, category: 'svg', paths: [] };
      layer.paths.push({ id: `svg-${elementIndex}`, points, closed });
      grouped.set(name, layer);
    });
    if (!grouped.size) throw new Error('No supported paths or shapes were found in this SVG.');
    return toPlotLayers(fitRawLayers([...grouped.values()], canvas), passIds);
  } finally {
    root.remove();
  }
}

export function importedMapToLayers(map: ImportedMap, canvas: CanvasSettings, passIds: string[]): PlotLayer[] {
  const allLatitudes = map.layers.flatMap((layer) => layer.features.flatMap((feature) => feature.points.map((point) => point[1])));
  const centreLatitude = allLatitudes.length ? allLatitudes.reduce((total, value) => total + value, 0) / allLatitudes.length : 0;
  const longitudeScale = Math.cos(centreLatitude * Math.PI / 180);
  const rawLayers: RawLayer[] = map.layers.map((layer) => ({
    name: layer.name,
    category: layer.category,
    paths: layer.features.map((feature) => ({
      id: feature.id,
      closed: feature.closed,
      points: feature.points.map(([longitude, latitude]) => ({ x: longitude * longitudeScale, y: -latitude })),
    })),
  }));
  const selectedBounds = map.bounds ? {
    minX: map.bounds.west * longitudeScale,
    maxX: map.bounds.east * longitudeScale,
    minY: -map.bounds.north,
    maxY: -map.bounds.south,
  } : undefined;
  return toPlotLayers(fitRawLayers(rawLayers, canvas, selectedBounds), passIds);
}
