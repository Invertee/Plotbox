import { describe, expect, it } from 'vitest';
import { algorithmDefaults, colourPassId, ensureColourPasses, generateColourTonalAreaFill } from '@plotter/algorithms';
import { createDefaultState } from '@plotter/core';

function colourBands() {
  const width = 12;
  const height = 6;
  const data = new Uint8ClampedArray(width * height * 4);
  const luminance = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = x < 4 ? [255, 0, 0] : x < 8 ? [255, 255, 255] : [0, 0, 255];
      const offset = (y * width + x) * 4;
      data[offset] = colour[0]!;
      data[offset + 1] = colour[1]!;
      data[offset + 2] = colour[2]!;
      data[offset + 3] = 255;
      luminance[y * width + x] = colour[0]! * 0.2126 + colour[1]! * 0.7152 + colour[2]! * 0.0722;
    }
  }
  return { image: { width, height, data }, luminance };
}

describe('colour tonal area fill', () => {
  it('creates separate pen passes without letting fill cross colour boundaries', () => {
    const { image, luminance } = colourBands();
    const result = generateColourTonalAreaFill(image, luminance, {
      bounds: { minX: 0, minY: 0, maxX: 12, maxY: 6 },
      placement: { x: 0, y: 0, width: 12, height: 6 },
      settings: {
        colourCount: 2,
        minRegionPixels: 1,
        skipPaper: true,
        levels: 1,
        highlightThreshold: 250,
        spacing: 1,
        angle: 0,
        closeRadius: 1,
        minimumRegionPixels: 1,
        includeContours: false,
      },
    });

    expect(result.generator).toBe('raster.colour-tonal-area-fill');
    expect(result.colourSeparation?.palette).toHaveLength(2);
    expect(new Set(result.paths.map(path => path.passId))).toEqual(new Set(result.colourSeparation!.palette.map(colour => colourPassId(colour.id))));
    expect(result.paths.flatMap(path => path.points).every(point => point.x <= 4 || point.x >= 8)).toBe(true);
  });

  it('creates editable automatic pens for the separated palette', () => {
    const { image, luminance } = colourBands();
    const result = generateColourTonalAreaFill(image, luminance, {
      bounds: { minX: 0, minY: 0, maxX: 12, maxY: 6 },
      placement: { x: 0, y: 0, width: 12, height: 6 },
      settings: { colourCount: 2, minRegionPixels: 1, skipPaper: true, levels: 1 },
    });
    const state = createDefaultState('raster', { preset: 'custom', orientation: 'landscape', widthMm: 12, heightMm: 6, marginMm: 0 });
    const synced = ensureColourPasses(result.colourSeparation!.palette, state.passes, state.pens);
    expect(synced.passes.filter(pass => pass.id.startsWith('colour-pass-'))).toHaveLength(2);
    expect(synced.pens.filter(pen => pen.id.startsWith('colour-pen-')).map(pen => pen.color)).toEqual(result.colourSeparation!.palette.map(colour => colour.colour));
  });

  it('registers colour separation and tonal controls independently', () => {
    expect(algorithmDefaults('raster.colour-tonal-area-fill')).toMatchObject({
      colourCount: 6,
      minRegionPixels: 12,
      levels: 3,
      highlightThreshold: 250,
      spacing: 0.55,
      includeContours: true,
    });
  });
});
