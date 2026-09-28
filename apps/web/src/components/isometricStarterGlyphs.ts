import type { IsometricRole, Point, SourcePath } from '@plotter/core';
import type { GlyphAsset, GlyphCategory } from './Glyphbox';

/** One illustration system for SVG previews and actual pen geometry. */
export const CITYSCAPE_PALETTE = [
  { colour: '#343750', name: 'Midnight ink' }, { colour: '#579cad', name: 'Glass blue' },
  { colour: '#db829c', name: 'Rose signs' }, { colour: '#9697bd', name: 'Lavender shade' },
  { colour: '#cea35e', name: 'Ochre lights' }, { colour: '#7d9e86', name: 'Garden green' },
];
const [INK, BLUE, ROSE, SHADE, GOLD, GREEN] = CITYSCAPE_PALETTE.map(c => c.colour) as [string, string, string, string, string, string];
const PAPER = '#fff5df';
export const CITYSCAPE_CATEGORY = 'iso-cityscape';
export const GREENSPACE_CATEGORY = 'iso-green-spaces';
export const WATERFRONT_CATEGORY = 'iso-waterfront';
export const TREELINED_CATEGORY = 'iso-tree-lined-roads';
type XYZ = [number, number, number];
const iso = ([u, v, z]: XYZ): Point => ({ x: (u - v) * Math.sqrt(3) / 2, y: (u + v) / 2 - z, elevation: z });

class Illustration {
  paths: SourcePath[] = [];
  shape(points: Point[], fill = 'none', stroke = INK, closed = true) {
    // Pale linework is a paper knockout, never an unplottable white stroke.
    if (stroke === PAPER && fill === 'none') {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b.x - a.x, b.y - a.y);
        if (!length) continue;
        const dx = -(b.y - a.y) / length * 0.55, dy = (b.x - a.x) / length * 0.55;
        const offset = (p: Point, x: number, y: number): Point => ({ ...p, x: p.x + x, y: p.y + y, elevation: (p.elevation ?? 0) - y, billboardX: (p.billboardX ?? 0) + x });
        this.shape([offset(a, dx, dy), offset(b, dx, dy), offset(b, -dx, -dy), offset(a, -dx, -dy)], PAPER, 'none');
      }
      return;
    }
    this.paths.push({ id: `shape-${this.paths.length}`, points, closed, stroke, fill, ...(fill === PAPER ? { paper: true } : {}) });
  }
  face(points: XYZ[], fill = PAPER, stroke = INK) { this.shape(points.map(iso), fill, stroke); }
  line(points: XYZ[], stroke = INK) { this.shape(points.map(iso), 'none', stroke, false); }
  box(u: number, v: number, w: number, d: number, z: number, h: number, front = PAPER, side = SHADE, roof = PAPER) {
    this.face([[u, v + d, z], [u + w, v + d, z], [u + w, v + d, z + h], [u, v + d, z + h]], front);
    this.face([[u + w, v, z], [u + w, v + d, z], [u + w, v + d, z + h], [u + w, v, z + h]], side);
    this.face([[u, v, z + h], [u + w, v, z + h], [u + w, v + d, z + h], [u, v + d, z + h]], roof);
  }
  asset(id: string, name: string, role: IsometricRole = 'building', road = false): GlyphAsset {
    const points = this.paths.flatMap(p => p.points);
    const left = road ? -Math.sqrt(3) * 25 : Math.min(...points.map(p => p.x)) - 2;
    const top = road ? Math.min(-25, ...points.map(p => p.y)) - 2 : Math.min(...points.map(p => p.y)) - 2;
    const width = road ? Math.sqrt(3) * 50 : Math.max(...points.map(p => p.x)) - left + 2;
    const height = Math.max(25, ...points.map(p => p.y)) - top + 2;
    const fmt = (v: number) => Number(v.toFixed(4));
    const shapes = this.paths.map(p => `<${p.closed ? 'polygon' : 'polyline'} points="${p.points.map(q => `${fmt(q.x)},${fmt(q.y)}`).join(' ')}" fill="${p.fill}" stroke="${p.stroke}"/>`).join('');
    return {
      id: `cityscape-${id}`, name, kind: 'isometric', categoryId: CITYSCAPE_CATEGORY, isometricRole: role,
      createdAt: new Date(0).toISOString(),
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}"><g stroke-width="0.85" stroke-linecap="round" stroke-linejoin="round">${shapes}</g></svg>`,
      // Isotropic building coordinates; roads occupy the full ground diamond.
      plotPaths: this.paths.map(p => ({ ...p, points: p.points.map(q => ({ x: (q.x - left) / width, y: road ? (q.y + 25) / 50 : (q.y - top) / width, ...(q.elevation ? { elevation: q.elevation / (road ? 50 : width) } : {}), ...(q.billboardX ? { billboardX: q.billboardX / width } : {}) })) })),
    };
  }
}

