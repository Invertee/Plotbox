import { describe, expect, it } from 'vitest';
import { cropMapCircle } from '@plotter/geometry';
import { boundsForView, dimensionsForBounds } from '../apps/web/src/components/MapRegionPicker';
import { importedMapToLayers, type ImportedMap } from '../apps/web/src/vectorSources';

describe('map selection shapes', () => {
  it('selects equal geographic width and height for square and circle footprints', () => {
    for (const shape of ['square', 'circle'] as const) {
      const d = dimensionsForBounds(boundsForView({ latitude: 54.6, longitude: -5.9, zoom: 13 }, 190 / 277, shape));
      expect(d.widthKm / d.heightKm).toBeCloseTo(1, 4);
    }
    const d = dimensionsForBounds(boundsForView({ latitude: 54.6, longitude: -5.9, zoom: 13 }, 190 / 277));
    expect(d.widthKm / d.heightKm).toBeCloseTo(190 / 277, 4);
  });
  it('clips a crossing line even when both endpoints lie outside the circle', () => {
    const paths = cropMapCircle([{ id: 'road', closed: false, points: [{ x: -2, y: 0 }, { x: 2, y: 0 }] }], { x: 0, y: 0 }, 1);
    expect(paths[0]?.points).toEqual([{ x: -1, y: 0 }, { x: 1, y: 0 }]);
    expect(cropMapCircle([{ id: 'road', closed: false, points: [{ x: -2, y: 2 }, { x: 2, y: 2 }] }], { x: 0, y: 0 }, 1)).toEqual([]);
  });
  it('preserves a closed water area covering the entire circular map for filling', () => {
    const paths = cropMapCircle([{ id: 'lake', closed: true, points: [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }] }], { x: 0, y: 0 }, 1);
    expect(paths[0]?.closed).toBe(true);
    expect(paths[0]?.points.length).toBe(128);
    expect(paths[0]?.points.every(p => Math.hypot(p.x, p.y) <= 1.000001)).toBe(true);
  });
  it('centres square and round maps on portrait paper without stretching', () => {
    const map: ImportedMap = { name: 'fixture', attribution: '', bounds: { north: 1, south: 0, east: 1, west: 0 }, layers: [{ name: 'Water', category: 'water', features: [{ id: 'lake', closed: true, points: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] }] }] };
    const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
    const square = importedMapToLayers(map, canvas, ['ink'], 'square')[0]!.sourcePaths![0]!.points;
    expect(Math.min(...square.map(p => p.x))).toBeCloseTo(10);
    expect(Math.min(...square.map(p => p.y))).toBeCloseTo(53.5);
    const circle = importedMapToLayers(map, canvas, ['ink'], 'circle')[0]!.sourcePaths![0]!;
    expect(circle.closed).toBe(true);
    expect(circle.points.every(p => Math.hypot(p.x - 105, p.y - 148.5) <= 95.00001)).toBe(true);
  });
});
