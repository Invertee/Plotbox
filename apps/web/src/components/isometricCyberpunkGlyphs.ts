import type { IsometricRole, Point, SourcePath } from '@plotter/core';
import type { GlyphAsset, GlyphCategory } from './Glyphbox';

export const CYBERPUNK_CATEGORY = 'iso-cyberpunk';
export const CYBERPUNK_PALETTE = [
  { colour: '#26213f', name: 'Cyberpunk · midnight ink' },
  { colour: '#ef4baf', name: 'Cyberpunk · neon magenta' },
  { colour: '#23becb', name: 'Cyberpunk · electric cyan' },
  { colour: '#855bc0', name: 'Cyberpunk · ultraviolet' },
  { colour: '#f6ac57', name: 'Cyberpunk · sunset amber' },
  { colour: '#626487', name: 'Cyberpunk · dusk blue' },
];
const [INK, PINK, CYAN, PURPLE, AMBER, SHADE] = CYBERPUNK_PALETTE.map(c => c.colour) as [string, string, string, string, string, string];
const PAPER = '#fff5df';

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
    paths.forEach((p, i) => { p.id = `cyberpunk-${i}`; });
    const points = paths.flatMap(p => p.points), ground = role !== 'building';
    const left = ground ? -25 * Math.sqrt(3) : Math.min(...points.map(p => p.x)) - 2;
    const width = ground ? 50 * Math.sqrt(3) : Math.max(...points.map(p => p.x)) - left + 2;
    const top = Math.min(-25, ...points.map(p => p.y)) - 2, bottom = Math.max(25, ...points.map(p => p.y)) + 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${bottom - top}"><g stroke-width="0.65" stroke-linejoin="round" stroke-linecap="round">${paths.map(p => `<${p.closed ? 'polygon' : 'polyline'} points="${p.points.map(q => `${rounded(q.x)},${rounded(q.y)}`).join(' ')}" fill="${p.fill}" stroke="${p.stroke}"/>`).join('')}</g></svg>`;
    return { id: `cyberpunk-${id}`, name, kind: 'isometric', categoryId: CYBERPUNK_CATEGORY, collectionId: CYBERPUNK_CATEGORY, createdAt: new Date(0).toISOString(), isometricRole: role, terrain, svg,
      plotPaths: paths.map(p => ({ ...p, points: p.points.map(q => ({ x: rounded((q.x - left) / width), y: rounded(ground ? (q.y + 25) / 50 : (q.y - top) / width), ...(q.elevation ? { elevation: rounded(q.elevation / (ground ? 50 : width)) } : {}) })) })), ...extra };
  }
}

function ground(m: Model, full = false) {
  const r = full ? 25 : 23;
  const s = m.face([[-r,-r,0],[r,-r,0],[r,r,0],[-r,r,0]], PAPER, [0,0,1], -100);
  for (let n = -20; n <= 20; n += 10) {
    m.detail(s, [[n,-r,0],[n,r,0]], 'none', PURPLE);
    m.detail(s, [[-r,n,0],[r,n,0]], 'none', PURPLE);
  }
}

// Facade details belong to their wall, so signs and windows turn with the model.
function block(m: Model, u: number, v: number, w: number, d: number, z: number, h: number, accent = CYAN, windows = true) {
  const walls = m.box(u,v,w,d,z,h,PAPER,PURPLE);
  const maps: ((x: number, height: number) => V)[] = [
    (x,zz) => [u+w-x,v,zz], (x,zz) => [u+w,v+d-x,zz],
    (x,zz) => [u+x,v+d,zz], (x,zz) => [u,v+x,zz],
  ];
  walls.forEach((wall, side) => {
    const p = maps[side]!, span = side % 2 ? d : w;
    m.detail(wall, [p(1,z+1),p(1,z+h-1),p(span-1,z+h-1)], 'none', accent);
    if (windows) for (let floor = 0; floor < Math.floor(h/7); floor++) {
      for (let x = 3; x < span-3; x += 5) {
        const zz = z+3+floor*7, colour = (floor+side+Math.floor(x/5))%4 === 0 ? AMBER : accent;
        m.detail(wall, [p(x,zz),p(Math.min(x+2.5,span-2),zz),p(Math.min(x+2.5,span-2),zz+2.5),p(x,zz+2.5)], colour, colour, true);
      }
    }
  });
  return { walls, maps };
}

