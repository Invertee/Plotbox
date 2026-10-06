import { describe, expect, it } from 'vitest';
import { ALGORITHMS, algorithmDefaults, buildIsometricMaze, generateAlgorithm, generateIsometricMaze } from '@plotter/algorithms';
import { visibleMazeStrokes } from '../packages/algorithms/src/mazeProjection';
import { createDefaultState } from '@plotter/core';
import { generateGCode, joinContinuousPaths } from '@plotter/gcode';

const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };

describe('isometric maze maps', () => {
  it('registers a worker generator with persisted defaults', () => {
    expect(ALGORITHMS.find(a => a.id === 'generative.isometric-maze')).toMatchObject({ group: 'generative', worker: true });
    expect(algorithmDefaults('generative.isometric-maze')).toMatchObject({ columns: 10, rows: 10, towers: true, monuments: true, showSolution: false });
    expect(generateAlgorithm('generative.isometric-maze', canvas, { columns: 4, rows: 4 }, ['ink']).paths.length).toBeGreaterThan(100);
  });

  it.each([1, 42, 41872, 999999])('makes a connected, reciprocal spanning tree for seed %s', seed => {
    const map = buildIsometricMaze({ seed, columns: 12, rows: 9, loops: 0 });
    const seen = new Set([map.start]), queue = [map.start];
    for (let i = 0; i < queue.length; i++) {
      const cell = map.cells[queue[i]!]!;
      for (const next of cell.neighbours) {
        const neighbour = map.cells[next]!;
        expect(neighbour.neighbours).toContain(cell.id);
        expect(Math.abs(cell.column - neighbour.column) + Math.abs(cell.row - neighbour.row)).toBe(1);
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    expect(seen.size).toBe(map.cells.length);
    expect(map.cells.reduce((n, c) => n + c.neighbours.length, 0) / 2).toBe(map.cells.length - 1);
    expect(map.solution[0]).toBe(map.start);
    expect(map.solution.at(-1)).toBe(map.exit);
    expect(new Set(map.solution).size).toBe(map.solution.length);
    for (let i = 1; i < map.solution.length; i++) expect(map.cells[map.solution[i - 1]!]!.neighbours).toContain(map.solution[i]);
  });

  it('adds alternate routes while preserving the existing maze', () => {
    const tree = buildIsometricMaze({ loops: 0 }), loops = buildIsometricMaze({ loops: 40 });
    for (const cell of tree.cells) for (const n of cell.neighbours) expect(loops.cells[cell.id]!.neighbours).toContain(n);
    expect(loops.cells.reduce((n, c) => n + c.neighbours.length, 0)).toBeGreaterThan(tree.cells.length * 2);
  });

  it('puts monuments only at non-terminal dead ends and permits independent feature toggles', () => {
    const map = buildIsometricMaze({ monumentDensity: 100, towerDensity: 30 });
    expect(map.cells.some(c => c.tower)).toBe(true);
    expect(map.cells.some(c => c.monument)).toBe(true);
    for (const cell of map.cells.filter(c => c.monument)) {
      expect(cell.neighbours).toHaveLength(1);
      expect([map.start, map.exit]).not.toContain(cell.id);
    }
    const plain = buildIsometricMaze({ towers: false, monuments: false, levels: 0 });
    expect(plain.cells.every(c => c.level === 0 && !c.tower && !c.monument)).toBe(true);
    expect(plain.cells.map(c => c.neighbours)).toEqual(map.cells.map(c => c.neighbours));
  });

  it('keeps topology and landmarks unchanged when the camera or display settings change', () => {
    expect(buildIsometricMaze({ rotation: 210, elevation: 90, showSolution: true, shading: true })).toEqual(buildIsometricMaze());
    expect(buildIsometricMaze({ seed: 123 })).not.toEqual(buildIsometricMaze({ seed: 124 }));
  });

  it.each([[45, 35], [0, 90], [90, 15], [180, 60], [270, 35], [360, 75]])('fits finite, repeatable paths within margins at rotation %s / elevation %s', (rotation, elevation) => {
    const settings = { columns: 5, rows: 4, rotation, elevation, showSolution: true, towerDensity: 30, monumentDensity: 100 };
    const a = generateIsometricMaze(canvas, settings, ['ink', 'gold', 'route']);
    const b = generateIsometricMaze(canvas, settings, ['ink', 'gold', 'route']);
    expect(a.paths).toEqual(b.paths);
    expect(a.paths.length).toBeGreaterThan(50);
    expect(new Set(a.paths.map(p => p.id)).size).toBe(a.paths.length);
    for (const path of a.paths) {
      expect(path.preserveGaps).toBe(true);
      expect(['ink', 'gold', 'route']).toContain(path.passId);
      for (const p of path.points) {
        expect(p.x).toBeGreaterThanOrEqual(10); expect(p.x).toBeLessThanOrEqual(200);
        expect(p.y).toBeGreaterThanOrEqual(10); expect(p.y).toBeLessThanOrEqual(287);
      }
    }
  });

  it('assigns landmarks and optional solution to separate pens, with a one-pen fallback', () => {
    const settings = { columns: 5, rows: 5, elevation: 90, monumentDensity: 100, showSolution: true };
    const paths = generateIsometricMaze(canvas, settings, ['ink', 'gold', 'red']).paths;
    for (const channel of ['monuments', 'endpoints', 'solution']) expect(paths.some(p => p.channel === channel)).toBe(true);
    expect(paths.filter(p => p.channel === 'solution').every(p => p.passId === 'red')).toBe(true);
    expect(paths.filter(p => p.channel === 'monuments').every(p => p.passId === 'gold')).toBe(true);
    const plain = generateIsometricMaze(canvas, { ...settings, showSolution: false, showEndpoints: false, monuments: false }, ['ink']);
    expect(plain.paths.every(p => !['solution', 'endpoints', 'monuments'].includes(p.channel!))).toBe(true);
    expect(generateIsometricMaze(canvas, settings, ['ink']).paths.every(p => p.passId === 'ink')).toBe(true);
  });

  it('bounds malformed settings and handles a paper with no drawable area', () => {
    const map = buildIsometricMaze({ columns: Infinity, rows: -100, levels: NaN, seed: NaN });
    expect(map.columns).toBe(10); expect(map.rows).toBe(4);
    expect(map.cells.every(c => Number.isFinite(c.level))).toBe(true);
    expect(generateIsometricMaze({ ...canvas, marginMm: 200 }, { columns: 4, rows: 4 }).paths).toEqual([]);
  });

  it('renders the largest supported city with tall towers and hatching', () => {
    const result = generateIsometricMaze(canvas, { columns: 24, rows: 24, levels: 8, towerDensity: 30, towerHeight: 6, heightScale: 2, shading: true, showSolution: true }, ['ink']);
    expect(result.paths.length).toBeGreaterThan(1000);
    expect(result.paths.length).toBeLessThan(100000);
    expect(result.paths.every(p => p.points.every(v => Number.isFinite(v.x) && Number.isFinite(v.y)))).toBe(true);
  });

  it('exports plotted paths without bridging hidden lines or dashed route gaps', () => {
    const state = createDefaultState('generative', canvas);
    const geometry = generateIsometricMaze(canvas, { columns: 4, rows: 4, showSolution: true }, state.passes.map(p => p.id));
    expect(joinContinuousPaths(geometry.paths, 10)).toHaveLength(geometry.paths.length);
    const documents = generateGCode('Maze', geometry, state.passes, state.pens, state.gcode, canvas.heightMm, true);
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every(d => d.content.includes('G21') && d.content.endsWith('M2\n') && !/NaN|Infinity/.test(d.content))).toBe(true);
  });
});

describe('maze hidden-line removal', () => {
  const face = [{ x: 0, y: 0, z: 2 }, { x: 2, y: 0, z: 2 }, { x: 2, y: 2, z: 2 }, { x: 0, y: 2, z: 2 }];
  const stroke = (z: number) => ({ a: { x: -1, y: 1, z }, b: { x: 3, y: 1, z }, channel: 'architecture' });
  it('splits a background stroke exactly at the foreground silhouette', () => {
    const result = visibleMazeStrokes([face], [stroke(1)]);
    expect(result).toHaveLength(2);
    expect(result[0]!.b.x).toBeCloseTo(0, 5); expect(result[1]!.a.x).toBeCloseTo(2, 5);
    expect(visibleMazeStrokes([[...face].reverse()], [stroke(1)])).toEqual(result);
  });
  it('retains foreground and coplanar strokes, including surface detail', () => {
    expect(visibleMazeStrokes([face], [stroke(2), stroke(3)])).toEqual([stroke(2), stroke(3)]);
  });
  it('clips where a sloping line crosses a face depth plane', () => {
    const result = visibleMazeStrokes([face], [{ a: { x: 0.5, y: 1, z: 1 }, b: { x: 1.5, y: 1, z: 3 }, channel: 'solution' }]);
    expect(result).toHaveLength(1); expect(result[0]!.a.x).toBeCloseTo(1, 5);
  });
});
