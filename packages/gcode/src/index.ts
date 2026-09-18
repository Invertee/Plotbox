import type { GCodeSettings, PenProfile, PlotGeometry, PlotPass, PlotPath, Point } from '@plotter/core';
import { optimisePathOrder } from '@plotter/geometry';

export interface GCodeDocument { filename: string; passId?: string; content: string }
export type GCodeProgress = (value: number, message: string) => void;

const n = (value: number) => Number(value.toFixed(3)).toString();

const DEFAULT_PATH_JOIN_TOLERANCE = 0.15;
const MAX_JOIN_ANGLE = Math.cos(Math.PI / 3);

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
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
    const path = paths[pathIndex]!;
    const first = path.points[0]!;
    const y = settings.origin === 'bottom-left' ? pageHeight - first.y : first.y;
    lines.push(`G0 X${n(first.x)} Y${n(y)} F${n(settings.travelFeed)}`);
    lines.push(`G1 Z${n(pen.zDown)} F${n(zDownFeed)}`);
    for (const point of path.points.slice(1)) {
      const pointY = settings.origin === 'bottom-left' ? pageHeight - point.y : point.y;
      lines.push(`G1 X${n(point.x)} Y${n(pointY)} F${n(pen.xyFeed)}`);
    }
    if (path.closed) lines.push(`G1 X${n(first.x)} Y${n(y)} F${n(pen.xyFeed)}`);
    lines.push(`G0 Z${n(pen.zUp)} F${n(zUpFeed)}`);
    if (onProgress && (pathIndex % 512 === 0 || pathIndex === paths.length - 1)) {
      onProgress(0.7 + 0.27 * ((completedBefore + pathIndex + 1) / Math.max(1, totalPaths)), `Writing ${Math.min(totalPaths, completedBefore + pathIndex + 1).toLocaleString()} of ${totalPaths.toLocaleString()} paths`);
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
