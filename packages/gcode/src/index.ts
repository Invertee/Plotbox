import type { GCodeSettings, PenProfile, PlotGeometry, PlotPass, PlotPath, Point } from '@plotter/core';
import { optimisePathOrder } from '@plotter/geometry';

export interface GCodeDocument { filename: string; passId?: string; content: string }
export type GCodeProgress = (value: number, message: string) => void;

const n = (value: number) => Number(value.toFixed(3)).toString();

const DEFAULT_PATH_JOIN_TOLERANCE = 0.15;
const MAX_JOIN_ANGLE = Math.cos(Math.PI / 3);
const DISTANCE_EPSILON = 0.000001;

type ScheduledPaintPath = { path: PlotPath; reloadBefore: boolean };

function finitePathSegments(path: PlotPath): PlotPath[] {
  const segments: PlotPath[] = [];
  let points: Point[] = [];
  let segmentIndex = 0;
  let containsInvalidPoint = false;
  const flush = () => {
    if (points.length > 1) {
      segments.push({
        ...path,
        id: segmentIndex === 0 ? path.id : `${path.id}-segment-${segmentIndex}`,
        points,
        // A path split around corrupt data is no longer a closed contour.
        closed: containsInvalidPoint ? false : path.closed,
      });
      segmentIndex += 1;
    }
    points = [];
  };
  for (const point of path.points) {
    const candidate = point as Point | null | undefined;
    if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
      containsInvalidPoint = true;
      flush();
      continue;
    }
    points.push(candidate);
  }
  flush();
  if (containsInvalidPoint) {
    for (const segment of segments) segment.closed = false;
  }
  return segments;
}

function appendLines(target: string[], source: string[]): void {
  // Avoid target.push(...source): detailed plots can contain hundreds of
  // thousands of lines, exceeding the JavaScript engine's argument limit.
  for (const line of source) target.push(line);
}

function direction(points: Point[], fromEnd: boolean): Point | undefined {
  const anchor = fromEnd ? points.length - 1 : 0;
  const step = fromEnd ? -1 : 1;
  for (let index = anchor + step; index >= 0 && index < points.length; index += step) {
    const x = points[anchor]!.x - points[index]!.x;
    const y = points[anchor]!.y - points[index]!.y;
    const length = Math.hypot(x, y);
    if (length > 0.000001) return fromEnd ? { x: x / length, y: y / length } : { x: -x / length, y: -y / length };
  }
  return undefined;
}

/**
 * Combines adjacent paths only when their endpoints are close and their tangents
 * point in the same direction. This removes pen lifts caused by tessellated curves
 * without bridging nearby, unrelated hatch lines.
 */
export function joinContinuousPaths(paths: PlotPath[], tolerance = DEFAULT_PATH_JOIN_TOLERANCE): PlotPath[] {
  if (tolerance <= 0) return paths;
  const joined: PlotPath[] = [];
  for (const path of paths) {
    const previous = joined[joined.length - 1];
    const previousEnd = previous?.points[previous.points.length - 1];
    const nextStart = path.points[0];
    if (!previous || previous.closed || path.closed || previous.preserveGaps || path.preserveGaps || !previousEnd || !nextStart) { joined.push({ ...path, points: [...path.points] }); continue; }

    const gap = Math.hypot(nextStart.x - previousEnd.x, nextStart.y - previousEnd.y);
    const previousDirection = direction(previous.points, true);
    const nextDirection = direction(path.points, false);
    const aligned = previousDirection && nextDirection
      ? previousDirection.x * nextDirection.x + previousDirection.y * nextDirection.y >= MAX_JOIN_ANGLE
      : false;
    if (gap <= tolerance && aligned) {
      const duplicateEndpoint = gap < 0.000001;
      previous.points = [...previous.points, ...path.points.slice(duplicateEndpoint ? 1 : 0)];
    } else joined.push({ ...path, points: [...path.points] });
  }
  return joined;
}

function interpolatePoint(start: Point, end: Point, ratio: number): Point {
  const pressure = start.pressure === undefined && end.pressure === undefined
    ? undefined
    : (start.pressure ?? end.pressure ?? 0) + ((end.pressure ?? start.pressure ?? 0) - (start.pressure ?? end.pressure ?? 0)) * ratio;
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio, ...(pressure === undefined ? {} : { pressure }) };
}

/**
 * Split ordered paint paths at the configured paint capacity while carrying the
 * used distance across pen-up gaps. Each marked segment starts with a well dip.
 */
