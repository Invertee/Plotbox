import { describe, expect, it } from 'vitest';
import { createDefaultState, reliefLayers, type TerrainData } from '@plotter/core';
import { generateRelief } from '@plotter/algorithms';
import { generateGCode } from '@plotter/gcode';

const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
const terrain: TerrainData = {
  width: 21, height: 21, bounds: { north: 0.02, south: 0, east: 0.02, west: 0 },
  elevations: Array.from({ length: 441 }, (_, i) => 100 + 400 * Math.exp(-((i % 21 - 10) ** 2 + (Math.floor(i / 21) - 10) ** 2) / 30)),
  water: [{ closed: true, points: [[0, 0], [0.005, 0], [0.005, 0.02], [0, 0.02], [0, 0]] }],
};

describe('isometric topography', () => {
  it('creates six editable pen passes and survives a saved-state round trip', () => {
    const state = createDefaultState('topography', canvas);
    state.mapSettings.terrain = terrain;
    state.mapSettings.importedShape = 'circle';
    const saved = JSON.parse(JSON.stringify(state));
    expect(saved.passes).toHaveLength(6);
    expect(saved.layers.map((l: { passId: string }) => l.passId)).toEqual(saved.passes.map((p: { id: string }) => p.id));
    expect(generateRelief(canvas, saved.mapSettings.terrain, { ...saved.mapSettings.relief, shape: saved.mapSettings.importedShape }, saved.layers).paths.length).toBeGreaterThan(50);
  });
  it('generates finite, paper-contained paths for each ink, with lifted gaps', () => {
    const result = generateRelief(canvas, terrain, {}, reliefLayers());
    expect(new Set(result.paths.map(p => p.passId)).size).toBe(6);
    for (const path of result.paths) {
      expect(path.preserveGaps).toBe(true);
      expect(path.points.length).toBeGreaterThan(1);
      for (const p of path.points) {
        expect(p.x).toBeGreaterThanOrEqual(canvas.marginMm - 1e-6);
        expect(p.x).toBeLessThanOrEqual(canvas.widthMm - canvas.marginMm + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(canvas.marginMm - 1e-6);
        expect(p.y).toBeLessThanOrEqual(canvas.heightMm - canvas.marginMm + 1e-6);
      }
    }
  });
  it('honours pass reassignment, hidden layers and rendering toggles', () => {
    const layers = reliefLayers().map(l => ({ ...l, visible: l.id !== 'relief-5', passId: 'custom-ink' }));
    const result = generateRelief(canvas, terrain, { water: false, bands: false }, layers);
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.paths.every(p => p.layerId === 'relief-3' && p.passId === 'custom-ink')).toBe(true);
  });
  it('crops a flat circular terrain and its ink strokes to the projected disk', () => {
    const flat = { ...terrain, elevations: terrain.elevations.map(() => 100) };
    const options = { shape: 'circle' as const, rotation: 0, tilt: 30, baseDepth: 0 };
    const result = generateRelief(canvas, flat, options, reliefLayers());
    for (const path of result.paths) for (const p of path.points) {
      const r = ((p.x - 105) / 95) ** 2 + ((p.y - 148.5) / 47.5) ** 2;
      expect(r).toBeLessThanOrEqual(1.001);
    }
  });
  it('exports the separate inks as finite machine paths with pen changes', () => {
    const state = createDefaultState('topography', canvas);
    const geometry = generateRelief(canvas, terrain, { spacing: 2 }, state.layers);
    const [document] = generateGCode('Relief', geometry, state.passes, state.pens, state.gcode, canvas.heightMm);
    expect(document!.content).not.toMatch(/NaN|Infinity/);
    expect(document!.content).toContain('M0');
    for (const pass of state.passes) expect(document!.content).toContain(pass.name);
  });
  it('handles a minimal circular grid without non-finite coordinates', () => {
    const data = { ...terrain, width: 2, height: 2, elevations: [0, 10, 0, 10] };
    const result = generateRelief(canvas, data, { shape: 'circle' }, reliefLayers());
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.paths.every(path => path.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))).toBe(true);
  });
  it('changes projection with angle and rejects incomplete elevation data', () => {
    expect(generateRelief(canvas, terrain, { rotation: 0 }, reliefLayers()).paths).not.toEqual(generateRelief(canvas, terrain, { rotation: 90 }, reliefLayers()).paths);
    expect(() => generateRelief(canvas, { ...terrain, elevations: [] }, {}, reliefLayers())).toThrow('valid terrain');
  });
  it('can cap the visible cut-wall depth without changing the terrain surface', () => {
    const layers = reliefLayers().map(layer => ({ ...layer, visible: layer.id === 'relief-5' }));
    const full = generateRelief(canvas, terrain, { exaggeration: 12, baseDepth: 10 }, layers);
    const clipped = generateRelief(canvas, terrain, { exaggeration: 12, baseDepth: 10, clipBaseDepth: true, maxBaseDepth: 3 }, layers);
    const inkLength = (geometry: typeof full) => geometry.paths.reduce((total, path) => total + path.points.slice(1).reduce((length, point, index) => length + Math.hypot(point.x - path.points[index]!.x, point.y - path.points[index]!.y), 0), 0);
    expect(inkLength(clipped)).toBeLessThan(inkLength(full));
    expect(clipped.paths.length).toBeGreaterThan(0);
  });
});
