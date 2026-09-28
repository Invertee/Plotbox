import { describe, expect, it } from 'vitest';
import { algorithmDefaults, generateTonalAreaFill } from '@plotter/algorithms';

const layout = {
  bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
  placement: { x: 0, y: 0, width: 20, height: 20 },
  passId: 'black',
};

describe('tonal area fill', () => {
  it('clips fill strokes to connected dark areas', () => {
    const width = 20;
    const height = 20;
    const luminance = new Float32Array(width * height).fill(255);
    for (let y = 5; y < 15; y += 1) for (let x = 5; x < 15; x += 1) luminance[y * width + x] = 0;
    const result = generateTonalAreaFill(luminance, width, height, {
      ...layout,
      levels: 1,
      spacing: 1,
      angle: 0,
      closeRadius: 0,
      minimumRegionPixels: 1,
      includeContours: false,
    });

    expect(result.generator).toBe('raster.tonal-area-fill');
    expect(result.paths.length).toBeGreaterThan(5);
    expect(result.paths.every(path => path.channel === 'fill-1')).toBe(true);
    expect(result.paths.flatMap(path => path.points).every(point => point.x >= 5 && point.x <= 15 && point.y >= 5 && point.y <= 15)).toBe(true);
  });

  it('adds nested fill directions only to successively darker tones', () => {
    const width = 20;
    const height = 10;
    const luminance = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) luminance[y * width + x] = x < 10 ? 0 : 150;
    const result = generateTonalAreaFill(luminance, width, height, {
      ...layout,
      placement: { ...layout.placement, height: 10 },
      bounds: { ...layout.bounds, maxY: 10 },
      levels: 2,
      highlightThreshold: 220,
      shadowThreshold: 70,
      spacing: 2,
      angle: 0,
      angleStep: 90,
      closeRadius: 0,
      minimumRegionPixels: 1,
      includeContours: false,
    });

    const lightFill = result.paths.filter(path => path.channel === 'fill-1');
    const darkFill = result.paths.filter(path => path.channel === 'fill-2');
    expect(lightFill.length).toBeGreaterThan(0);
    expect(darkFill.length).toBeGreaterThan(0);
    expect(lightFill.flatMap(path => path.points).some(point => point.x > 10)).toBe(true);
    expect(darkFill.flatMap(path => path.points).every(point => point.x <= 10)).toBe(true);
  });

  it('removes isolated specks smaller than the selected area', () => {
    const luminance = new Float32Array(20 * 20).fill(255);
    luminance[10 * 20 + 10] = 0;
    const result = generateTonalAreaFill(luminance, 20, 20, {
      ...layout,
      levels: 1,
      spacing: 0.5,
      closeRadius: 0,
      minimumRegionPixels: 2,
      includeContours: false,
    });
    expect(result.paths).toEqual([]);
  });

  it('registers practical defaults for region fills and detail edges', () => {
    expect(algorithmDefaults('raster.tonal-area-fill')).toMatchObject({
      levels: 3,
      spacing: 0.55,
      closeRadius: 1,
      includeContours: true,
      edgeThreshold: 55,
    });
  });
});

