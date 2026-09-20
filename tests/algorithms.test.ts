import { describe, expect, it } from 'vitest';
import { addPaintPressure, algorithmDefaults, generateAlgorithm, generateScanlines, generateSpiroglyph, generateSpiralBlocks, generateVectorLayers, traceRasterContours } from '@plotter/algorithms';
import type { PlotLayer } from '@plotter/core';
import { calculateImagePlacement, drawableBounds } from '@plotter/geometry';
import { turtleDraw } from 'turtletoy';

const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };

describe('generative algorithms', () => {
  it('keeps all test pattern paths inside the safe margin', () => {
    const result = generateAlgorithm('generative.test-pattern', canvas, { spacing: 15 }, ['one', 'two']);
    expect(result.paths.length).toBeGreaterThan(20);
    for (const point of result.paths.flatMap((path) => path.points)) {
      expect(point.x).toBeGreaterThanOrEqual(10);
      expect(point.x).toBeLessThanOrEqual(200);
      expect(point.y).toBeGreaterThanOrEqual(10);
      expect(point.y).toBeLessThanOrEqual(287);
    }
  });

  it('produces repeatable seeded flow fields', () => {
    const settings = { seed: 12, particles: 20, steps: 12, stepSize: 1, fieldScale: 30 };
    const first = generateAlgorithm('generative.flow-field', canvas, settings, ['one', 'two']);
    const second = generateAlgorithm('generative.flow-field', canvas, settings, ['one', 'two']);
    expect(first.paths.map((path) => path.points)).toEqual(second.paths.map((path) => path.points));
  });

  it('can emit multiple output channels', () => {
    const result = generateAlgorithm('generative.truchet', canvas, { seed: 1, tileSize: 20, density: 1 }, ['black', 'blue']);
    expect(new Set(result.paths.map((path) => path.passId))).toEqual(new Set(['black', 'blue']));
  });
});

describe('raster placement', () => {
  const bounds = drawableBounds(210, 297, 10);

  it('contains a landscape image without distorting it', () => {
    const placement = calculateImagePlacement(1600, 900, bounds, { fit: 'contain', scalePercent: 100, offsetXmm: 0, offsetYmm: 0 });
    expect(placement.width).toBeCloseTo(190);
    expect(placement.height).toBeCloseTo(106.875);
    expect(placement.x).toBeCloseTo(10);
  });

  it('supports cover, stretch, scale and offsets', () => {
    const cover = calculateImagePlacement(1600, 900, bounds, { fit: 'cover', scalePercent: 100, offsetXmm: 0, offsetYmm: 0 });
    expect(cover.height).toBeCloseTo(277);
    expect(cover.width).toBeGreaterThan(190);
    const stretch = calculateImagePlacement(1600, 900, bounds, { fit: 'stretch', scalePercent: 50, offsetXmm: 4, offsetYmm: -3 });
    expect(stretch).toMatchObject({ width: 95, height: 138.5 });
    expect(stretch.x).toBeCloseTo(61.5);
  });
});

