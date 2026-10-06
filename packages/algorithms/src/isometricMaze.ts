import type { CanvasSettings, PlotGeometry, PlotPath } from '@plotter/core';
import type { AlgorithmDefinition } from './index';
import { mixMazeVertex, visibleMazeStrokes, type MazeStroke, type MazeVertex } from './mazeProjection';

type Settings = Record<string, number | string | boolean>;
export const ISOMETRIC_MAZE: AlgorithmDefinition = {
  id: 'generative.isometric-maze', name: 'Isometric 3D maze', group: 'generative', worker: true,
  controls: [
    { key: 'seed', label: 'Map seed', type: 'number', min: 1, max: 999999, step: 1, default: 41872 },
    { key: 'columns', label: 'Columns', type: 'range', min: 4, max: 24, step: 1, default: 10 },
    { key: 'rows', label: 'Rows', type: 'range', min: 4, max: 24, step: 1, default: 10 },
    { key: 'branching', label: 'Branching', type: 'range', min: 0, max: 100, step: 5, unit: '%', default: 35 },
    { key: 'loops', label: 'Extra connections', type: 'range', min: 0, max: 40, step: 5, unit: '%', default: 0 },
    { key: 'levels', label: 'Terrace levels', type: 'range', min: 0, max: 8, step: 1, default: 4 },
    { key: 'heightScale', label: 'Height exaggeration', type: 'range', min: 0.3, max: 2, step: 0.1, default: 1 },
    { key: 'towers', label: 'Add towers', type: 'boolean', default: true },
    { key: 'towerDensity', label: 'Tower frequency', type: 'range', min: 0, max: 30, step: 1, unit: '%', default: 9, visibleWhen: { key: 'towers', value: true } },
    { key: 'towerHeight', label: 'Tower extra levels', type: 'range', min: 1, max: 6, step: 1, default: 3, visibleWhen: { key: 'towers', value: true } },
    { key: 'monuments', label: 'Dead-end monuments', type: 'boolean', default: true },
    { key: 'monumentDensity', label: 'Monument frequency', type: 'range', min: 0, max: 100, step: 5, unit: '%', default: 75, visibleWhen: { key: 'monuments', value: true } },
    { key: 'monumentStyle', label: 'Monument style', type: 'select', default: 'mixed', options: [
      { value: 'mixed', label: 'Mixed landmarks' }, { value: 'obelisk', label: 'Obelisks' }, { value: 'pyramid', label: 'Stepped pyramids' },
    ], visibleWhen: { key: 'monuments', value: true } },
    { key: 'rotation', label: 'View rotation', type: 'range', min: 0, max: 360, step: 1, unit: '°', default: 45 },
    { key: 'elevation', label: 'Viewing elevation', type: 'range', min: 15, max: 90, step: 1, unit: '°', default: 35 },
    { key: 'shading', label: 'Hatch building sides', type: 'boolean', default: false },
    { key: 'showEndpoints', label: 'Mark start and exit', type: 'boolean', default: true },
    { key: 'showSolution', label: 'Show solution route', type: 'boolean', default: false },
  ],
};