// Single-line lettering is actual plot geometry, independent of installed fonts.
const LETTERS: Record<string, string> = {
  A: '0,4 0,1 1,0 2,1 2,4;0,2 2,2', B: '0,4 0,0 1.5,0 2,1 1.5,2 0,2;1.5,2 2,3 1.5,4 0,4',
  C: '2,0 0,0 0,4 2,4', D: '0,4 0,0 1,0 2,1 2,3 1,4 0,4', E: '2,0 0,0 0,4 2,4;0,2 1.5,2',
  F: '0,4 0,0 2,0;0,2 1.5,2', G: '2,0 0,0 0,4 2,4 2,2 1,2', H: '0,0 0,4;2,0 2,4;0,2 2,2',
  I: '0,0 2,0;1,0 1,4;0,4 2,4', J: '0,0 2,0 2,4 0,4 0,3', K: '0,0 0,4;2,0 0,2 2,4',
  L: '0,0 0,4 2,4', M: '0,4 0,0 1,2 2,0 2,4', N: '0,4 0,0 2,4 2,0', O: '0,0 2,0 2,4 0,4 0,0',
  P: '0,4 0,0 2,0 2,2 0,2', Q: '0,0 2,0 2,4 0,4 0,0;1,3 2.5,4.5', R: '0,4 0,0 2,0 2,2 0,2 2,4',
  S: '2,0 0,0 0,2 2,2 2,4 0,4', T: '0,0 2,0;1,0 1,4', U: '0,0 0,4 2,4 2,0',
  V: '0,0 1,4 2,0', W: '0,0 0,4 1,2 2,4 2,0', X: '0,0 2,4;2,0 0,4', Y: '0,0 1,2 2,0;1,2 1,4', Z: '0,0 2,0 0,4 2,4 2,0',
};
function lettering(d: Illustration, text: string, map: (x: number, y: number) => XYZ, colour = INK) {
  [...text].forEach((letter, i) => (LETTERS[letter] ?? '').split(';').filter(Boolean).forEach(line => {
    d.line(line.split(' ').map(pair => { const [x, y] = pair.split(',').map(Number); return map(x! + i * 3.3, y!); }), colour);
  }));
}

type Building = { id: string; name: string; floors: number; type: 'home' | 'flats' | 'shop' | 'office' | 'factory' | 'warehouse'; sign?: string; roof?: 'pitch' | 'saw' | 'terrace'; tint?: string; width?: number; depth?: number };
function building(spec: Building): GlyphAsset {
  const d = new Illustration(), w = spec.width ?? 66, depth = spec.depth ?? 58;
  const u = -w / 2, v = -depth / 2, h = 15 * spec.floors + 8;
  const tint = spec.tint ?? ROSE;
  // A generous paved apron meets the adjoining street, with inset kerbs and joints.
  d.box(u - 10, v - 10, w + 20, depth + 20, -1, 2, PAPER, SHADE, PAPER);
  for (let x = u - 8; x < u + w + 10; x += 9) d.line([[x, v + depth + 3, 1], [x, v + depth + 10, 1]], SHADE);
  for (let y = v - 8; y < v + depth + 10; y += 9) d.line([[u + w + 3, y, 1], [u + w + 10, y, 1]], SHADE);
  d.box(u - 3, v - 3, w + 6, depth + 6, 0, 3, PAPER, SHADE);
  d.box(u, v, w, depth, 3, h, spec.type === 'office' ? PAPER : tint, SHADE, PAPER);
  const facade = (side: boolean, x: number, z: number): XYZ => side ? [u + w, v + depth - x, z] : [u + x, v + depth, z];
  const rect = (side: boolean, x: number, z: number, width: number, height: number, fill: string, stroke = INK) =>
    d.face([facade(side, x, z), facade(side, x + width, z), facade(side, x + width, z + height), facade(side, x, z + height)], fill, stroke);
  for (const side of [false, true]) {
    const span = side ? depth : w, cols = spec.type === 'office' ? 5 : 3;
    for (let floor = 0; floor < spec.floors; floor++) {
      if (floor === 0 && ['shop', 'warehouse', 'factory'].includes(spec.type)) continue;
      const z = 8 + floor * 15;
      for (let col = 0; col < cols; col++) {
        const x = 6 + col * (span - 9) / cols, ww = (span - 9) / cols - 4;
        rect(side, x, z, ww, 9, (floor + col) % 5 === 0 ? GOLD : BLUE);
        d.line([facade(side, x + ww / 2, z), facade(side, x + ww / 2, z + 9)], PAPER);
        if (spec.type === 'flats' && floor > 0) {
          rect(side, x - 1, z - 2, ww + 2, 3, PAPER);
          for (let rail = 2; rail < ww; rail += 3) d.line([facade(side, x + rail, z - 2), facade(side, x + rail, z + 1)]);
        }
      }
      if (floor > 0) d.line([facade(side, 0, z - 4), facade(side, span, z - 4)], PAPER);
    }
    if (spec.type === 'shop') {
      rect(side, 5, 5, span - 10, 12, BLUE);
      for (let x = 7; x < span - 7; x += 12) d.line([facade(side, x, 5), facade(side, x, 17)], PAPER);
      rect(side, 2, 19, span - 4, 12, PAPER);
      const word = spec.sign ?? 'SHOP', scale = Math.min(1.75, (span - 10) / (word.length * 3.3));
      lettering(d, word, (x, y) => facade(side, 6 + x * scale, 28 - y * scale), ROSE);
      for (let x = 0; x < span; x += 6) {
        const edge = (t: number, outward: boolean): XYZ => {
          const p = facade(side, t, outward ? 15 : 19);
          if (outward) p[side ? 0 : 1] += 5;
          return p;
        };
        d.face([edge(x, false), edge(Math.min(x + 6, span), false), edge(Math.min(x + 6, span), true), edge(x, true)], x % 12 === 0 ? tint : PAPER);
      }
    } else if (['factory', 'warehouse'].includes(spec.type)) {
      for (let x = 6; x < span - 15; x += 22) {
        rect(side, x, 4, 17, 17, PAPER);
        for (let z = 7; z < 20; z += 3) d.line([facade(side, x, z), facade(side, x + 17, z)], SHADE);
      }
      rect(side, 3, h - 6, span - 6, 9, tint);
      const word = spec.sign ?? 'WORKS', scale = Math.min(1.25, (span - 10) / (word.length * 3.3));
      lettering(d, word, (x, y) => facade(side, 7 + x * scale, h + 1 - y * scale));
    } else {
      rect(side, span / 2 - 5, 3, 10, 14, PAPER);
      d.line([facade(side, span / 2, 3), facade(side, span / 2, 17)]);
      rect(side, span / 2 - 7, 18, 14, 3, tint);
    }
  }
  const roofZ = h + 3;
  if (spec.roof === 'pitch') {
    d.face([[u, v, roofZ], [u + w / 2, v, roofZ + 20], [u + w / 2, v + depth, roofZ + 20], [u, v + depth, roofZ]], BLUE);
    d.face([[u + w / 2, v + depth, roofZ + 20], [u + w, v + depth, roofZ], [u + w, v, roofZ], [u + w / 2, v, roofZ + 20]], SHADE);
    d.face([[u, v + depth, roofZ], [u + w, v + depth, roofZ], [u + w / 2, v + depth, roofZ + 20]], PAPER);
    for (let row = 1; row < 5; row++) {
      const x = u + w / 2 + row * w / 10, z = roofZ + 20 - row * 4;
      d.line([[x, v, z], [x, v + depth, z]], INK);
    }
    for (let y = v + 7; y < v + depth; y += 8) d.line([[u + w / 2, y, roofZ + 20], [u + w, y, roofZ]], INK);
    d.box(u + 9, v + 8, 9, 9, roofZ + 13, 13, tint, SHADE, PAPER);
  } else if (spec.roof === 'saw') {
    for (let x = u; x < u + w; x += w / 3) {
      d.face([[x, v, roofZ], [x + w / 3, v, roofZ + 13], [x + w / 3, v + depth, roofZ + 13], [x, v + depth, roofZ]], PAPER);
      d.face([[x + w / 3, v, roofZ], [x + w / 3, v + depth, roofZ], [x + w / 3, v + depth, roofZ + 13], [x + w / 3, v, roofZ + 13]], BLUE);
      d.face([[x, v + depth, roofZ], [x + w / 3, v + depth, roofZ], [x + w / 3, v + depth, roofZ + 13]], SHADE);
    }
  } else {
    d.face([[u + 3, v + 3, roofZ], [u + w - 3, v + 3, roofZ], [u + w - 3, v + depth - 3, roofZ], [u + 3, v + depth - 3, roofZ]], SHADE);
    d.box(u + 8, v + 7, 19, 15, roofZ, 8, PAPER, tint, PAPER);
    for (let n = 0; n < 2; n++) {
      d.box(u + w - 25, v + 10 + n * 15, 12, 9, roofZ, 3, PAPER, BLUE, PAPER);
      for (let x = 2; x < 11; x += 3) d.line([[u + w - 25 + x, v + 11 + n * 15, roofZ + 3], [u + w - 25 + x, v + 18 + n * 15, roofZ + 3]]);
    }
    if (spec.roof === 'terrace') {
      d.box(u + 7, v + depth - 15, 27, 8, roofZ, 4, PAPER, PAPER, GREEN);
      for (let n = 0; n < 4; n++) d.line([[u + 9 + n * 7, v + depth - 10, roofZ + 4], [u + 9 + n * 7, v + depth - 10, roofZ + 10]], GREEN);
    }
    if (spec.type === 'factory') {
      d.box(u + 8, v + 10, 10, 10, roofZ + 8, 34, tint, SHADE, INK);
      d.box(u + 22, v + 10, 8, 8, roofZ, 28, PAPER, SHADE, INK);
    }
  }
  if (spec.sign && spec.type === 'office') {
    d.face([[u + 5, v + depth, h - 4], [u + w - 5, v + depth, h - 4], [u + w - 5, v + depth, h + 5], [u + 5, v + depth, h + 5]], ROSE);
    lettering(d, spec.sign, (x, y) => [u + 9 + x * 1.2, v + depth, h + 3 - y * 1.2], PAPER);
  }
  person(d, u + w * 0.23, v + depth + 7, 0.72, BLUE);
  if (spec.type !== 'home') person(d, u + w + 7, v + depth * 0.35, 0.72, ROSE);
  return d.asset(spec.id, spec.name);
}

