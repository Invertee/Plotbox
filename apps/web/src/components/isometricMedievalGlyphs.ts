import type { IsometricRole, Point, SourcePath } from '@plotter/core';
import type { GlyphAsset, GlyphCategory } from './Glyphbox';

export const MEDIEVAL_CATEGORY = 'iso-medieval';
// The Antiquity inks keep both historical packs compatible with the same pens.
const INK = '#493c32', RED = '#b8583c', GOLD = '#bc9356', GREEN = '#758464', BLUE = '#5a9296', SHADE = '#b6a58d', PAPER = '#fff5df';
type V = [number, number, number];
type Mark = { vertices: V[]; fill: string; stroke: string; closed: boolean };
type Surface = { marks: Mark[]; normal?: V; layer: number };
const project = ([u, v, z]: V): Point => ({ x: (u - v) * Math.sqrt(3) / 2, y: (u + v) / 2 - z, elevation: z });
const turn = ([u, v, z]: V, rotation: number): V => {
  for (let i = 0; i < rotation; i++) [u, v] = [-v, u];
  return [u, v, z];
};
const rounded = (n: number) => Number(n.toFixed(5));

/** Keep wall details attached to their face, cull hidden walls, then project
 * the complete model anew for each view. These are not rotated SVG bitmaps. */
class Model {
  surfaces: Surface[] = [];
  face(vertices: V[], fill = PAPER, normal?: V, layer = 0): Surface {
    const surface: Surface = { marks: [{ vertices, fill, stroke: INK, closed: true }], normal, layer };
    this.surfaces.push(surface); return surface;
  }
  detail(surface: Surface, vertices: V[], fill = 'none', stroke = INK, closed = false) {
    surface.marks.push({ vertices, fill, stroke, closed });
  }
  line(vertices: V[], colour = INK, layer = 0) {
    this.surfaces.push({ marks: [{ vertices, fill: 'none', stroke: colour, closed: false }], layer });
  }
  box(u: number, v: number, w: number, d: number, z: number, h: number, fill = PAPER, top = fill, layer = 0) {
    const walls = [
      this.face([[u, v, z], [u + w, v, z], [u + w, v, z + h], [u, v, z + h]], fill, [0, -1, 0], layer),
      this.face([[u + w, v, z], [u + w, v + d, z], [u + w, v + d, z + h], [u + w, v, z + h]], fill, [1, 0, 0], layer),
      this.face([[u + w, v + d, z], [u, v + d, z], [u, v + d, z + h], [u + w, v + d, z + h]], fill, [0, 1, 0], layer),
      this.face([[u, v + d, z], [u, v, z], [u, v, z + h], [u, v + d, z + h]], fill, [-1, 0, 0], layer),
    ];
    this.face([[u, v, z + h], [u + w, v, z + h], [u + w, v + d, z + h], [u, v + d, z + h]], top, [0, 0, 1], layer);
    return walls;
  }
  asset(id: string, name: string, rotation = 0, role: IsometricRole = 'building', terrain?: GlyphAsset['terrain'], extra: Partial<GlyphAsset> = {}): GlyphAsset {
    const depth = (s: Surface) => {
      const points = s.marks[0]!.vertices.map(p => turn(p, rotation));
      return points.reduce((n, p) => n + p[0] + p[1] + p[2], 0) / points.length;
    };
    const paths: SourcePath[] = this.surfaces.filter(s => {
      if (!s.normal) return true;
      const n = turn(s.normal, rotation); return n[0] + n[1] + n[2] > .001;
    }).sort((a, b) => a.layer - b.layer || depth(a) - depth(b)).flatMap(s => s.marks.map(mark => {
      const normal = s.normal ? turn(s.normal, rotation) : undefined;
      const fill = mark.fill === PAPER && normal && normal[0] > .5 && normal[2] === 0 ? SHADE : mark.fill;
      return { id: '', points: mark.vertices.map(p => project(turn(p, rotation))), closed: mark.closed, stroke: mark.stroke, fill, ...(fill === PAPER ? { paper: true } : {}) };
    }));
    paths.forEach((p, i) => { p.id = `medieval-${i}`; });
    const points = paths.flatMap(p => p.points), ground = role !== 'building';
    const left = ground ? -25 * Math.sqrt(3) : Math.min(...points.map(p => p.x)) - 2;
    const width = ground ? 50 * Math.sqrt(3) : Math.max(...points.map(p => p.x)) - left + 2;
    const top = Math.min(-25, ...points.map(p => p.y)) - 2, bottom = Math.max(25, ...points.map(p => p.y)) + 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${bottom - top}"><g stroke-width="0.65" stroke-linejoin="round" stroke-linecap="round">${paths.map(p => `<${p.closed ? 'polygon' : 'polyline'} points="${p.points.map(q => `${rounded(q.x)},${rounded(q.y)}`).join(' ')}" fill="${p.fill}" stroke="${p.stroke}"/>`).join('')}</g></svg>`;
    return { id: `medieval-${id}`, name, kind: 'isometric', categoryId: MEDIEVAL_CATEGORY, collectionId: MEDIEVAL_CATEGORY, createdAt: new Date(0).toISOString(), isometricRole: role, terrain, svg,
      plotPaths: paths.map(p => ({ ...p, points: p.points.map(q => ({ x: rounded((q.x - left) / width), y: rounded(ground ? (q.y + 25) / 50 : (q.y - top) / width), ...(q.elevation ? { elevation: rounded(q.elevation / (ground ? 50 : width)) } : {}) })) })), ...extra };
  }
}