// Stroke lettering remains printable without fonts, raster images or glow filters.
const LETTERS: Record<string,string> = {
  A:'0,0 0,3 1,4 2,3 2,0;0,2 2,2', C:'2,0 0,0 0,4 2,4', D:'0,0 0,4 1,4 2,3 2,1 1,0 0,0',
  E:'2,0 0,0 0,4 2,4;0,2 1.5,2', H:'0,0 0,4;2,0 2,4;0,2 2,2', I:'0,0 2,0;1,0 1,4;0,4 2,4',
  L:'0,4 0,0 2,0', M:'0,0 0,4 1,2 2,4 2,0', N:'0,0 0,4 2,0 2,4', O:'0,0 0,4 2,4 2,0 0,0',
  R:'0,0 0,4 2,4 2,2 0,2;0,2 2,0', S:'0,0 2,0 2,2 0,2 0,4 2,4', T:'0,4 2,4;1,4 1,0',
  V:'0,4 1,0 2,4', X:'0,0 2,4;0,4 2,0', Y:'0,4 1,2 2,4;1,2 1,0',
};
function sign(m: Model, surface: Surface, map: (x: number,z: number) => V, text: string, x: number, z: number, scale = 1, colour = PINK) {
  const w = (text.length*3-1)*scale;
  m.detail(surface, [map(x-1,z-1),map(x+w+1,z-1),map(x+w+1,z+5*scale),map(x-1,z+5*scale)], INK, colour, true);
  [...text].forEach((letter,i) => (LETTERS[letter] ?? '').split(';').filter(Boolean).forEach(line => {
    m.detail(surface, line.split(' ').map(pair => {
      const [a,b] = pair.split(',').map(Number); return map(x+(a!+i*3)*scale,z+b!*scale);
    }), 'none', colour);
  }));
}
function antenna(m: Model, u: number, v: number, z: number, h = 13) {
  m.box(u-1,v-1,2,2,z,2,SHADE);
  m.line([[u,v,z+2],[u,v,z+h]],CYAN);
  m.line([[u-3,v,z+h-4],[u+3,v,z+h-4]],PINK);
  m.line([[u,v-3,z+h-7],[u,v+3,z+h-7]],PINK);
}
function palm(m: Model, u: number, v: number, h = 18) {
  m.box(u-2,v-2,4,4,0,2,PURPLE);
  m.line([[u,v,2],[u+1,v,h*.6],[u+3,v,h]],AMBER);
  for (let i=0;i<7;i++) {
    const a=i*Math.PI*2/7, dx=Math.cos(a),dy=Math.sin(a);
    m.line([[u+3,v,h],[u+3+dx*4,v+dy*4,h+2],[u+3+dx*8,v+dy*8,h-2]],CYAN);
    m.line([[u+3+dx*4,v+dy*4,h+2],[u+3+dx*6-dy,v+dy*6+dx,h-1]],CYAN);
  }
}
function sunset(m: Model, u: number,v: number,z: number,r=9) {
  const vertices: V[]=[[u-r-2,v,z-r-2],[u+r+2,v,z-r-2],[u+r+2,v,z+r+2],[u-r-2,v,z+r+2]];
  const s=m.face(vertices,INK,[0,1,0]);
  const back=m.face(vertices,SHADE,[0,-1,0]);
  m.detail(back,[[u-r,v,z-r],[u+r,v,z+r]],'none',PURPLE);
  m.detail(back,[[u+r,v,z-r],[u-r,v,z+r]],'none',PURPLE);
  for (let y=-r+1;y<r;y+=2) {
    const x=Math.sqrt(r*r-y*y);
    m.detail(s,[[u-x,v,z+y],[u+x,v,z+y]],'none',y>0?AMBER:PINK);
  }
}