const BUILDINGS: Building[] = [
  { id: 'cottage', name: 'Residential · tiled cottage · 1 storey', type: 'home', floors: 1, roof: 'pitch', tint: PAPER },
  { id: 'townhouse', name: 'Residential · rose townhouse · 2 storeys', type: 'home', floors: 2, roof: 'pitch', tint: ROSE, width: 48 },
  { id: 'terrace', name: 'Residential · garden terrace · 3 storeys', type: 'home', floors: 3, roof: 'terrace', tint: PAPER },
  { id: 'walkup', name: 'Residential · balcony walk-up · 4 storeys', type: 'flats', floors: 4, roof: 'terrace' },
  { id: 'apartments', name: 'Residential · courtyard apartments · 6 storeys', type: 'flats', floors: 6, tint: PAPER },
  { id: 'residential-tower', name: 'Residential · skyline tower · 9 storeys', type: 'flats', floors: 9, roof: 'terrace', tint: PAPER, width: 52, depth: 48 },
  { id: 'cafe', name: 'Commercial · corner café · 2 storeys', type: 'shop', floors: 2, sign: 'CAFE', tint: ROSE },
  { id: 'market', name: 'Commercial · neighbourhood market · 1 storey', type: 'shop', floors: 1, sign: 'MARKET', tint: GREEN, width: 78 },
  { id: 'bookshop', name: 'Commercial · tiled bookshop · 3 storeys', type: 'shop', floors: 3, sign: 'BOOKS', roof: 'pitch', tint: PAPER },
  { id: 'diner', name: 'Commercial · blue diner · 2 storeys', type: 'shop', floors: 2, sign: 'DINER', tint: BLUE },
  { id: 'hotel', name: 'Commercial · rooftop hotel · 7 storeys', type: 'office', floors: 7, sign: 'HOTEL', roof: 'terrace' },
  { id: 'offices', name: 'Commercial · glass offices · 5 storeys', type: 'office', floors: 5 },
  { id: 'office-tower', name: 'Commercial · slender offices · 11 storeys', type: 'office', floors: 11, width: 52, depth: 46 },
  { id: 'warehouse', name: 'Industrial · loading warehouse · 2 storeys', type: 'warehouse', floors: 2, sign: 'DEPOT', tint: GOLD, width: 80 },
  { id: 'sawtooth', name: 'Industrial · sawtooth works · 2 storeys', type: 'factory', floors: 2, sign: 'WORKS', roof: 'saw', tint: PAPER, width: 84 },
  { id: 'factory', name: 'Industrial · chimney factory · 3 storeys', type: 'factory', floors: 3, sign: 'MILL', tint: ROSE },
  { id: 'workshop', name: 'Industrial · repair workshop · 1 storey', type: 'warehouse', floors: 1, sign: 'REPAIR', tint: BLUE },
  { id: 'utility', name: 'Industrial · utility building · 4 storeys', type: 'factory', floors: 4, sign: 'POWER', tint: PAPER, width: 56 },
];

