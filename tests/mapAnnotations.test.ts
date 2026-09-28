import { describe, expect, it } from 'vitest';
import { formatMapCoordinates, generateMapAnnotations, generateMapTitle, mapAnnotationBackgrounds, mapTitleBackground, maskPathsBehindMapAnnotations, maskPathsBehindMapTitle, MAP_ANNOTATION_FONT_OPTIONS, MAP_MARKER_OPTIONS } from '../packages/algorithms/src/mapAnnotations';
import type { CanvasSettings, MapAnnotation, MapTitleSettings } from '@plotter/core';

const canvas: CanvasSettings = { preset: 'A4', orientation: 'portrait', widthMm: 210, heightMm: 297, marginMm: 10 };
const annotation: MapAnnotation = {
  id: 'city-hall',
  markerType: 'location-pin',
  label: 'City Hall',
  xPercent: 50,
  yPercent: 50,
  markerSizeMm: 10,
  labelSizeMm: 4,
  font: 'single-line',
  passId: 'pass-2',
  visible: true,
};
const title: MapTitleSettings = { enabled: true, text: 'Chamonix', position: 'top', font: 'single-line', titleSizeMm: 8, showCoordinates: true, subtitleSizeMm: 3, passId: 'pass-1' };
const mapBounds = { north: 45.95, south: 45.89, east: 6.92, west: 6.82 };

describe('map annotations', () => {
  it('renders a location marker and vector label in the selected pen pass', () => {
    const result = generateMapAnnotations([annotation], canvas);

    expect(result.paths.length).toBeGreaterThan(10);
    expect(result.paths.every((path) => path.passId === 'pass-2')).toBe(true);
    expect(result.paths.every((path) => path.layerId === 'annotation:city-hall')).toBe(true);
    expect(result.paths.some((path) => path.channel === 'marker' && path.closed)).toBe(true);
    expect(result.paths.some((path) => path.channel === 'label')).toBe(true);
  });

  it('positions the marker anchor by percentage of the drawable safe area', () => {
    const result = generateMapAnnotations([{ ...annotation, label: '', xPercent: 100, yPercent: 100 }], canvas);
    const marker = result.paths.find((path) => path.channel === 'marker')!;

    expect(marker.points).toContainEqual({ x: 200, y: 287 });
  });

  it('supports every declared font and ignores hidden annotations', () => {
    for (const font of MAP_ANNOTATION_FONT_OPTIONS) {
      const result = generateMapAnnotations([{ ...annotation, font: font.id }], canvas);
      expect(result.paths.some((path) => path.channel === 'label')).toBe(true);
      expect(result.paths.every((path) => path.points.length > 1)).toBe(true);
    }
    expect(generateMapAnnotations([{ ...annotation, visible: false }], canvas).paths).toEqual([]);
    expect(MAP_MARKER_OPTIONS.map((option) => option.id)).toContain('location-pin');
  });

  it('renders normalized Glyphbox paths at the annotation anchor and size', () => {
    const result = generateMapAnnotations([{ ...annotation, label: '', markerType: 'glyphbox', markerSizeMm: 20, glyphId: 'custom-star', glyphPaths: [{
      id: 'star-path',
      closed: true,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
    }] }], canvas);
    const marker = result.paths.find((path) => path.channel === 'marker')!;

    expect(marker.closed).toBe(true);
    expect(marker.points).toEqual([{ x: 95, y: 128.5 }, { x: 115, y: 128.5 }, { x: 105, y: 148.5 }]);
  });

  it('centres the label vertically alongside the marker', () => {
    const result = generateMapAnnotations([{ ...annotation, label: 'Home' }], canvas);
    const markerPoints = result.paths.filter((path) => path.channel.startsWith('marker')).flatMap((path) => path.points);
    const labelPoints = result.paths.filter((path) => path.channel === 'label').flatMap((path) => path.points);
    const midpoint = (points: typeof markerPoints) => {
      const y = points.map((point) => point.y);
      return (Math.min(...y) + Math.max(...y)) / 2;
    };

    expect(midpoint(labelPoints)).toBeCloseTo(midpoint(markerPoints), 8);
  });

  it('adds a rounded paper background and removes map strokes beneath it', () => {
    const boxed = { ...annotation, background: true, backgroundPaddingMm: 2, backgroundRadiusMm: 3 };
    const backgrounds = mapAnnotationBackgrounds([boxed], canvas);
    const result = generateMapAnnotations([boxed], canvas);
    const crossing = { id: 'road', layerId: 'roads', passId: 'pass-1', points: [{ x: 80, y: 145 }, { x: 150, y: 145 }] };
    const visible = maskPathsBehindMapAnnotations([crossing], [boxed], canvas);

    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0]!.polygon.length).toBeGreaterThan(8);
    expect(result.paths.some((path) => path.channel === 'annotation-background' && path.closed)).toBe(true);
    expect(visible.length).toBe(2);
    expect(visible.every((path) => path.preserveGaps)).toBe(true);
  });

  it('centres a map title and optional coordinate subtitle at either edge', () => {
    const top = generateMapTitle(title, mapBounds, canvas);
    const bottom = generateMapTitle({ ...title, position: 'bottom' }, mapBounds, canvas);
    const titlePoints = top.paths.filter((path) => path.channel === 'map-title').flatMap((path) => path.points);
    const centreX = (Math.min(...titlePoints.map((point) => point.x)) + Math.max(...titlePoints.map((point) => point.x))) / 2;

    expect(centreX).toBeCloseTo(canvas.widthMm / 2, 8);
    expect(top.paths.some((path) => path.channel === 'map-title-coordinates')).toBe(true);
    expect(Math.max(...top.paths.flatMap((path) => path.points).map((point) => point.y))).toBeLessThan(Math.min(...bottom.paths.flatMap((path) => path.points).map((point) => point.y)));
    expect(top.paths.every((path) => path.passId === 'pass-1' && path.layerId === 'map-title')).toBe(true);
    expect(formatMapCoordinates(mapBounds)).toBe('45.9200 N / 6.8700 E');
  });

  it('clears map detail behind the title block', () => {
    const background = mapTitleBackground(title, mapBounds, canvas)!;
    const y = (background[0]!.y + background[2]!.y) / 2;
    const crossing = { id: 'contour', layerId: 'contours', passId: 'pass-2', points: [{ x: 10, y }, { x: 200, y }] };
    const visible = maskPathsBehindMapTitle([crossing], title, mapBounds, canvas);

    expect(visible).toHaveLength(2);
    expect(visible.every((path) => path.preserveGaps)).toBe(true);
  });
});