function number(s: Settings, key: string): number {
  const control = ISOMETRIC_MAZE.controls.find(c => c.key === key)!;
  const value = Number(s[key] ?? control.default);
  return Math.max(control.min!, Math.min(control.max!, Number.isFinite(value) ? value : Number(control.default)));
}
const enabled = (s: Settings, key: string) => (s[key] ?? ISOMETRIC_MAZE.controls.find(c => c.key === key)!.default) === true;
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let v = Math.imul(state ^ (state >>> 15), state | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MazeCell {
  id: number; column: number; row: number; level: number; tower: boolean;
  monument?: 'obelisk' | 'pyramid'; neighbours: number[];
}
export interface IsometricMazeLayout {
  columns: number; rows: number; cells: MazeCell[]; start: number; exit: number; solution: number[];
}

/** A spanning tree gives every terrace a route; optional extra edges create loops. */
export function buildIsometricMaze(settings: Settings = {}): IsometricMazeLayout {
  const columns = Math.round(number(settings, 'columns')), rows = Math.round(number(settings, 'rows'));
  const seed = Math.round(number(settings, 'seed')), rng = random(seed);
  const cells: MazeCell[] = Array.from({ length: columns * rows }, (_, id) => ({
    id, column: id % columns, row: Math.floor(id / columns), level: 0, tower: false, neighbours: [],
  }));
  const start = (rows - 1) * columns, exit = columns - 1;
  const adjacent = (cell: MazeCell) => [[1, 0], [0, 1], [-1, 0], [0, -1]].flatMap(([dx, dy]) => {
    const x = cell.column + dx!, y = cell.row + dy!;
    return x >= 0 && x < columns && y >= 0 && y < rows ? [y * columns + x] : [];
  });
  const connect = (a: number, b: number) => { cells[a]!.neighbours.push(b); cells[b]!.neighbours.push(a); };
  const visited = new Set([start]), active = [start], branching = number(settings, 'branching') / 100;
  while (active.length) {
    const index = rng() < branching ? Math.floor(rng() * active.length) : active.length - 1;
    const id = active[index]!, neighbours = adjacent(cells[id]!).filter(n => !visited.has(n));
    if (!neighbours.length) { active.splice(index, 1); continue; }
    const next = neighbours[Math.floor(rng() * neighbours.length)]!;
    connect(id, next); visited.add(next); active.push(next);
  }
  // Consume one random draw per potential edge so raising the loop control only adds links.
  const loops = number(settings, 'loops') / 100;
  for (const cell of cells) for (const next of adjacent(cell).filter(n => n > cell.id && !cell.neighbours.includes(n))) {
    if (rng() < loops) connect(cell.id, next);
  }
  const heightRng = random(seed ^ 0x7a4c913b), phaseX = heightRng() * 6.28, phaseY = heightRng() * 6.28;
  const levels = Math.round(number(settings, 'levels'));
  for (const cell of cells) {
    const height = 0.5 + 0.26 * Math.sin(cell.column * 0.73 + phaseX) + 0.24 * Math.cos(cell.row * 0.67 + phaseY);
    cell.level = Math.round(height * levels);
  }
  const detailRng = random(seed ^ 0x39ce7221);
  for (const cell of cells) {
    const towerRoll = detailRng(), monumentRoll = detailRng(), styleRoll = detailRng();
    if (cell.id === start || cell.id === exit) continue;
    cell.tower = enabled(settings, 'towers') && towerRoll < number(settings, 'towerDensity') / 100
      && !adjacent(cell).some(n => cells[n]!.tower);
    if (cell.tower) cell.level += Math.round(number(settings, 'towerHeight'));
    if (enabled(settings, 'monuments') && cell.neighbours.length === 1 && monumentRoll < number(settings, 'monumentDensity') / 100) {
      cell.monument = settings.monumentStyle === 'obelisk' ? 'obelisk' : settings.monumentStyle === 'pyramid' ? 'pyramid' : styleRoll < 0.5 ? 'obelisk' : 'pyramid';
    }
  }
  const parent = new Map<number, number>([[start, -1]]), queue = [start];
  for (let i = 0; i < queue.length && !parent.has(exit); i++) {
    for (const next of cells[queue[i]!]!.neighbours) if (!parent.has(next)) { parent.set(next, queue[i]!); queue.push(next); }
  }
  const solution = [exit];
  while (solution[solution.length - 1] !== start) solution.push(parent.get(solution[solution.length - 1]!)!);
  solution.reverse();
  return { columns, rows, cells, start, exit, solution };
}

const point = (x: number, y: number, z: number): MazeVertex => ({ x, y, z });
const PITCH = 1.65, HALF = 0.57, BRIDGE_HALF = 0.24;

export function generateIsometricMaze(canvas: CanvasSettings, settings: Settings = {}, passIds: string[] = []): PlotGeometry {
  const layout = buildIsometricMaze(settings), heightScale = number(settings, 'heightScale');
  const faces: MazeVertex[][] = [], strokes: MazeStroke[] = [], edges = new Set<string>();
  const line = (a: MazeVertex, b: MazeVertex, channel = 'architecture') => {
    const key = [a, b].map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`).sort().join('|') + channel;
    if (edges.has(key)) return;
    edges.add(key); strokes.push({ a, b, channel });
  };
  const face = (vertices: MazeVertex[], channel = 'architecture', outline = true) => {
    faces.push(vertices);
    if (outline) vertices.forEach((p, i) => line(p, vertices[(i + 1) % vertices.length]!, channel));
  };
  const box = (x0: number, y0: number, x1: number, y1: number, bottom: number, top: number, channel = 'architecture', hatch = false, stair = false) => {
    const a = point(x0, y0, top), b = point(x1, y0, top), c = point(x1, y1, top), d = point(x0, y1, top);
    const e = point(x0, y0, bottom), f = point(x1, y0, bottom), g = point(x1, y1, bottom), h = point(x0, y1, bottom);
    face([a, b, c, d], channel); face([e, f, b, a], channel, !stair); face([f, g, c, b], channel, !stair);
    face([g, h, d, c], channel, !stair); face([h, e, a, d], channel, !stair);
    if (hatch) {
      for (let x = x0 + 0.13; x < x1 - 0.03; x += 0.13) line(point(x, y1, bottom), point(x, y1, top), 'shading');
      for (let y = y0 + 0.13; y < y1 - 0.03; y += 0.13) line(point(x0, y, bottom), point(x0, y, top), 'shading');
    }
  };
  const centre = (cell: MazeCell) => point(cell.column * PITCH, cell.row * PITCH, 0.48 + cell.level * 0.32 * heightScale);
  const shading = enabled(settings, 'shading');
  box(-HALF - 0.1, -HALF - 0.1, (layout.columns - 1) * PITCH + HALF + 0.1, (layout.rows - 1) * PITCH + HALF + 0.1, -0.2, 0, 'architecture', shading);
  for (const cell of layout.cells) {
    const { x, y, z } = centre(cell);
    box(x - HALF, y - HALF, x + HALF, y + HALF, 0, z, 'architecture', shading);
    if (cell.tower && !cell.monument) {
      // Inlaid roof rings leave a walkable rooftop and distinguish towers in plan view.
      for (const r of [0.22, 0.32, 0.42]) {
        const ring = [point(x - r, y - r, z), point(x + r, y - r, z), point(x + r, y + r, z), point(x - r, y + r, z)];
        ring.forEach((p, i) => line(p, ring[(i + 1) % ring.length]!, 'detail'));
      }
    }
    if (cell.monument) {
      box(x - 0.25, y - 0.25, x + 0.25, y + 0.25, z, z + 0.12 * heightScale, 'monuments');
      if (cell.monument === 'pyramid') {
        for (let tier = 0; tier < 4; tier++) {
          const r = 0.21 - tier * 0.045;
          box(x - r, y - r, x + r, y + r, z + (0.12 + tier * 0.11) * heightScale, z + (0.23 + tier * 0.11) * heightScale, 'monuments');
        }
      } else {
        const top = z + 0.7 * heightScale, r = 0.1;
        box(x - r, y - r, x + r, y + r, z + 0.12 * heightScale, top, 'monuments');
        const rim = [point(x - r, y - r, top), point(x + r, y - r, top), point(x + r, y + r, top), point(x - r, y + r, top)];
        rim.forEach((p, i) => face([p, rim[(i + 1) % 4]!, point(x, y, top + 0.2 * heightScale)], 'monuments'));
      }
    }
  }
  const routes = new Map<string, MazeVertex[]>();
  for (const cell of layout.cells) for (const next of cell.neighbours.filter(n => n > cell.id)) {
    const a = centre(cell), b = centre(layout.cells[next]!), dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    const from = point(a.x + dx * HALF, a.y + dy * HALF, a.z), to = point(b.x - dx * HALF, b.y - dy * HALF, b.z);
    const steps = Math.max(1, Math.ceil(Math.abs(b.z - a.z) / (0.09 * heightScale)));
    const route = [a, from];
    for (let i = 0; i < steps; i++) {
      const p = mixMazeVertex(from, to, i / steps), q = mixMazeVertex(from, to, (i + 1) / steps);
      const z = a.z + (b.z - a.z) * (i + (b.z > a.z ? 1 : 0)) / steps;
      box(p.x - (dy ? BRIDGE_HALF : 0), p.y - (dx ? BRIDGE_HALF : 0), q.x + (dy ? BRIDGE_HALF : 0), q.y + (dx ? BRIDGE_HALF : 0), 0, z, 'architecture', false, true);
      const riser = b.z > a.z ? p : q;
      for (const side of [-1, 1]) line(point(riser.x + dy * side * BRIDGE_HALF, riser.y + dx * side * BRIDGE_HALF, p.z), point(riser.x + dy * side * BRIDGE_HALF, riser.y + dx * side * BRIDGE_HALF, q.z));
      route.push({ ...p, z }, { ...q, z });
    }
    route.push(to, b); routes.set(`${cell.id},${next}`, route);
  }
  if (enabled(settings, 'showEndpoints')) {
    // Single-stroke S and E sit on their terraces, with a surrounding ring.
    for (const id of [layout.start, layout.exit]) {
      const c = centre(layout.cells[id]!);
      const glyph = id === layout.start ? [[0.12, -0.18], [-0.12, -0.18], [-0.12, 0], [0.12, 0], [0.12, 0.18], [-0.12, 0.18]]
        : [[0.12, -0.18], [-0.12, -0.18], [-0.12, 0.18], [0.12, 0.18]];
      const at = (v: number[]) => point(c.x + v[0]!, c.y + v[1]!, c.z + 0.001);
      for (let i = 1; i < glyph.length; i++) line(at(glyph[i - 1]!), at(glyph[i]!), 'endpoints');
      if (id === layout.exit) line(at([-0.12, 0]), at([0.1, 0]), 'endpoints');
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16, next = (i + 1) * Math.PI / 16;
        line(at([Math.cos(angle) * 0.36, Math.sin(angle) * 0.36]), at([Math.cos(next) * 0.36, Math.sin(next) * 0.36]), 'endpoints');
      }
    }
  }
  const solution: MazeStroke[] = [];
  if (enabled(settings, 'showSolution')) {
    for (let i = 1; i < layout.solution.length; i++) {
      const a = layout.solution[i - 1]!, b = layout.solution[i]!;
      const route = routes.get(`${Math.min(a, b)},${Math.max(a, b)}`)!;
      for (let j = 1; j < route.length; j++) {
        let p = route[j - 1]!, q = route[j]!;
        // Leave the endpoint labels clear.
        if (j === 1 && (Math.min(a, b) === layout.start || Math.min(a, b) === layout.exit)) p = mixMazeVertex(p, q, 0.75);
        if (j === route.length - 1 && (Math.max(a, b) === layout.start || Math.max(a, b) === layout.exit)) q = mixMazeVertex(p, q, 0.25);
        solution.push({ a: { ...p, z: p.z + 0.003 }, b: { ...q, z: q.z + 0.003 }, channel: 'solution' });
      }
    }
  }
  const yaw = number(settings, 'rotation') * Math.PI / 180, tilt = number(settings, 'elevation') * Math.PI / 180;
  const project = (p: MazeVertex): MazeVertex => {
    const u = p.x * Math.cos(yaw) - p.y * Math.sin(yaw), v = p.x * Math.sin(yaw) + p.y * Math.cos(yaw);
    return point(u, v * Math.sin(tilt) - p.z * Math.cos(tilt), v * Math.cos(tilt) + p.z * Math.sin(tilt));
  };
  const projectedFaces = faces.map(f => f.map(project));
  const projectedStrokes = [...strokes, ...solution].map(s => ({ ...s, a: project(s.a), b: project(s.b) }));
  const vertices = projectedFaces.flat();
  const minX = vertices.reduce((v, p) => Math.min(v, p.x), Infinity), maxX = vertices.reduce((v, p) => Math.max(v, p.x), -Infinity);
  const minY = vertices.reduce((v, p) => Math.min(v, p.y), Infinity), maxY = vertices.reduce((v, p) => Math.max(v, p.y), -Infinity);
  const availableX = Math.max(0, canvas.widthMm - canvas.marginMm * 2), availableY = Math.max(0, canvas.heightMm - canvas.marginMm * 2);
  const scale = Math.min(availableX / (maxX - minX), availableY / (maxY - minY)) * 0.98;
  if (!Number.isFinite(scale) || scale <= 0) return { generator: ISOMETRIC_MAZE.id, generatedAt: new Date().toISOString(), paths: [] };
  const ox = (canvas.widthMm - (maxX - minX) * scale) / 2 - minX * scale, oy = (canvas.heightMm - (maxY - minY) * scale) / 2 - minY * scale;
  const page = (p: MazeVertex) => ({ x: p.x * scale + ox, y: p.y * scale + oy });
  const primary = passIds[0] ?? 'pass-1', accent = passIds[1] ?? primary, routePass = passIds[2] ?? accent;
  const paths: PlotPath[] = [];
  for (const stroke of visibleMazeStrokes(projectedFaces, projectedStrokes)) {
    const a = page(stroke.a), b = page(stroke.b), length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.035) continue;
    const emit = (from: number, to: number) => paths.push({
      id: `maze-${paths.length}`, layerId: 'layer-1', channel: stroke.channel,
      passId: stroke.channel === 'solution' ? routePass : stroke.channel === 'monuments' || stroke.channel === 'endpoints' ? accent : primary,
      preserveGaps: true, points: [{ x: a.x + (b.x - a.x) * from, y: a.y + (b.y - a.y) * from }, { x: a.x + (b.x - a.x) * to, y: a.y + (b.y - a.y) * to }],
    });
    if (stroke.channel === 'solution') {
      for (let d = 0; d < length; d += 1.15) if (Math.min(0.55, length - d) > 0.035) emit(d / length, Math.min(length, d + 0.55) / length);
    } else emit(0, 1);
  }
  return { generator: ISOMETRIC_MAZE.id, paths, generatedAt: new Date().toISOString() };
}