function schedulePaintPaths(paths: PlotPath[], reloadDistance: number): ScheduledPaintPath[] {
  const maximum = Number.isFinite(reloadDistance) && reloadDistance > 0 ? reloadDistance : Number.POSITIVE_INFINITY;
  const scheduled: ScheduledPaintPath[] = [];
  let distanceSinceReload = maximum;
  let segmentIndex = 0;

  for (const path of paths) {
    const source = path.closed && path.points.length > 1 ? [...path.points, path.points[0]!] : path.points;
    if (source.length < 2) continue;
    let reloadBefore = distanceSinceReload >= maximum - DISTANCE_EPSILON;
    if (reloadBefore) distanceSinceReload = 0;
    let current: Point[] = [source[0]!];

    const flush = () => {
      if (current.length < 2) return;
      scheduled.push({ path: { ...path, id: `${path.id}-paint-${segmentIndex++}`, points: current, closed: false }, reloadBefore });
      current = [current[current.length - 1]!];
      reloadBefore = false;
    };

    for (let pointIndex = 1; pointIndex < source.length; pointIndex += 1) {
      let start = current[current.length - 1]!;
      const end = source[pointIndex]!;
      let edgeLength = Math.hypot(end.x - start.x, end.y - start.y);
      if (edgeLength <= DISTANCE_EPSILON) continue;

      while (edgeLength > DISTANCE_EPSILON) {
        const capacity = maximum - distanceSinceReload;
        if (capacity <= DISTANCE_EPSILON) {
          flush();
          reloadBefore = true;
          distanceSinceReload = 0;
          continue;
        }
        if (edgeLength <= capacity + DISTANCE_EPSILON) {
          current.push(end);
          distanceSinceReload += edgeLength;
          break;
        }
        const split = interpolatePoint(start, end, capacity / edgeLength);
        current.push(split);
        distanceSinceReload += capacity;
        flush();
        reloadBefore = true;
        distanceSinceReload = 0;
        start = split;
        edgeLength = Math.hypot(end.x - start.x, end.y - start.y);
      }
    }
    flush();
  }
  return scheduled;
}

function paintZ(pen: PenProfile, point: Point): number {
  if (pen.paintUsePressure === false || point.pressure === undefined || !Number.isFinite(point.pressure)) return pen.zDown;
  const pressure = Math.max(0, Math.min(1, point.pressure));
  const maximum = pen.paintMaxPressureZ ?? pen.zDown;
  return pen.zDown + (maximum - pen.zDown) * pressure;
}

function paintDipGCode(pen: PenProfile, settings: GCodeSettings, zUpFeed: number, zDownFeed: number): string[] {
  const coordinates = [pen.paintWellX, pen.paintWellY, pen.paintWellZ];
  if (coordinates.some((value) => value === undefined || !Number.isFinite(value))) {
    throw new Error(`${pen.name} needs a captured paint well X/Y position and dip Z height before export.`);
  }
  const lines = [
    ...(settings.includeComments ? [`; Reload ${pen.name}`] : []),
    `G0 Z${n(pen.zUp)} F${n(zUpFeed)}`,
    `G0 X${n(pen.paintWellX!)} Y${n(pen.paintWellY!)} F${n(settings.travelFeed)}`,
    `G1 Z${n(pen.paintWellZ!)} F${n(zDownFeed)}`,
  ];
  const dwell = Math.max(0, pen.paintDipDwellSeconds ?? 0);
  if (dwell > 0) lines.push(`G4 P${n(dwell)}`);
  lines.push(`G0 Z${n(pen.zUp)} F${n(zUpFeed)}`);
  return lines;
}