function base(m: Model, full = false, fill = PAPER) {
  const r = full ? 25 : 23;
  const s = m.face([[-r, -r, 0], [r, -r, 0], [r, r, 0], [-r, r, 0]], fill, [0, 0, 1], -100);
  for (let x = -r + 6; x < r; x += 7) {
    m.detail(s, [[x, r - 3, .02], [x, r, .02]], 'none', SHADE);
    m.detail(s, [[r - 3, x, .02], [r, x, .02]], 'none', SHADE);
  }
}

function roof(m: Model, u: number, v: number, w: number, d: number, z: number, rise = 11, colour = RED) {
  for (const [y, normal] of [[v, [0, -1, 0]], [v + d, [0, 1, 0]]] as [number, V][]) {
    const s = m.face([[u, y, z], [u + w, y, z], [u + w / 2, y, z + rise]], PAPER, normal);
    m.detail(s, [[u + w / 2, y, z], [u + w / 2, y, z + rise]], 'none', GOLD);
    m.detail(s, [[u + 1, y, z + .5], [u + w / 2, y, z + rise - 1], [u + w - 1, y, z + .5]], 'none', GOLD);
  }
  for (const side of [-1, 1]) {
    const ridge = u + w / 2, edge = side < 0 ? u - 1 : u + w + 1;
    const s = m.face([[ridge, v - 1, z + rise], [edge, v - 1, z], [edge, v + d + 1, z], [ridge, v + d + 1, z + rise]], colour, [side * rise / (w / 2 + 1), 0, 1]);
    for (let t = .2; t < 1; t += .2) {
      const x = ridge + (edge - ridge) * t;
      m.detail(s, [[x, v - 1, z + rise * (1 - t)], [x, v + d + 1, z + rise * (1 - t)]], 'none', colour === GOLD ? INK : GOLD);
    }
    for (let y = v + 3; y < v + d; y += 5) m.detail(s, [[ridge, y, z + rise], [edge, y, z]], 'none', colour === BLUE ? SHADE : INK);
  }
}

function cone(m: Model, u: number, v: number, r: number, z: number, h: number, colour = BLUE) {
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, b = (i + 1) * Math.PI / 6, mid = (a + b) / 2;
    m.face([[u + r * Math.cos(a), v + r * Math.sin(a), z], [u + r * Math.cos(b), v + r * Math.sin(b), z], [u, v, z + h]], colour, [Math.cos(mid) * h / r, Math.sin(mid) * h / r, 1]);
  }
}

function barrel(m: Model, u: number, v: number, z = 0, r = 2, h = 5) {
  const sides = 10;
  for (let i = 0; i < sides; i++) {
    const a = i * 2 * Math.PI / sides, b = (i + 1) * 2 * Math.PI / sides;
    const p = (angle: number, zz: number): V => [u + r * Math.cos(angle), v + r * Math.sin(angle), z + zz];
    const s = m.face([p(a, 0), p(b, 0), p(b, h), p(a, h)], GOLD, [Math.cos((a + b) / 2), Math.sin((a + b) / 2), 0]);
    for (const level of [1, h - 1]) m.detail(s, [p(a, level), p(b, level)]);
  }
  m.face(Array.from({ length: sides }, (_, i): V => [u + r * Math.cos(i * 2 * Math.PI / sides), v + r * Math.sin(i * 2 * Math.PI / sides), z + h]), GOLD, [0, 0, 1]);
}

