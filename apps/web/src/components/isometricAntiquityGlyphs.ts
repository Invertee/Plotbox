import type { IsometricRole, Point, SourcePath } from '@plotter/core';
import type { GlyphAsset, GlyphCategory } from './Glyphbox';

/** Classical architecture drawn as real pen geometry, with the same ground
 * diamond and elevation convention as the original Cityscape collection. */
export const ANTIQUITY_CATEGORY = 'iso-antiquity';
export const ANTIQUITY_PALETTE = [
  { colour: '#493c32', name: 'Antiquity · umber ink' },
  { colour: '#b8583c', name: 'Antiquity · terracotta' },
  { colour: '#bc9356', name: 'Antiquity · bronze ochre' },
  { colour: '#758464', name: 'Antiquity · olive green' },
  { colour: '#5a9296', name: 'Antiquity · Aegean blue' },
  { colour: '#b6a58d', name: 'Antiquity · limestone shade' },
];
const [INK, CLAY, GOLD, GREEN, BLUE, SHADE] = ANTIQUITY_PALETTE.map(c => c.colour) as [string, string, string, string, string, string];
const PAPER = '#fff5df';
type XYZ = [number, number, number];
const iso = ([u, v, z]: XYZ): Point => ({ x: (u - v) * Math.sqrt(3) / 2, y: (u + v) / 2 - z, elevation: z });
const round = (n: number) => Number(n.toFixed(5));

class Tile {
  paths: SourcePath[] = [];
  face(vertices: XYZ[], fill = PAPER, stroke = INK) {
    this.paths.push({ id: `antique-${this.paths.length}`, points: vertices.map(iso), closed: true, fill, stroke, ...(fill === PAPER ? { paper: true } : {}) });
  }
  line(vertices: XYZ[], stroke = INK) {
    this.paths.push({ id: `antique-${this.paths.length}`, points: vertices.map(iso), closed: false, fill: 'none', stroke });
  }
  box(u: number, v: number, w: number, d: number, z: number, h: number, front = PAPER, side = SHADE, top = PAPER) {
    this.face([[u, v + d, z], [u + w, v + d, z], [u + w, v + d, z + h], [u, v + d, z + h]], front);
    this.face([[u + w, v, z], [u + w, v + d, z], [u + w, v + d, z + h], [u + w, v, z + h]], side);
    this.face([[u, v, z + h], [u + w, v, z + h], [u + w, v + d, z + h], [u, v + d, z + h]], top);
  }
  disc(u: number, v: number, r: number, z: number, fill = PAPER, ry = r) {
    this.face(Array.from({ length: 20 }, (_, i): XYZ => [u + r * Math.cos(i * Math.PI / 10), v + ry * Math.sin(i * Math.PI / 10), z]), fill);
  }
  cylinder(u: number, v: number, r: number, z: number, h: number, fill = PAPER) {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 4 + i * Math.PI / 10, b = a + Math.PI / 10;
      this.face([[u + r * Math.cos(a), v + r * Math.sin(a), z], [u + r * Math.cos(b), v + r * Math.sin(b), z], [u + r * Math.cos(b), v + r * Math.sin(b), z + h], [u + r * Math.cos(a), v + r * Math.sin(a), z + h]], i < 5 ? SHADE : fill);
    }
    this.disc(u, v, r, z + h, fill);
  }
  asset(id: string, name: string, role: IsometricRole = 'building', terrain?: GlyphAsset['terrain'], extra: Partial<GlyphAsset> = {}): GlyphAsset {
    const ground = role !== 'building', points = this.paths.flatMap(p => p.points);
    const left = ground ? -Math.sqrt(3) * 25 : Math.min(...points.map(p => p.x)) - 2;
    const top = Math.min(-25, ...points.map(p => p.y)) - 2;
    const width = ground ? Math.sqrt(3) * 50 : Math.max(...points.map(p => p.x)) - left + 2;
    const height = Math.max(25, ...points.map(p => p.y)) - top + 2;
    const shapes = this.paths.map(p => `<${p.closed ? 'polygon' : 'polyline'} points="${p.points.map(q => `${round(q.x)},${round(q.y)}`).join(' ')}" fill="${p.fill}" stroke="${p.stroke}"/>`).join('');
    return {
      id: `antiquity-${id}`, name, kind: 'isometric', categoryId: ANTIQUITY_CATEGORY, collectionId: ANTIQUITY_CATEGORY,
      createdAt: new Date(0).toISOString(), isometricRole: role, terrain,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}"><g stroke-width="0.65" stroke-linejoin="round" stroke-linecap="round">${shapes}</g></svg>`,
      plotPaths: this.paths.map(p => ({ ...p, points: p.points.map(q => ({ x: round((q.x - left) / width), y: round(ground ? (q.y + 25) / 50 : (q.y - top) / width), ...(q.elevation ? { elevation: round(q.elevation / (ground ? 50 : width)) } : {}) })) })),
      ...extra,
    };
  }
}

function base(d: Tile, size = 42) {
  d.box(-size / 2, -size / 2, size, size, -1, 1.5);
  for (let x = -size / 2 + 5; x < size / 2; x += 7) {
    d.line([[x, size / 2 - 3, .5], [x, size / 2, .5]], SHADE);
    d.line([[size / 2 - 3, x, .5], [size / 2, x, .5]], SHADE);
  }
}

function column(d: Tile, u: number, v: number, z: number, h: number, r = 1.2, ionic = false) {
  d.box(u - r * 1.5, v - r * 1.5, r * 3, r * 3, z, 1);
  d.box(u - r, v - r, r * 2, r * 2, z + 1, h - 2);
  d.line([[u, v + r, z + 2], [u, v + r * .8, z + h - 2]], SHADE);
  d.box(u - r * 1.7, v - r * 1.7, r * 3.4, r * 3.4, z + h - 1, 1);
  if (ionic) for (const x of [-r * 1.3, r * 1.3]) d.line([[u + x, v + r * 1.8, z + h], [u + x, v + r * 1.8, z + h - 1.5], [u + x * .65, v + r * 1.8, z + h - 1.5]]);
}

