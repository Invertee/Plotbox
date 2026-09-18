import { describe, expect, it } from 'vitest';
import { separateColours, generateColourSeparation, ensureColourPasses, colourPassId } from '@plotter/algorithms';
import { createDefaultState, DEFAULT_RASTER_PLACEMENT, type ColourSeparationSettings } from '@plotter/core';
import { generateGCode, joinContinuousPaths } from '@plotter/gcode';

const canvas = { preset: 'custom' as const, orientation: 'landscape' as const, widthMm: 20, heightMm: 20, marginMm: 0 };
const settings = { colourCount: 3, minRegionPixels: 1, cleanEdges: false };
function pixels(rows: string[]) {
  const colours: Record<string, number[]> = { R: [220, 40, 30, 255], B: [30, 80, 220, 255], '.': [250, 249, 248, 255], T: [0, 0, 0, 0] };
  return { width: rows[0]!.length, height: rows.length, data: new Uint8ClampedArray(rows.flatMap(row => [...row].flatMap(c => colours[c]!))) };
}
const render = (image: ReturnType<typeof pixels>, config?: ColourSeparationSettings, width = 0.3) => {
  const initial = createDefaultState('raster', canvas);
  const palette = separateColours(image, settings).palette;
  const { pens, passes } = ensureColourPasses(palette, initial.passes, initial.pens);
  return generateColourSeparation(image, canvas, DEFAULT_RASTER_PLACEMENT, settings, config, passes, pens.map(p => ({ ...p, widthMm: width })));
};