function tree(m: Model, u: number, v: number, scale = 1, pine = false) {
  m.box(u - .6, v - .6, 1.2, 1.2, 0, 9 * scale, GOLD);
  if (pine) for (let i = 0; i < 3; i++) cone(m, u, v, (5 - i) * scale, (4 + i * 4) * scale, 8 * scale, GREEN);
  else {
    const rings = [[6, 1.5], [8, 5.5], [12, 5], [15, .5]];
    for (let ring = 0; ring < rings.length - 1; ring++) {
      const [z1, r1] = rings[ring]!, [z2, r2] = rings[ring + 1]!;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, b = (i + 1) * Math.PI / 4;
        const p = (angle: number, r: number, z: number): V => [u + r * Math.cos(angle) * scale, v + r * Math.sin(angle) * scale, z * scale];
        const s = m.face([p(a,r1!,z1!),p(b,r1!,z1!),p(b,r2!,z2!),p(a,r2!,z2!)], GREEN, [Math.cos((a+b)/2),Math.sin((a+b)/2),(r1!-r2!)/(z2!-z1!)]);
        s.marks[0]!.stroke = GREEN;
      }
    }
  }
}

function opening(m: Model, wall: Surface, p: (x: number, z: number) => V, x: number, z: number, w: number, h: number, pointed = false, door = false) {
  const vertices = pointed ? [p(x, z), p(x, z + h * .65), p(x + w / 2, z + h), p(x + w, z + h * .65), p(x + w, z)] : [p(x, z), p(x, z + h), p(x + w, z + h), p(x + w, z)];
  m.detail(wall, vertices, door ? GOLD : BLUE, INK, true);
  m.detail(wall, [p(x + w / 2, z), p(x + w / 2, z + h * (pointed ? .85 : 1))], 'none', INK);
  if (!door) m.detail(wall, [p(x, z + h * .45), p(x + w, z + h * .45)], 'none', GOLD);
  else for (let t = 1; t < w; t += 1.4) m.detail(wall, [p(x + t, z), p(x + t, z + h * .6)], 'none', INK);
}

function house(m: Model, u: number, v: number, w: number, d: number, floors = 2, timber = true, colour = RED, entrance = 2, raised = 0, roofed = true) {
  const start = m.surfaces.length;
  const z = 1, h = floors * 10;
  m.box(u - .5, v - .5, w + 1, d + 1, 0, 1, SHADE);
  const walls = m.box(u, v, w, d, z, h);
  const maps: ((x: number, z: number) => V)[] = [
    (x, zz) => [u + x, v, zz], (x, zz) => [u + w, v + x, zz],
    (x, zz) => [u + w - x, v + d, zz], (x, zz) => [u, v + d - x, zz],
  ];
  walls.forEach((wall, side) => {
    const p = maps[side]!, span = side % 2 ? d : w;
    if (timber) {
      for (let x = 0; x <= span; x += span / 4) {
        m.detail(wall, [p(x, 1), p(Math.min(span, x + .8), 1), p(Math.min(span, x + .8), h + 1), p(x, h + 1)], GOLD, INK, true);
      }
      for (let f = 0; f <= floors; f++) m.detail(wall, [p(0, f * 10 + 1), p(span, f * 10 + 1)], 'none', GOLD);
      for (let f = 1; f < floors; f++) for (const x of [0, span * .75]) m.detail(wall, [p(x + 1, f * 10 + 2), p(x + span / 4 - 1, (f + 1) * 10)], 'none', GOLD);
    } else {
      for (let zz = 4; zz < h; zz += 4) {
        m.detail(wall, [p(0, zz), p(3, zz)], 'none', SHADE);
        m.detail(wall, [p(span - 3, zz), p(span, zz)], 'none', SHADE);
      }
    }
    for (let f = 0; f < floors; f++) for (let x = 3; x < span - 4; x += 8) {
      const door = f === 0 && side === entrance && x === 3;
      opening(m, wall, p, x, door ? 1 : f * 10 + 4, door ? 4.5 : 3.5, door ? 7 : 4.5, !timber, door);
    }
  });
  if (roofed) {
    roof(m, u, v, w, d, h + 1, colour === GOLD ? 9 : 13, colour);
    m.box(u + w - 6, v + 3, 3, 4, h + 6, 11, SHADE);
    m.box(u + w - 6.5, v + 2.5, 4, 5, h + 17, 1, PAPER, INK);
  }
  if (raised) for (const s of m.surfaces.slice(start)) for (const mark of s.marks) mark.vertices = mark.vertices.map(([x,y,z]) => [x,y,z+raised]);
}