const BUILDINGS: { id: string; name: string; draw: (m: Model) => void }[] = [
  { id:'courtyard-house', name:'Residential · Neon courtyard house', draw(m) {
    block(m,-18,-15,12,30,0,12,CYAN);
    block(m,-6,-15,24,12,0,12,PINK);
    block(m,6,4,12,11,0,8,CYAN,false);
    m.box(-4,0,7,12,0,.7,PURPLE,CYAN);
    for(let x=-14;x<-7;x+=2) m.line([[x,-12,12],[x,11,12]],PINK);
    palm(m,16,19,12);
  } },
  { id:'duplex-house', name:'Residential · Synthwave duplex', draw(m) {
    for(const x of [-18,2]) {
      const {walls,maps}=block(m,x,-13,16,26,0,18,x<0?PINK:CYAN);
      const p=maps[2]!; m.detail(walls[2]!,[p(6,0),p(10,0),p(10,7),p(6,7)],INK,AMBER,true);
      m.box(x-1,10,18,5,9,1,PURPLE);
      for(let y=-10;y<8;y+=4) m.line([[x+2,y,18],[x+14,y,18]],CYAN);
    }
  } },
  { id:'retro-villa', name:'Residential · Sunset villa', draw(m) {
    block(m,-18,-14,36,21,0,10,PINK);
    block(m,-15,-11,18,15,10,8,CYAN,false);
    m.box(-20,-16,40,25,18,1,PURPLE);
    const pool=m.face([[-5,11,0],[16,11,0],[16,21,0],[-5,21,0]],CYAN,[0,0,1]);
    for(const y of [14,18]) m.detail(pool,[[-3,y,0],[14,y,0]],'none',PURPLE);
    palm(m,-16,16,15);
  } },
  { id:'tenement-block', name:'Residential · Neon tenement block', draw(m) {
    block(m,-18,-15,36,30,0,34,PINK);
    for(const z of [11,21,31]) {
      m.box(-19,13,38,5,z,1,PURPLE);
      m.line([[-19,18,z+3],[19,18,z+3]],CYAN);
      for(let x=-18;x<=18;x+=6) m.line([[x,18,z],[x,18,z+3]],CYAN);
    }
    m.box(-12,-10,10,8,34,4,SHADE); antenna(m,9,-5,34);
  } },
  { id:'robot-factory', name:'Industry · Robotics assembly plant', draw(m) {
    const {walls,maps}=block(m,-20,-17,40,31,0,18,CYAN,false);
    const p=maps[2]!;
    for(const x of [3,16,29]) {
      m.detail(walls[2]!,[p(x,1),p(x+8,1),p(x+8,13),p(x,13)],SHADE,CYAN,true);
      for(let z=3;z<13;z+=3) m.detail(walls[2]!,[p(x,z),p(x+8,z)],'none',INK);
    }
    for(const x of [-15,0,15]) block(m,x-3,-13,6,24,18,3,PINK,false);
    for(const x of [-13,10]) { block(m,x,-17,5,5,20,13,PURPLE,false); m.box(x-1,-18,7,7,33,1,PINK); }
  } },
  { id:'cargo-depot', name:'Industry · Automated cargo depot', draw(m) {
    block(m,-19,-17,38,18,0,20,CYAN,false);
    for(const [u,v,z,colour] of [[-18,4,0,PURPLE],[2,4,0,PINK],[-18,4,7,CYAN]] as [number,number,number,string][]) {
      const walls=m.box(u,v,16,13,z,7,colour);
      for(let x=2;x<16;x+=3) m.detail(walls[2]!,[[u+x,v+13,z+1],[u+x,v+13,z+6]],'none',INK);
    }
    for(const u of [-21,21]) m.box(u,2,1,17,0,25,SHADE);
    m.box(-21,6,43,3,25,2,AMBER); m.line([[0,7,25],[0,7,17],[3,7,17]],PINK);
  } },
  { id:'cyber-clinic', name:'Shop · Cybernetic clinic', draw(m) {
    const {walls,maps}=block(m,-16,-14,32,28,0,21,CYAN);
    sign(m,walls[2]!,maps[2]!,'CLINIC',3,12,1.4,CYAN);
    m.box(-18,12,36,6,10,1,PINK);
    const s=m.face([[17,-8,15],[17,2,15],[17,2,27],[17,-8,27]],INK,[1,0,0]);
    m.detail(s,[[17,-3,17],[17,-3,25]],'none',PINK); m.detail(s,[[17,-7,21],[17,1,21]],'none',PINK);
  } },
  { id:'record-store', name:'Shop · Vinyl record store', draw(m) {
    const {walls,maps}=block(m,-18,-13,36,26,0,16,PINK,false);
    sign(m,walls[2]!,maps[2]!,'VINYL',6,8,1.4,AMBER);
    for(const x of [3,15,27]) { const p=maps[2]!; m.detail(walls[2]!,[p(x,1),p(x+6,1),p(x+6,7),p(x,7)],INK,CYAN,true); }
    const s=m.face([[-10,0,18],[10,0,18],[10,0,38],[-10,0,38]],INK,[0,1,0]);
    m.face([[-10,0,18],[10,0,18],[10,0,38],[-10,0,38]],SHADE,[0,-1,0]);
    for(const r of [3,6,8]) m.detail(s,Array.from({length:25},(_,i):V=>[Math.cos(i*Math.PI/12)*r,0,28+Math.sin(i*Math.PI/12)*r]),'none',r===3?AMBER:PINK);
  } },
  { id:'prism-tower', name:'Tower · Prism headquarters', draw(m) {
    block(m,-17,-15,34,30,0,7,PINK,false);
    block(m,-12,-11,24,22,7,49,CYAN);
    block(m,-8,-7,16,14,56,9,PINK,false); antenna(m,2,0,65,17);
  } },
  { id:'sunset-hotel', name:'Tower · Sunset terraces hotel', draw(m) {
    for(let i=0;i<4;i++) block(m,-18+i*4,-16+i*3,36-i*8,32-i*6,i*12,12,i%2?CYAN:PINK);
    const s=m.face([[-15,17,4],[15,17,4],[15,17,13],[-15,17,13]],INK,[0,1,0]);
    sign(m,s,(x,z)=>[x,17,z],'HOTEL',-12,6,1.6,AMBER);
  } },
  { id:'capsule-flats', name:'Residential · Capsule apartments', draw(m) {
    block(m,-15,-12,30,24,0,36,CYAN,false);
    for(let floor=0;floor<4;floor++) for(const x of [-11,0,11]) {
      const {walls,maps}=block(m,x-4,10,8,6,3+floor*8,5,floor%2?PINK:CYAN,false);
      m.detail(walls[2]!,[maps[2]!(1,4+floor*8),maps[2]!(7,4+floor*8),maps[2]!(7,6+floor*8),maps[2]!(1,6+floor*8)],INK,CYAN,true);
    }
    block(m,-9,-6,10,9,36,5,PINK,false); antenna(m,9,-5,36);
  } },
  { id:'neon-arcade', name:'Street · Neon arcade', draw(m) {
    const {walls,maps}=block(m,-18,-13,36,26,0,18,PINK,false);
    sign(m,walls[2]!,maps[2]!,'ARCADE',4,9,1.6);
    for(const x of [3,11,23,29]) {
      const p=maps[2]!; m.detail(walls[2]!,[p(x,1),p(x+4,1),p(x+4,8),p(x,8)],INK,CYAN,true);
      m.detail(walls[2]!,[p(x+1,5),p(x+3,5),p(x+3,7),p(x+1,7)],PURPLE,PINK,true);
    }
    block(m,-20,-15,40,30,18,2,CYAN,false);
    sunset(m,0,0,32,9);
  } },
  { id:'noodle-bar', name:'Street · Midnight noodle bar', draw(m) {
    const {walls,maps}=block(m,-17,-12,29,24,0,20,AMBER,false);
    sign(m,walls[2]!,maps[2]!,'RAMEN',3,12,1.5,AMBER);
    const p=maps[2]!; m.detail(walls[2]!,[p(3,3),p(26,3),p(26,9),p(3,9)],INK,CYAN,true);
    m.box(-18,12,32,5,10,1,PINK);
    for(const x of [-12,-4,4]) m.box(x,17,3,3,0,4,PURPLE);
    const panel=m.face([[14,0,6],[14,7,6],[14,7,33],[14,0,33]],INK,[1,0,0]);
    for(let i=0;i<3;i++) sign(m,panel,(x,z)=>[14,7-x,z],'N',2,9+i*8,1.3,PINK);
    m.box(-10,-6,9,8,20,4,SHADE); antenna(m,5,-7,20,8);
  } },
  { id:'synth-cinema', name:'Street · Synthwave cinema', draw(m) {
    block(m,-19,-15,38,30,0,20,PURPLE,false);
    const {walls,maps}=block(m,-21,9,42,9,10,10,PINK,false);
    sign(m,walls[2]!,maps[2]!,'CINEMA',9,12,1.4,AMBER);
    for(const x of [-12,-4,4,12]) m.box(x-2,15,4,2,0,9,INK,CYAN);
    sunset(m,0,5,33,12);
  } },
  { id:'data-vault', name:'Industry · Data vault', draw(m) {
    const {walls,maps}=block(m,-16,-15,32,30,0,27,CYAN,false);
    walls.forEach((wall,i)=>{ const p=maps[i]!; for(let x=3;x<28;x+=4) m.detail(wall,[p(x,4),p(x,24)],'none',i%2?PURPLE:CYAN); });
    for(const x of [-9,4]) for(const y of [-8,5]) {
      m.box(x-3,y-3,6,6,27,3,SHADE,INK);
      for(const t of [-1,1]) m.line([[x-2,y+t,30],[x+2,y+t,30]],CYAN);
    }
    sign(m,walls[2]!,maps[2]!,'DATA',6,11,1.6,PINK);
  } },
  { id:'relay-spire', name:'Tower · Broadcast relay', draw(m) {
    block(m,-13,-13,26,26,0,10,PURPLE);
    block(m,-5,-5,10,10,10,40,CYAN,false);
    for(const z of [26,39,50]) block(m,-10,-10,20,20,z,3,PINK,false);
    antenna(m,0,0,53,23);
    for(const side of [-1,1]) m.line([[side*12,0,10],[side*4,0,36]],PURPLE);
  } },
  { id:'sky-station', name:'Transit · Skyrail station', draw(m) {
    for(const x of [-15,15]) for(const y of [-10,10]) block(m,x-2,y-2,4,4,0,15,CYAN,false);
    block(m,-23,-15,46,30,15,3,PINK,false);
    const deck=m.face([[-23,-6,18],[23,-6,18],[23,6,18],[-23,6,18]],INK,[0,0,1]);
    for(const y of [-4,4]) m.detail(deck,[[-23,y,18],[23,y,18]],'none',CYAN);
    block(m,-15,-4,26,8,18,6,CYAN);
    for(const x of [-19,19]) m.box(x,-13,1,26,18,10,PURPLE);
    block(m,-23,-16,46,32,28,2,PINK,false);
    for(let i=0;i<6;i++) m.box(-18,16+i,9,1,0,15-i*2,SHADE);
  } },
  { id:'night-market', name:'Street · Night market', draw(m) {
    for(const x of [-15,6]) {
      block(m,x,-10,12,13,0,9,PINK,false); m.box(x-1,-11,14,16,9,2,PURPLE);
      m.box(x,4,12,3,0,4,CYAN);
      for(const dx of [2,6,10]) m.box(x+dx,4,1.5,2,4,2,AMBER);
    }
    for(const x of [-21,21]) m.box(x,8,1,1,0,20,PURPLE);
    m.line([[-21,8,20],[0,8,17],[21,8,20]],PINK);
    for(const x of [-15,-5,5,15]) m.box(x,8,2,2,16+Math.abs(x)/10,2,AMBER);
    palm(m,-14,17,12);
  } },
  { id:'retro-service', name:'Transit · Neon charging station', draw(m) {
    block(m,-18,-15,22,13,0,12,CYAN,false);
    for(const x of [-14,12]) m.box(x,8,1.5,1.5,0,16,PURPLE);
    block(m,-21,-4,42,20,16,2,PINK,false);
    for(const x of [-12,2,13]) {
      const {walls,maps}=block(m,x,4,4,5,0,8,CYAN,false);
      m.detail(walls[2]!,[maps[2]!(1,3),maps[2]!(3,5),maps[2]!(1,5),maps[2]!(3,7)],'none',AMBER);
    }
  } },
  { id:'pyramid-club', name:'Landmark · Horizon pyramid club', draw(m) {
    block(m,-20,-20,40,40,0,5,PINK,false);
    for(let side=0;side<4;side++) {
      const p=(x:number,y:number,z:number)=>turn([x,y,z],side);
      const s=m.face([p(-18,18,5),p(18,18,5),p(0,0,36)],PURPLE,turn([0,1,18/31],side));
      for(let z=10;z<34;z+=5) { const r=18*(36-z)/31; m.detail(s,[p(-r,r,z),p(r,r,z)],'none',z%10?PINK:CYAN); }
    }
    const door=m.face([[-5,18,5],[5,18,5],[5,15,11],[-5,15,11]],INK,[0,1,0]);
    m.detail(door,[[-5,18,5],[-5,15,11],[5,15,11],[5,18,5]],'none',AMBER);
  } },
];

