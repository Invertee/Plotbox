import { describe, expect, it } from 'vitest';
import { DEFAULT_BORDER, type CanvasSettings, type PlotGeometry } from '@plotter/core';
import { applyPlotBorder } from '@plotter/geometry';

const canvas: CanvasSettings = { preset: 'custom', orientation: 'landscape', widthMm: 100, heightMm: 80, marginMm: 5 };
const geometry: PlotGeometry = {
  generator: 'test',
  generatedAt: new Date(0).toISOString(),
  paths: [{ id: 'crossing', layerId: 'layer-1', passId: 'pass-1', points: [{ x: 0, y: 40 }, { x: 100, y: 40 }] }],
};

describe('plot borders', () => {
  it('leaves geometry unchanged when both border options are off', () => {
    expect(applyPlotBorder(geometry, canvas, DEFAULT_BORDER)).toBe(geometry);
  });

  it('cuts artwork out of the whitespace band', () => {
    const result = applyPlotBorder(geometry, canvas, { ...DEFAULT_BORDER, whitespace: true, insetMm: 10, whitespaceWidthMm: 8 });
    expect(result.paths).toHaveLength(3);
    expect(result.paths.map(path => path.points.map(point => point.x))).toEqual([[0, 10], [18, 82], [90, 100]]);
    expect(result.paths.every(path => path.preserveGaps)).toBe(true);
  });

  it('creates selectable plotted patterns on the requested pass', () => {
    const waves = applyPlotBorder({ ...geometry, paths: [] }, canvas, { ...DEFAULT_BORDER, enabled: true, pattern: 'waves', passId: 'pass-2' });
    expect(waves.paths).toHaveLength(1);
    expect(waves.paths[0]?.layerId).toBe('plot-border');
    expect(waves.paths[0]?.passId).toBe('pass-2');
    expect(waves.paths[0]?.points.length).toBeGreaterThan(20);

    const dots = applyPlotBorder({ ...geometry, paths: [] }, canvas, { ...DEFAULT_BORDER, enabled: true, pattern: 'dotted' });
    expect(dots.paths.length).toBeGreaterThan(10);
    expect(dots.paths.every(path => path.closed)).toBe(true);
  });
});