const ROAD_ROLES: { role: Exclude<IsometricRole, 'building' | 'terrain'>; name: string; mask: number }[] = [
  { role: 'road-straight', name: 'Straight', mask: 5 }, { role: 'road-corner', name: 'Corner', mask: 3 },
  { role: 'road-tee', name: 'T junction', mask: 7 }, { role: 'road-cross', name: 'Crossroads', mask: 15 }, { role: 'road-end', name: 'Dead end', mask: 1 },
];
function road(mask: number, role: IsometricRole, name: string, variant: 'avenue' | 'signs' | 'crossing' | 'trees') {
  const d = new Illustration();
  const rotate = (x: number, y: number, side: number): [number, number] => { for (let i = 0; i < side; i++) [x, y] = [-y, x]; return [x, y]; };
  const surface: XYZ[] = [];
  for (let side = 0; side < 4; side++) {
    const arm = mask & (1 << side) ? [[12, -12], [25, -12], [25, 12], [12, 12]] : [[12, -12], [12, 12]];
    for (const [x, y] of arm) surface.push([...rotate(x!, y!, side), 0]);
  }
  if (variant === 'trees') {
    d.face([[-25, -25, 0], [25, -25, 0], [25, 25, 0], [-25, 25, 0]], PAPER, 'none');
    for (let p = -25; p <= 25; p += 5) {
      d.line([[p, -25, 0], [p, 25, 0]], SHADE);
      d.line([[-25, p, 0], [25, p, 0]], SHADE);
    }
  }
  d.face(surface, SHADE, 'none');
  for (let side = 0; side < 4; side++) {
    const p = (x: number, y: number, z = 0): XYZ => [...rotate(x, y, side), z];
    if (mask & (1 << side)) {
      for (const edge of [-13.5, 13.5]) d.line([p(12, edge), p(25, edge)], INK);
      if (variant === 'crossing') {
        for (let x = 15; x < 23; x += 3) d.face([p(x, -10), p(x + 1.4, -10), p(x + 1.4, 10), p(x, 10)], PAPER, 'none');
        d.line([p(12.8, -10), p(12.8, 10)], PAPER);
      } else {
        d.line([p(7, 0), p(13, 0)], GOLD);
        d.line([p(18, 0), p(23, 0)], GOLD);
        d.line([p(15, 6), p(22, 6)], PAPER);
        d.line([p(19, 4), p(22, 6), p(19, 8)], PAPER);
      }
    } else d.line([p(13.5, -13.5), p(13.5, 13.5)]);
  }
  // Vertex heights let road rotations keep signposts upright.
  const upright = (points: XYZ[], fill = 'none', stroke = INK, closed = false) => {
    d.shape(points.map(p => ({ ...iso(p), elevation: p[2] })), fill, stroke, closed);
  };
  if (variant === 'trees') {
    for (const [u, v] of [[-19, -19], [19, -19], [-19, 19], [19, 19]]) {
      planter(d, u! - 3.5, v! - 3.5, 7, 7, false);
      tree(d, u!, v!, .44);
    }
  }
  if (variant === 'signs' || variant === 'crossing') {
    const side = [0, 1, 2, 3].find(s => mask & (1 << s))!;
    const [u, v] = rotate(18, 18, side);
    upright([[u, v, 0], [u, v, 10]]);
    if (variant === 'signs') {
      upright([[u - 4, v, 9], [u + 4, v, 9], [u + 4, v, 15], [u - 4, v, 15]], PAPER, INK, true);
      upright([[u - 2, v, 12], [u + 2, v, 12], [u, v, 14]], 'none', ROSE);
    } else {
      upright([[u - 2.5, v, 9], [u + 2.5, v, 9], [u + 2.5, v, 17], [u - 2.5, v, 17]], INK, INK, true);
      [ROSE, GOLD, GREEN].forEach((c, i) => upright([[u - 1, v, 15.5 - i * 2.5], [u + 1, v, 15.5 - i * 2.5]], 'none', c));
    }
  }
  return { ...d.asset(`${variant}-${role}`, `Road · ${name} · ${variant === 'trees' ? 'tree-lined pavement' : variant === 'avenue' ? 'lane arrows' : variant === 'signs' ? 'street signs' : 'signals & zebra crossing'}`, role, true), ...(variant === 'trees' ? { categoryId: TREELINED_CATEGORY, treeLined: true } : {}) };
}