function roof(d: Tile, u: number, v: number, w: number, depth: number, z: number, rise = 7, colour = CLAY) {
  d.face([[u - 1, v + depth + 1, z], [u + w + 1, v + depth + 1, z], [u + w / 2, v + depth + 1, z + rise]], PAPER);
  d.face([[u - 1, v - 1, z], [u + w / 2, v - 1, z + rise], [u + w / 2, v + depth + 1, z + rise], [u - 1, v + depth + 1, z]], colour);
  d.face([[u + w / 2, v - 1, z + rise], [u + w + 1, v - 1, z], [u + w + 1, v + depth + 1, z], [u + w / 2, v + depth + 1, z + rise]], colour);
  for (let t = .2; t < 1; t += .2) {
    const zz = z + rise * (1 - t), x = u + w / 2 + (w / 2 + 1) * t;
    d.line([[x, v - 1, zz], [x, v + depth + 1, zz]], GOLD);
  }
  for (let y = v + 2; y < v + depth + 1; y += 4) d.line([[u + w / 2, y, z + rise], [u + w + 1, y, z]], INK);
  d.line([[u + w / 2, v - 1, z + rise + .5], [u + w / 2, v + depth + 1, z + rise + .5]], GOLD);
}

/** A true semicircular opening on either visible wall. */
function arch(d: Tile, u: number, v: number, z: number, w: number, h: number, side = false, fill = SHADE) {
  const p = (x: number, zz: number): XYZ => side ? [u, v - x, zz] : [u + x, v, zz];
  const spring = z + h - w / 2;
  const arc = Array.from({ length: 9 }, (_, i) => p(w / 2 + Math.cos(Math.PI - i * Math.PI / 8) * w / 2, spring + Math.sin(i * Math.PI / 8) * w / 2));
  d.face([p(0, z), ...arc, p(w, z)], fill);
  d.line([p(-.7, z), p(-.7, spring), ...Array.from({ length: 9 }, (_, i) => p(w / 2 + Math.cos(Math.PI - i * Math.PI / 8) * (w / 2 + .7), spring + Math.sin(i * Math.PI / 8) * (w / 2 + .7))), p(w + .7, z)], GOLD);
}

function amphora(d: Tile, u: number, v: number, z = .5, s = 1) {
  const p = (x: number, zz: number): XYZ => [u + x * s, v, z + zz * s];
  d.face([p(-.6, 0), p(-1.8, 2), p(-2, 3.5), p(-.7, 4.5), p(-.7, 5.5), p(.7, 5.5), p(.7, 4.5), p(2, 3.5), p(1.8, 2), p(.6, 0)], CLAY);
  d.line([p(-.7, 4.5), p(-2.5, 4.5), p(-2.5, 3), p(-1.8, 2.5)], GOLD);
  d.line([p(.7, 4.5), p(2.5, 4.5), p(2.5, 3), p(1.8, 2.5)], GOLD);
  d.line([p(-1.6, 2.7), p(1.6, 2.7)], GOLD);
}

function tree(d: Tile, u: number, v: number, s = 1, cypress = false) {
  d.line([[u, v, .5], [u, v, 9 * s]], INK);
  if (cypress) {
    d.face([[u - 2 * s, v, 5 * s], [u - 2.8 * s, v, 10 * s], [u - 1.6 * s, v, 17 * s], [u, v, 23 * s], [u + 1.8 * s, v, 16 * s], [u + 2.8 * s, v, 9 * s], [u + 1.5 * s, v, 5 * s]], GREEN);
    d.line([[u, v, 6 * s], [u, v, 19 * s]], GOLD);
  } else {
    d.line([[u, v, 6 * s], [u - 3 * s, v, 10 * s]], GOLD);
    d.face([[-6, 10], [-5, 13], [-2, 14], [0, 13], [3, 14], [6, 12], [5, 9], [2, 8], [-1, 9], [-4, 8]].map(([x, z]): XYZ => [u + x! * s, v, z! * s]), GREEN);
    d.line([[u - 3 * s, v, 11 * s], [u, v, 12 * s], [u + 3 * s, v, 11 * s]], GOLD);
  }
}

function pool(d: Tile, u: number, v: number, w: number, depth: number, z = .5) {
  d.box(u, v, w, depth, z, 1, PAPER, SHADE, PAPER);
  d.face([[u + 1.5, v + 1.5, z + 1], [u + w - 1.5, v + 1.5, z + 1], [u + w - 1.5, v + depth - 1.5, z + 1], [u + 1.5, v + depth - 1.5, z + 1]], BLUE);
  d.line([[u + 3, v + depth / 2, z + 1.1], [u + w - 3, v + depth / 2, z + 1.1]], GOLD);
}

function fountain(d: Tile, u = 0, v = 0, r = 7) {
  d.cylinder(u, v, r, .5, 1.5);
  d.disc(u, v, r - 1, 2.1, BLUE);
  column(d, u, v, 2.2, 5, .7);
  d.disc(u, v, r * .5, 7.2);
  d.line([[u, v, 7.2], [u, v, 10], [u + 3, v, 8], [u + 4, v, 3]], BLUE);
  d.line([[u, v, 10], [u - 3, v, 8], [u - 4, v, 3]], BLUE);
}

function steps(d: Tile, u: number, v: number, w: number, n = 4, z = .5) {
  for (let i = 0; i < n; i++) d.box(u, v - i * 1.7, w, 1.7, z, (i + 1) * 1.1);
}

