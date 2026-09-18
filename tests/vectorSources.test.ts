import { describe, expect, it } from 'vitest';
import { importedMapToLayers, type ImportedMap } from '../apps/web/src/vectorSources';

describe('map source fitting', () => {
  it('fits regions with more coordinates than the JavaScript argument limit', () => {
    const points = Array.from({ length: 150_000 }, (_, index): [number, number] => [
      1.2 + (index % 500) * 0.00001,
      52.6 + Math.floor(index / 500) * 0.00001,
    ]);
    const map: ImportedMap = {
      name: 'Large region',
      attribution: 'Test data',
      bounds: { north: 52.604, south: 52.599, east: 1.206, west: 1.199 },
      layers: [{ name: 'Roads', category: 'local-roads', features: [{ id: 'large-road', closed: false, points }] }],
    };

    const layers = importedMapToLayers(map, { preset: 'A4', orientation: 'portrait', widthMm: 210, heightMm: 297, marginMm: 10 }, ['pass-1']);

    expect(layers).toHaveLength(1);
    const fittedPoints = layers[0]?.sourcePaths?.flatMap((path) => path.points) ?? [];
    expect(fittedPoints.length).toBeGreaterThan(100_000);
    expect(fittedPoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(fittedPoints.every((point) => point.x >= 10 && point.x <= 200 && point.y >= 10 && point.y <= 287)).toBe(true);
  });

  it('crops crossing features to the selected coordinates and fills the drawable area', () => {
    const map: ImportedMap = {
      name: 'Selected region',
      attribution: 'Test data',
      bounds: { north: 1, south: 0, east: 1, west: 0 },
      layers: [{ name: 'Roads', category: 'local-roads', features: [
        { id: 'horizontal', closed: false, points: [[-1, 0.5], [2, 0.5]] },
        { id: 'vertical', closed: false, points: [[0.5, -1], [0.5, 2]] },
      ] }],
    };

    const layers = importedMapToLayers(map, { preset: 'custom', orientation: 'landscape', widthMm: 200, heightMm: 100, marginMm: 10 }, ['pass-1']);
    const paths = layers[0]?.sourcePaths ?? [];

    expect(paths).toHaveLength(2);
    expect(paths[0]?.points).toEqual([{ x: 10, y: 50 }, { x: 190, y: 50 }]);
    expect(paths[1]?.points).toEqual([{ x: 100, y: 90 }, { x: 100, y: 10 }]);
  });
});