function awning(m: Model, u: number, v: number, w: number, z: number, colour = RED) {
  for (let x = 0; x < w; x += 3) m.face([[u + x, v, z], [u + Math.min(w, x + 3), v, z], [u + Math.min(w, x + 3), v + 7, z - 3], [u + x, v + 7, z - 3]], Math.round(x / 3) % 2 ? PAPER : colour, [0, 3 / 7, 1]);
  for (const x of [u, u + w]) m.box(x, v + 6, .7, .7, 0, z - 3, GOLD);
}

function sign(m: Model, u: number, v: number, kind = 'inn') {
  m.box(u, v, .7, .7, 0, 15, GOLD);
  m.box(u, v, 6, .7, 14, .7, GOLD);
  const s = m.face([[u + 2, v, 9], [u + 6, v, 9], [u + 6, v, 13], [u + 2, v, 13]], kind === 'inn' ? BLUE : GOLD);
  m.detail(s, [[u + 3, v, 10], [u + 5, v, 10], [u + 5, v, 12], [u + 3, v, 12], [u + 3, v, 10]], 'none', INK);
}

type Design = { id: string; name: string; draw: (m: Model) => void };
const buildings: Design[] = [];
const add = (id: string, name: string, draw: Design['draw']) => buildings.push({ id, name, draw });

const HOMES = [
  ['croft', 'thatched crofter’s cottage', 1, 24, 20, true, GOLD],
  ['stone-cottage', 'stone cottage', 1, 27, 22, false, RED],
  ['timber-house', 'half-timbered house', 2, 24, 24, true, RED],
  ['blue-house', 'blue-roofed townhouse', 2, 22, 27, true, BLUE],
  ['weaver-house', 'weaver’s tall house', 3, 21, 24, true, RED],
  ['merchant-home', 'stone merchant residence', 3, 29, 26, false, BLUE],
  ['longhouse', 'rural longhouse', 1, 20, 36, true, GOLD],
  ['gable-house', 'narrow gabled house', 3, 17, 28, true, BLUE],
] as const;
for (const [id, name, floors, w, d, timber, colour] of HOMES) add(id, `Home · ${name}`, m => {
  base(m); house(m, -w / 2, -d / 2 - 2, w, d, floors, timber, colour);
  barrel(m, 17, 17); tree(m, -18, 15, .55);
});
add('crosswing-house', 'Home · crosswing manor', m => { base(m); house(m, -18, -17, 22, 31, 2); house(m, 4, -8, 14, 23, 2, true, BLUE); barrel(m, 13, 19); });
add('farmstead', 'Home · cottage and barn farmstead', m => { base(m); house(m, -19, -18, 20, 24, 1, true, GOLD); house(m, 4, -13, 15, 21, 1, true, RED); m.box(-16, 13, 28, 6, 0, 1, GOLD, GREEN); tree(m, 17, 17, .7); });
add('courtyard-manor', 'Home · walled courtyard manor', m => { base(m); house(m, -20, -19, 38, 14, 2, false, BLUE); house(m, -20, -3, 11, 22, 1); m.box(12, -3, 6, 22, 0, 4); barrel(m, 5, 12); tree(m, -1, 3, .6); });
add('jettied-house', 'Home · jettied merchant house', m => { base(m); house(m, -11, -13, 22, 26, 1, false, RED, 2, 0, false); house(m, -14, -16, 28, 32, 1, true, BLUE, -1, 11); awning(m, -9, 13, 17, 10); barrel(m, 18, 17); });