function houseBody(d: Tile, u: number, v: number, w: number, depth: number, floors = 1, tint = PAPER, balcony = false) {
  const h = floors * 10 + 4;
  d.box(u, v, w, depth, .5, h, tint);
  d.box(u - .5, v - .5, w + 1, depth + 1, h - .7, 1.2);
  for (const side of [false, true]) {
    const span = side ? depth : w;
    for (let floor = 0; floor < floors; floor++) for (let x = 3; x < span - 3; x += 8) {
      const door = floor === 0 && x === 3;
      arch(d, side ? u + w : u + x, side ? v + depth - x : v + depth, door ? .5 : floor * 10 + 5, door ? 4.5 : 3, door ? 8 : 4, side, door ? GOLD : SHADE);
    }
    for (let floor = 1; floor < floors; floor++) d.line(side ? [[u + w, v, floor * 10 + 2], [u + w, v + depth, floor * 10 + 2]] : [[u, v + depth, floor * 10 + 2], [u + w, v + depth, floor * 10 + 2]], GOLD);
  }
  if (balcony) {
    d.box(u + 2, v + depth, w - 4, 3, 11, 1);
    d.line([[u + 2, v + depth + 3, 15], [u + w - 2, v + depth + 3, 15]], GOLD);
    for (let x = u + 2; x <= u + w - 2; x += 3) d.line([[x, v + depth + 3, 12], [x, v + depth + 3, 15]], GOLD);
  }
  roof(d, u, v, w, depth, h + .5, w * .25);
}

type Home = { id: string; name: string; floors: number; w: number; depth: number; tint?: string; balcony?: boolean; wing?: boolean; porch?: boolean };
function home(s: Home) {
  const d = new Tile(); base(d, 48);
  houseBody(d, -s.w / 2, -s.depth / 2 - 3, s.w, s.depth, s.floors, s.tint, s.balcony);
  if (s.wing) houseBody(d, -s.w / 2 - 5, s.depth / 2 - 4, s.w * .58, 10, 1);
  if (s.porch) {
    for (const x of [-9, 0, 9]) column(d, x, s.depth / 2 + 4, .5, 9);
    roof(d, -11, s.depth / 2 - 3, 22, 9, 10, 3);
  }
  amphora(d, 18, 17, .5, .8); tree(d, -19, 14, .55, s.floors > 1);
  return d.asset(s.id, `Home · ${s.name}`);
}

function courtyard(id: string, name: string, variant: 'atrium' | 'villa' | 'peristyle' | 'garden' | 'estate') {
  const d = new Tile(); base(d, 50);
  houseBody(d, -21, -21, 42, 12, variant === 'estate' ? 2 : 1);
  houseBody(d, -21, -7, 11, 25, variant === 'villa' ? 2 : 1);
  if (variant === 'atrium' || variant === 'peristyle' || variant === 'estate') houseBody(d, 11, -7, 10, 25, 1);
  if (variant === 'garden') {
    d.box(-7, -4, 25, 22, .5, 1, PAPER, SHADE, GREEN);
    for (const x of [-2, 12]) tree(d, x, 5, .6, true);
    fountain(d, 5, 15, 4);
  } else pool(d, -6, 0, 14, 15);
  if (variant === 'peristyle' || variant === 'estate') {
    for (const x of [-8, 8]) for (const y of [-4, 5, 16]) column(d, x, y, .5, 9, .7);
    for (const x of [-9, 7]) d.box(x, -6, 2, 24, 9.5, 1.5);
  }
  d.box(-21, 20, 42, 1.5, .5, 2.5);
  amphora(d, -5, 19, .5, .65); amphora(d, 6, 19, .5, .65);
  return d.asset(id, `Home · ${name}`);
}

function awning(d: Tile, u: number, v: number, w: number, z: number, tint = CLAY) {
  for (let x = 0; x < w; x += 3) d.face([[u + x, v, z], [u + Math.min(w, x + 3), v, z], [u + Math.min(w, x + 3), v + 6, z - 2], [u + x, v + 6, z - 2]], Math.round(x / 3) % 2 ? PAPER : tint);
  for (const x of [u, u + w]) d.line([[x, v + 6, .5], [x, v + 6, z - 2]], GOLD);
}

const TRADES = ['bakery', 'wine', 'pottery', 'fish', 'cloth', 'oil', 'smith', 'grain', 'tavern'] as const;
function goods(d: Tile, trade: typeof TRADES[number], u: number, v: number, z: number) {
  if (['wine', 'pottery', 'oil', 'tavern'].includes(trade)) {
    for (const x of [0, 4, 8]) amphora(d, u + x, v, z, trade === 'pottery' ? .8 : .65);
  } else if (trade === 'bakery') {
    for (const x of [0, 4, 8]) { d.disc(u + x, v, 1.7, z + .4, GOLD); d.line([[u + x - 1, v, z + .5], [u + x + 1, v, z + .5]], INK); }
  } else if (trade === 'fish') {
    for (const x of [0, 4, 8]) d.face([[u + x, v - 2, z], [u + x + 1.5, v, z], [u + x, v + 2, z], [u + x - 1, v + 3, z], [u + x + 1, v + 3, z], [u + x - 1.5, v, z]], BLUE);
  } else if (trade === 'cloth') {
    for (let i = 0; i < 3; i++) d.box(u + i * 3.5, v - 2, 3, 5, z, 1.5, i % 2 ? CLAY : BLUE, SHADE, i % 2 ? CLAY : BLUE);
  } else if (trade === 'smith') {
    d.box(u + 2, v - 1, 4, 3, z, 2, SHADE, INK, SHADE);
    d.face([[u, v, z + 2], [u + 9, v, z + 2], [u + 7, v + 3, z + 2], [u + 2, v + 3, z + 2]], SHADE);
  } else {
    for (const x of [0, 4, 8]) d.cylinder(u + x, v, 1.7, z, 2.5, GOLD);
  }
}

function merchant(trade: typeof TRADES[number], i: number) {
  const d = new Tile(); base(d, 46);
  houseBody(d, -17, -17, 31, 24, i % 3 === 0 ? 2 : 1, i % 2 ? PAPER : GOLD);
  arch(d, -12, 7, .5, 8, 10, false, INK);
  arch(d, 1, 7, .5, 8, 10, false, SHADE);
  awning(d, -15, 7, 27, 12, trade === 'fish' || trade === 'cloth' ? BLUE : CLAY);
  d.box(-12, 13, 21, 5, .5, 3, PAPER, SHADE, GOLD);
  goods(d, trade, -8, 15, 3.6);
  if (trade === 'bakery' || trade === 'smith') {
    d.box(15, -10, 5, 8, .5, 8, GOLD); arch(d, 15.5, -2, 1, 4, 5, false, INK);
    d.box(16, -9, 3, 3, 8.5, 15, CLAY);
  } else amphora(d, 17, 13, .5, 1);
  const names = ['bread oven & bakery', 'wine merchant', 'potter’s workshop', 'fishmonger', 'dyer & cloth shop', 'olive-oil merchant', 'blacksmith’s forge', 'grain dealer', 'street tavern'];
  return d.asset(`shop-${trade}`, `Merchant · ${names[i]}`);
}