function greenAsset(id: string, name: string, draw: (d: Illustration) => void): GlyphAsset {
  const d = new Illustration();
  draw(d);
  return { ...d.asset(`green-${id}`, name, 'terrain', true), categoryId: GREENSPACE_CATEGORY, terrain: 'park' };
}

// Ground furniture uses the same inset stonework and slender outlines as the façades.
function ground(d: Illustration, fill = PAPER) {
  d.box(-25, -25, 50, 50, -1, 1, PAPER, SHADE, PAPER);
  for (let v = -25; v < 25; v += 6.25) {
    d.line([[-25, v, .05], [25, v, .05]], SHADE);
    for (let u = -25 + (Math.round(v / 6.25) % 2 ? 3.125 : 0); u < 25; u += 12.5) d.line([[u, v, .05], [u, Math.min(25, v + 6.25), .05]], SHADE);
  }
  if (fill !== PAPER) lawn(d, -19, -19, 38, 38);
}

function lawn(d: Illustration, u: number, v: number, w: number, depth: number) {
  d.box(u, v, w, depth, .1, .8, PAPER, SHADE, PAPER);
  d.face([[u + 1, v + 1, .95], [u + w - 1, v + 1, .95], [u + w - 1, v + depth - 1, .95], [u + 1, v + depth - 1, .95]], GREEN);
  for (let x = u + 4; x < u + w - 3; x += 6) for (let y = v + 4; y < v + depth - 3; y += 8) d.line([[x - 1, y, 1], [x, y - .8, 1], [x + 1, y, 1]], PAPER);
}

function planter(d: Illustration, u: number, v: number, w: number, depth: number, planted = true) {
  d.box(u, v, w, depth, .1, 2.2, PAPER, SHADE, PAPER);
  for (let x = u + 3; x < u + w; x += 4) d.line([[x, v + depth, .2], [x, v + depth, 2.1]], SHADE);
  d.face([[u + 1, v + 1, 2.35], [u + w - 1, v + 1, 2.35], [u + w - 1, v + depth - 1, 2.35], [u + 1, v + depth - 1, 2.35]], GREEN);
  if (planted) for (let x = u + 2; x < u + w - 1; x += 3) {
    d.line([[x, v + depth / 2, 2.4], [x + .6, v + depth / 2, 4.4]], GREEN);
    d.line([[x - .5, v + depth / 2, 4], [x + 1, v + depth / 2, 4.8]], ROSE);
  }
}

// Rounded crowns are screen-facing botanical linework anchored in 3D. Their
// offsets and elevation are preserved separately so road rotations never squash trees.
function foliage(d: Illustration, u: number, v: number, z: number, rx: number, ry: number, colour = GREEN, seed = 0) {
  const centre = iso([u, v, z]);
  const p = (x: number, y: number): Point => ({ x: centre.x + x, y: centre.y + y, elevation: z - y, billboardX: x });
  const contour = Array.from({ length: 48 }, (_, i) => {
    const a = i / 48 * Math.PI * 2;
    const lobe = 1 + .065 * Math.sin(a * 9 + seed) + .035 * Math.cos(a * 13 - seed);
    return p(Math.cos(a) * rx * lobe, Math.sin(a) * ry * lobe);
  });
  d.shape(contour, colour);
  // A fine underside contour reads as shadow without a large purple half-crown.
  d.shape(Array.from({ length: 16 }, (_, i) => { const a = .18 + i / 15 * 2.65; return p(Math.cos(a) * rx * .88, Math.sin(a) * ry * .82); }), 'none', INK, false);
  for (const [x, y, r] of [[-.4, -.2, .23], [.15, -.48, .25], [.25, .18, .2]]) {
    d.shape(Array.from({ length: 7 }, (_, i) => { const a = Math.PI + i * Math.PI / 6; return p((x! + Math.cos(a) * r!) * rx, (y! + Math.sin(a) * r! * .7) * ry); }), 'none', PAPER, false);
  }
}

function tree(d: Illustration, u: number, v: number, scale = 1, blossom = false) {
  d.box(u - .65 * scale, v - .65 * scale, 1.3 * scale, 1.3 * scale, 1, 18 * scale, PAPER, GOLD, PAPER);
  d.line([[u, v, 9 * scale], [u - 3 * scale, v, 16 * scale]], INK);
  d.line([[u, v, 11 * scale], [u + 3 * scale, v, 18 * scale]], INK);
  const colour = blossom ? ROSE : GREEN;
  foliage(d, u, v, 22 * scale, 10.5 * scale, 11 * scale, colour, blossom ? 4 : 2);
}

function conifer(d: Illustration, u: number, v: number, scale = 1) {
  d.box(u - .6, v - .6, 1.2, 1.2, 0, 12 * scale, PAPER, GOLD);
  foliage(d, u, v, 22 * scale, 4.5 * scale, 16 * scale, GREEN, 5);
}

function bench(d: Illustration, u: number, v: number, rotation = false) {
  const p = (along: number, across: number, z: number): XYZ => rotation ? [u + across, v + along, z] : [u + along, v + across, z];
  for (const x of [-4, 4]) d.line([p(x, -1.2, 0), p(x, -1.2, 3.4), p(x, 1.5, 3.4), p(x, 1.5, 0)]);
  for (const y of [-1, 0, 1]) d.face([p(-5.5, y, 3.4), p(5.5, y, 3.4), p(5.5, y + .65, 3.4), p(-5.5, y + .65, 3.4)], PAPER);
  for (const x of [-4, 4]) d.line([p(x, 1.5, 1), p(x, 1.5, 7)]);
  for (const z of [4.7, 6]) d.face([p(-5.5, 1.6, z), p(5.5, 1.6, z), p(5.5, 1.6, z + .8), p(-5.5, 1.6, z + .8)], GOLD);
}