const TRADES = ['bakery', 'blacksmith', 'potter', 'weaver', 'butcher', 'fishmonger', 'brewer', 'apothecary'] as const;
TRADES.forEach((trade, i) => add(`shop-${trade}`, `Merchant · ${trade === 'blacksmith' ? 'blacksmith’s forge' : trade}`, m => {
  base(m); house(m, -17, -18, 29, 25, i % 3 ? 2 : 1, trade !== 'blacksmith', i % 2 ? BLUE : RED);
  awning(m, -15, 7, 25, 12, i % 2 ? BLUE : RED);
  m.box(-12, 14, 20, 5, 0, 4, GOLD);
  if (trade === 'blacksmith') {
    m.box(14, -11, 6, 8, 0, 9, SHADE); m.box(15, -10, 4, 4, 9, 19, SHADE);
    m.box(-5, 14, 4, 4, 4, 2, INK); m.box(-8, 14, 10, 4, 6, 1.5, SHADE);
  } else if (trade === 'potter' || trade === 'brewer' || trade === 'apothecary') {
    for (const x of [-8, -2, 4]) barrel(m, x, 16, 4, trade === 'apothecary' ? 1 : 1.7, 3);
    barrel(m, 17, 15, 0, 2.5, 6);
  } else if (trade === 'weaver') {
    for (let k = 0; k < 3; k++) m.box(-10 + k * 5, 14, 4, 4, 4, 1, k % 2 ? RED : BLUE);
  } else for (const x of [-8, -2, 4]) {
    const s = m.face([[x - 2, 16, 4.3], [x, 14, 5], [x + 2, 16, 4.3], [x, 18, 4.3]], trade === 'fishmonger' ? BLUE : trade === 'butcher' ? RED : GOLD);
    m.detail(s, [[x - 1, 16, 4.5], [x + 1, 16, 4.5]]);
  }
  sign(m, -19, 16, trade);
}));
add('inn', 'Merchant · roadside inn', m => { base(m); house(m, -17, -17, 31, 29, 3); sign(m, 18, 14); barrel(m, 17, 5); barrel(m, 18, -2); m.box(-12, 16, 15, 4, 0, 3, GOLD); });
add('market-hall', 'Merchant · open timber market hall', m => {
  base(m); for (const x of [-17, 17]) for (const y of [-15, 0, 15]) m.box(x, y, 1.5, 1.5, 0, 17, GOLD);
  roof(m, -20, -18, 40, 38, 17, 12);
  for (const x of [-12, 8]) { m.box(x, -9, 6, 23, 0, 4, GOLD); for (const y of [-5, 4, 11]) barrel(m, x + 3, y, 4, 1.8, 2.5); }
});

function crenellations(m: Model, u: number, v: number, w: number, d: number, z: number) {
  m.box(u - .5, v - .5, w + 1, d + 1, z, 1.5);
  for (let x = u; x < u + w; x += 5) for (const y of [v, v + d - 2]) m.box(x, y, Math.min(3, u + w - x), 2, z + 1.5, 3);
  for (let y = v + 5; y < v + d - 3; y += 5) for (const x of [u, u + w - 2]) m.box(x, y, 2, 3, z + 1.5, 3);
}
function tower(m: Model, u: number, v: number, w = 12, h = 30, spire = false) {
  const walls = m.box(u, v, w, w, 0, h);
  const maps: ((x: number, z: number) => V)[] = [(x,z)=>[u+x,v,z],(x,z)=>[u+w,v+x,z],(x,z)=>[u+w-x,v+w,z],(x,z)=>[u,v+w-x,z]];
  walls.forEach((s, i) => { for (const z of [9, 20]) if (z + 5 < h) opening(m, s, maps[i]!, w / 2 - 1, z, 2, 5, true); });
  if (spire) cone(m, u + w / 2, v + w / 2, w * .8, h, 18);
  else crenellations(m, u, v, w, w, h);
}
add('keep', 'Castle · square stone keep', m => { base(m); tower(m, -15, -15, 30, 35); tower(m, -19, -19, 9, 43, true); tower(m, 10, 10, 9, 43, true); });
add('watchtower', 'Castle · crenellated watchtower', m => { base(m); tower(m, -9, -9, 18, 38); m.box(-14, -14, 28, 28, 0, 2); barrel(m, 17, 10); });
add('gatehouse', 'Castle · twin-tower gatehouse', m => {
  base(m); tower(m, -22, -9, 13, 31, true); tower(m, 9, -9, 13, 31, true);
  m.box(-9, -6, 18, 10, 15, 9); crenellations(m, -9, -6, 18, 10, 24);
  for (let x = -7; x <= 7; x += 2) m.box(x, 0, .6, .6, 0, 16, GOLD);
  m.box(-8, 1, 16, .6, 6, .7, GOLD); m.box(-8, 1, 16, .6, 12, .7, GOLD);
});
add('wall', 'Castle · battlement wall', m => { base(m); m.box(-22, -4, 44, 8, 0, 20); crenellations(m, -22, -4, 44, 8, 20); tower(m, -6, -7, 12, 28); });
add('corner-wall', 'Castle · corner wall and turret', m => { base(m); m.box(-20, -20, 40, 6, 0, 17); crenellations(m, -20, -20, 40, 6, 17); m.box(-20, -14, 6, 34, 0, 17); crenellations(m, -20, -14, 6, 34, 17); tower(m, -22, -22, 12, 29, true); });