function passGCode(pass: PlotPass, pen: PenProfile, geometry: PlotGeometry, settings: GCodeSettings, pageHeight: number, completedBefore: number, totalPaths: number, onProgress?: GCodeProgress): string[] {
  const lines: string[] = [];
  const zUpFeed = pen.zUpFeed ?? pen.zFeed ?? 600;
  const zDownFeed = pen.zDownFeed ?? pen.zFeed ?? 600;
  if (settings.includeComments) lines.push(`; ${pass.name} — ${pen.name}`);
  lines.push(`G0 Z${n(pen.zUp)} F${n(zUpFeed)}`);
  const passPaths = geometry.paths.filter((path) => path.passId === pass.id && path.points.length > 1);
  const ordered = optimisePathOrder(passPaths, { x: 0, y: 0 }, (completed) => {
    onProgress?.(0.08 + 0.62 * ((completedBefore + completed) / Math.max(1, totalPaths)), `Optimising ${Math.min(totalPaths, completedBefore + completed).toLocaleString()} of ${totalPaths.toLocaleString()} paths`);
  });
  const paths = joinContinuousPaths(ordered, settings.pathJoinTolerance ?? DEFAULT_PATH_JOIN_TOLERANCE);
  const isPaint = pen.mediaType === 'paint';
  const scheduled = isPaint
    ? schedulePaintPaths(paths, Math.max(0, pen.paintReloadDistanceMm ?? 0))
    : paths.map((path) => ({ path, reloadBefore: false }));
  for (let pathIndex = 0; pathIndex < scheduled.length; pathIndex += 1) {
    const { path, reloadBefore } = scheduled[pathIndex]!;
    if (isPaint && reloadBefore) appendLines(lines, paintDipGCode(pen, settings, zUpFeed, zDownFeed));
    const first = path.points[0]!;
    const y = settings.origin === 'bottom-left' ? pageHeight - first.y : first.y;
    lines.push(`G0 X${n(first.x)} Y${n(y)} F${n(settings.travelFeed)}`);
    lines.push(`G1 Z${n(isPaint ? paintZ(pen, first) : pen.zDown)} F${n(zDownFeed)}`);
    for (const point of path.points.slice(1)) {
      const pointY = settings.origin === 'bottom-left' ? pageHeight - point.y : point.y;
      const z = isPaint && pen.paintUsePressure !== false && point.pressure !== undefined ? ` Z${n(paintZ(pen, point))}` : '';
      lines.push(`G1 X${n(point.x)} Y${n(pointY)}${z} F${n(pen.xyFeed)}`);
    }
    if (path.closed) lines.push(`G1 X${n(first.x)} Y${n(y)} F${n(pen.xyFeed)}`);
    lines.push(`G0 Z${n(pen.zUp)} F${n(zUpFeed)}`);
    if (onProgress && (pathIndex % 512 === 0 || pathIndex === scheduled.length - 1)) {
      const passProgress = (pathIndex + 1) / Math.max(1, scheduled.length);
      onProgress(0.7 + 0.27 * ((completedBefore + passProgress * passPaths.length) / Math.max(1, totalPaths)), `Writing ${Math.min(totalPaths, Math.round(completedBefore + passProgress * passPaths.length)).toLocaleString()} of ${totalPaths.toLocaleString()} paths`);
    }
  }
  lines.push(`G0 Z${n(pen.zUp)} F${n(zUpFeed)}`);
  lines.push(`G0 X${n(settings.parkX)} Y${n(settings.parkY)} F${n(settings.travelFeed)}`);
  return lines;
}

export function generateGCode(projectName: string, geometry: PlotGeometry, passes: PlotPass[], pens: PenProfile[], settings: GCodeSettings, pageHeight: number, split = false, onProgress?: GCodeProgress): GCodeDocument[] {
  // Saved geometry may contain null coordinates because JSON serialises NaN
  // and Infinity as null. Split at those points instead of joining across an
  // invalid span or failing the entire export in number formatting.
  const safeGeometry = { ...geometry, paths: geometry.paths.flatMap(finitePathSegments) };
  const active = passes.filter((pass) => pass.enabled && safeGeometry.paths.some((path) => path.passId === pass.id));
  const pathCounts = active.map((pass) => safeGeometry.paths.filter((path) => path.passId === pass.id).length);
  const totalPaths = pathCounts.reduce((total, count) => total + count, 0);
  let completedBefore = 0;
  const header = ['G21', 'G90'];
  const safeName = projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plot';
  if (split) {
    const documents = active.map((pass, index) => {
      const pen = pens.find((item) => item.id === pass.penId);
      if (!pen) throw new Error(`Missing pen for ${pass.name}`);
      const lines = [...header];
      appendLines(lines, passGCode(pass, pen, safeGeometry, settings, pageHeight, completedBefore, totalPaths, onProgress));
      lines.push('M2', '');
      const safePassName = pass.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pass';
      const document = { filename: `${index + 1}-${safePassName}-${safeName}.gcode`, passId: pass.id, content: lines.join('\n') };
      completedBefore += pathCounts[index] ?? 0;
      return document;
    });
    onProgress?.(1, 'G-code ready');
    return documents;
  }
  const body: string[] = [...header];
  active.forEach((pass, index) => {
    const pen = pens.find((item) => item.id === pass.penId);
    if (!pen) throw new Error(`Missing pen for ${pass.name}`);
    appendLines(body, passGCode(pass, pen, safeGeometry, settings, pageHeight, completedBefore, totalPaths, onProgress));
    completedBefore += pathCounts[index] ?? 0;
    if (settings.pauseBetweenPasses && index < active.length - 1) {
      if (settings.includeComments) body.push('; Change pen');
      body.push(settings.pauseCommand || 'M0');
    }
  });
  body.push('M2', '');
  onProgress?.(1, 'G-code ready');
  return [{ filename: `${safeName}.gcode`, content: body.join('\n') }];
}