function market(id: string, name: string, covered: boolean) {
  const d = new Tile(); base(d, 48);
  if (covered) {
    for (const x of [-18, -6, 6, 18]) column(d, x, -13, .5, 17, 1);
    d.box(-20, -16, 40, 4, 17.5, 2);
  }
  for (let i = 0; i < 3; i++) {
    const u = -20 + i * 14;
    d.box(u, -5, 11, 7, .5, 4, GOLD);
    goods(d, TRADES[i * 2]!, u + 1, -1, 4.6);
    if (!covered) awning(d, u, -8, 11, 12, i === 1 ? BLUE : CLAY);
  }
  if (covered) {
    for (const x of [-18, -6, 6, 18]) column(d, x, 6, .5, 17, 1);
    roof(d, -21, -17, 42, 26, 19.5, 7);
  }
  amphora(d, -15, 15); amphora(d, -9, 16, .5, .8);
  d.box(9, 13, 8, 7, .5, 4, GOLD); goods(d, 'grain', 9, 16, 4.6);
  return d.asset(id, `Merchant · ${name}`);
}

function temple(id: string, name: string, cols: number, ionic: boolean, long: boolean, gold = false) {
  const d = new Tile(); base(d, 50);
  const w = cols * 6, dep = long ? 32 : 23, u = -w / 2;
  for (let i = 0; i < 3; i++) d.box(u - 4 + i, -dep / 2 - 3 + i, w + 8 - 2 * i, dep + 6 - 2 * i, .5 + i * 1.3, 1.3);
  d.box(u + 4, -dep / 2 + 3, w - 8, dep - 9, 4.4, 18);
  arch(d, -3, dep / 2 - 6, 4.4, 6, 12, false, GOLD);
  for (let y = -dep / 2; y < dep / 2; y += 6) column(d, w / 2, y, 4.4, 19, 1, ionic);
  for (let i = 0; i < cols; i++) column(d, u + 1 + i * (w - 2) / (cols - 1), dep / 2, 4.4, 19, 1, ionic);
  d.box(u - 2, -dep / 2 - 2, w + 4, dep + 4, 23.4, 2.5);
  for (let x = u; x < w / 2; x += 3) d.line([[x, dep / 2 + 2, 23.8], [x, dep / 2 + 2, 25.5]], GOLD);
  roof(d, u - 2, -dep / 2 - 2, w + 4, dep + 4, 26, 8, gold ? GOLD : CLAY);
  d.face([[u + 1, dep / 2 + 3, 27], [w / 2 - 1, dep / 2 + 3, 27], [0, dep / 2 + 3, 32]], PAPER);
  d.line([[-3, dep / 2 + 3, 28], [0, dep / 2 + 3, 30], [3, dep / 2 + 3, 28]], GOLD);
  steps(d, -7, dep / 2 + 6, 14, 3);
  return d.asset(id, `Monument · ${name}`);
}

function civic(id: string, name: string, kind: 'stoa' | 'basilica' | 'library' | 'granary') {
  const d = new Tile(); base(d, 50);
  const h = kind === 'basilica' ? 25 : 18;
  houseBody(d, -21, -17, 42, 25, kind === 'basilica' ? 2 : 1);
  for (const x of [-18, -9, 0, 9, 18]) {
    arch(d, x - 2, 8, 2, 4, 9);
    column(d, x, 16, .5, h - 5, 1, kind === 'library');
  }
  d.box(-22, 9, 44, 9, h - 4.5, 2, PAPER, SHADE, GOLD);
  roof(d, -22, 8, 44, 11, h - 2.5, 4);
  if (kind === 'granary') for (const x of [-17, -6, 5, 16]) amphora(d, x, 21, .5, .7);
  else { steps(d, -10, 23, 20, 3); for (const x of [-19, 19]) tree(d, x, 21, .4, true); }
  return d.asset(id, `Civic · ${name}`);
}

function archway(id: string, name: string, triple: boolean) {
  const d = new Tile(); base(d, 46);
  const w = triple ? 40 : 26, u = -w / 2, openings = triple ? [-13, 0, 13] : [0];
  // Separate piers leave genuine gaps in the silhouette.
  for (const x of triple ? [-20, -7, 6, 19] : [-13, 8]) d.box(x, -5, triple ? 3 : 5, 10, .5, 19);
  d.box(u, -5, w + (triple ? 2 : 0), 10, 19.5, 9);
  for (const x of openings) {
    const r = triple ? 4.8 : 8;
    const arc: XYZ[] = Array.from({ length: 13 }, (_, i) => [x + Math.cos(Math.PI - i * Math.PI / 12) * r, 5, 14 + Math.sin(i * Math.PI / 12) * r]);
    d.face([[x - r, 5, 22.5], ...arc, [x + r, 5, 22.5]], PAPER);
    for (const dx of [-r - 1, r + 1]) column(d, x + dx, 6, .5, 22, .65);
  }
  d.box(u - 1, -6, w + (triple ? 4 : 2), 12, 28.5, 2);
  d.face([[-6, 6, 24], [6, 6, 24], [6, 6, 27], [-6, 6, 27]], GOLD);
  for (const x of [-8, 8]) d.box(x - 2, -2, 4, 4, 30.5, 3);
  return d.asset(id, `Monument · ${name}`);
}