const ROAD_SHAPES: { role: IsometricRole; name: string; mask: number }[] = [
  {role:'road-straight',name:'straight',mask:5}, {role:'road-corner',name:'corner',mask:3},
  {role:'road-tee',name:'T junction',mask:7}, {role:'road-cross',name:'crossroads',mask:15}, {role:'road-end',name:'end',mask:1},
];
function car(m: Model, kind: number, u: number, v: number, rotation = 0) {
  const c=new Model(), long=kind===2?12:10, accent=kind===1?AMBER:kind===3?CYAN:PINK;
  c.box(-long,-3.5,long*2,7,1,3,accent,accent);
  const rear=kind===2?-8:-4, front=kind===0?3:5;
  c.face([[rear,-3,4],[front,-3,4],[front-2,-2.5,7],[rear+1,-2.5,7]],INK,[0,-1,1]);
  c.face([[rear,3,4],[front,3,4],[front-2,2.5,7],[rear+1,2.5,7]],INK,[0,1,1]);
  c.face([[front,-3,4],[front,3,4],[front-2,2.5,7],[front-2,-2.5,7]],CYAN,[1,0,1]);
  c.face([[rear,-3,4],[rear,3,4],[rear+1,2.5,7],[rear+1,-2.5,7]],CYAN,[-1,0,1]);
  c.face([[rear+1,-2.5,7],[front-2,-2.5,7],[front-2,2.5,7],[rear+1,2.5,7]],accent,[0,0,1]);
  for(const x of [-long+4,long-4]) for(const side of [-1,1]) {
    const s=c.face(Array.from({length:10},(_,i):V=>[x+1.7*Math.cos(i*Math.PI/5),side*3.7,1.8+1.7*Math.sin(i*Math.PI/5)]),INK,[0,side,0]);
    c.detail(s,[[x-1,side*3.7,1.8],[x+1,side*3.7,1.8]],'none',CYAN);
  }
  c.line([[long, -2.8,3],[long,2.8,3]],AMBER);
  c.line([[-long,-2.8,3],[-long,2.8,3]],PINK);
  if(kind===0) c.box(-9,-4,1,8,5,.6,PURPLE);
  if(kind===1) c.box(-1,-1.5,3,3,7,1,AMBER);
  if(kind===3) { c.box(-1,-2.5,3,2.5,7,1,CYAN); c.box(-1,0,3,2.5,7,1,PINK); }
  for(const s of c.surfaces) {
    if(s.normal) s.normal=turn(s.normal,rotation);
    for(const mark of s.marks) mark.vertices=mark.vertices.map(p=>{const q=turn(p,rotation);return [q[0]+u,q[1]+v,q[2]];});
    m.surfaces.push(s);
  }
}
function road(shape: typeof ROAD_SHAPES[number], boulevard: boolean, traffic = -1) {
  const m=new Model(); ground(m,true);
  const vertices: V[]=[];
  for(let side=0;side<4;side++) for(const [x,y] of shape.mask & (1<<side) ? [[11,-11],[25,-11],[25,11],[11,11]] : [[11,-11],[11,11]]) vertices.push(turn([x!,y!,0],side));
  const s=m.face(vertices,SHADE,[0,0,1],-90);
  for(let side=0;side<4;side++) {
    const p=(x:number,y:number):V=>turn([x,y,0],side);
    if(shape.mask & (1<<side)) {
      for(const y of [-10,10]) m.detail(s,[p(11,y),p(25,y)],'none',side%2?PINK:CYAN);
      for(const x of [15,22]) m.detail(s,[p(x,0),p(x+3,0)],'none',AMBER);
      if(boulevard) for(const y of [-7,-3,1,5]) m.detail(s,[p(12,y),p(15,y)],'none',CYAN);
    } else m.detail(s,[p(11,-11),p(11,11)],'none',PINK);
  }
  if(boulevard) { palm(m,-19,-19,13); palm(m,19,19,13); }
  if(traffic>=0) car(m,traffic,0,-5);
  const style=traffic>=0?['Wedge sports car','Autonomous taxi','Delivery van','Patrol cruiser'][traffic]:boulevard?'Palm boulevard':'Neon avenue';
  return m.asset(`road-${traffic>=0?`traffic-${traffic}`:boulevard?'palms':'neon'}-${shape.role.slice(5)}`,`Road · ${style} · ${shape.name}`,0,shape.role,undefined,{treeLined:boulevard});
}
function plaza(kind: number) {
  const m=new Model(); ground(m,true);
  if(kind===0) {
    for(const u of [-16,14]) for(const v of [-15,15]) palm(m,u,v,17);
    m.box(-8,-5,16,10,0,1,PURPLE,CYAN);
  } else if(kind===1) {
    m.box(-12,-12,24,24,0,2,PURPLE,INK);
    for(const r of [4,8,11]) m.line([[-r,-r,2],[r,-r,2],[r,r,2],[-r,r,2],[-r,-r,2]],r===8?PINK:CYAN);
    for(const side of [-1,1]) m.line([[side*7,0,2],[0,0,20],[0,side*7,2]],CYAN);
  } else {
    for(const x of [-17,17]) m.box(x,-4,2,16,0,3,PURPLE);
    m.box(-10,-14,20,3,0,3,SHADE); sunset(m,0,-12,15,10);
    palm(m,-17,15,14);
  }
  return m.asset(`plaza-${kind}`,`Plaza · ${['Neon palm garden','Hologram court','Sunset square'][kind]}`,0,'terrain','park');
}

