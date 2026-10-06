import { describe, expect, it } from 'vitest';
import { algorithmDefaults, generateStraightLinePortrait } from '@plotter/algorithms';

const bounds = { minX: 10, minY: 10, maxX: 42, maxY: 34 };
const black = { id: 'black', penWidth: 0.3 };
const blue = { id: 'blue', penWidth: 0.2 };

describe('straight line portrait', () => {
  it('creates reproducible straight strokes with more coverage in dark tones', () => {
    const settings = algorithmDefaults('raster.straight-lines');
    const white = generateStraightLinePortrait(bounds, settings, () => 255, black);
    const mid = generateStraightLinePortrait(bounds, settings, () => 128, black);
    const dark = generateStraightLinePortrait(bounds, settings, () => 0, black);
    expect(white.paths).toEqual([]);
    expect(dark.paths.length).toBeGreaterThan(mid.paths.length * 2);
    expect(mid.paths.length).toBeGreaterThan(0);
    expect(dark.paths).toEqual(generateStraightLinePortrait(bounds, settings, () => 0, black).paths);
    expect(dark.paths.every(path => path.points.length === 2 && path.passId === 'black')).toBe(true);
  });

  it('clips strokes to the page and stops at blank image gaps', () => {
    const sample = (x: number) => x >= 25 && x <= 26 ? 255 : 0;
    const result = generateStraightLinePortrait(bounds, { lineLength: 7, detailSize: 0.5 }, sample, black);
    expect(result.paths.length).toBeGreaterThan(0);
    for (const path of result.paths) {
      const [start, end] = path.points;
      expect(start!.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(end!.x).toBeLessThanOrEqual(bounds.maxX);
      expect(start!.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(end!.y).toBeLessThanOrEqual(bounds.maxY);
      expect(start!.x < 25 && end!.x > 26).toBe(false);
      expect(end!.x < 25 && start!.x > 26).toBe(false);
    }
  });

  it('puts definition strokes on an independent pass and follows its pen width', () => {
    const source = (x: number) => x < 26 ? 20 : 200;
    const settings = { secondPass: true, definitionStrength: 1.2 };
    const thin = generateStraightLinePortrait(bounds, settings, source, black, blue);
    const thick = generateStraightLinePortrait(bounds, settings, source, black, { ...blue, penWidth: 0.6 });
    const primary = thin.paths.filter(path => path.passId === 'black');
    const definition = thin.paths.filter(path => path.passId === 'blue');
    expect(primary.length).toBeGreaterThan(0);
    expect(definition.length).toBeGreaterThan(0);
    expect(definition.length).toBeGreaterThan(thick.paths.filter(path => path.passId === 'blue').length);
    expect(definition.filter(path => path.points[0]!.x < 26).length).toBeGreaterThan(definition.filter(path => path.points[0]!.x >= 26).length * 3);
    expect(thin.paths.some(path => path.channel === 'definition')).toBe(true);
    expect(generateStraightLinePortrait(bounds, settings, source, black).paths.every(path => path.passId === 'black')).toBe(true);
  });
});