function theatre() {
  const d = new Tile(); base(d, 50);
  // Back-to-front tiers, open toward the viewer, with radial stair aisles.
  for (let ring = 0; ring < 5; ring++) {
    const r = 22 - ring * 3, inner = r - 2.7, z = 13 - ring * 2.4;
    for (let i = 0; i < 18; i++) {
      const a = Math.PI * .85 + i * Math.PI * 1.3 / 18, b = a + Math.PI * 1.3 / 18;
      d.face([[r * Math.cos(a), r * Math.sin(a), z - 2.4], [r * Math.cos(b), r * Math.sin(b), z - 2.4], [r * Math.cos(b), r * Math.sin(b), z], [r * Math.cos(a), r * Math.sin(a), z]], SHADE);
      d.face([[r * Math.cos(a), r * Math.sin(a), z], [r * Math.cos(b), r * Math.sin(b), z], [inner * Math.cos(b), inner * Math.sin(b), z], [inner * Math.cos(a), inner * Math.sin(a), z]], PAPER);
    }
  }
  d.disc(0, 0, 7, .6, GOLD);
  d.box(-14, 12, 28, 7, .5, 3);
  for (const x of [-11, 0, 11]) column(d, x, 17, 3.5, 9, .7);
  d.box(-14, 15, 28, 4, 12.5, 2);
  return d.asset('theatre', 'Monument · open-air Greek theatre');
}

function rotunda(id: string, name: string, ruin = false) {
  const d = new Tile(); base(d, 44);
  d.cylinder(0, 0, 17, .5, 2); d.cylinder(0, 0, 15, 2.5, 1.5);
  const columns = Array.from({ length: 10 }, (_, i) => ({ u: 12 * Math.cos(i * Math.PI / 5), v: 12 * Math.sin(i * Math.PI / 5), i })).sort((a, b) => a.u + a.v - b.u - b.v);
  for (const c of columns) column(d, c.u, c.v, 4, ruin && c.i % 3 === 0 ? 7 : 18, 1, true);
  if (!ruin) {
    d.cylinder(0, 0, 15, 22, 2);
    for (let i = 0; i < 20; i++) {
      const a = i * Math.PI / 10, b = (i + 1) * Math.PI / 10;
      d.face([[15 * Math.cos(a), 15 * Math.sin(a), 24], [15 * Math.cos(b), 15 * Math.sin(b), 24], [0, 0, 34]], CLAY);
    }
    d.cylinder(0, 0, 1, 34, 2, GOLD);
  } else { d.box(8, 15, 7, 3, .5, 2); tree(d, -17, 14, .6); }
  return d.asset(id, `Monument · ${name}`);
}

function bath(id: string, name: string, grand: boolean) {
  const d = new Tile(); base(d, 50);
  houseBody(d, -19, -20, 38, 15, 1);
  houseBody(d, -21, -3, 10, 23, grand ? 2 : 1);
  houseBody(d, 12, -3, 9, 23, 1);
  pool(d, -8, 1, 17, 18);
  for (const x of [-8, 8]) column(d, x, -4, .5, 12, .8);
  if (grand) {
    d.cylinder(0, -12, 10, 15, 3);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, b = (i + 1) * Math.PI / 6;
      d.face([[10 * Math.cos(a), -12 + 10 * Math.sin(a), 18], [10 * Math.cos(b), -12 + 10 * Math.sin(b), 18], [0, -12, 26]], GOLD);
    }
  }
  amphora(d, -7, 22, .5, .6); amphora(d, 8, 22, .5, .6);
  return d.asset(id, `Civic · ${name}`);
}

function aqueduct() {
  const d = new Tile(); base(d, 50);
  for (const x of [-22, -8, 6, 20]) d.box(x, -3, 3, 7, .5, 24);
  for (const x of [-19, -5, 9]) {
    const arc: XYZ[] = Array.from({ length: 9 }, (_, i) => [x + 5.5 - Math.cos(i * Math.PI / 8) * 5.5, 4, 17 + Math.sin(i * Math.PI / 8) * 5.5]);
    d.face([[x, 4, 25], ...arc, [x + 11, 4, 25]], PAPER);
  }
  d.box(-23, -4, 47, 9, 24, 3);
  d.face([[-22, -2, 27.1], [23, -2, 27.1], [23, 3, 27.1], [-22, 3, 27.1]], BLUE);
  d.box(-23, 4, 47, 1, 27, 2);
  tree(d, -18, 15, .6, true); tree(d, 17, 17, .5);
  return d.asset('aqueduct', 'Monument · arched aqueduct');
}

function tower(id: string, name: string, lighthouse: boolean) {
  const d = new Tile(); base(d, 42);
  d.box(-13, -13, 26, 26, .5, 4);
  for (let level = 0; level < 3; level++) {
    const w = 22 - level * 5, z = 4.5 + level * 12;
    d.box(-w / 2, -w / 2, w, w, z, 12);
    arch(d, -2, w / 2, z + 3, 4, 6);
    arch(d, w / 2, 2, z + 3, 4, 6, true);
    d.box(-w / 2 - 1, -w / 2 - 1, w + 2, w + 2, z + 11, 1.5);
  }
  for (const x of [-4, 4]) for (const y of [-4, 4]) column(d, x, y, 41, 8, .7);
  roof(d, -6, -6, 12, 12, 49, 4, lighthouse ? GOLD : CLAY);
  if (lighthouse) d.face([[-2, 0, 42], [-3, 0, 46], [0, 0, 49], [1, 0, 46], [3, 0, 45], [2, 0, 42]], CLAY);
  steps(d, -5, 20, 10, 5);
  return d.asset(id, `Civic · ${name}`);
}

