import { DEFAULT_ISOMETRIC, type CanvasSettings, type IsometricGlyph, type IsometricSettings, type IsometricTile, type PlotGeometry, type PlotPath, type Point, type SourcePath } from '@plotter/core';
import { hatchSourcePath } from './vectorHatching';

const clamp = (value: number, low: number, high: number, fallback: number) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
const mod = (n: number, d: number) => ((n % d) + d) % d;
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
const masks = { 'road-straight': 5, 'road-corner': 3, 'road-tee': 7, 'road-cross': 15, 'road-end': 1 };
export const ISOMETRIC_ALGORITHMS = [{ id: 'city', name: 'City · roads & districts' }, { id: 'ordered', name: 'Ordered glyph grid' }] as const;

export function isometricSettings(input: Partial<IsometricSettings> = {}): IsometricSettings {
  const s = { ...DEFAULT_ISOMETRIC, ...input };
  return { ...s, cells: Math.round(clamp(s.cells, 4, 40, 12)), angle: clamp(s.angle, 15, 45, 30), sourceAngle: clamp(s.sourceAngle, 15, 45, 30),
    buildingScale: clamp(s.buildingScale, 0.2, 1, 0.72), blockSize: Math.round(clamp(s.blockSize, 2, 10, 4)),
    clusterDepth: Math.round(clamp(s.clusterDepth, 1, 5, 2)), density: clamp(s.density, 0, 100, 85), districtSize: Math.round(clamp(s.districtSize, 1, 8, 2)),
    fillSpacing: clamp(s.fillSpacing, 0.15, 5, 0.65), waterCoverage: clamp(s.waterCoverage, 20, 70, 40), greenSpacesPerBlock: Math.round(clamp(s.greenSpacesPerBlock, 0, 2, 2)) };
}

export interface CityCell { u: number; v: number; roadMask: number; building: boolean; district: number; water?: boolean; shoreMask?: number }
/** A continuous avenue network. Blocks group contiguous frontage, never scatter individual lots. */
export function planIsometricCells(input: Partial<IsometricSettings>, min: number, max: number): CityCell[] {
  const s = isometricSettings(input);
  const period = s.blockSize + 1;
  const centre = s.fit === 'square' ? (s.cells - 1) / 2 : 0;
  const lakeRadius = Math.max(1, Math.floor(s.cells * s.waterCoverage / 200));
  const water = (u: number, v: number) => s.landscape === 'coast' ? u >= Math.round(centre + s.cells * (.5 - s.waterCoverage / 100))
    : s.landscape === 'lake' && Math.abs(u - centre) <= lakeRadius && Math.abs(v - centre) <= lakeRadius;
  const road = (u: number, v: number) => !water(u, v) && (mod(u, period) === 0 || mod(v, period * (s.roadLayout === 'avenues' ? 2 : 1)) === 0);
  const cells: CityCell[] = [];
  for (let u = min; u <= max; u++) for (let v = min; v <= max; v++) {
    const isRoad = s.algorithm === 'city' && road(u, v);
    const roadMask = isRoad ? directions.reduce((mask, [du, dv], i) => mask | (road(u + du, v + dv) ? 1 << i : 0), 0) : 0;
    const vp = period * (s.roadLayout === 'avenues' ? 2 : 1);
    const ru = mod(u, period), rv = mod(v, vp);
    const distance = Math.min(ru, period - ru, rv, vp - rv);
    // Fill a contiguous portion of each block, expanding from its road-facing corner.
    const occupied = (ru - 1 + (rv - 1) / vp) < s.blockSize * s.density / 100;
    const district = Math.floor(u / (period * s.districtSize)) + Math.floor(v / (vp * s.districtSize));
    const isWater = water(u, v);
    const shoreMask = isWater ? directions.reduce((mask, [du, dv], i) => mask | (!water(u + du, v + dv) ? 1 << i : 0), 0) : 0;
    cells.push({ u, v, roadMask, building: !isWater && !isRoad && (s.algorithm === 'ordered' || (distance <= s.clusterDepth && occupied && s.density > 0)), district, water: isWater, shoreMask });
  }
  return cells.sort((a, b) => a.u + a.v - b.u - b.v || a.u - b.u);
}