function church(m: Model, grand = false) {
  base(m); house(m, -12, -19, 24, 35, grand ? 3 : 2, false, BLUE);
  tower(m, -9, 8, 18, grand ? 43 : 32, true);
  m.box(-.4, 15, .8, .8, grand ? 61 : 50, 7, GOLD); m.box(-3, 15, 6, .8, grand ? 65 : 54, .8, GOLD);
  for (const x of [-16, 12]) for (const y of [-14, -3]) m.box(x, y, 4, 3, 0, grand ? 19 : 12, SHADE);
}
add('chapel', 'Civic · village chapel', m => church(m));
add('church', 'Civic · great parish church', m => church(m, true));
add('cloister', 'Civic · monastery cloister', m => {
  base(m); house(m, -21, -21, 42, 13, 2, false, RED);
  for (const x of [-20, 13]) { for (const y of [-3, 6, 15]) m.box(x, y, 2, 2, 0, 11); roof(m, x - 2, -7, 9, 28, 11, 5); }
  m.box(-9, -3, 18, 20, 0, .7, PAPER, GREEN); barrel(m, 0, 8, .7, 4, 2); tree(m, 0, 8, .6);
});
add('guildhall', 'Civic · merchants’ guildhall', m => { base(m); house(m, -19, -16, 38, 32, 3, true, RED); tower(m, -5, -5, 10, 44, true); awning(m, -16, 16, 31, 11, BLUE); });
add('watermill', 'Civic · riverside watermill', m => {
  base(m); house(m, -18, -17, 26, 32, 2, true, RED);
  const wheel = m.face(Array.from({ length: 20 }, (_, i): V => [13, -1 + 10 * Math.cos(i * Math.PI / 10), 11 + 10 * Math.sin(i * Math.PI / 10)]), GOLD);
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; m.detail(wheel, [[13, -1, 11], [13, -1 + 10 * Math.cos(a), 11 + 10 * Math.sin(a)]]); }
  m.box(8, -2, 8, 2, 10, 2, GOLD); barrel(m, -14, 19);
});
add('windmill', 'Civic · timber post windmill', m => {
  base(m); tower(m, -7, -7, 14, 24); roof(m, -8, -8, 16, 16, 25, 12, GOLD);
  const c: V = [0, 10, 26];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + .4, p = (r: number, t: number): V => [c[0] + r * Math.cos(a) - t * Math.sin(a), c[1], c[2] + r * Math.sin(a) + t * Math.cos(a)];
    const s = m.face([p(2, -1), p(19, -1), p(19, 3), p(7, 3)], PAPER);
    for (let r = 7; r < 19; r += 3) m.detail(s, [p(r, -1), p(r, 3)], 'none', GOLD);
  }
});
add('tithe-barn', 'Civic · great tithe barn', m => { base(m); house(m, -18, -20, 36, 40, 1, true, GOLD); for (const x of [-17, 16]) barrel(m, x, 20); });

const GARDENS = ['village green', 'herb garden', 'orchard', 'well courtyard', 'cloister fountain', 'graveyard', 'tournament green', 'woodcutter’s grove'];
function garden(i: number) {
  const m = new Model(); base(m, true, i === 3 || i === 4 ? PAPER : GREEN);
  if ([0, 2, 7].includes(i)) {
    for (const [u, v] of [[-16, -15], [14, -14], [-15, 14], [16, 16]]) tree(m, u!, v!, .75, i === 7);
    if (i === 0) { m.box(-7, -3, 14, 5, 0, 3, GOLD); sign(m, 2, 9); }
    if (i === 7) for (const x of [-5, 0, 5]) m.box(x, -5, 3, 14, 0, 3, GOLD);
  } else if (i === 1) {
    for (const x of [-20, 5]) for (const y of [-19, -5, 9]) {
      m.box(x, y, 14, 9, 0, 1, GOLD, GREEN);
      for (const dx of [3, 7, 11]) tree(m, x + dx, y + 4, .2);
    }
  } else if (i === 3) {
    barrel(m, 0, 0, 0, 6, 4);
    for (const x of [-7, 7]) m.box(x, -.5, 1, 1, 0, 15, GOLD);
    roof(m, -9, -6, 18, 12, 15, 6); barrel(m, 11, 7, 0, 1.5, 3);
  } else if (i === 4) {
    const s = m.face([[-9, -9, 1], [9, -9, 1], [9, 9, 1], [-9, 9, 1]], BLUE, [0, 0, 1]);
    m.detail(s, [[-7, -7, 1], [7, -7, 1], [7, 7, 1], [-7, 7, 1], [-7, -7, 1]], 'none', GOLD);
    m.box(-1, -1, 2, 2, 1, 9); cone(m, 0, 0, 4, 7, 2, GOLD);
    for (const x of [-18, 18]) tree(m, x, 12, .7);
  } else if (i === 5) {
    for (const x of [-13, 0, 13]) for (const y of [-14, 4]) { m.box(x - 1, y, 2, 2, 0, 7); m.box(x - 3, y, 6, 2, 4, 1.5); }
    tree(m, -20, 18, .75, true); tree(m, 20, 18, .75, true);
  } else {
    m.box(-1, -21, 2, 42, 0, 3, GOLD);
    for (const x of [-17, 17]) { m.box(x, -17, .8, .8, 0, 20, GOLD); m.face([[x, -17, 20], [x + 6, -17, 18], [x, -17, 16]], x < 0 ? RED : BLUE); cone(m, x, 15, 6, 6, 9, x < 0 ? RED : BLUE); }
  }
  return m;
}