function lamp(d: Illustration, u: number, v: number) {
  d.box(u - .6, v - .6, 1.2, 1.2, 0, 13, PAPER, SHADE);
  d.box(u - 1.5, v - 1.5, 3, 3, 13, 3.5, PAPER, GOLD, SHADE);
  d.face([[u - 2, v - 2, 16.5], [u + 2, v - 2, 16.5], [u + 2, v + 2, 16.5], [u - 2, v + 2, 16.5]], INK);
}

function grass(d: Illustration, u: number, v: number) {
  d.line([[u - 1, v, 0], [u, v, 2], [u + .6, v, 0]], GREEN);
  d.line([[u, v - .6, 0], [u, v, 2]], GREEN);
}

function person(d: Illustration, u: number, v: number, scale = 1, coat = ROSE) {
  const p = (x: number, z: number): XYZ => [u + x * scale, v, 1 + z * scale];
  d.line([p(-1.5, 0), p(0, 4), p(1.5, 0)]);
  d.face([p(-1.5, 4), p(1.5, 4), p(1.1, 8), p(-1.1, 8)], coat);
  d.line([p(-2.5, 4), p(-1, 7), p(1, 7), p(2.5, 5)]);
  d.face([p(-1.2, 8.8), p(-1.2, 10.5), p(1.2, 10.5), p(1.2, 8.8)], PAPER);
}

function fence(d: Illustration, u: number, v: number, length: number) {
  for (let x = 0; x <= length; x += 5) d.line([[u + x, v, 0], [u + x, v, 6]]);
  d.line([[u, v, 5], [u + length, v, 5]]);
  d.line([[u, v, 2], [u + length, v, 2]], SHADE);
}

const GREEN_SPACES: GlyphAsset[] = [
  greenAsset('broadleaf-tree', 'Tree · plane tree and stone seating', d => {
    ground(d); planter(d, -11, -11, 22, 22, false); tree(d, 0, 0, .9);
    bench(d, 0, 17); lamp(d, 19, -17); person(d, 16, 12, .43, BLUE);
  }),
  greenAsset('flowering-tree', 'Tree · cherry blossom reading garden', d => {
    ground(d); lawn(d, -19, -19, 25, 34); planter(d, 11, -18, 8, 19);
    tree(d, -6, -3, .82, true); bench(d, 14, 10, true); person(d, 8, 18, .43);
  }),
  greenAsset('conifer', 'Tree · cypress courtyard', d => {
    ground(d); planter(d, -18, -17, 13, 14, false); planter(d, 5, -7, 13, 14, false);
    conifer(d, -11, -10, .9); conifer(d, 11, 0, .74); bench(d, -5, 16); lamp(d, 19, 17);
  }),
  greenAsset('grove', 'Trees · leafy garden square', d => {
    ground(d); lawn(d, -19, -19, 16, 38); lawn(d, 3, -19, 16, 38);
    for (const [u, v] of [[-11, -11], [11, -11], [-11, 11], [11, 11]]) tree(d, u!, v!, .6);
    person(d, 0, 9, .4, BLUE); fence(d, -19, 20, 38);
  }),
  greenAsset('lawn-path', 'Park · pergola and garden walk', d => {
    ground(d); lawn(d, -19, -19, 15, 38); lawn(d, 4, -19, 15, 38);
    for (const u of [-4, 4]) for (const v of [-13, 5]) d.box(u - .7, v - .7, 1.4, 1.4, 0, 15, PAPER, SHADE);
    for (let v = -16; v <= 8; v += 4) d.box(-6, v, 12, 1.2, 15, 1, PAPER, SHADE, PAPER);
    tree(d, -12, -10, .63); planter(d, 9, -16, 8, 13); bench(d, 12, 11, true); person(d, 0, 15, .43);
  }),
  greenAsset('pond', 'Park · stone fountain and reflecting pool', d => {
    ground(d); d.box(-14, -10, 28, 23, 0, 2, PAPER, SHADE, PAPER);
    d.face([[-12, -8, 2.1], [12, -8, 2.1], [12, 11, 2.1], [-12, 11, 2.1]], BLUE);
    for (const v of [-4, 1, 6]) d.line([[-8, v, 2.2], [8, v, 2.2]], PAPER);
    d.box(-2, -1, 4, 4, 2, 5, PAPER, SHADE, PAPER);
    for (const u of [-5, 5]) d.line([[0, 1, 7], [u / 2, 1, 11], [u, 1, 8], [u * 1.3, 1, 3]], BLUE);
    tree(d, -16, -15, .58); bench(d, 0, 19); lamp(d, 19, 15); person(d, 18, -4, .4);
  }),
  greenAsset('playground', 'Park · timber playground and slide', d => {
    ground(d); d.box(-19, -18, 38, 35, 0, 1, PAPER, SHADE, PAPER);
    for (const u of [-13, -4]) for (const v of [-11, -2]) d.box(u, v, 1, 1, 1, 14, PAPER, GOLD);
    d.box(-14, -12, 12, 12, 8, 1, PAPER, SHADE, PAPER);
    d.face([[-15, -13, 16], [-8, -13, 21], [-8, 1, 21], [-15, 1, 16]], BLUE);
    d.face([[-8, -13, 21], [-1, -13, 16], [-1, 1, 16], [-8, 1, 21]], PAPER);
    d.face([[-8, 0, 9], [-4, 0, 9], [4, 13, 1], [0, 13, 1]], ROSE);
    for (const x of [-8, -4]) d.line([[x, 0, 10], [x + 8, 13, 2]], INK);
    for (let z = 2; z <= 9; z += 2) d.line([[-15, -7, z], [-15, -3, z]], GOLD);
    d.line([[-15, -7, 1], [-15, -7, 10], [-15, -3, 10], [-15, -3, 1]]);
    tree(d, 14, -12, .58); bench(d, 10, 19); person(d, 9, 9, .3, BLUE); fence(d, -18, -20, 36);
  }),
  greenAsset('community-garden', 'Green space · walled community garden', d => {
    ground(d);
    for (const [u, v] of [[-18, -14], [-18, 1], [1, 1]]) {
      planter(d, u!, v!, 14, 10, false);
      for (let x = 3; x < 13; x += 3) for (const y of [3, 7]) d.line([[u! + x - 1, v! + y, 2.4], [u! + x, v! + y, 4.8], [u! + x + 1, v! + y, 2.4]], GREEN);
    }
    d.box(3, -18, 13, 13, 0, 11, PAPER, SHADE, PAPER);
    d.face([[2, -19, 11], [9, -19, 16], [9, -4, 16], [2, -4, 11]], BLUE);
    d.face([[9, -19, 16], [17, -19, 11], [17, -4, 11], [9, -4, 16]], PAPER);
    d.face([[6, -5, .5], [11, -5, .5], [11, -5, 8], [6, -5, 8]], GOLD);
    fence(d, -19, -21, 38); bench(d, 1, 19); person(d, -1, -7, .4);
  }),
  greenAsset('flower-garden', 'Green space · lawn and flower borders', d => {
    ground(d); lawn(d, -17, -11, 34, 27);
    planter(d, -19, -19, 38, 6); planter(d, -19, -11, 5, 24); planter(d, 14, -11, 5, 24);
    bench(d, 0, 20); tree(d, -13, -15, .63, true); person(d, 17, 18, .43, BLUE);
  }),
  greenAsset('pocket-plaza', 'Green space · garden kiosk and café seats', d => {
    ground(d); planter(d, -19, -18, 14, 14, false); tree(d, -12, -11, .75);
    d.box(2, -16, 16, 14, 0, 13, PAPER, SHADE, PAPER);
    d.box(1, -17, 18, 16, 13, 2, PAPER, SHADE, PAPER);
    d.face([[4, -2, 4], [16, -2, 4], [16, -2, 10], [4, -2, 10]], BLUE);
    for (let u = 1; u < 19; u += 3) d.face([[u, -2, 12], [u + 3, -2, 12], [u + 3, 3, 10], [u, 3, 10]], u % 2 ? ROSE : PAPER);
    d.box(-5, 6, 10, 7, 0, 4, PAPER, SHADE, PAPER);
    bench(d, 0, 17); bench(d, -12, 8, true); lamp(d, 20, 18); person(d, 11, 10, .43);
  }),
];