export function matchRoadGlyph(mask: number, glyphs: IsometricGlyph[], variant = 0): { glyph: IsometricGlyph; rotation: number } | undefined {
  const matches: Array<{ glyph: IsometricGlyph; rotation: number }> = [];
  for (const glyph of glyphs) {
    if (!glyph.role.startsWith('road-')) continue;
    const base = masks[glyph.role as keyof typeof masks];
    for (let rotation = 0; rotation < 4; rotation++) {
      if (((base << rotation | base >> (4 - rotation)) & 15) === mask) {
        matches.push({ glyph, rotation });
        break;
      }
    }
  }
  return matches.length ? matches[mod(variant, matches.length)] : undefined;
}

/** Clip segments, rather than clamping vertices (which draws false lines along the page edge). */
function clipPath(path: PlotPath, left: number, top: number, right: number, bottom: number): PlotPath[] {
  const source = path.closed ? [...path.points, path.points[0]!] : path.points;
  const pieces: PlotPath[] = [];
  let points: Point[] = [];
  const flush = () => { if (points.length > 1) pieces.push({ ...path, id: `${path.id}-${pieces.length}`, points, closed: false, preserveGaps: true }); points = []; };
  for (let i = 1; i < source.length; i++) {
    const a = source[i - 1]!, b = source[i]!, dx = b.x - a.x, dy = b.y - a.y;
    let lo = 0, hi = 1;
    const p = [-dx, dx, -dy, dy], q = [a.x - left, right - a.x, a.y - top, bottom - a.y];
    for (let j = 0; j < 4; j++) {
      if (p[j] === 0) { if (q[j]! < 0) hi = -1; }
      else if (p[j]! < 0) lo = Math.max(lo, q[j]! / p[j]!);
      else hi = Math.min(hi, q[j]! / p[j]!);
    }
    if (lo > hi) { flush(); continue; }
    const start = { x: a.x + lo * dx, y: a.y + lo * dy }, end = { x: a.x + hi * dx, y: a.y + hi * dy };
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-8) continue;
    const previous = points.at(-1);
    if (previous && Math.hypot(previous.x - start.x, previous.y - start.y) > 1e-7) flush();
    if (!points.length) points.push(start);
    points.push(end);
    if (hi < 1) flush();
  }
  flush();
  return pieces;
}