const PARK_NAMES = ['olive grove', 'cypress walk', 'peristyle fountain garden', 'sacred spring', 'vineyard pergola', 'herb garden', 'statue courtyard', 'mosaic plaza', 'ruined sanctuary', 'reflecting garden'] as const;
function park(i: number) {
  const d = new Tile();
  d.face([[-25, -25, 0], [25, -25, 0], [25, 25, 0], [-25, 25, 0]], PAPER, 'none');
  for (const x of [-21, 7]) for (const y of [-21, 7]) d.box(x, y, 14, 14, 0, .6, PAPER, SHADE, i === 7 ? GOLD : GREEN);
  if (i === 0 || i === 1) {
    for (const [u, v] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) tree(d, u!, v!, i === 0 ? .9 : .75, i === 1);
    if (i === 1) fountain(d, 0, 0, 4);
  } else if (i === 2) {
    for (const x of [-19, 0, 19]) column(d, x, -20, 0, 12, .8);
    d.box(-21, -22, 42, 4, 12, 2);
    fountain(d); tree(d, -17, 16, .65, true); tree(d, 17, 16, .65, true);
  } else if (i === 3) {
    d.box(-14, -17, 28, 5, 0, 17);
    for (const x of [-10, 0, 10]) arch(d, x - 3, -12, 3, 6, 10);
    pool(d, -15, -11, 30, 14); d.line([[0, -12, 8], [0, -5, 2]], BLUE);
    tree(d, -19, 17, .65); tree(d, 18, 16, .65);
  } else if (i === 4) {
    for (const x of [-15, 15]) for (const y of [-17, 0, 17]) column(d, x, y, 0, 12, .7);
    for (const x of [-16, 14]) d.box(x, -20, 2, 40, 12, 1, GOLD, SHADE, GREEN);
    for (let y = -18; y <= 18; y += 6) d.box(-17, y, 34, 1.5, 13, 1, GOLD, SHADE, GREEN);
    for (const y of [-10, 7]) amphora(d, 0, y, 0, .8);
  } else if (i === 5) {
    for (const x of [-19, 6]) for (const y of [-18, -4, 10]) {
      d.box(x, y, 13, 8, .5, 1.5, GOLD, SHADE, GREEN);
      for (let k = 2; k < 13; k += 4) d.line([[x + k, y + 4, 2], [x + k, y + 4, 5], [x + k + 1, y + 4, 4]], GREEN);
    }
    amphora(d, 0, 17);
  } else if (i === 6) {
    d.box(-5, -5, 10, 10, 0, 3); column(d, 0, 0, 3, 6, 2);
    d.face([[-2, 0, 9], [-1.5, 0, 17], [-3, 0, 19], [2, 0, 19], [1.5, 0, 9]], PAPER);
    d.cylinder(0, 0, 1.5, 19, 2); d.line([[2, 0, 17], [5, 0, 20], [5, 0, 9]], GOLD);
    tree(d, -17, 15, .65, true); tree(d, 17, 15, .65, true);
  } else if (i === 7) {
    for (let r = 19; r > 1; r -= 3) d.face([[-r, 0, .7], [0, -r, .7], [r, 0, .7], [0, r, .7]], Math.round(r / 3) % 2 ? BLUE : PAPER);
    for (const x of [-19, 19]) for (const y of [-19, 19]) amphora(d, x, y, .7, .7);
  } else if (i === 8) {
    for (const x of [-15, -4, 7, 18]) column(d, x, -12, .6, x === -4 ? 8 : 17, 1.2);
    d.box(5, -15, 16, 5, 17.6, 2); d.box(-9, 8, 15, 4, .6, 3);
    tree(d, -17, 15, .7); tree(d, 16, 17, .5);
  } else {
    pool(d, -6, -19, 12, 38);
    for (const x of [-17, 17]) for (const y of [-15, 0, 15]) tree(d, x, y, .55, true);
  }
  return d.asset(`park-${i + 1}`, `Garden · ${PARK_NAMES[i]}`, 'terrain', 'park');
}

const ROAD_SHAPES: { role: IsometricRole; name: string; mask: number }[] = [
  { role: 'road-straight', name: 'straight', mask: 5 }, { role: 'road-corner', name: 'corner', mask: 3 },
  { role: 'road-tee', name: 'T junction', mask: 7 }, { role: 'road-cross', name: 'crossroads', mask: 15 }, { role: 'road-end', name: 'end', mask: 1 },
];
function road(shape: typeof ROAD_SHAPES[number], style: 'pavers' | 'processional' | 'cypress' | 'olive') {
  const d = new Tile();
  d.face([[-25, -25, 0], [25, -25, 0], [25, 25, 0], [-25, 25, 0]], PAPER, 'none');
  const rotate = (x: number, y: number, side: number): XYZ => { for (let i = 0; i < side; i++) [x, y] = [-y, x]; return [x, y, 0]; };
  const surface: XYZ[] = [];
  for (let side = 0; side < 4; side++) for (const [x, y] of shape.mask & (1 << side) ? [[12, -12], [25, -12], [25, 12], [12, 12]] : [[12, -12], [12, 12]]) surface.push(rotate(x!, y!, side));
  d.face(surface, style === 'processional' ? GOLD : SHADE, 'none');
  for (let row = -12; row < 12; row += 6) {
    d.line([[-12, row, .05], [12, row, .05]], INK);
    for (let x = -12 + (row % 12 === 0 ? 4 : 0); x < 12; x += 8) d.line([[x, row, .05], [x, row + 6, .05]], INK);
  }
  for (let side = 0; side < 4; side++) {
    const p = (x: number, y: number) => rotate(x, y, side);
    if (shape.mask & (1 << side)) {
      for (const y of [-13, 13]) d.line([p(12, y), p(25, y)]);
      for (let x = 12; x < 25; x += 6.5) {
        d.line([p(x, -12), p(x, 12)]);
        for (const y of [-6, 3]) d.line([p(x, y), p(Math.min(x + 6.5, 25), y)]);
      }
    } else d.line([p(13, -13), p(13, 13)]);
  }
  if (style === 'cypress' || style === 'olive') {
    for (const [u, v] of [[-19, -19], [19, -19], [-19, 19], [19, 19]]) {
      d.box(u! - 3, v! - 3, 6, 6, 0, .6, PAPER, SHADE, GREEN);
      tree(d, u!, v!, style === 'cypress' ? .45 : .5, style === 'cypress');
    }
  } else if (style === 'processional') {
    for (const [u, v] of [[-19, -19], [19, 19]]) {
      column(d, u!, v!, 0, 9, .9); d.disc(u!, v!, 2, 9.3, GOLD);
    }
  } else { d.box(-21, -21, 3, 3, 0, 4); d.line([[-20, -18, 1], [-20, -18, 3]], GOLD); }
  return d.asset(`road-${style}-${shape.role.slice(5)}`, `Road · ${style === 'pavers' ? 'Roman paving' : style === 'processional' ? 'processional way' : `${style} avenue`} · ${shape.name}`, shape.role, undefined, { treeLined: style === 'cypress' || style === 'olive' });
}

