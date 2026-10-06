import type { Point, SourcePath } from '@plotter/core';

/** Clip both closed fill regions and open strokes to a circular map footprint. */
export function cropMapCircle(paths: SourcePath[], centre: Point, radius: number): SourcePath[] {
  if (!(radius > 0)) return [];
  const result: SourcePath[] = [];
  for (const path of paths) {
    if (path.closed) {
      // An inscribed convex polygon preserves closed regions for hatch treatments.
      let points = path.points;
      for (let side = 0; side < 128 && points.length; side++) {
        const angle = (side + 0.5) * 2 * Math.PI / 128;
        const nx = Math.cos(angle), ny = Math.sin(angle), limit = radius * Math.cos(Math.PI / 128);
        const distance = (p: Point) => (p.x - centre.x) * nx + (p.y - centre.y) * ny - limit;
        const output: Point[] = [];
        let a = points[points.length - 1]!, da = distance(a);
        for (const b of points) {
          const db = distance(b);
          if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
          if (db <= 0) output.push(b);
          a = b; da = db;
        }
        points = output;
      }
      if (points.length >= 3) result.push({ ...path, points });
      continue;
    }
    let run: Point[] = [];
    const flush = () => { if (run.length > 1) result.push({ ...path, id: `${path.id}-circle-${result.length}`, points: run }); run = []; };
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1]!, b = path.points[i]!;
      const dx = b.x - a.x, dy = b.y - a.y, ax = a.x - centre.x, ay = a.y - centre.y;
      const aa = dx * dx + dy * dy;
      if (aa < 1e-16) continue;
      const bb = 2 * (ax * dx + ay * dy), cc = ax * ax + ay * ay - radius * radius;
      const disc = bb * bb - 4 * aa * cc;
      if (disc <= 0) { flush(); continue; }
      const t0 = Math.max(0, (-bb - Math.sqrt(disc)) / (2 * aa)), t1 = Math.min(1, (-bb + Math.sqrt(disc)) / (2 * aa));
      if (t0 >= t1) { flush(); continue; }
      const start = { x: a.x + t0 * dx, y: a.y + t0 * dy }, end = { x: a.x + t1 * dx, y: a.y + t1 * dy };
      if (run.length && Math.hypot(run[run.length - 1]!.x - start.x, run[run.length - 1]!.y - start.y) > 1e-6) flush();
      if (!run.length) run.push(start);
      run.push(end);
      if (t1 < 1) flush();
    }
    flush();
  }
  return result;
}