describe('spiroglyph raster generation', () => {
  const bounds = drawableBounds(210, 297, 10);

  it('produces one continuous spiral inside the safe area', () => {
    const result = generateSpiroglyph(bounds, { lineSpacing: 2, frequency: 36, amplitude: 0.8, smoothing: 6 }, (x, y) => x + y > 220 ? 235 : 30, 'black');
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.points.length).toBeGreaterThan(5_000);
    expect(result.paths[0]?.passId).toBe('black');
    for (const point of result.paths[0]!.points) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(point.x).toBeLessThanOrEqual(bounds.maxX);
      expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(point.y).toBeLessThanOrEqual(bounds.maxY);
    }
  });

  it('uses tone thresholds to change the wave displacement', () => {
    const settings = { lineSpacing: 3, frequency: 12, amplitude: 2, minimumAmplitude: 0, smoothing: 0, shadowThreshold: 40, highlightThreshold: 210, sampleStep: 1 };
    const dark = generateSpiroglyph(bounds, settings, () => 0).paths[0]!.points;
    const light = generateSpiroglyph(bounds, settings, () => 255).paths[0]!.points;
    expect(dark.some((point, index) => Math.hypot(point.x - light[index]!.x, point.y - light[index]!.y) > 1)).toBe(true);
  });

  it('reserves the requested gap between neighboring wave turns', () => {
    const settings = { lineSpacing: 2, frequency: 12, amplitude: 8, minimumGap: 0.4, smoothing: 0, sampleStep: 0.6 };
    const dark = generateSpiroglyph(bounds, settings, () => 0).paths[0]!.points;
    const baseline = generateSpiroglyph(bounds, settings, () => 255).paths[0]!.points;
    expect(dark).toHaveLength(baseline.length);
    expect(Math.max(...dark.map((point, index) => Math.hypot(point.x - baseline[index]!.x, point.y - baseline[index]!.y)))).toBeLessThanOrEqual(0.801);
  });

  it('creates interleaved spiroglyph arms on separate colour passes', () => {
    const result = generateSpiroglyph(bounds, { spiralCount: 2, shape: 'circle', lineSpacing: 3, frequency: 12, amplitude: 0, sampleStep: 1 }, () => 255, ['black', 'red']);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.map(item => item.passId)).toEqual(['black', 'red']);
    expect(result.paths.map(item => item.channel)).toEqual(['spiral-1', 'spiral-2']);
    expect(Math.hypot(
      result.paths[0]!.points[0]!.x - result.paths[1]!.points[0]!.x,
      result.paths[0]!.points[0]!.y - result.paths[1]!.points[0]!.y,
    )).toBeCloseTo(3, 5);
  });

  it('creates block tones as one continuous plotter path', () => {
    const settings = { lineSpacing: 3, blockSpacing: 0.8, blockWidth: 2.5, minimumGap: 0.5, smoothing: 0 };
    const dark = generateSpiralBlocks(bounds, settings, () => 0, 'black');
    const light = generateSpiralBlocks(bounds, settings, () => 255, 'black');
    expect(dark.paths).toHaveLength(1);
    expect(dark.paths[0]?.passId).toBe('black');
    expect(dark.paths[0]!.points.length).toBeGreaterThan(light.paths[0]!.points.length * 2);
    for (const point of dark.paths[0]!.points) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(point.x).toBeLessThanOrEqual(bounds.maxX);
      expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(point.y).toBeLessThanOrEqual(bounds.maxY);
    }
  });

  it('creates interleaved spiral-block arms and cycles available colours', () => {
    const result = generateSpiralBlocks(bounds, { spiralCount: 3, lineSpacing: 3, blockSpacing: 1, blockWidth: 1 }, () => 0, ['black', 'red']);
    expect(result.paths).toHaveLength(3);
    expect(result.paths.map(item => item.passId)).toEqual(['black', 'red', 'black']);
    expect(result.paths.every(item => item.points.length > 100)).toBe(true);
  });
});

describe('scanline raster generation', () => {
  const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 20 };

  it('offers wave and block output controls', () => {
    expect(algorithmDefaults('raster.scanlines')).toMatchObject({
      style: 'waves', spacing: 2, angle: 0, maximumWidth: 1.2,
      waveLength: 3.7, blockSpacing: 0.55, minimumGap: 0.35,
    });
  });

  it('creates tone-controlled blocks along every scanline', () => {
    const settings = { style: 'blocks', spacing: 3, blockSpacing: 1, maximumWidth: 2.5, minimumGap: 0.5, smoothing: 0 };
    const dark = generateScanlines(bounds, settings, () => 0, 'black');
    const light = generateScanlines(bounds, settings, () => 255, 'black');
    expect(dark.paths.length).toBeGreaterThan(4);
    expect(dark.paths).toHaveLength(light.paths.length);
    expect(dark.paths[0]?.passId).toBe('black');
    expect(dark.paths.flatMap(item => item.points).length).toBeGreaterThan(light.paths.flatMap(item => item.points).length * 2);
    for (const point of dark.paths.flatMap(item => item.points)) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(point.x).toBeLessThanOrEqual(bounds.maxX);
      expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(point.y).toBeLessThanOrEqual(bounds.maxY);
    }
  });

  it('supports angled lines and caps wave width to preserve the minimum gap', () => {
    const vertical = generateScanlines(bounds, { style: 'waves', spacing: 3, angle: 90, maximumWidth: 0, sampleStep: 1 }, () => 255);
    const first = vertical.paths.find(item => item.points.length > 5)!.points;
    expect(Math.max(...first.map(point => point.y)) - Math.min(...first.map(point => point.y))).toBeGreaterThan(10);
    expect(Math.max(...first.map(point => point.x)) - Math.min(...first.map(point => point.x))).toBeLessThan(0.001);

    const settings = { style: 'waves', spacing: 2, maximumWidth: 8, minimumGap: 0.6, waveLength: 4, sampleStep: 0.5, smoothing: 0 };
    const dark = generateScanlines(bounds, settings, () => 0).paths;
    const light = generateScanlines(bounds, settings, () => 255).paths;
    expect(dark).toHaveLength(light.length);
    const displacement = dark.flatMap((item, row) => item.points.map((point, index) => Math.hypot(point.x - light[row]!.points[index]!.x, point.y - light[row]!.points[index]!.y)));
    expect(Math.max(...displacement)).toBeLessThanOrEqual(0.701);
  });
});