const ROAD_SHAPES: { role: IsometricRole; name: string; mask: number }[] = [
  { role: 'road-straight', name: 'straight', mask: 5 }, { role: 'road-corner', name: 'corner', mask: 3 },
  { role: 'road-tee', name: 'T junction', mask: 7 }, { role: 'road-cross', name: 'crossroads', mask: 15 }, { role: 'road-end', name: 'end', mask: 1 },
];
function road(shape: typeof ROAD_SHAPES[number], style: number) {
  const m = new Model(); base(m, true, style === 1 ? GREEN : PAPER);
  const vertices: V[] = [];
  for (let side = 0; side < 4; side++) for (const [x, y] of shape.mask & (1 << side) ? [[12, -12], [25, -12], [25, 12], [12, 12]] : [[12, -12], [12, 12]]) vertices.push(turn([x!, y!, .1], side));
  const s = m.face(vertices, style === 1 ? GOLD : SHADE, [0, 0, 1], -90);
  for (let x = -10; x <= 10; x += 5) for (let y = -10; y <= 10; y += 5) m.detail(s, [[x - 2, y - 1, .1], [x + 1, y - 2, .1], [x + 2, y + 1, .1], [x - 1, y + 2, .1], [x - 2, y - 1, .1]], 'none', style === 1 ? SHADE : INK);
  for (let side = 0; side < 4; side++) {
    const p = (x: number, y: number): V => turn([x, y, .1], side);
    if (shape.mask & (1 << side)) {
      for (const y of [-13, 13]) m.detail(s, [p(12, y), p(25, y)]);
      for (let x = 15; x < 25; x += 5) for (const y of [-8, -2, 4, 10]) m.detail(s, [p(x - 1, y - 1), p(x + 2, y - 1), p(x + 2, y + 1)]);
    } else m.detail(s, [p(13, -13), p(13, 13)]);
  }
  if (style === 2) for (const [u, v] of [[-19, -19], [19, -19], [-19, 19], [19, 19]]) tree(m, u!, v!, .5);
  else if (style === 0) sign(m, -19, -19, 'market');
  return m.asset(`road-${style}-${shape.role.slice(5)}`, `Road · ${['cobbled lane', 'country track', 'tree-lined street'][style]} · ${shape.name}`, 0, shape.role, undefined, { treeLined: style === 2 });
}