type Occluder = { polygon: Point[]; left: number; top: number; right: number; bottom: number };
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const pointAt = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function convexHull(source: Point[]): Point[] {
  const points = [...new Map(source.map(p => [`${p.x.toFixed(8)},${p.y.toFixed(8)}`, p])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (points.length < 3) return points;
  const half = (items: Point[]) => {
    const result: Point[] = [];
    for (const point of items) {
      while (result.length > 1 && cross(result[result.length - 2]!, result[result.length - 1]!, point) <= 1e-9) result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(points), upper = half([...points].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function polygonMask(points: Point[]): Occluder | undefined {
  const polygon = convexHull(points);
  return shapeMask(polygon);
}

// Preserve concavities inside artwork (road junctions, arrows, roof shapes).
function shapeMask(polygon: Point[]): Occluder | undefined {
  if (polygon.length < 3) return undefined;
  return {
    polygon,
    left: Math.min(...polygon.map(p => p.x)), top: Math.min(...polygon.map(p => p.y)),
    right: Math.max(...polygon.map(p => p.x)), bottom: Math.max(...polygon.map(p => p.y)),
  };
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!;
    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLength && Math.abs(cross(a, b, point)) / edgeLength < 1e-7 && point.x >= Math.min(a.x, b.x) - 1e-7 && point.x <= Math.max(a.x, b.x) + 1e-7 && point.y >= Math.min(a.y, b.y) - 1e-7 && point.y <= Math.max(a.y, b.y) + 1e-7) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Retain the actual roof/awning silhouette, including gaps around chimneys.
 * Interior windows need no extra mask when a convex wall already covers them. */
function glyphMasks(paths: SourcePath[]): Occluder[] {
  const result: Array<{ mask: Occluder; convex: boolean }> = [];
  for (const path of paths) {
    if (!path.closed || !path.fill || path.fill === 'none') continue;
    const mask = shapeMask(path.points);
    if (!mask || result.some(existing => existing.convex && mask.polygon.every(p => pointInPolygon(p, existing.mask.polygon)))) continue;
    const turns = mask.polygon.map((p, i, polygon) => cross(p, polygon[(i + 1) % polygon.length]!, polygon[(i + 2) % polygon.length]!));
    result.push({ mask, convex: turns.every(t => t >= -1e-9) || turns.every(t => t <= 1e-9) });
  }
  if (!result.length) { const legacy = polygonMask(paths.flatMap(p => p.points)); if (legacy) return [legacy]; }
  return result.map(r => r.mask);
}

/** Remove the portions of a plot path hidden by an opaque foreground shape.
 * The returned gaps become real pen lifts rather than paper-coloured paint. */
function clipPathBehindMask(path: PlotPath, mask: Occluder): PlotPath[] {
  if (path.points.length < 2) return [path];
  const pathLeft = Math.min(...path.points.map(p => p.x)), pathRight = Math.max(...path.points.map(p => p.x));
  const pathTop = Math.min(...path.points.map(p => p.y)), pathBottom = Math.max(...path.points.map(p => p.y));
  if (pathRight < mask.left || pathLeft > mask.right || pathBottom < mask.top || pathTop > mask.bottom) return [path];
  const source = path.closed ? [...path.points, path.points[0]!] : path.points;
  const pieces: PlotPath[] = [];
  let points: Point[] = [];
  const flush = () => { if (points.length > 1) pieces.push({ ...path, id: `${path.id}-visible-${pieces.length}`, points, closed: false, preserveGaps: true }); points = []; };
  for (let i = 1; i < source.length; i++) {
    const a = source[i - 1]!, b = source[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const cuts = [0, 1];
    for (let edge = 0; edge < mask.polygon.length; edge++) {
      const c = mask.polygon[edge]!, d = mask.polygon[(edge + 1) % mask.polygon.length]!;
      const ex = d.x - c.x, ey = d.y - c.y;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-10) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator;
      if (t > 1e-8 && t < 1 - 1e-8 && u >= -1e-8 && u <= 1 + 1e-8) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);
    const unique = cuts.filter((value, index) => !index || Math.abs(value - cuts[index - 1]!) > 1e-8);
    for (let part = 1; part < unique.length; part++) {
      const lo = unique[part - 1]!, hi = unique[part]!;
      if (pointInPolygon(pointAt(a, b, (lo + hi) / 2), mask.polygon)) { flush(); continue; }
      const start = pointAt(a, b, lo), end = pointAt(a, b, hi), previous = points.at(-1);
      if (previous && Math.hypot(previous.x - start.x, previous.y - start.y) > 1e-7) flush();
      if (!points.length) points.push(start);
      points.push(end);
    }
  }
  flush();
  return pieces;
}

export function clipPathBehindPolygon(path: PlotPath, polygon: Point[]): PlotPath[] {
  const mask = polygonMask(polygon);
  return mask ? clipPathBehindMask(path, mask) : [path];
}

function clipBehindMasks(path: PlotPath, masks: Occluder[]): PlotPath[] {
  const left = Math.min(...path.points.map(p => p.x)), right = Math.max(...path.points.map(p => p.x));
  const top = Math.min(...path.points.map(p => p.y)), bottom = Math.max(...path.points.map(p => p.y));
  let pieces = [path];
  for (const mask of masks) {
    if (!pieces.length) break;
    if (right < mask.left || left > mask.right || bottom < mask.top || top > mask.bottom) continue;
    pieces = pieces.flatMap(piece => clipPathBehindMask(piece, mask));
  }
  return pieces;
}

/** The preview, tile editor and plot exporter share this exact placement model. */
export function buildIsometricScene(canvas: CanvasSettings, input: Partial<IsometricSettings>, glyphs: IsometricGlyph[]) {
  const s = isometricSettings(input), rad = Math.PI / 180;
  const cos = Math.cos(s.angle * rad), sin = Math.sin(s.angle * rad);
  const width = canvas.widthMm - 2 * canvas.marginMm, height = canvas.heightMm - 2 * canvas.marginMm;
  if (![width, height, canvas.marginMm].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('The safe margin leaves no drawing area.');
  const selectedLand = glyphs.filter(g => (g.role === 'building' || g.terrain === 'park') && (!s.buildingCategories.length || s.buildingCategories.includes(g.categoryId ?? '')));
  const architecture = selectedLand.filter(g => g.role === 'building');
  const buildings = s.algorithm === 'city' && architecture.length ? architecture : selectedLand;
  // A selected artwork pack supplies its own gardens, coastline and vessels.
  const landCollections = new Set(selectedLand.map(g => g.collectionId).filter((id): id is string => !!id));
  const landscape = glyphs.filter(g => !s.buildingCategories.length || !landCollections.size || (g.collectionId && landCollections.has(g.collectionId)));
  const parks = landscape.filter(g => g.terrain === 'park');
  const selectedRoads = glyphs.filter(g => g.role.startsWith('road-') && (!s.roadCategories.length || s.roadCategories.includes(g.categoryId ?? '')));
  const roadCollections = new Set(selectedRoads.map(g => g.collectionId).filter((id): id is string => !!id));
  const roads = glyphs.filter(g => selectedRoads.includes(g) || (s.treeLinedStreets && g.treeLined && g.collectionId && roadCollections.has(g.collectionId)));
  const groups = [...new Set(buildings.map(g => g.categoryId ?? ''))].sort();
  const bounds = new Map<string, { left: number; bottom: number; width: number; height: number }>();
  let maxRise = 0;
  for (const g of glyphs) {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const path of g.paths) for (const p of path.points) { left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
    if (!Number.isFinite(left) || right - left < 1e-8) continue;
    bounds.set(g.id, { left, bottom, width: right - left, height: bottom - top });
    if (g.role === 'building') maxRise = Math.max(maxRise, (bottom - top) / (right - left) * 2 * cos * s.buildingScale * Math.tan(s.angle * rad) / Math.tan(s.sourceAngle * rad));
    else maxRise = Math.max(maxRise, Math.max(0, .5 - top) * 2 * sin);
  }
  const unit = s.fit === 'square' ? Math.min(width / (2 * cos * s.cells), height / (2 * sin * s.cells + maxRise)) : width / (2 * cos * s.cells);
  const cx = canvas.widthMm / 2;
  const cy = s.fit === 'square' ? canvas.heightMm / 2 + maxRise * unit / 2 - (s.cells - 1) * sin * unit : canvas.heightMm / 2;
  const project = (u: number, v: number): Point => ({ x: cx + (u - v) * cos * unit, y: cy + (u + v) * sin * unit });
  const extent = Math.ceil(width / (4 * cos * unit) + height / (4 * sin * unit) + maxRise / sin + 2);
  const min = s.fit === 'square' ? 0 : -extent, max = s.fit === 'square' ? s.cells - 1 : extent;
  if ((max - min + 1) ** 2 > 25_000) throw new Error('This grid is too dense for the page. Reduce grid cells or increase the angle.');
  const unproject = (p: Point): Point => ({ x: ((p.x - cx) / (cos * unit) + (p.y - cy) / (sin * unit)) / 2, y: ((p.y - cy) / (sin * unit) - (p.x - cx) / (cos * unit)) / 2 });
  const generated: IsometricTile[] = [];
  const planned = s.tiles ? [] : planIsometricCells(s, min, max);
  const parkCells = new Set<string>();
  if (s.algorithm === 'city' && architecture.length && parks.length && s.greenSpacesPerBlock) {
    const period = s.blockSize + 1, vp = period * (s.roadLayout === 'avenues' ? 2 : 1);
    const blocks = new Map<string, CityCell[]>();
    for (const cell of planned.filter(c => c.building)) {
      const key = `${Math.floor(cell.u / period)}:${Math.floor(cell.v / vp)}`;
      const block = blocks.get(key) ?? []; block.push(cell); blocks.set(key, block);
    }
    for (const block of blocks.values()) {
      // Keep at least one building in tiny/coast-clipped blocks. Separate the two
      // green lots so each block gets small pockets rather than a park district.
      const ranked = [...block].sort((a, b) => ((Math.imul(a.u + 31, 73856093) ^ Math.imul(a.v + 47, 19349663)) >>> 0) - ((Math.imul(b.u + 31, 73856093) ^ Math.imul(b.v + 47, 19349663)) >>> 0));
      const first = ranked[0]!;
      const count = Math.min(s.greenSpacesPerBlock, Math.max(0, block.length - 1));
      if (count) parkCells.add(`${first.u}:${first.v}`);
      if (count > 1) {
        const second = ranked.slice(1).sort((a, b) => (Math.abs(b.u - first.u) + Math.abs(b.v - first.v)) - (Math.abs(a.u - first.u) + Math.abs(a.v - first.v)))[0]!;
        parkCells.add(`${second.u}:${second.v}`);
      }
    }
  }
  if (!s.tiles) for (const cell of planned) {
    const origin = project(cell.u, cell.v), id = `${cell.u}:${cell.v}`;
    if (origin.x < canvas.marginMm - 2 * unit || origin.x > canvas.widthMm - canvas.marginMm + 2 * unit || origin.y < canvas.marginMm - 2 * unit || origin.y > canvas.heightMm - canvas.marginMm + (maxRise + 2) * unit) continue;
    const hash = Math.imul(cell.u + 101, 374761393) ^ Math.imul(cell.v + 137, 668265263);
    const variant = (hash ^ (hash >>> 13)) >>> 0;
    if (cell.water) {
      const matches: Array<{ glyph: IsometricGlyph; rotation: number }> = [];
      if (cell.shoreMask) for (const glyph of landscape.filter(g => g.terrain === 'shore')) {
        for (let rotation = 0; rotation < 4; rotation++) if ((((glyph.shoreMask ?? 4) << rotation | (glyph.shoreMask ?? 4) >> (4 - rotation)) & 15) === cell.shoreMask) {
          matches.push({ glyph, rotation }); break;
        }
      }
      const pool = landscape.filter(g => g.terrain === (s.waterFeatures && !cell.shoreMask && variant % 7 === 0 ? 'feature' : 'water'));
      const fallback = landscape.filter(g => g.terrain === 'water');
      const match = matches[mod(variant, matches.length)];
      const glyph = match?.glyph ?? pool[mod(variant, pool.length)] ?? fallback[0];
      if (glyph) generated.push({ id, glyphId: glyph.id, u: cell.u, v: cell.v, rotation: match?.rotation ?? 0 });
    } else if (cell.roadMask) {
      const period = s.blockSize + 1, vp = period * (s.roadLayout === 'avenues' ? 2 : 1);
      const leafyAvenue = s.treeLinedStreets && ((mod(cell.u, period) === 0 && mod(Math.floor(cell.u / period), 3) === 1) || (mod(cell.v, vp) === 0 && mod(Math.floor(cell.v / vp), 3) === 1));
      const preferred = roads.filter(g => !!g.treeLined === leafyAvenue);
      const match = matchRoadGlyph(cell.roadMask, preferred, cell.u * 31 + cell.v * 17) ?? matchRoadGlyph(cell.roadMask, roads, cell.u * 31 + cell.v * 17);
      generated.push({ id, glyphId: match?.glyph.id ?? '', u: cell.u, v: cell.v, rotation: match?.rotation ?? 0, roadMask: cell.roadMask });
    } else if (cell.building && groups.length) {
      const group = groups[mod(cell.district, groups.length)];
      const pool = (parkCells.has(id) ? parks : buildings.filter(g => (g.categoryId ?? '') === group)).filter(g => bounds.has(g.id));
      const glyph = pool[mod(hash ^ (hash >>> 13), pool.length)];
      if (glyph) generated.push({ id, glyphId: glyph.id, u: cell.u, v: cell.v, rotation: 0 });
    }
  }
  const tiles = (s.tiles ?? generated).filter(t => Number.isFinite(t.u) && Number.isFinite(t.v)).map(t => ({ ...t, rotation: mod(Math.round(t.rotation || 0), 4) })).sort((a, b) => a.u + a.v - b.u - b.v || a.u - b.u);
  const byId = new Map(glyphs.map(g => [g.id, g]));
  const tilePaths = (tile: IsometricTile): SourcePath[] => {
    const glyph = byId.get(tile.glyphId), origin = project(tile.u, tile.v);
    if (!glyph) return directions.flatMap(([du, dv], i) => (tile.roadMask ?? 0) & (1 << i) ? [{ id: `fallback-${i}`, points: [origin, project(tile.u + du / 2, tile.v + dv / 2)], closed: false }] : []);
    if (glyph.role !== 'building') return glyph.paths.map(path => ({ ...path, points: path.points.map(p => {
      const groundY = p.y + (p.elevation ?? 0);
      const groundX = p.x - (p.billboardX ?? 0);
      let u = groundX + groundY - 1, v = groundY - groundX;
      for (let r = 0; r < tile.rotation; r++) [u, v] = [-v, u];
      const ground = project(tile.u + u, tile.v + v);
      return { x: ground.x + (p.billboardX ?? 0) * 2 * cos * unit, y: ground.y - (p.elevation ?? 0) * 2 * sin * unit };
    }) }));
    const b = bounds.get(glyph.id);
    if (!b) return [];
    const scale = 2 * cos * unit * s.buildingScale / b.width;
    const yScale = scale * Math.tan(s.angle * rad) / Math.tan(s.sourceAngle * rad);
    return glyph.paths.map(path => ({ ...path, points: path.points.map(p => ({ x: origin.x + (p.x - b.left - b.width / 2) * scale, y: origin.y + sin * unit * s.buildingScale + (p.y - b.bottom) * yScale })) }));
  };
  const tileHitPolygons = (tile: IsometricTile) => glyphMasks(tilePaths(tile)).map(mask => mask.polygon);
  return { tiles, project, unproject, tilePaths, tileHitPolygons, min, max, unit, sin, cos, byId };
}

/** One tile per cell. Dropping onto an occupied cell swaps the two tiles. */
export function moveIsometricTile(tiles: IsometricTile[], id: string, u: number, v: number): IsometricTile[] {
  const source = tiles.find(t => t.id === id);
  if (!source || !Number.isFinite(u) || !Number.isFinite(v)) return tiles;
  u = Math.round(u); v = Math.round(v);
  const target = tiles.find(t => t.id !== id && t.u === u && t.v === v);
  return tiles.map(t => t.id === id ? { ...t, u, v } : t.id === target?.id ? { ...t, u: source.u, v: source.v } : t);
}

export function generateIsometric(canvas: CanvasSettings, input: Partial<IsometricSettings>, glyphs: IsometricGlyph[], passIds = ['pass-1']): PlotGeometry {
  const s = isometricSettings(input);
  const { tiles, project, tilePaths, min, max, unit, byId } = buildIsometricScene(canvas, s, glyphs);
  const paths: PlotPath[] = [];
  let pointCount = 0;
  const emit = (id: string, points: Point[], layerId: string, pass: string, closed = false, masks: Occluder[] = []) => {
    if (points.length < 2) return;
    pointCount += points.length;
    if (pointCount > 2_000_000) throw new Error('This drawing is too detailed. Reduce grid cells or simplify the glyphs.');
    const visible = clipBehindMasks({ id, points, layerId, passId: passIds.includes(pass) ? pass : passIds[0] ?? 'pass-1', closed }, masks);
    paths.push(...visible.flatMap(path => clipPath(path, canvas.marginMm, canvas.marginMm, canvas.widthMm - canvas.marginMm, canvas.heightMm - canvas.marginMm)));
  };
  const occluders: Occluder[] = [];
  const paintGlyph = (id: string, source: SourcePath[], layer: string, fallbackPass: string) => {
    const masks = [...occluders];
    const colourPass = (colour?: string) => s.useGlyphColours && colour ? s.colourPasses[colour] || fallbackPass : fallbackPass;
    // Later filled shapes cover earlier marks, even when assigned to different pens.
    for (let i = source.length - 1; i >= 0; i--) {
      const path = source[i]!;
      const filled = path.closed && !!path.fill && path.fill !== 'none';
      if (filled && !path.paper && s.fillMode === 'hatch') {
        for (const [line, points] of hatchSourcePath(path, 45, s.fillSpacing).entries()) emit(`${id}-${i}-fill-${line}`, points, layer, colourPass(path.fill), false, masks);
      }
      if (path.stroke !== 'none') emit(`${id}-${i}`, path.points, layer, colourPass(path.stroke), path.closed, masks);
      // Outline mode still needs visible boundaries for fill-only coloured shapes.
      else if (filled && !path.paper && s.fillMode === 'outline') emit(`${id}-${i}`, path.points, layer, colourPass(path.fill), true, masks);
      if (filled) { const mask = shapeMask(path.points); if (mask) masks.push(mask); }
    }
  };
  for (const tile of [...tiles].reverse()) {
    const glyph = byId.get(tile.glyphId);
    const road = glyph?.role.startsWith('road-') || (!glyph && !!tile.roadMask);
    const layer = road ? 'iso-roads' : glyph?.role === 'terrain' ? 'iso-terrain' : 'iso-buildings';
    const transformed = tilePaths(tile);
    paintGlyph(road ? `road-${tile.id}` : `building-${tile.id}-${tile.glyphId}`, transformed, layer, road ? s.roadPassId : s.buildingPassId);
    occluders.push(...glyphMasks(transformed));
  }
  if (s.algorithm === 'city' && tiles.some(tile => tile.roadMask || byId.get(tile.glyphId)?.role.startsWith('road-'))) {
    // The glyph aprons are intentionally inset. Draw the selected ground surface
    // in the exposed space; opaque buildings, streets and water mask it below.
    const waterTiles = new Set(tiles.filter(tile => {
      const terrain = byId.get(tile.glyphId)?.terrain;
      return terrain === 'water' || terrain === 'shore' || terrain === 'feature';
    }).map(tile => `${tile.u}:${tile.v}`));
    const roadPaths = tiles.flatMap(tile => {
      const glyph = byId.get(tile.glyphId);
      return glyph?.role.startsWith('road-') ? glyph.paths : [];
    });
    // Use the placed road collection. An outline-only dark-paper pack has no
    // ink fills, so use its bright outline colour for exposed paving instead.
    const pavementColour = roadPaths.find(path => path.closed && path.fill && path.fill !== 'none' && !path.paper)?.fill
      ?? roadPaths.find(path => path.stroke && /^#[0-9a-f]{6}$/i.test(path.stroke))?.stroke;
    const pavementPass = s.useGlyphColours && pavementColour ? s.colourPasses[pavementColour] || s.roadPassId : s.roadPassId;
    const grassPass = s.useGlyphColours ? s.colourPasses['#7d9e86'] || s.gridPassId : s.gridPassId;
    // Outline-only road collections need broad paving slabs, not a dense mesh
    // between their buildings. Filled collections retain their finer paving.
    const inkFilledRoads = roadPaths.some(path => path.closed && path.fill && path.fill !== 'none' && !path.paper);
    const joints = inkFilledRoads ? Math.max(2, Math.min(8, Math.round(unit / 3))) : 1;
    for (const cell of planIsometricCells(s, min, max)) {
      if (cell.water || waterTiles.has(`${cell.u}:${cell.v}`)) continue;
      const centre = project(cell.u, cell.v);
      if (centre.x < canvas.marginMm - 2 * unit || centre.x > canvas.widthMm - canvas.marginMm + 2 * unit || centre.y < canvas.marginMm - 2 * unit || centre.y > canvas.heightMm - canvas.marginMm + 2 * unit) continue;
      if (s.groundSurface === 'grass') {
        if (cell.roadMask) continue;
        // A single direction of widely spaced hatching tints the lawn without
        // recreating the square pavement joints beneath the buildings.
        for (let i = 0; i < 6; i++) {
          const offset = (i + .5) / 6 - .5;
          emit(`grass-shade-${cell.u}:${cell.v}-${i}`, [project(cell.u - .5, cell.v + offset), project(cell.u + .5, cell.v + offset)], 'iso-terrain', grassPass, false, occluders);
        }
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
          const seed = (Math.imul(cell.u + 101, 73856093) ^ Math.imul(cell.v + 137, 19349663) ^ Math.imul(row + 1, 83492791) ^ Math.imul(col + 1, 2654435761)) >>> 0;
          if (seed % 5 === 0) continue;
          const u = cell.u + (col + .5 + ((seed >>> 5) % 7 - 3) / 30) / 4 - .5;
          const v = cell.v + (row + .5 + ((seed >>> 9) % 7 - 3) / 30) / 4 - .5;
          const base = project(u, v);
          const blade = Math.min(1.4, unit * .13);
          for (let i = -1; i <= 1; i++) emit(`grass-${cell.u}:${cell.v}-${row}-${col}-${i}`, [base, { x: base.x + i * blade * .55, y: base.y - blade * (i === 0 ? 1 : .7) }], 'iso-terrain', grassPass, false, occluders);
        }
        continue;
      }
      for (let i = 1; i <= joints; i++) {
        const offset = i / joints - .5;
        emit(`pavement-${cell.u}:${cell.v}-u-${i}`, [project(cell.u + offset, cell.v - .5), project(cell.u + offset, cell.v + .5)], 'iso-roads', pavementPass, false, occluders);
        emit(`pavement-${cell.u}:${cell.v}-v-${i}`, [project(cell.u - .5, cell.v + offset), project(cell.u + .5, cell.v + offset)], 'iso-roads', pavementPass, false, occluders);
      }
    }
  }
  if (s.showGrid) for (let i = min; i <= max + 1; i++) {
    emit(`grid-u-${i}`, [project(i - 0.5, min - 0.5), project(i - 0.5, max + 0.5)], 'iso-grid', s.gridPassId, false, occluders);
    emit(`grid-v-${i}`, [project(min - 0.5, i - 0.5), project(max + 0.5, i - 0.5)], 'iso-grid', s.gridPassId, false, occluders);
  }
  return { paths, generator: `isometric.${s.algorithm}`, generatedAt: new Date().toISOString() };
}