function sea(d: Tile, calm = false) {
  d.face([[-25, -25, 0], [25, -25, 0], [25, 25, 0], [-25, 25, 0]], BLUE, 'none');
  for (const [u, v] of [[-19, -18], [3, -15], [-8, -3], [12, 8], [-18, 15], [-1, 21]]) d.line([[u!, v!, .05], [u! + 3, v! - (calm ? 0 : 1), .05], [u! + 7, v!, .05]], SHADE);
}

function shore(d: Tile, mask: number, stone = true) {
  sea(d);
  // Each shore mask uses precisely the same orientation as the city planner.
  for (let side = 0; side < 4; side++) if (mask & (1 << side)) {
    const p = (x: number, y: number, z: number): XYZ => { for (let i = 0; i < side; i++) [x, y] = [-y, x]; return [x, y, z]; };
    d.face([p(8, -25, .6), p(25, -25, .6), p(25, 25, .6), p(8, 25, .6)], stone ? PAPER : GOLD);
    d.face([p(8, -25, .6), p(8, 25, .6), p(8, 25, -1.3), p(8, -25, -1.3)], SHADE);
    if (stone) for (let y = -25; y <= 25; y += 6.25) d.line([p(8, y, .6), p(25, y, .6)], SHADE);
  }
}

function harbour(id: string, name: string, kind: 'pier' | 'cargo' | 'crane' | 'boathouse' | 'beacon') {
  const d = new Tile(); shore(d, 4);
  if (kind === 'beacon') {
    d.box(-23, -9, 12, 18, .6, 7); d.box(-21, -7, 8, 14, 7.6, 12);
    arch(d, -19, 7, 9, 4, 6); d.box(-22, -8, 10, 16, 19.6, 1);
    for (const x of [-20, -14]) column(d, x, 4, 20.6, 6, .7);
    roof(d, -22, -8, 10, 16, 26.6, 4, GOLD);
  } else {
    d.box(-10, -6, 32, 12, -.5, 2, GOLD, SHADE, GOLD);
    for (let x = -9; x <= 21; x += 3) d.line([[x, -6, 1.5], [x, 6, 1.5]], INK);
    for (const x of [-6, 19]) for (const y of [-5, 5]) d.box(x, y, 1.5, 1.5, -1, 5, GOLD);
    if (kind === 'cargo') {
      for (const x of [-3, 3, 9]) amphora(d, x, 1, 1.5, .7);
      d.box(-22, -16, 8, 8, .6, 5, GOLD); d.box(-20, -15, 6, 6, 5.6, 3, GOLD);
    } else if (kind === 'crane') {
      d.line([[-16, 4, .6], [-16, -1, 22], [-13, -6, .6]], GOLD);
      d.line([[-16, -1, 22], [11, -1, 17], [11, -1, 6]], INK);
      d.line([[-16, -1, 15], [11, -1, 17]], GOLD);
      d.box(8, -3, 6, 5, 3, 3, GOLD);
      d.cylinder(-15, 3, 3, 3, 2, GOLD);
    } else if (kind === 'boathouse') {
      for (const x of [-6, 16]) for (const y of [-5, 5]) column(d, x, y, 1.5, 11, .7);
      roof(d, -9, -7, 29, 15, 12.5, 5);
    } else { amphora(d, -18, -13, .6); amphora(d, -18, -7, .6, .8); }
  }
  return d.asset(id, `Harbour · ${name}`, 'terrain', 'shore', { shoreMask: 4 });
}

const SHIP_NAMES = ['merchant roundship', 'Roman grain ship', 'Greek trading galley', 'trireme with oars', 'coastal fishing skiff', 'river cargo barge', 'ceremonial galley', 'furled-sail coaster'] as const;
function ship(i: number) {
  const d = new Tile(); sea(d);
  const galley = i === 2 || i === 3 || i === 6, small = i === 4, barge = i === 5;
  const length = small ? 15 : 22, beam = galley ? 5 : small ? 4 : 8;
  d.face([[-length, 0, 3], [-length + 5, -beam, 2], [length - 6, -beam, 2], [length, 0, 4], [length - 6, beam, 2], [-length + 5, beam, 2]], GOLD);
  d.face([[-length, 0, 3], [-length + 5, beam, 2], [length - 6, beam, 2], [length, 0, 4], [length - 6, beam - 1, -1], [-length + 6, beam - 1, -1]], CLAY);
  d.line([[-length + 3, 1, 3], [-length + 5, beam - 1, 3], [length - 6, beam - 1, 3], [length - 1, 0, 4]], INK);
  for (let x = -length + 6; x < length - 5; x += 4) d.line([[x, -beam + 1, 2.2], [x, beam - 1, 2.2]], INK);
  d.line([[-length + 2, 1, 3], [-length - 1, 1, 7], [-length, 1, 9], [-length + 3, 1, 9]], GOLD);
  if (galley) {
    for (let x = -14; x < 15; x += 4) for (const sign of [-1, 1]) d.line([[x, sign * 3, 2.3], [x - 3, sign * 12, .4]], GOLD);
    d.face([[length - 2, 0, 1], [25, 0, 0], [length - 2, 2, -.5]], GOLD);
    for (let x = -12; x <= 12; x += 6) d.face([[x - 1.5, beam, 3], [x - 1.5, beam, 6], [x + 1.5, beam, 6], [x + 1.5, beam, 3]], i === 6 ? BLUE : PAPER);
  }
  if (small || barge) {
    for (const x of [-7, 0, 7]) {
      if (barge) amphora(d, x, 0, 2.5, .7);
      else d.line([[x, -3, 3], [x, 3, 3]], GOLD);
    }
    d.line([[-8, 2, 3], [-15, 12, .2]], GOLD);
    if (small) { d.line([[4, -2, 3], [9, -3, 12], [16, -3, 2]], INK); }
  } else {
    d.line([[0, 0, 2], [0, 0, 32]], INK);
    d.line([[-15, 0, 28], [15, 0, 28]], GOLD);
    if (i === 7) {
      d.face([[-14, 0, 28], [14, 0, 28], [12, 0, 25], [-12, 0, 25]], PAPER);
      for (let x = -10; x <= 10; x += 5) d.line([[x, 0, 25], [x, 0, 28]], GOLD);
    } else {
      d.face([[-13, 0, 27], [13, 0, 27], [15, 1.5, 18], [11, 2, 10], [-10, 2, 10], [-15, 1.5, 18]], i === 6 ? CLAY : PAPER);
      for (const x of [-7, 0, 7]) d.line([[x, 0, 27], [x + 1, 1.5, 18], [x * .8, 2, 10]], i === 6 ? GOLD : SHADE);
      d.line([[-14, 1, 20], [14, 1, 20]], GOLD);
      if (i === 1 || i === 6) d.face([[-3, 1.6, 20], [0, 1.6, 24], [3, 1.6, 20], [0, 1.6, 15]], i === 6 ? GOLD : CLAY);
    }
    d.line([[0, 0, 32], [-length + 3, 0, 3]], INK);
    d.line([[0, 0, 32], [length - 2, 0, 4]], INK);
    if (i === 0 || i === 1 || i === 7) for (const x of [-12, -7, 8]) amphora(d, x, 5, 2.5, .55);
  }
  d.line([[-22, 13, .1], [-13, 15, .1], [7, 15, .1]], SHADE);
  return d.asset(`ship-${i + 1}`, `Vessel · ${SHIP_NAMES[i]}`, 'terrain', 'feature');
}