function sea(m: Model, calm = false) {
  const s = m.face([[-25, -25, 0], [25, -25, 0], [25, 25, 0], [-25, 25, 0]], BLUE, [0, 0, 1], -100);
  for (const [u, v] of [[-19, -18], [5, -15], [-8, -3], [12, 8], [-18, 15], [-1, 21]]) m.detail(s, [[u!, v!, .05], [u! + 3, v! - (calm ? 0 : 1), .05], [u! + 7, v!, .05]], 'none', SHADE);
}
function shore(mask: number, dock = 0) {
  const m = new Model(); sea(m);
  for (let side = 0; side < 4; side++) if (mask & (1 << side)) {
    const s = m.face([[8,-25,.6],[25,-25,.6],[25,25,.6],[8,25,.6]].map(p => turn(p as V, side)), PAPER, [0,0,1], -80);
    for (let y = -25; y <= 25; y += 6.25) m.detail(s, [turn([8,y,.6],side),turn([25,y,.6],side)], 'none', SHADE);
  }
  if (dock) {
    m.box(-10,-6,32,12,0,2,GOLD);
    for (let x = -8; x < 22; x += 3) m.line([[x,-6,2.05],[x,6,2.05]],INK);
    for (const x of [-5,18]) for (const y of [-5,5]) m.box(x,y,1,1,-1,6,GOLD);
    if (dock === 2) for (const x of [-3,3,9]) barrel(m,x,0,2,2,5);
    if (dock === 3) { house(m,-23,-12,13,24,1,true,RED); barrel(m,9,0,2); }
    if (dock === 4) {
      m.box(-18,-2,2,2,0,24,GOLD); m.line([[-17,-1,23],[12,-1,18],[12,-1,6]],INK);
      m.line([[-17,-1,15],[12,-1,18]],GOLD); m.box(9,-4,6,6,3,3,GOLD);
    }
  }
  return m;
}
function ship(i: number) {
  const m = new Model(); sea(m);
  const small = i === 3, l = small ? 15 : 22, b = small ? 4 : 7;
  const outline: V[] = [[-l,0,4],[-l+5,-b,2],[l-6,-b,2],[l,0,5],[l-6,b,2],[-l+5,b,2]];
  const deck = m.face(outline,GOLD,[0,0,1]);
  for (let x = -l + 6; x < l - 5; x += 4) m.detail(deck,[[x,-b+1,2.1],[x,b-1,2.1]],'none',INK);
  for (let j = 0; j < outline.length; j++) {
    const a = outline[j]!, c = outline[(j+1)%outline.length]!;
    m.face([a,c,[c[0]*.85,c[1]*.75,-1],[a[0]*.85,a[1]*.75,-1]],RED,[(a[0]+c[0])/2,(a[1]+c[1])/2,0]);
  }
  if (i === 0 || i === 1) { m.box(-18,-5,8,10,3,5,GOLD); m.box(12,-4,5,8,3,4,GOLD); }
  if (small) {
    for (const x of [-7,0,7]) m.box(x,-3,1,6,2,1,GOLD);
    m.line([[-8,1,3],[-15,11,0]],GOLD); barrel(m,5,0,2,1.5,3);
  } else if (i === 4) {
    for (const x of [-12,-5,2,9]) barrel(m,x,0,2,2.5,5);
    m.line([[-14,1,4],[-23,12,0]],GOLD);
  } else {
    m.box(-.5,-.5,1,1,2,31,GOLD); m.line([[-14,0,29],[14,0,29]],INK);
    const sail = i === 2 ? m.face([[0,0,31],[0,0,9],[18,0,10]],PAPER) : m.face([[-13,0,28],[13,0,28],[15,2,18],[10,3,10],[-10,3,10],[-15,2,18]],PAPER);
    if (i === 1) for (let x = -10; x <= 10; x += 5) m.detail(sail,[[x,0,28],[x+1,2,18],[x*.75,3,10]],'none',RED);
    else m.detail(sail,[[0,1,25],[0,2.5,14]],'none',RED);
    m.line([[0,0,33],[-l+2,0,4]],INK); m.line([[0,0,33],[l-2,0,5]],INK);
    m.face([[0,0,33],[7,0,31],[0,0,30]],i === 1 ? BLUE : RED);
  }
  return m;
}

const VIEWS = ['front-right', 'rear-right', 'rear-left', 'front-left'];
export const MEDIEVAL_CATEGORIES: GlyphCategory[] = [{ id: MEDIEVAL_CATEGORY, name: 'Medieval · towns & castles', kind: 'isometric' }];
export const MEDIEVAL_ASSETS: GlyphAsset[] = [
  ...buildings.flatMap(design => {
    const m = new Model(); design.draw(m);
    return VIEWS.map((view, rotation) => m.asset(`${design.id}-view-${rotation}`, `${design.name} · ${view}`, rotation));
  }),
  ...GARDENS.flatMap((name,i) => [0,1].map(r => garden(i).asset(`garden-${i}-view-${r}`, `Garden · ${name} · ${VIEWS[r]}`, r, 'terrain', 'park'))),
  ...[0,1,2].flatMap(style => ROAD_SHAPES.map(shape => road(shape,style))),
  ...[false,true].map(calm => { const m = new Model(); sea(m,calm); return m.asset(calm?'river-water':'sea-water',calm?'Water · calm river':'Water · coastal sea',0,'terrain','water'); }),
  ...[{id:'quay',name:'stone quay',mask:4},{id:'corner',name:'harbour corner',mask:12},{id:'canal',name:'stone canal',mask:5},{id:'basin',name:'harbour basin',mask:13}].map(s => shore(s.mask).asset(`shore-${s.id}`,`Coast · ${s.name}`,0,'terrain','shore',{shoreMask:s.mask})),
  ...['timber jetty','barrel loading dock','quayside warehouse','cargo crane'].map((name,i)=>shore(4,i+1).asset(`dock-${i}`,`Harbour · ${name}`,0,'terrain','shore',{shoreMask:4})),
  ...['merchant cog','striped-sail trading ship','lateen coaster','fishing skiff','river cargo barge'].flatMap((name,i)=>VIEWS.map((view,r)=>ship(i).asset(`vessel-${i}-view-${r}`,`Vessel · ${name} · ${view}`,r,'terrain','feature'))),
];
