/** Exact hidden-line removal for convex, planar maze faces. Depth increases toward the camera. */
export interface MazeVertex { x: number; y: number; z: number }
export interface MazeStroke { a: MazeVertex; b: MazeVertex; channel: string }
export const mixMazeVertex = (a: MazeVertex, b: MazeVertex, t: number): MazeVertex => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
});
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const EPS = 1e-7;

export function visibleMazeStrokes(faces: MazeVertex[][], strokes: MazeStroke[]): MazeStroke[] {
  const polygons = faces.flatMap(points => {
    const a = points[0]!, b = points[1]!, c = points[2]!;
    const determinant = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
    if (Math.abs(determinant) < EPS) return [];
    const dx = ((b.z - a.z) * (c.y - a.y) - (c.z - a.z) * (b.y - a.y)) / determinant;
    const dy = ((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / determinant;
    return [{ points, sign: Math.sign(determinant), dx, dy, intercept: a.z - dx * a.x - dy * a.y,
      minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
      minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) }];
  });
  if (!polygons.length) return strokes;
  // A spatial index keeps large cities from comparing every edge with every face.
  const minX = polygons.reduce((v, p) => Math.min(v, p.minX), Infinity), maxX = polygons.reduce((v, p) => Math.max(v, p.maxX), -Infinity);
  const minY = polygons.reduce((v, p) => Math.min(v, p.minY), Infinity), maxY = polygons.reduce((v, p) => Math.max(v, p.maxY), -Infinity);
  const size = Math.max(maxX - minX, maxY - minY, 1) / 40;
  const bucket = (v: number, origin: number) => Math.floor((v - origin) / size);
  const grid = new Map<string, number[]>();
  polygons.forEach((p, index) => {
    for (let y = bucket(p.minY, minY); y <= bucket(p.maxY, minY); y++) {
      for (let x = bucket(p.minX, minX); x <= bucket(p.maxX, minX); x++) {
        const key = `${x},${y}`, list = grid.get(key) ?? [];
        list.push(index); grid.set(key, list);
      }
    }
  });
  const output: MazeStroke[] = [];
  for (const stroke of strokes) {
    const { a, b } = stroke;
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
    const candidates = new Set<number>();
    for (let y = bucket(top, minY); y <= bucket(bottom, minY); y++) {
      for (let x = bucket(left, minX); x <= bucket(right, minX); x++) {
        for (const index of grid.get(`${x},${y}`) ?? []) candidates.add(index);
      }
    }
    const hidden: [number, number][] = [];
    for (const index of candidates) {
      const face = polygons[index]!;
      if (face.maxX < left - EPS || face.minX > right + EPS || face.maxY < top - EPS || face.minY > bottom + EPS) continue;
      let lo = 0, hi = 1;
      // Clip the segment against the projected polygon, then against its depth plane.
      const clipPositive = (start: number, end: number) => {
        if (start < 0 && end < 0) { hi = -1; return; }
        if (start < 0) lo = Math.max(lo, start / (start - end));
        else if (end < 0) hi = Math.min(hi, start / (start - end));
      };
      const depthAt = (p: MazeVertex) => face.dx * p.x + face.dy * p.y + face.intercept - p.z - EPS;
      clipPositive(depthAt(a), depthAt(b));
      if (lo >= hi) continue;
      for (let i = 0; i < face.points.length && lo < hi; i++) {
        const p = face.points[i]!, q = face.points[(i + 1) % face.points.length]!;
        const side = (v: MazeVertex) => face.sign * cross(q.x - p.x, q.y - p.y, v.x - p.x, v.y - p.y) + EPS;
        clipPositive(side(a), side(b));
      }
      if (lo < hi) hidden.push([lo, hi]);
    }
    hidden.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const emit = (from: number, to: number) => {
      if (to - from > EPS) output.push({ ...stroke, a: mixMazeVertex(a, b, from), b: mixMazeVertex(a, b, to) });
    };
    for (const [lo, hi] of hidden) { if (lo > cursor) emit(cursor, lo); cursor = Math.max(cursor, hi); }
    if (cursor < 1) emit(cursor, 1);
  }
  return output;
}