describe('colour separation', () => {
  it('uses a deterministic palette and splits disconnected pieces of the same colour', () => {
    const image = pixels(['RR.BB', 'RR.BB', '.....', 'RR.TT']);
    const a = separateColours(image, settings); const b = separateColours(image, settings);
    expect(a.palette).toHaveLength(2); expect(a.regions).toHaveLength(3);
    expect(a.palette).toEqual(b.palette); expect(a.regionLabels).toEqual(b.regionLabels);
    expect(a.palette.reduce((n, p) => n + p.pixels, 0)).toBe(10);
    expect(a.regions[0]!.colourId).toBe(a.regions[2]!.colourId);
  });
  it('keeps transparent and paper pixels blank, and can include paper explicitly', () => {
    const image = pixels(['R.T']);
    expect(separateColours(image, settings).palette).toHaveLength(1);
    const result = separateColours(image, { ...settings, skipPaper: false });
    expect(result.palette).toHaveLength(2); expect(result.regionLabels[2]).toBeLessThan(0);
    expect(render(pixels(['TT', '..'])).paths).toHaveLength(0);
    const warmPaper = { width: 1, height: 1, data: new Uint8ClampedArray([247, 243, 237, 255]) };
    expect(separateColours(warmPaper, settings).regions).toHaveLength(0);
  });
  it('removes small components while preserving larger shapes', () => {
    const result = separateColours(pixels(['RR.B', 'RR..']), { ...settings, minRegionPixels: 2 });
    expect(result.regions).toHaveLength(1); expect(result.regions[0]!.pixels).toBe(4);
  });
  it('clips hatching around an interior hole, including through G-code path joining', () => {
    const image = pixels(['RRRRR', 'R...R', 'R...R', 'R...R', 'RRRRR']);
    const colour = separateColours(image, settings).palette[0]!.id;
    const result = render(image, { colours: { [colour]: { angle: 0, spacing: 1 } }, regions: {} });
    expect(result.paths.length).toBeGreaterThan(20);
    for (const path of result.paths) {
      const [a, b] = path.points;
      if (a!.y > 4 && a!.y < 16) expect(b!.x <= 4 || a!.x >= 16).toBe(true);
    }
    expect(joinContinuousPaths(result.paths, 20)).toHaveLength(result.paths.length);
  });
  it('applies colour defaults and overrides only the selected piece', () => {
    const image = pixels(['RR..RR', 'RR..RR']);
    const { regions } = separateColours(image, settings);
    const result = render(image, { colours: { [regions[0]!.colourId]: { fill: 'crosshatch', passId: 'custom' } }, regions: { [regions[1]!.id]: { enabled: false } } });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(new Set(result.paths.map(p => p.channel))).toEqual(new Set([regions[0]!.id]));
    expect(new Set(result.paths.map(p => p.passId))).toEqual(new Set(['custom']));
  });
  it('keeps angled fill segments inside their own colour, including concave edges and holes', () => {
    const image = pixels(['RRRRBB', 'R..RBB', 'RRRRBB', '..RRBB', 'RRRRBB', 'RR..BB']);
    const separated = separateColours(image, settings);
    for (const angle of [0, 30, 45, 89, 135]) {
      const config = { colours: Object.fromEntries(separated.palette.map(p => [p.id, { angle, spacing: 0.8 }])), regions: {} };
      const result = render(image, config);
      for (const path of result.paths) {
        const [a, b] = path.points;
        for (let t = 0.01; t < 1; t += 0.05) {
          const x = Math.floor((a!.x + (b!.x - a!.x) * t) / 20 * image.width);
          const y = Math.floor((a!.y + (b!.y - a!.y) * t) / 20 * image.height);
          const regionIndex = separated.regionLabels[y * image.width + x]!;
          expect(separated.regions[regionIndex]?.id).toBe(path.channel);
        }
      }
    }
  });
  it('uses pen width for dense fill and clips cover placement to the safe area', () => {
    const image = pixels(['RRRR', 'RRRR']);
    const config: ColourSeparationSettings = { colours: { '0': { fill: 'solid', angle: 0 } }, regions: {} };
    expect(render(image, config, 0.2).paths.length).toBeGreaterThan(render(image, config, 0.8).paths.length);
    const result = generateColourSeparation(image, canvas, { ...DEFAULT_RASTER_PLACEMENT, fit: 'cover', offsetXmm: 4 }, settings, config, [], []);
    for (const point of result.paths.flatMap(p => p.points)) { expect(point.x).toBeGreaterThanOrEqual(-1e-8); expect(point.x).toBeLessThanOrEqual(20 + 1e-8); expect(point.y).toBeGreaterThanOrEqual(-1e-8); expect(point.y).toBeLessThanOrEqual(20 + 1e-8); }
  });
  it('supports tone-based treatments per colour while keeping every mark inside its piece', () => {
    const image = pixels(['RRRRR', 'R...R', 'R...R', 'R...R', 'RRRRR']);
    const separated = separateColours(image, settings);
    const colourId = separated.palette[0]!.id;
    const treatments = [
      { fill: 'dither' as const, algorithmSettings: { spacing: 0.8, markSize: 1.2, markStyle: 'ring', overlap: 0.4, seed: 17 } },
      { fill: 'stipple' as const, algorithmSettings: { count: 1200, markSize: 1.2, markStyle: 'cross', overlap: 0.4, tonePower: 1, seed: 17 } },
      { fill: 'tonal-dashes' as const, algorithmSettings: { spacing: 0.8, density: 2, dashLength: 5, minDashLength: 1, angle: 30, angleVariation: 40, overlap: 0.5, tonePower: 1, seed: 17 } },
    ];
    for (const treatment of treatments) {
      const config: ColourSeparationSettings = { colours: { [colourId]: treatment }, regions: {} };
      const first = render(image, config);
      const second = render(image, config);
      expect(first.paths.length).toBeGreaterThan(0);
      expect(first.paths).toEqual(second.paths);
      for (const path of first.paths) {
        for (let segment = 0; segment + 1 < path.points.length; segment++) {
          const a = path.points[segment]!; const b = path.points[segment + 1]!;
          for (let t = 0.01; t < 1; t += 0.1) {
            const x = Math.floor((a.x + (b.x - a.x) * t) / 20 * image.width);
            const y = Math.floor((a.y + (b.y - a.y) * t) / 20 * image.height);
            const regionIndex = separated.regionLabels[y * image.width + x]!;
            expect(separated.regions[regionIndex]?.id).toBe(path.channel);
          }
        }
      }
    }
  });
  it('allows one piece to override its colour with a tone-based treatment', () => {
    const image = pixels(['RR..RR', 'RR..RR']);
    const separated = separateColours(image, settings);
    const [selected] = separated.regions;
    const result = render(image, {
      colours: { [selected!.colourId]: { fill: 'none', algorithmSettings: { markStyle: 'cross', markSize: 0.8, overlap: 0, seed: 29 } } },
      regions: { [selected!.id]: { fill: 'dither', algorithmSettings: { spacing: 0.6 } } },
    });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(new Set(result.paths.map(path => path.channel))).toEqual(new Set([selected!.id]));
  });
  it('creates calibrated passes once and exports a separate file per detected colour', () => {
    const image = pixels(['RRBB', 'RRBB']);
    const result = render(image);
    const state = createDefaultState('raster', canvas);
    state.pens[0]!.zDown = -2;
    const first = ensureColourPasses(result.colourSeparation!.palette, state.passes, state.pens);
    expect(first.pens.at(-1)!.zDown).toBe(-2);
    first.pens.at(-1)!.color = '#123456';
    expect(ensureColourPasses(result.colourSeparation!.palette, first.passes, first.pens)).toEqual(first);
    const usedPasses = first.passes.filter(p => result.paths.some(path => path.passId === p.id));
    const docs = generateGCode('Colours', result, usedPasses, first.pens, state.gcode, canvas.heightMm, true);
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map(d => d.passId))).toEqual(new Set(result.colourSeparation!.palette.map(p => colourPassId(p.id))));
  });
});