function water(d: Illustration) {
  d.face([[-25, -25, 0], [25, -25, 0], [25, 25, 0], [-25, 25, 0]], BLUE, 'none');
  for (const [u, v] of [[-17, -15], [8, -18], [-5, 0], [15, 8], [-16, 17], [5, 20]]) {
    d.line([[u!, v!, .05], [u! + 4, v! - 1, .05], [u! + 8, v!, .05]], PAPER);
  }
}

function shoreline(d: Illustration, quay = false, corner = false) {
  water(d);
  const land: XYZ[] = corner
    ? [[-25, -25, .5], [25, -25, .5], [25, -8, .5], [-8, -8, .5], [-8, 25, .5], [-25, 25, .5]]
    : [[-25, -25, .5], [-7, -25, .5], [-7, 25, .5], [-25, 25, .5]];
  d.face(land, quay ? PAPER : GOLD);
  if (quay) {
    for (let v = -25; v <= 25; v += 6.25) d.line([[-25, v, .5], [-7, v, .5]], SHADE);
    d.line([[-16, -25, .5], [-16, 25, .5]], SHADE);
    d.face([[-7, -25, .5], [-7, 25, .5], [-7, 25, -2], [-7, -25, -2]], SHADE);
    for (const v of [-20, 20]) d.box(-10, v - 1, 2, 2, .5, 3, INK, INK, GOLD);
    person(d, -20, 10, .65);
  } else {
    d.line([[-4, corner ? -4 : -25, .1], [-4, 25, .1]], PAPER);
    if (corner) d.line([[-4, -4, .1], [25, -4, .1]], PAPER);
    d.face([[-25, -25, .7], [-18, -25, .7], [-18, 25, .7], [-25, 25, .7]], GREEN);
    for (const v of [-15, 13]) grass(d, -22, v);
  }
}

function vessel(d: Illustration, fishing = false, sail = false) {
  water(d);
  d.face([[-20, -5, 2], [-14, -9, 2], [13, -9, 2], [22, 0, 2], [13, 9, 2], [-14, 9, 2], [-20, 5, 2]], PAPER);
  d.face([[-20, 5, 2], [-14, 9, 2], [13, 9, 2], [22, 0, 2], [13, 7, -2], [-14, 7, -2]], fishing ? ROSE : SHADE);
  d.line([[-18, 4, 3], [-13, 7, 3], [12, 7, 3], [19, 0, 3]], GOLD);
  if (sail) {
    d.line([[0, 0, 2], [0, 0, 30]]);
    d.face([[0, 0, 29], [0, 0, 6], [17, 0, 6]], PAPER);
    d.face([[-2, 0, 25], [-2, 0, 7], [-16, 0, 7]], ROSE);
    d.line([[0, 0, 30], [-17, 0, 3]], SHADE);
  } else {
    d.box(-9, -5, fishing ? 10 : 13, 10, 2, 8, PAPER, SHADE, PAPER);
    for (const u of [-7, -3]) d.face([[u, 5, 6], [u + 2.5, 5, 6], [u + 2.5, 5, 9], [u, 5, 9]], BLUE);
    d.box(-6, -2, 3, 3, 10, 4, ROSE, SHADE, INK);
    d.line([[6, 0, 2], [6, 0, fishing ? 23 : 18]]);
    d.line([[6, 0, 19], [16, 0, 17], [15, 0, 4]], INK);
    if (fishing) {
      for (const u of [8, 12]) d.box(u, -5, 3, 4, 2, 2, GOLD, SHADE, PAPER);
      person(d, 4, 5, .5, BLUE);
    } else {
      for (const v of [-4, 1]) d.box(5, v, 10, 4, 2, 4, v < 0 ? ROSE : GOLD, SHADE, PAPER);
    }
  }
  d.line([[-23, 10, .1], [-15, 12, .1], [8, 12, .1]], PAPER);
}

