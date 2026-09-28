import type { CanvasSettings, MapAnnotation, MapTitleSettings, PlotGeometry, PlotPath, Point } from '@plotter/core';
import { clipPathBehindPolygon } from './isometric';

export const MAP_MARKER_OPTIONS = [
  { id: 'location-pin', label: 'Location pin' },
] as const;

export const MAP_ANNOTATION_FONT_OPTIONS = [
  { id: 'single-line', label: 'Single line' },
  { id: 'block', label: 'Block' },
  { id: 'dot-matrix', label: 'Dot matrix' },
] as const;

// Compact 5 × 7 plotter alphabet. Each row is encoded as a five-bit mask.
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14], H: [17, 17, 17, 31, 17, 17, 17], I: [31, 4, 4, 4, 4, 4, 31],
  J: [7, 2, 2, 2, 18, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [30, 1, 1, 14, 1, 1, 30], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 16, 30, 1, 1, 30],
  '6': [14, 16, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 1, 14], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 4, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0], '_': [0, 0, 0, 0, 0, 0, 31], '/': [1, 2, 2, 4, 8, 8, 16],
  '&': [12, 18, 20, 8, 21, 18, 13], "'": [4, 4, 8, 0, 0, 0, 0], ':': [0, 12, 12, 0, 12, 12, 0],
  '?': [14, 17, 1, 2, 4, 0, 4], '!': [4, 4, 4, 4, 4, 0, 4], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
};

type PathShape = { points: Point[]; closed?: boolean; channel: string };
type MarkerRenderer = (anchor: Point, size: number) => PathShape[];

function circle(centre: Point, radius: number, segments = 20): Point[] {
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
  });
}

const MARKER_RENDERERS: Record<string, MarkerRenderer> = {
  'location-pin': (anchor, size) => {
    const radius = size * 0.34;
    const centre = { x: anchor.x, y: anchor.y - size * 0.62 };
    const shoulder = Math.PI * 0.77;
    const outline: Point[] = [];
    for (let index = 0; index <= 15; index += 1) {
      const angle = shoulder - shoulder * 2 * index / 15;
      outline.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
    }
    outline.push(anchor);
    return [
      { points: outline, closed: true, channel: 'marker' },
      { points: circle(centre, radius * 0.28, 14), closed: true, channel: 'marker-detail' },
    ];
  },
};

function glyphMarkerPaths(annotation: MapAnnotation, anchor: Point, size: number): PathShape[] {
  return (annotation.glyphPaths ?? []).map((path) => ({
    points: path.points.map((point) => ({
      x: anchor.x + (point.x - 0.5) * size,
      y: anchor.y - size + point.y * size,
    })),
    closed: path.closed,
    channel: 'marker',
  }));
}

function glyphPaths(character: string, origin: Point, height: number, font: string): PathShape[] {
  const rows = FONT[character.toUpperCase()] ?? FONT['?']!;
  const cell = height / 7;
  const paths: PathShape[] = [];
  for (let row = 0; row < 7; row += 1) {
    const mask = rows[row]!;
    if (font === 'single-line') {
      let start = -1;
      for (let column = 0; column <= 5; column += 1) {
        const on = column < 5 && (mask & (1 << (4 - column))) !== 0;
        if (on && start < 0) start = column;
        if (!on && start >= 0) {
          paths.push({ points: [{ x: origin.x + (start + 0.2) * cell, y: origin.y + (row + 0.5) * cell }, { x: origin.x + (column - 0.2) * cell, y: origin.y + (row + 0.5) * cell }], channel: 'label' });
          start = -1;
        }
      }
      continue;
    }
    for (let column = 0; column < 5; column += 1) {
      if ((mask & (1 << (4 - column))) === 0) continue;
      const centre = { x: origin.x + (column + 0.5) * cell, y: origin.y + (row + 0.5) * cell };
      if (font === 'dot-matrix') paths.push({ points: circle(centre, cell * 0.2, 8), closed: true, channel: 'label' });
      else paths.push({ points: [
        { x: origin.x + column * cell + cell * 0.12, y: origin.y + row * cell + cell * 0.12 },
        { x: origin.x + (column + 1) * cell - cell * 0.12, y: origin.y + row * cell + cell * 0.12 },
        { x: origin.x + (column + 1) * cell - cell * 0.12, y: origin.y + (row + 1) * cell - cell * 0.12 },
        { x: origin.x + column * cell + cell * 0.12, y: origin.y + (row + 1) * cell - cell * 0.12 },
      ], closed: true, channel: 'label' });
    }
  }
  return paths;
}

function labelPaths(label: string, origin: Point, height: number, font: string): PathShape[] {
  const cell = height / 7;
  const advance = cell * 6;
  return [...label].flatMap((character, index) => glyphPaths(character, { x: origin.x + index * advance, y: origin.y }, height, font));
}

