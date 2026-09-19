import { describe, expect, it } from 'vitest';
import { algorithmDefaults, generateContinuousScribble } from '@plotter/algorithms';
import { pathLength } from '@plotter/geometry';
import { generateGCode, joinContinuousPaths } from '@plotter/gcode';

const bounds = { minX: 10, minY: 10, maxX: 42, maxY: 34 };

describe('continuous scribble', () => {
  it('leaves white and pale paper unplotted only when requested', () => {
    expect(algorithmDefaults('raster.continuous-scribble').skipWhite).toBe(false);
    for (const tone of [255, 245]) {
      expect(generateContinuousScribble(bounds, { skipWhite: true }, () => tone).paths).toEqual([]);
      expect(generateContinuousScribble(bounds, {}, () => tone).paths).toHaveLength(1);
    }
    expect(generateContinuousScribble(bounds, { skipWhite: true }, () => 220).paths.length).toBeGreaterThan(0);
  });

  it('clips loops and connecting lines at narrow white gaps and preserves pen lifts', () => {
    const sample = (x: number) => x > 24 && x < 24.2 ? 255 : 80;
    const result = generateContinuousScribble(bounds, { skipWhite: true }, sample);
    expect(result.paths.length).toBeGreaterThan(1);
    expect(joinContinuousPaths(result.paths, 100)).toHaveLength(result.paths.length);
    for (const path of result.paths) {
      expect(path.preserveGaps).toBe(true);
      for (let i = 0; i < path.points.length; i++) {
        const point = path.points[i]!;
        expect(sample(point.x)).toBeLessThan(240);
        if (i > 0) {
          const previous = path.points[i - 1]!;
          expect((previous.x <= 24 && point.x >= 24.2) || (point.x <= 24 && previous.x >= 24.2)).toBe(false);
        }
      }
    }
  });

  it('covers every highlight region with a single reproducible bounded path', () => {
    const first = generateContinuousScribble(bounds, {}, () => 255, 'ink');
    expect(first.paths).toHaveLength(1);
    expect(first.paths[0]!.passId).toBe('ink');
    expect(first.paths).toEqual(generateContinuousScribble(bounds, {}, () => 255, 'ink').paths);
    const occupied = new Set<string>();
    for (const p of first.paths[0]!.points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x >= 10 && p.x <= 42 && p.y >= 10 && p.y <= 34).toBe(true);
      occupied.add(`${Math.min(7, Math.floor((p.x - 10) / 4))},${Math.min(5, Math.floor((p.y - 10) / 4))}`);
    }
    expect(occupied.size).toBe(48);
    expect(first.paths).not.toEqual(generateContinuousScribble(bounds, { seed: 15 }, () => 255, 'ink').paths);
  });

  it('increases actual ink length monotonically from white through grey to black', () => {
    const lengths = [255, 192, 128, 64, 0].map(tone => pathLength(generateContinuousScribble(bounds, {}, () => tone).paths[0]!));
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThan(lengths[i - 1]!);
    expect(lengths[4]!).toBeGreaterThan(lengths[0]! * 2);
  });

  it('resolves small dark features without abandoning the pale background', () => {
    const points = generateContinuousScribble(bounds, { detailSize: 0.25 }, (x, y) => Math.abs(x - 26) < 0.6 && y > 14 && y < 30 ? 0 : 255).paths[0]!.points;
    const ink = (left: number, right: number) => {
      let total = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!; const b = points[i]!;
        if (a.x >= left && a.x <= right && b.x >= left && b.x <= right && a.y > 15 && a.y < 29) total += Math.hypot(b.x - a.x, b.y - a.y);
      }
      return total;
    };
    expect(ink(25.4, 26.6)).toBeGreaterThan(ink(17.4, 18.6) * 2);
    expect(ink(17.4, 18.6)).toBeGreaterThan(0);
  });

  it('exports with exactly one pen-down move', () => {
    const geometry = generateContinuousScribble(bounds, {}, x => x < 25 ? 20 : 240, 'ink');
    const [document] = generateGCode('Scribble', geometry,
      [{ id: 'ink', name: 'Ink', penId: 'pen', enabled: true }],
      [{ id: 'pen', name: 'Fine', color: '#000', widthMm: 0.15, zUp: 0, zDown: -2, xyFeed: 2000, zFeed: 500 }],
      { origin: 'top-left', travelFeed: 3000, parkX: 0, parkY: 0, pauseBetweenPasses: false, pauseCommand: 'M0', includeComments: false }, 50);
    expect(document!.content.match(/G1 Z-2 /g)).toHaveLength(1);
  });

  it('compensates shadow density for pen width while retaining a sparse highlight floor', () => {
    const thick = generateContinuousScribble(bounds, { penWidth: 0.3 }, () => 100).paths[0]!;
    const fine = generateContinuousScribble(bounds, { penWidth: 0.1 }, () => 100).paths[0]!;
    expect(pathLength(fine)).toBeGreaterThan(pathLength(thick) * 1.8);
    const white = generateContinuousScribble(bounds, {}, () => 255).paths[0]!;
    expect(pathLength(white) / (32 * 24)).toBeLessThan(0.9);
  });

  it('does not clamp loops into a dark rectangular frame', () => {
    const points = generateContinuousScribble(bounds, {}, () => 255).paths[0]!.points;
    const border = points.filter(p => p.x === bounds.minX || p.x === bounds.maxX || p.y === bounds.minY || p.y === bounds.maxY);
    expect(border.length / points.length).toBeLessThan(0.005);
  });

  it('handles empty and tiny bounds, malformed settings and reports completed coverage', () => {
    expect(generateContinuousScribble({ ...bounds, maxX: 9 }, {}, () => 0).paths).toEqual([]);
    let completed = 0;
    const tiny = generateContinuousScribble({ minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 }, { detailSize: NaN, seed: Infinity }, () => 0, 'ink', value => { completed = value; });
    expect(tiny.paths).toHaveLength(1);
    expect(completed).toBe(1);
    expect(algorithmDefaults('raster.continuous-scribble').detailSize).toBe(0.8);
    expect(() => generateContinuousScribble({ ...bounds, maxX: 10000 }, { detailSize: 0.25 }, () => 0)).toThrow('too large');
  });
});