export const ANTIQUITY_CATEGORIES: GlyphCategory[] = [{ id: ANTIQUITY_CATEGORY, name: 'Antiquity · Rome & Greece', kind: 'isometric' }];
export const ANTIQUITY_ASSETS: GlyphAsset[] = [
  ...([
    { id: 'farmhouse', name: 'rural tiled farmhouse', floors: 1, w: 25, depth: 24 },
    { id: 'cottage', name: 'ochre artisan cottage', floors: 1, w: 29, depth: 20, tint: GOLD },
    { id: 'porch-house', name: 'Greek portico house', floors: 1, w: 28, depth: 22, porch: true },
    { id: 'wing-house', name: 'Roman stepped-roof house', floors: 2, w: 26, depth: 22, wing: true },
    { id: 'townhouse', name: 'balcony townhouse', floors: 2, w: 24, depth: 25, balcony: true },
    { id: 'painted-house', name: 'ochre merchant residence', floors: 2, w: 31, depth: 23, tint: GOLD, porch: true },
    { id: 'insula', name: 'three-storey insula', floors: 3, w: 31, depth: 28, balcony: true },
    { id: 'tall-insula', name: 'four-storey corner insula', floors: 4, w: 26, depth: 24, balcony: true },
  ] satisfies Home[]).map(home),
  courtyard('atrium-domus', 'atrium domus', 'atrium'),
  courtyard('courtyard-villa', 'courtyard villa', 'villa'),
  courtyard('peristyle-house', 'peristyle residence', 'peristyle'),
  courtyard('garden-house', 'walled garden house', 'garden'),
  courtyard('patrician-estate', 'patrician estate', 'estate'),
  ...TRADES.map(merchant),
  market('agora-stalls', 'open agora stalls', false),
  market('covered-market', 'roofed market hall', true),
  temple('doric-temple', 'Doric temple', 4, false, true),
  temple('ionic-temple', 'Ionic sanctuary', 4, true, false),
  temple('grand-temple', 'six-column great temple', 6, false, true),
  temple('treasury', 'small golden-roof treasury', 3, true, false, true),
  civic('stoa', 'agora stoa', 'stoa'), civic('basilica', 'forum basilica', 'basilica'),
  civic('library', 'colonnaded library', 'library'), civic('granary', 'harbour granary', 'granary'),
  archway('triumphal-arch', 'triumphal arch', false), archway('triple-gateway', 'triple city gateway', true),
  theatre(), rotunda('tholos', 'round tholos sanctuary'), rotunda('ruined-tholos', 'ruined circular temple', true),
  bath('public-baths', 'courtyard public baths', false), bath('grand-thermae', 'domed imperial thermae', true),
  aqueduct(), tower('pharos', 'tiered Pharos lighthouse', true), tower('watchtower', 'tiled harbour watchtower', false),
  ...PARK_NAMES.map((_, i) => park(i)),
  ...(['pavers', 'processional', 'cypress', 'olive'] as const).flatMap(style => ROAD_SHAPES.map(shape => road(shape, style))),
  ...[false, true].map(calm => { const d = new Tile(); sea(d, calm); return d.asset(calm ? 'water-calm' : 'water-aegean', calm ? 'Water · sheltered harbour' : 'Water · Aegean sea', 'terrain', 'water'); }),
  ...[
    { id: 'quay', name: 'limestone quay', mask: 4, stone: true },
    { id: 'quay-corner', name: 'inner harbour corner', mask: 12, stone: true },
    { id: 'canal', name: 'stone canal', mask: 5, stone: true },
    { id: 'harbour-basin', name: 'enclosed harbour basin', mask: 13, stone: true },
    { id: 'sand', name: 'Mediterranean beach', mask: 4, stone: false },
    { id: 'sand-cove', name: 'sheltered sandy cove', mask: 12, stone: false },
  ].map(s => { const d = new Tile(); shore(d, s.mask, s.stone); return d.asset(`shore-${s.id}`, `Coast · ${s.name}`, 'terrain', 'shore', { shoreMask: s.mask }); }),
  harbour('timber-pier', 'timber landing pier', 'pier'), harbour('amphora-dock', 'amphora loading dock', 'cargo'),
  harbour('cargo-crane', 'timber cargo crane', 'crane'), harbour('boat-shed', 'roofed boat shed', 'boathouse'),
  harbour('quay-beacon', 'quayside beacon', 'beacon'),
  ...SHIP_NAMES.map((_, i) => ship(i)),
];