function centredLabelPaths(label: string, centreX: number, top: number, height: number, font: string, channel: string): PathShape[] {
  const shapes = labelPaths(label, { x: 0, y: top }, height, font);
  const points = shapes.flatMap((shape) => shape.points);
  if (!points.length) return [];
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const offsetX = centreX - (left + right) / 2;
  return shapes.map((shape) => ({ ...shape, channel, points: shape.points.map((point) => ({ x: point.x + offsetX, y: point.y })) }));
}

function appendLabelPaths(shapes: PathShape[], annotation: MapAnnotation, anchor: Point, markerSize: number): void {
  const label = annotation.label.trim();
  if (!label) return;
  const markerPoints = shapes.flatMap((shape) => shape.points);
  const labelHeight = Math.max(1, annotation.labelSizeMm);
  const markerTop = Math.min(...markerPoints.map((point) => point.y));
  const markerBottom = Math.max(...markerPoints.map((point) => point.y));
  const labelTop = (markerTop + markerBottom - labelHeight) / 2;
  shapes.push(...labelPaths(label, { x: anchor.x + markerSize * 0.52, y: labelTop }, labelHeight, annotation.font));
}

function roundedRectangle(left: number, top: number, right: number, bottom: number, radius: number): Point[] {
  const r = Math.max(0, Math.min(radius, (right - left) / 2, (bottom - top) / 2));
  if (r === 0) return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  const points: Point[] = [];
  const corners = [
    { x: right - r, y: top + r, start: -Math.PI / 2 },
    { x: right - r, y: bottom - r, start: 0 },
    { x: left + r, y: bottom - r, start: Math.PI / 2 },
    { x: left + r, y: top + r, start: Math.PI },
  ];
  for (const corner of corners) {
    for (let index = 0; index <= 4; index += 1) {
      const angle = corner.start + index / 4 * Math.PI / 2;
      points.push({ x: corner.x + Math.cos(angle) * r, y: corner.y + Math.sin(angle) * r });
    }
  }
  return points;
}

/** Paper-space masks used to keep map detail from running through labels. */
export function mapAnnotationBackgrounds(annotations: MapAnnotation[], canvas: CanvasSettings): Array<{ id: string; polygon: Point[] }> {
  const drawableWidth = Math.max(0, canvas.widthMm - canvas.marginMm * 2);
  const drawableHeight = Math.max(0, canvas.heightMm - canvas.marginMm * 2);
  return annotations.flatMap((annotation) => {
    if (!annotation.visible || !annotation.background) return [];
    const anchor = {
      x: canvas.marginMm + drawableWidth * Math.max(0, Math.min(100, annotation.xPercent)) / 100,
      y: canvas.marginMm + drawableHeight * Math.max(0, Math.min(100, annotation.yPercent)) / 100,
    };
    const markerSize = Math.max(1, annotation.markerSizeMm);
    const renderer = MARKER_RENDERERS[annotation.markerType] ?? MARKER_RENDERERS['location-pin']!;
    const shapes = annotation.glyphPaths?.length ? glyphMarkerPaths(annotation, anchor, markerSize) : renderer(anchor, markerSize);
    appendLabelPaths(shapes, annotation, anchor, markerSize);
    const points = shapes.flatMap((shape) => shape.points);
    if (!points.length) return [];
    const padding = Math.max(0, annotation.backgroundPaddingMm ?? 1.5);
    const left = Math.min(...points.map((point) => point.x)) - padding;
    const top = Math.min(...points.map((point) => point.y)) - padding;
    const right = Math.max(...points.map((point) => point.x)) + padding;
    const bottom = Math.max(...points.map((point) => point.y)) + padding;
    return [{ id: annotation.id, polygon: roundedRectangle(left, top, right, bottom, annotation.backgroundRadiusMm ?? 2) }];
  });
}

/** Create real pen-up gaps behind annotation backgrounds for preview and G-code. */
export function maskPathsBehindMapAnnotations(paths: PlotPath[], annotations: MapAnnotation[], canvas: CanvasSettings): PlotPath[] {
  const backgrounds = mapAnnotationBackgrounds(annotations, canvas);
  return backgrounds.reduce((visible, background) => visible.flatMap((path) => clipPathBehindPolygon(path, background.polygon)), paths);
}