function waterfrontAsset(id: string, name: string, draw: (d: Illustration) => void, terrain: GlyphAsset['terrain'] = 'feature', shoreMask?: number): GlyphAsset {
  const d = new Illustration(); draw(d);
  return { ...d.asset(`water-${id}`, name, 'terrain', true), categoryId: WATERFRONT_CATEGORY, terrain, shoreMask };
}
const WATERFRONT: GlyphAsset[] = [
  waterfrontAsset('open', 'Water · open sea', water, 'water'),
  waterfrontAsset('lake', 'Water · calm lake', d => { water(d); d.line([[-12, 7, .1], [0, 6, .1], [12, 7, .1]], PAPER); }, 'water'),
  waterfrontAsset('beach', 'Coast · beach and dunes', d => shoreline(d), 'shore', 4),
  waterfrontAsset('corner', 'Coast · sheltered bay corner', d => shoreline(d, false, true), 'shore', 12),
  waterfrontAsset('quay', 'Coast · paved quay and walkers', d => shoreline(d, true), 'shore', 4),
  waterfrontAsset('lake-bank', 'Lake · reed bank', d => { shoreline(d); for (const v of [-14, -6, 8, 16]) { d.line([[-8, v, 0], [-8, v, 6]], GREEN); d.line([[-8, v, 6], [-7, v, 8]], GOLD); } }, 'shore', 4),
  waterfrontAsset('dock', 'Harbour · timber fishing dock', d => {
    shoreline(d, true);
    d.box(-8, -5, 28, 10, 0, 2, GOLD, SHADE, PAPER);
    for (let u = -6; u < 20; u += 3) d.line([[u, -5, 2], [u, 5, 2]], GOLD);
    for (const u of [-4, 17]) for (const v of [-4, 4]) d.box(u, v, 1.5, 1.5, -1, 6, GOLD, SHADE, PAPER);
    person(d, 11, 0, .6, BLUE);
    d.line([[12, 0, 6], [21, 0, 10], [23, 0, 0]]);
  }, 'shore', 4),
  waterfrontAsset('cargo', 'Ship · coastal cargo vessel', d => vessel(d)),
  waterfrontAsset('fishing', 'Boat · fishing trawler', d => vessel(d, true)),
  waterfrontAsset('sailing', 'Boat · little sailing yacht', d => vessel(d, false, true)),
  waterfrontAsset('shark', 'Wildlife · shark and wake', d => {
    water(d);
    d.face([[-13, 0, .3], [-5, -4, .3], [14, 0, .3], [-5, 4, .3]], SHADE);
    d.face([[-4, 0, .3], [3, 0, 12], [6, 0, .3]], PAPER);
    d.face([[-14, 0, .3], [-18, 0, 6], [-17, 0, .3]], SHADE);
    d.line([[-13, 7, .1], [-3, 8, .1], [10, 6, .1]], PAPER);
  }),
  waterfrontAsset('whale', 'Wildlife · surfacing whale', d => {
    water(d);
    d.face([[-18, 0, 1], [-12, -6, 2], [3, -7, 3], [13, -4, 2], [17, 0, 1], [13, 5, 1], [0, 7, 1], [-12, 4, 1]], SHADE);
    d.face([[-15, 0, 1], [-22, -6, 3], [-22, 1, 2], [-18, 4, 2], [-21, 9, 3], [-13, 5, 1]], BLUE);
    d.line([[4, 7, 1], [10, 6, 1], [15, 3, 1]], PAPER);
    d.line([[10, 0, 3], [10, 0, 14], [5, 0, 18], [3, 0, 16]], BLUE);
    d.line([[10, 0, 11], [13, 0, 17], [16, 0, 16]], BLUE);
    d.line([[12, 4, 2], [13, 4, 2]], INK);
  }),
];

export const ISOMETRIC_STARTER_CATEGORIES: GlyphCategory[] = [
  { id: CITYSCAPE_CATEGORY, name: 'Cityscape', kind: 'isometric' },
  { id: GREENSPACE_CATEGORY, name: 'Parks & green spaces', kind: 'isometric' },
  { id: WATERFRONT_CATEGORY, name: 'Coasts & lakes', kind: 'isometric' },
  { id: TREELINED_CATEGORY, name: 'Tree-lined roads', kind: 'isometric' },
];
export const ISOMETRIC_STARTER_ASSETS = [
  ...BUILDINGS.map(building),
  ...(['avenue', 'signs', 'crossing'] as const).flatMap(variant => ROAD_ROLES.map(r => road(r.mask, r.role, r.name, variant))),
  ...ROAD_ROLES.map(r => road(r.mask, r.role, r.name, 'trees')),
  ...GREEN_SPACES,
  ...WATERFRONT,
];
