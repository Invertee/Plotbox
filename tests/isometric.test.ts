import { describe, expect, it } from 'vitest';
import { createDefaultState, DEFAULT_ISOMETRIC, type IsometricGlyph } from '../packages/core/src';
import { buildIsometricScene, clipPathBehindPolygon, generateIsometric, matchRoadGlyph, moveIsometricTile, planIsometricCells } from '../packages/algorithms/src/isometric';

const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
const building: IsometricGlyph = { id: 'house', name: 'House', categoryId: 'homes', role: 'building', paths: [{ id: 'outline', closed: true, points: [{ x: 0, y: .4 }, { x: .5, y: 0 }, { x: 1, y: .4 }, { x: 1, y: .7 }, { x: .5, y: 1 }, { x: 0, y: .7 }] }] };

describe('isometric cities', () => {
  it.each([15, 30, 45])('maps page points back to the same ground cells at %s degrees', angle => {
    for (const fit of ['square', 'edges'] as const) {
      const scene = buildIsometricScene(canvas, { angle, fit }, [building]);
      for (const [u, v] of [[0, 0], [3, 7], [-2, 4], [1.4, 2.7]]) {
        const point = scene.unproject(scene.project(u!, v!));
        expect(point.x).toBeCloseTo(u!); expect(point.y).toBeCloseTo(v!);
      }
    }
  });

  it('snaps tile moves and swaps occupied cells without mutating the original layout', () => {
    const tiles = [{ id: 'a', glyphId: 'house', u: 1, v: 2, rotation: 0 }, { id: 'b', glyphId: 'house', u: 3, v: 4, rotation: 1 }];
    const moved = moveIsometricTile(tiles, 'a', 3.1, 3.9);
    expect(moved).toEqual([{ ...tiles[0], u: 3, v: 4 }, { ...tiles[1], u: 1, v: 2 }]);
    expect(tiles[0]).toMatchObject({ u: 1, v: 2 });
    expect(moveIsometricTile(tiles, 'a', NaN, 3)).toBe(tiles);
  });

  it('renders and reloads a manual layout independently of generator density or categories', () => {
    const tiles = [{ id: 'manual', glyphId: building.id, u: 2, v: 3, rotation: 0 }];
    const settings = { tiles, density: 0, buildingCategories: ['excluded'] };
    const scene = buildIsometricScene(canvas, settings, [building]);
    expect(scene.tiles).toEqual(tiles);
    const output = generateIsometric(canvas, settings, [building]);
    expect(output.paths.length).toBeGreaterThan(0);
    expect(output.paths.every(p => p.id.includes('manual'))).toBe(true);
    expect(generateIsometric(canvas, JSON.parse(JSON.stringify(settings)), [building]).paths).toEqual(output.paths);
    expect(generateIsometric(canvas, { tiles: [] }, [building]).paths).toEqual([]);
    const moved = generateIsometric(canvas, { tiles: moveIsometricTile(tiles, 'manual', 4, 3) }, [building]);
    expect(moved.paths).not.toEqual(output.paths);
  });

  it.each(['coast', 'lake'] as const)('stops the road network at the %s shore', landscape => {
    const cells = planIsometricCells({ landscape }, -1, 12);
    const at = (u: number, v: number) => cells.find(c => c.u === u && c.v === v);
    for (const cell of cells.filter(c => c.u >= 0 && c.u <= 11 && c.v >= 0 && c.v <= 11)) {
      if (cell.water) { expect(cell.roadMask).toBe(0); expect(cell.building).toBe(false); }
      [[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(([du, dv], i) => {
        if (cell.roadMask & (1 << i)) expect(at(cell.u + du!, cell.v + dv!)?.water).toBe(false);
      });
    }
  });

  it('creates and round-trips a dedicated project with its settings and glyph snapshot', () => {
    const state = createDefaultState('isometric', canvas);
    expect(state.algorithmId).toBe('isometric.city');
    expect(state.isometric).toEqual(DEFAULT_ISOMETRIC);
    state.isometricGlyphs = [building];
    const saved = JSON.parse(JSON.stringify(state));
    expect(generateIsometric(canvas, saved.isometric, saved.isometricGlyphs).paths).toEqual(generateIsometric(canvas, state.isometric!, [building]).paths);
  });

  it.each(['blocks', 'avenues'] as const)('builds one connected %s road network, with buildings only near streets', roadLayout => {
    const cells = planIsometricCells({ roadLayout, clusterDepth: 1 }, 0, 23);
    const roads = new Set(cells.filter(c => c.roadMask).map(c => `${c.u},${c.v}`));
    const visited = new Set<string>(), queue = [roads.values().next().value!];
    while (queue.length) {
      const key = queue.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const [u, v] = key.split(',').map(Number) as [number, number];
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = `${u + du!},${v + dv!}`;
        if (roads.has(next) && !visited.has(next)) queue.push(next);
      }
    }
    expect(visited.size).toBe(roads.size);
    for (const c of cells.filter(c => c.building)) {
      expect(c.roadMask).toBe(0);
      const period = DEFAULT_ISOMETRIC.blockSize + 1;
      const vp = period * (roadLayout === 'avenues' ? 2 : 1);
      expect(Math.min(c.u % period, period - c.u % period, c.v % vp, vp - c.v % vp)).toBeLessThanOrEqual(1);
    }
  });

  it('fills contiguous clusters and adds buildings monotonically as occupancy grows', () => {
    const low = planIsometricCells({ density: 35 }, 0, 19).filter(c => c.building);
    const high = planIsometricCells({ density: 90 }, 0, 19).filter(c => c.building);
    expect(high.length).toBeGreaterThan(low.length);
    expect(low.every(c => high.some(h => h.u === c.u && h.v === c.v))).toBe(true);
    expect(planIsometricCells({ density: 0 }, 0, 19).some(c => c.building)).toBe(false);
  });

  it('matches all road topologies through ground-plane rotations', () => {
    const tiles: IsometricGlyph[] = (['road-straight', 'road-corner', 'road-tee', 'road-cross', 'road-end'] as const).map(role => ({ ...building, id: role, role }));
    for (let mask = 1; mask < 16; mask++) expect(matchRoadGlyph(mask, tiles), `mask ${mask}`).toBeDefined();
    expect(matchRoadGlyph(10, tiles)?.rotation).toBe(1);
    expect(matchRoadGlyph(15, [tiles[0]!])).toBeUndefined();
  });

  it('cycles deterministically through duplicate road tile designs', () => {
    const first = { ...building, id: 'plain', role: 'road-cross' as const };
    const second = { ...building, id: 'signals', role: 'road-cross' as const };
    expect(matchRoadGlyph(15, [first, second], 0)?.glyph.id).toBe('plain');
    expect(matchRoadGlyph(15, [first, second], 1)?.glyph.id).toBe('signals');
    expect(matchRoadGlyph(15, [first, second], 2)?.glyph.id).toBe('plain');
  });

  it('turns lines hidden behind a foreground silhouette into pen lifts', () => {
    const path = { id: 'rear-line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], layerId: 'buildings', passId: 'ink' };
    const pieces = clipPathBehindPolygon(path, [{ x: 4, y: -2 }, { x: 6, y: -2 }, { x: 6, y: 2 }, { x: 4, y: 2 }]);
    expect(pieces.map(piece => piece.points)).toEqual([
      [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      [{ x: 6, y: 0 }, { x: 10, y: 0 }],
    ]);
    expect(pieces.every(piece => piece.preserveGaps)).toBe(true);
  });

  it.each([15, 30, 45])('clips edge-fill geometry correctly at %s degrees', angle => {
    const paths = generateIsometric(canvas, { fit: 'edges', angle, showGrid: true }, [building]).paths;
    expect(paths.length).toBeGreaterThan(100);
    const points = paths.flatMap(p => p.points);
    expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 10 - 1e-8 && p.x <= 200 + 1e-8 && p.y >= 10 - 1e-8 && p.y <= 287 + 1e-8)).toBe(true);
    for (const [key, edge] of [['x', 10], ['x', 200], ['y', 10], ['y', 287]] as const) expect(points.some(p => Math.abs(p[key] - edge) < 1e-7)).toBe(true);
    expect(paths.every(p => p.preserveGaps)).toBe(true);
  });

  it('keeps a square ground grid centred and inside the page', () => {
    const paths = generateIsometric(canvas, { showGrid: true }, [building], ['ink', 'blue']).paths;
    expect(paths.every(p => p.passId === 'ink')).toBe(true);
    expect(paths.some(p => p.layerId === 'iso-buildings')).toBe(true);
    const x = paths.flatMap(p => p.points.map(v => v.x));
    expect((Math.min(...x) + Math.max(...x)) / 2).toBeCloseTo(canvas.widthMm / 2);
  });

  it('uses category selection and supports a separate ordered placement algorithm', () => {
    const second = { ...building, id: 'tower', categoryId: 'towers' };
    const paths = generateIsometric(canvas, { algorithm: 'ordered', buildingCategories: ['towers'], buildingPassId: 'blue' }, [building, second], ['ink', 'blue']).paths;
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(p => p.id.includes('tower') && p.passId === 'blue')).toBe(true);
    expect(paths.some(p => p.layerId === 'iso-roads')).toBe(false);
    expect(generateIsometric(canvas, { buildingCategories: ['missing'], algorithm: 'ordered' }, [building]).paths).toEqual([]);
  });

  it('uses road glyph geometry when available and connected lines for missing types', () => {
    const tile = { ...building, role: 'road-cross' as const, paths: [{ id: 'line', closed: false, points: [{ x: .25, y: .75 }, { x: .75, y: .25 }] }] };
    const roads = generateIsometric(canvas, {}, [tile]).paths;
    expect(roads.some(p => p.id.startsWith('road-0:0-0'))).toBe(true);
    expect(roads.every(p => p.layerId === 'iso-roads')).toBe(true);
  });

  it('bounds invalid settings and rejects impossible page geometry', () => {
    expect(generateIsometric(canvas, { cells: NaN, angle: Infinity }, [building]).paths.length).toBeGreaterThan(0);
    expect(() => generateIsometric({ ...canvas, marginMm: 200 }, {}, [])).toThrow('no drawing area');
  });

  it('cuts paper windows out of coloured fills without creating a paper pen pass', () => {
    const filled: IsometricGlyph = { ...building, paths: [
      { id: 'wall', closed: true, fill: '#ff0000', stroke: 'none', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
      { id: 'paper', closed: true, paper: true, fill: '#fff5df', stroke: 'none', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
    ] };
    const settings = { algorithm: 'ordered' as const, cells: 4, fillSpacing: 0.2, colourPasses: { '#ff0000': 'red' } };
    const hidden = generateIsometric(canvas, settings, [filled], ['black', 'red']);
    expect(hidden.paths).toEqual([]);
    const visible = generateIsometric(canvas, settings, [{ ...filled, paths: filled.paths.slice(0, 1) }], ['black', 'red']);
    expect(visible.paths.length).toBeGreaterThan(0);
    expect(visible.paths.every(p => p.passId === 'red')).toBe(true);
    const mono = generateIsometric(canvas, { ...settings, useGlyphColours: false }, [{ ...filled, paths: filled.paths.slice(0, 1) }], ['black', 'red']);
    expect(mono.paths.every(p => p.passId === 'black')).toBe(true);
  });

  it('preserves concave fill cutouts instead of masking their convex hull', () => {
    const base = { id: 'colour', closed: true, fill: '#ff0000', stroke: 'none', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] };
    const cutout = { id: 'cutout', closed: true, fill: '#fff5df', paper: true, stroke: 'none', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: .3 }, { x: .3, y: .3 }, { x: .3, y: 1 }, { x: 0, y: 1 }] };
    const paths = generateIsometric(canvas, { algorithm: 'ordered', cells: 4, fillSpacing: 0.2 }, [{ ...building, paths: [base, cutout] }]).paths;
    expect(paths.length).toBeGreaterThan(0);
  });

  it('keeps raised road signposts vertical when their ground tile rotates', () => {
    const road: IsometricGlyph = { id: 'signpost', name: 'Sign', role: 'road-straight', paths: [
      { id: 'post', closed: false, points: [{ x: .7, y: .6 }, { x: .7, y: .4, elevation: .2 }] },
    ] };
    const paths = generateIsometric(canvas, { cells: 6, density: 0 }, [road]).paths.filter(p => p.points.length === 2 && Math.abs(p.points[0]!.x - p.points[1]!.x) < 1e-8);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.every(p => p.points[0]!.y > p.points[1]!.y)).toBe(true);
  });
});