export function generateMapAnnotations(annotations: MapAnnotation[], canvas: CanvasSettings): PlotGeometry {
  const output: PlotPath[] = [];
  const drawableWidth = Math.max(0, canvas.widthMm - canvas.marginMm * 2);
  const drawableHeight = Math.max(0, canvas.heightMm - canvas.marginMm * 2);
  let pathIndex = 0;
  for (const annotation of annotations) {
    if (!annotation.visible) continue;
    const anchor = {
      x: canvas.marginMm + drawableWidth * Math.max(0, Math.min(100, annotation.xPercent)) / 100,
      y: canvas.marginMm + drawableHeight * Math.max(0, Math.min(100, annotation.yPercent)) / 100,
    };
    const markerSize = Math.max(1, annotation.markerSizeMm);
    const renderer = MARKER_RENDERERS[annotation.markerType] ?? MARKER_RENDERERS['location-pin']!;
    const shapes = annotation.glyphPaths?.length ? glyphMarkerPaths(annotation, anchor, markerSize) : renderer(anchor, markerSize);
    appendLabelPaths(shapes, annotation, anchor, markerSize);
    const background = mapAnnotationBackgrounds([annotation], canvas)[0];
    if (background) shapes.unshift({ points: background.polygon, closed: true, channel: 'annotation-background' });
    for (const shape of shapes) output.push({
      id: `annotation-${pathIndex++}`,
      points: shape.points,
      closed: shape.closed,
      passId: annotation.passId,
      layerId: `annotation:${annotation.id}`,
      channel: shape.channel,
    });
  }
  return { paths: output, generatedAt: new Date().toISOString(), generator: 'map.annotations' };
}

export type MapCoordinateBounds = { north: number; south: number; east: number; west: number };

export function formatMapCoordinates(bounds?: MapCoordinateBounds): string {
  if (!bounds) return '';
  const latitude = (bounds.north + bounds.south) / 2;
  const longitude = (bounds.east + bounds.west) / 2;
  return `${Math.abs(latitude).toFixed(4)} ${latitude < 0 ? 'S' : 'N'} / ${Math.abs(longitude).toFixed(4)} ${longitude < 0 ? 'W' : 'E'}`;
}

function mapTitleShapes(settings: MapTitleSettings, bounds: MapCoordinateBounds | undefined, canvas: CanvasSettings): PathShape[] {
  if (!settings.enabled) return [];
  const title = settings.text.trim();
  const coordinates = settings.showCoordinates ? formatMapCoordinates(bounds) : '';
  if (!title && !coordinates) return [];
  const titleHeight = title ? Math.max(1, settings.titleSizeMm) : 0;
  const subtitleHeight = coordinates ? Math.max(1, settings.subtitleSizeMm) : 0;
  const gap = title && coordinates ? Math.max(1, subtitleHeight * 0.45) : 0;
  const blockHeight = titleHeight + gap + subtitleHeight;
  const edgePadding = Math.max(2, titleHeight * 0.35);
  const drawableTop = canvas.marginMm;
  const drawableBottom = canvas.heightMm - canvas.marginMm;
  const top = settings.position === 'bottom' ? drawableBottom - edgePadding - blockHeight : drawableTop + edgePadding;
  const centreX = canvas.widthMm / 2;
  const shapes: PathShape[] = [];
  if (title) shapes.push(...centredLabelPaths(title, centreX, top, titleHeight, settings.font, 'map-title'));
  if (coordinates) shapes.push(...centredLabelPaths(coordinates, centreX, top + titleHeight + gap, subtitleHeight, settings.font, 'map-title-coordinates'));
  return shapes;
}

/** Paper-space area cleared beneath the map title and optional coordinates. */
export function mapTitleBackground(settings: MapTitleSettings | undefined, bounds: MapCoordinateBounds | undefined, canvas: CanvasSettings): Point[] | undefined {
  if (!settings) return undefined;
  const points = mapTitleShapes(settings, bounds, canvas).flatMap((shape) => shape.points);
  if (!points.length) return undefined;
  const padding = Math.max(1, settings.titleSizeMm * 0.2);
  const left = Math.max(canvas.marginMm, Math.min(...points.map((point) => point.x)) - padding);
  const top = Math.max(canvas.marginMm, Math.min(...points.map((point) => point.y)) - padding);
  const right = Math.min(canvas.widthMm - canvas.marginMm, Math.max(...points.map((point) => point.x)) + padding);
  const bottom = Math.min(canvas.heightMm - canvas.marginMm, Math.max(...points.map((point) => point.y)) + padding);
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

export function maskPathsBehindMapTitle(paths: PlotPath[], settings: MapTitleSettings | undefined, bounds: MapCoordinateBounds | undefined, canvas: CanvasSettings): PlotPath[] {
  const background = mapTitleBackground(settings, bounds, canvas);
  return background ? paths.flatMap((path) => clipPathBehindPolygon(path, background)) : paths;
}

export function generateMapTitle(settings: MapTitleSettings | undefined, bounds: MapCoordinateBounds | undefined, canvas: CanvasSettings): PlotGeometry {
  const shapes = settings ? mapTitleShapes(settings, bounds, canvas) : [];
  const paths = shapes.map((shape, index): PlotPath => ({
    id: `map-title-${index}`,
    points: shape.points,
    closed: shape.closed,
    passId: settings!.passId,
    layerId: 'map-title',
    channel: shape.channel,
  }));
  return { paths, generatedAt: new Date().toISOString(), generator: 'map.title' };
}
