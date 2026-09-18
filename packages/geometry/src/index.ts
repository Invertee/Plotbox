import type { PlotGeometry, PlotPath, Point, RasterPlacementSettings } from '@plotter/core';

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export interface ImagePlacement { x: number; y: number; width: number; height: number }

export function drawableBounds(width: number, height: number, margin: number): Bounds {
  return { minX: margin, minY: margin, maxX: width - margin, maxY: height - margin };
}

export function calculateImagePlacement(imageWidth: number, imageHeight: number, bounds: Bounds, settings: RasterPlacementSettings): ImagePlacement {
  const drawWidth = bounds.maxX - bounds.minX;
  const drawHeight = bounds.maxY - bounds.minY;
  const userScale = Math.max(0.01, settings.scalePercent / 100);
  let width: number;
  let height: number;
  if (settings.fit === 'stretch') {
    width = drawWidth * userScale;
    height = drawHeight * userScale;
  } else {
    const baseScale = settings.fit === 'cover'
      ? Math.max(drawWidth / imageWidth, drawHeight / imageHeight)
      : Math.min(drawWidth / imageWidth, drawHeight / imageHeight);
    width = imageWidth * baseScale * userScale;
    height = imageHeight * baseScale * userScale;
  }
  return {
    x: bounds.minX + (drawWidth - width) / 2 + settings.offsetXmm,
    y: bounds.minY + (drawHeight - height) / 2 + settings.offsetYmm,
    width,
    height,
  };
}

export function clampPoint(point: Point, bounds: Bounds): Point {
  return { x: Math.max(bounds.minX, Math.min(bounds.maxX, point.x)), y: Math.max(bounds.minY, Math.min(bounds.maxY, point.y)) };
}

export function clipGeometry(geometry: PlotGeometry, bounds: Bounds): PlotGeometry {
  return {
    ...geometry,
    paths: geometry.paths
      .map((path) => ({ ...path, points: path.points.map((point) => clampPoint(point, bounds)) }))
      .filter((path) => path.points.length > 1),
  };
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function simplifyPoints(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = distanceToSegment(points[i]!, first, last);
    if (distance > maxDistance) { maxDistance = distance; index = i; }
  }
  if (maxDistance <= tolerance) return [first, last];
  const left = simplifyPoints(points.slice(0, index + 1), tolerance);
  const right = simplifyPoints(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

export function pathLength(path: PlotPath): number {
  return path.points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - path.points[index]!.x, point.y - path.points[index]!.y), 0);
}

type PathEndpoint = Point & { pathIndex: number; reverse: boolean; active: boolean; node?: EndpointNode };
type EndpointNode = {
  endpoint: PathEndpoint;
  left?: EndpointNode;
  right?: EndpointNode;
  parent?: EndpointNode;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  activeCount: number;
};

function buildEndpointIndex(endpoints: PathEndpoint[], depth = 0, parent?: EndpointNode): EndpointNode | undefined {
  if (!endpoints.length) return undefined;
  const axis = depth % 2 === 0 ? 'x' : 'y';
  endpoints.sort((a, b) => a[axis] - b[axis]);
  const middle = Math.floor(endpoints.length / 2);
  const endpoint = endpoints[middle]!;
  const node: EndpointNode = {
    endpoint,
    parent,
    minX: endpoint.x,
    minY: endpoint.y,
    maxX: endpoint.x,
    maxY: endpoint.y,
    activeCount: 1,
  };
  endpoint.node = node;
  node.left = buildEndpointIndex(endpoints.slice(0, middle), depth + 1, node);
  node.right = buildEndpointIndex(endpoints.slice(middle + 1), depth + 1, node);
  for (const child of [node.left, node.right]) {
    if (!child) continue;
    node.minX = Math.min(node.minX, child.minX);
    node.minY = Math.min(node.minY, child.minY);
    node.maxX = Math.max(node.maxX, child.maxX);
    node.maxY = Math.max(node.maxY, child.maxY);
    node.activeCount += child.activeCount;
  }
  return node;
}

function distanceSquaredToBounds(point: Point, node: EndpointNode): number {
  const dx = point.x < node.minX ? node.minX - point.x : point.x > node.maxX ? point.x - node.maxX : 0;
  const dy = point.y < node.minY ? node.minY - point.y : point.y > node.maxY ? point.y - node.maxY : 0;
  return dx * dx + dy * dy;
}

function nearestEndpoint(root: EndpointNode, point: Point): PathEndpoint | undefined {
  let best: PathEndpoint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const visit = (node?: EndpointNode) => {
    if (!node || node.activeCount === 0 || distanceSquaredToBounds(point, node) > bestDistance) return;
    if (node.endpoint.active) {
      const dx = node.endpoint.x - point.x;
      const dy = node.endpoint.y - point.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { best = node.endpoint; bestDistance = distance; }
    }
    const leftDistance = node.left?.activeCount ? distanceSquaredToBounds(point, node.left) : Number.POSITIVE_INFINITY;
    const rightDistance = node.right?.activeCount ? distanceSquaredToBounds(point, node.right) : Number.POSITIVE_INFINITY;
    if (leftDistance <= rightDistance) { visit(node.left); visit(node.right); }
    else { visit(node.right); visit(node.left); }
  };
  visit(root);
  return best;
}

function deactivateEndpoint(endpoint: PathEndpoint): void {
  if (!endpoint.active) return;
  endpoint.active = false;
  let node = endpoint.node;
  while (node) {
    node.activeCount = (node.endpoint.active ? 1 : 0) + (node.left?.activeCount ?? 0) + (node.right?.activeCount ?? 0);
    node = node.parent;
  }
}

/**
 * Orders paths using a mutable k-d tree of both endpoints. The previous linear
 * search repeated for every path was quadratic and became unusable on detailed
 * maps; this keeps nearest-neighbour ordering close to O(n log n).
 */
export function optimisePathOrder(paths: PlotPath[], start: Point = { x: 0, y: 0 }, onProgress?: (completed: number, total: number) => void): PlotPath[] {
  if (paths.length < 2) return [...paths];
  const endpoints: PathEndpoint[] = [];
  paths.forEach((path, pathIndex) => {
    const first = path.points[0];
    const last = path.points[path.points.length - 1];
    if (!first || !last) return;
    endpoints.push({ ...first, pathIndex, reverse: false, active: true });
    endpoints.push({ ...last, pathIndex, reverse: true, active: true });
  });
  const root = buildEndpointIndex(endpoints);
  if (!root) return [...paths];
  const endpointsByPath = new Map<number, PathEndpoint[]>();
  for (const endpoint of endpoints) {
    const pair = endpointsByPath.get(endpoint.pathIndex) ?? [];
    pair.push(endpoint);
    endpointsByPath.set(endpoint.pathIndex, pair);
  }
  const result: PlotPath[] = [];
  let cursor = start;
  while (result.length < endpointsByPath.size) {
    const nearest = nearestEndpoint(root, cursor);
    if (!nearest) break;
    const next = paths[nearest.pathIndex]!;
    const ordered = nearest.reverse ? { ...next, points: [...next.points].reverse() } : next;
    result.push(ordered);
    cursor = ordered.points[ordered.points.length - 1] ?? cursor;
    for (const endpoint of endpointsByPath.get(nearest.pathIndex) ?? []) deactivateEndpoint(endpoint);
    if (onProgress && (result.length % 256 === 0 || result.length === endpointsByPath.size)) onProgress(result.length, endpointsByPath.size);
  }
  // Preserve any degenerate paths for callers other than G-code generation.
  paths.forEach((path, index) => { if (!endpointsByPath.has(index)) result.push(path); });
  return result;
}