describe('paint pressure generation', () => {
  it('maps image tone into the configured normalised pressure range', () => {
    const source = {
      generator: 'source', generatedAt: '',
      paths: [{ id: 'line', layerId: 'layer-1', passId: 'pass-1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }],
    };
    const painted = addPaintPressure(source, (x) => x === 0 ? 255 : 0, { minimumPressure: 0.2, maximumPressure: 0.9 }, 'raster.paint-scanlines');
    expect(painted.generator).toBe('raster.paint-scanlines');
    expect(painted.paths[0]!.points[0]!.pressure).toBeCloseTo(0.2);
    expect(painted.paths[0]!.points[1]!.pressure).toBeCloseTo(0.9);
    expect(algorithmDefaults('raster.paint-scribble')).toMatchObject({ minimumPressure: 0.1, maximumPressure: 1 });
  });
});

describe('raster contour tracing', () => {
  it('follows line direction instead of producing horizontal scan-line blocks', () => {
    const width = 24;
    const height = 24;
    const pixels = new Float32Array(width * height).fill(255);
    for (let index = 4; index < 20; index += 1) {
      pixels[index * width + index] = 0;
      pixels[index * width + index + 1] = 0;
    }
    const paths = traceRasterContours(pixels, width, height, { threshold: 40, minimumPoints: 3 });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((path) => {
      const first = path[0]!;
      const last = path[path.length - 1]!;
      return Math.abs(last.x - first.x) > 5 && Math.abs(last.y - first.y) > 5;
    })).toBe(true);
  });

  it('does not create contours in a flat image', () => {
    expect(traceRasterContours(new Float32Array(100).fill(128), 10, 10)).toEqual([]);
  });

  it('registers contour controls separately from legacy edge drawing', () => {
    expect(algorithmDefaults('raster.edge')).toEqual({ edgeThreshold: 70 });
    expect(algorithmDefaults('raster.contours')).toMatchObject({ edgeThreshold: 55, minimumLength: 1, simplification: 0.15 });
  });
});

describe('TurtleToy integration', () => {
  it('keeps the first draw line by default', () => {
    expect(algorithmDefaults('generative.turtle').ignoreFirstDraw).toBe(false);
  });

  it('runs standard TurtleToy code with a walk function', () => {
    const lines: number[][] = [];
    turtleDraw(`
      Canvas.setpenopacity(1);
      const turtle = new Turtle();
      turtle.penup();
      turtle.goto(-50, -20);
      turtle.pendown();
      function walk(i) {
        turtle.forward(100);
        turtle.right(144);
        return i < 4;
      }
    `, { onDrawLine: (x1, y1, x2, y2) => lines.push([x1, y1, x2, y2]) });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual([-50, -20, 50, -20]);
  });
});

describe('SVG and map layer treatments', () => {
  const square = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }];

  it('preserves source paths for outline layers', () => {
    const layers: PlotLayer[] = [{ id: 'buildings', name: 'Buildings', visible: true, algorithmId: 'vector.outline', passId: 'black', sourcePaths: [{ id: 'square', closed: true, points: square }] }];
    const result = generateVectorLayers(layers);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({ layerId: 'buildings', passId: 'black', closed: true });
  });

  it('hatches closed regions and sends the second angle to another pass', () => {
    const layers: PlotLayer[] = [{ id: 'water', name: 'Water', visible: true, algorithmId: 'vector.crosshatch', passId: 'blue', secondaryPassId: 'black', algorithmSettings: { spacing: 5, angle: 0, secondAngle: 90 }, sourcePaths: [{ id: 'square', closed: true, points: square }] }];
    const result = generateVectorLayers(layers);
    expect(result.paths.length).toBeGreaterThan(10);
    expect(new Set(result.paths.map((path) => path.passId))).toEqual(new Set(['blue', 'black']));
    for (const point of result.paths.flatMap((path) => path.points)) {
      expect(point.x).toBeGreaterThanOrEqual(9.999);
      expect(point.x).toBeLessThanOrEqual(50.001);
      expect(point.y).toBeGreaterThanOrEqual(9.999);
      expect(point.y).toBeLessThanOrEqual(50.001);
    }
  });

  it('does not emit hidden layers', () => {
    const layers: PlotLayer[] = [{ id: 'hidden', name: 'Hidden', visible: false, algorithmId: 'vector.outline', passId: 'black', sourcePaths: [{ id: 'square', closed: true, points: square }] }];
    expect(generateVectorLayers(layers).paths).toHaveLength(0);
  });

  it('supports cross and round stipple marks', () => {
    const common = { id: 'marks', name: 'Marks', visible: true, algorithmId: 'vector.stipple', passId: 'black', algorithmSettings: { spacing: 20, density: 1, markSize: 2, seed: 3 }, sourcePaths: [{ id: 'square', closed: true, points: square }] } satisfies PlotLayer;
    const crosses = generateVectorLayers([{ ...common, algorithmSettings: { ...common.algorithmSettings, markStyle: 'cross' } }]);
    const rings = generateVectorLayers([{ ...common, algorithmSettings: { ...common.algorithmSettings, markStyle: 'ring' } }]);
    expect(crosses.paths.length).toBeGreaterThan(rings.paths.length);
    expect(rings.paths.every((path) => path.closed)).toBe(true);
  });
});