function water(m: Model) {
  const s=m.face([[-25,-25,0],[25,-25,0],[25,25,0],[-25,25,0]],INK,[0,0,1],-100);
  for(const [u,v] of [[-20,-18],[3,-17],[-11,-5],[12,9],[-20,14],[-6,21]]) {
    m.detail(s,[[u!,v!,0],[u!+4,v!-1,0],[u!+9,v!,0]],'none',CYAN);
    m.detail(s,[[u!+1,v!+2,0],[u!+6,v!+2,0]],'none',PINK);
  }
}
function shore(mask: number, dock = false) {
  const m=new Model(); water(m);
  for(let side=0;side<4;side++) if(mask & (1<<side)) {
    const p=(u:number,v:number):V=>turn([u,v,.5],side);
    const s=m.face([p(10,-25),p(25,-25),p(25,25),p(10,25)],PAPER,[0,0,1],-80);
    m.detail(s,[p(11,-25),p(11,25)],'none',PINK);
    for(let v=-20;v<=20;v+=10) m.detail(s,[p(12,v),p(25,v)],'none',PURPLE);
  }
  if(dock) {
    m.box(-18,-4,30,8,0,2,PURPLE,INK);
    for(const v of [-3,3]) m.line([[-18,v,2],[12,v,2]],CYAN);
    for(const u of [-15,5]) m.box(u,-4,1,1,0,5,PINK);
  }
  return m;
}
function boat(kind: number) {
  const m=new Model(); water(m);
  const long=kind===3?22:20, beam=kind===3?8:6, accent=kind===1?AMBER:kind===2?PURPLE:PINK;
  const outline: V[]=[[-long,0,2],[-long+4,-beam,2],[long-6,-beam,2],[long,0,3],[long-6,beam,2],[-long+4,beam,2]];
  m.face(outline,INK,[0,0,1]);
  for(let i=0;i<outline.length;i++) {
    const a=outline[i]!,b=outline[(i+1)%outline.length]!;
    const s=m.face([a,b,[b[0]*.85,b[1]*.8,-1],[a[0]*.85,a[1]*.8,-1]],accent,[(a[0]+b[0])/2,(a[1]+b[1])/2,0]);
    m.detail(s,[a,b],'none',CYAN);
  }
  if(kind===3) {
    for(const x of [-12,-1,10]) {
      const walls=m.box(x-4,-5,8,10,2,5,x===-1?CYAN:PURPLE);
      for(const dx of [-2,0,2]) m.detail(walls[2]!,[[x+dx,5,3],[x+dx,5,6]],'none',INK);
    }
    block(m,-19,-4,6,8,2,8,AMBER,false);
  } else {
    block(m,-11,-4,kind===0?13:20,8,2,kind===0?4:7,CYAN,kind!==0);
    m.face([[-1,-4,7],[8,-4,3],[8,4,3],[-1,4,7]],CYAN,[1,0,1]);
    for(const y of [-4,4]) m.line([[8,y,3],[16,y*.5,3]],PINK);
    if(kind===1) m.box(-4,-2,5,4,9,1,AMBER);
    if(kind===2) { antenna(m,-6,0,9,8); m.box(-15,-2,3,4,2,10,PURPLE); }
  }
  return m;
}

const VIEWS=['front-right','rear-right','rear-left','front-left'];
export const CYBERPUNK_CATEGORIES: GlyphCategory[]=[{id:CYBERPUNK_CATEGORY,name:'Retrowave / Cyberpunk city',kind:'isometric'}];
export const CYBERPUNK_ASSETS: GlyphAsset[]=[
  ...BUILDINGS.flatMap(design=>{
    const m=new Model(); ground(m); design.draw(m);
    return VIEWS.map((view,rotation)=>m.asset(`${design.id}-view-${rotation}`,`${design.name} · ${view}`,rotation));
  }),
  ...[false,true].flatMap(boulevard=>ROAD_SHAPES.map(shape=>road(shape,boulevard))),
  ...[0,1,2,3].map(traffic=>road(ROAD_SHAPES[0]!,false,traffic)),
  ...[1,3].map(traffic=>road(ROAD_SHAPES[3]!,false,traffic)),
  ...[0,1,2].map(plaza),
  (()=>{const m=new Model();water(m);return m.asset('water','Water · Neon reflections',0,'terrain','water');})(),
  ...[{mask:1,name:'Neon quay'},{mask:3,name:'Quay corner'},{mask:5,name:'Canal'},{mask:7,name:'Harbour basin'},{mask:15,name:'Marina pool'}].map(s=>shore(s.mask).asset(`shore-${s.mask}`,`Waterfront · ${s.name}`,0,'terrain','shore',{shoreMask:s.mask})),
  shore(1,true).asset('dock','Waterfront · Neon jetty',0,'terrain','shore',{shoreMask:1}),
  ...['Razor speedboat','Water taxi','Utility tug','Container barge'].flatMap((name,i)=>VIEWS.map((view,rotation)=>boat(i).asset(`boat-${i}-view-${rotation}`,`Boat · ${name} · ${view}`,rotation,'terrain','feature'))),
];

