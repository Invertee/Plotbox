import { DEFAULT_RELIEF, type CanvasSettings, type PlotGeometry, type PlotLayer, type PlotPath, type ReliefSettings, type TerrainData } from '@plotter/core';

import { simplifyPoints } from '@plotter/geometry';

type Vertex = { x: number; y: number; z: number; u: number; v: number };
const mix = (a: Vertex, b: Vertex, t: number): Vertex => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Orthographic terrain with a surface depth buffer shared by every pen pass. */
export function generateRelief(canvas: CanvasSettings, data: TerrainData, options: Partial<ReliefSettings>, layers: PlotLayer[]): PlotGeometry {
  const s = { ...DEFAULT_RELIEF, ...options };
  const inShape = (u: number, v: number) => s.shape !== 'circle' || (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.250001;
  const { width: w, height: h, elevations: heights, bounds } = data;
  if (w < 2 || h < 2 || w > 1024 || h > 1024 || heights.length !== w * h || !heights.every(Number.isFinite)
    || !(bounds.east > bounds.west && bounds.north > bounds.south)) throw new Error('Download a valid terrain region first.');
  const numeric = ['rotation', 'tilt', 'exaggeration', 'contourInterval', 'spacing', 'baseDepth', 'maxBaseDepth'] as const;
  for (const key of numeric) if (!Number.isFinite(s[key])) s[key] = DEFAULT_RELIEF[key];
  const interval = clamp(s.contourInterval, 5, 200), spacing = clamp(s.spacing, 0.25, 5);
  const selectedHeights = heights.filter((_, i) => inShape((i % w) / (w - 1), Math.floor(i / w) / (h - 1)));
  if (!selectedHeights.length) selectedHeights.push(...heights);
  const low = selectedHeights.reduce((a, b) => Math.min(a, b), Infinity), high = selectedHeights.reduce((a, b) => Math.max(a, b), -Infinity);
  const metresX = (bounds.east - bounds.west) * 111320 * Math.cos((bounds.north + bounds.south) * Math.PI / 360);
  const metresY = (bounds.north - bounds.south) * 111320;
  const unit = Math.max(metresX, metresY), extentX = metresX / unit, extentY = metresY / unit;
  const yaw = s.rotation * Math.PI / 180, tilt = clamp(s.tilt, 15, 75) * Math.PI / 180;
  const exaggeration = clamp(s.exaggeration, 0, 20);
  const raw = (x: number, y: number, elevation: number): Vertex => {
    const a = (x - 0.5) * extentX, b = (y - 0.5) * extentY;
    const u = a * Math.cos(yaw) - b * Math.sin(yaw), v = a * Math.sin(yaw) + b * Math.cos(yaw);
    const z = (elevation - low) / unit * exaggeration;
    return { x: u, y: v * Math.sin(tilt) - z * Math.cos(tilt), z: v * Math.cos(tilt) + z * Math.sin(tilt), u: x, v: y };
  };
  const vertices = heights.map((z, i) => raw((i % w) / (w - 1), Math.floor(i / w) / (h - 1), z));
  const footprint = s.shape === 'circle'
    ? Array.from({ length: 256 }, (_, i) => raw(.5 + .5 * Math.cos(i / 256 * Math.PI * 2), .5 + .5 * Math.sin(i / 256 * Math.PI * 2), low))
    : [raw(0, 0, low), raw(1, 0, low), raw(1, 1, low), raw(0, 1, low)];
  const fittedVertices = [...vertices.filter(p => inShape(p.u, p.v)), ...footprint];
  const minX = fittedVertices.reduce((a, p) => Math.min(a, p.x), Infinity), maxX = fittedVertices.reduce((a, p) => Math.max(a, p.x), -Infinity);
  const minY = fittedVertices.reduce((a, p) => Math.min(a, p.y), Infinity), maxY = fittedVertices.reduce((a, p) => Math.max(a, p.y), -Infinity);
  const availableX = Math.max(1, canvas.widthMm - 2 * canvas.marginMm), availableY = Math.max(1, canvas.heightMm - 2 * canvas.marginMm);
  const base = clamp(s.baseDepth, 0, Math.min(15, availableY / 4));
  const scale = Math.min(availableX / (maxX - minX), (availableY - base) / (maxY - minY));
  const ox = (canvas.widthMm - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (canvas.heightMm - (maxY - minY) * scale - base) / 2 - minY * scale;
  const page = (p: Vertex): Vertex => ({ ...p, x: p.x * scale + ox, y: p.y * scale + oy, z: p.z * scale });
  const mesh = vertices.map(page);
  const project = (x: number, y: number, z: number) => page(raw(x, y, z));
  // A bounded screen-space depth buffer hides far slopes, including shading strokes.
  const resolution = Math.min(8, 1600 / Math.max(canvas.widthMm, canvas.heightMm));
  const bw = Math.ceil(canvas.widthMm * resolution) + 1, bh = Math.ceil(canvas.heightMm * resolution) + 1;
  const depth = new Float32Array(bw * bh).fill(-Infinity);
  const triangles: [number, number, number][] = [];
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    triangles.push([i, i + 1, i + w], [i + 1, i + w + 1, i + w]);
  }
  for (const ids of triangles) {
    const [a, b, c] = ids.map(i => mesh[i]!) as [Vertex, Vertex, Vertex];
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-10) continue;
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y) * resolution)); y <= Math.min(bh - 1, Math.ceil(Math.max(a.y, b.y, c.y) * resolution)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) * resolution)); x <= Math.min(bw - 1, Math.ceil(Math.max(a.x, b.x, c.x) * resolution)); x++) {
        const u = ((b.y - c.y) * (x / resolution - c.x) + (c.x - b.x) * (y / resolution - c.y)) / den;
        const v = ((c.y - a.y) * (x / resolution - c.x) + (a.x - c.x) * (y / resolution - c.y)) / den;
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1.000001 && inShape(u * a.u + v * b.u + (1 - u - v) * c.u, u * a.v + v * b.v + (1 - u - v) * c.v)) depth[y * bw + x] = Math.max(depth[y * bw + x]!, u * a.z + v * b.z + (1 - u - v) * c.z);
      }
    }
  }
  const paths: PlotPath[] = [];
  const visible = (p: Vertex) => {
    const x = clamp(Math.round(p.x * resolution), 0, bw - 1), y = clamp(Math.round(p.y * resolution), 0, bh - 1);
    // A small neighbourhood avoids self-occlusion from depth quantisation on steep faces.
    let nearest = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < bw && y + dy >= 0 && y + dy < bh) nearest = Math.min(nearest, depth[(y + dy) * bw + x + dx]!);
    return p.z >= nearest - 0.06;
  };
  const emit = (points: Vertex[], index: number, hide = true) => {
    const layer = layers.find(l => l.id === `relief-${index}`);
    if (!layer?.visible || !layer.passId) return;
    let current: Vertex[] = [];
    const flush = () => {
      if (current.length > 1) paths.push({ id: `relief-path-${paths.length}`, layerId: layer.id, passId: layer.passId, points: simplifyPoints(current.map(p => ({ x: p.x, y: p.y })), 0.025), preserveGaps: true });
      current = [];
    };
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!, b = points[i + 1]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * resolution * 2));
      for (let j = i ? 1 : 0; j <= steps; j++) {
        const t = j / steps, p = mix(a, b, t);
        if (inShape(p.u, p.v) && (!hide || visible(p))) current.push(p); else flush();
      }
    }
    flush();
  };
  const sample = (x: number, y: number) => {
    const gx = clamp(x, 0, 1) * (w - 1), gy = clamp(y, 0, 1) * (h - 1);
    const ix = Math.min(w - 2, Math.floor(gx)), iy = Math.min(h - 2, Math.floor(gy));
    const fx = gx - ix, fy = gy - iy, i = iy * w + ix;
    // Match the triangle split used by the depth buffer exactly.
    return fx + fy <= 1 ? heights[i]! * (1 - fx - fy) + heights[i + 1]! * fx + heights[i + w]! * fy
      : heights[i + w + 1]! * (fx + fy - 1) + heights[i + 1]! * (1 - fy) + heights[i + w]! * (1 - fx);
  };
  const water = (data.water ?? []).map(path => {
    const points = path.points.map(([lon, lat]) => ({ x: (lon - bounds.west) / (bounds.east - bounds.west), y: (bounds.north - lat) / (bounds.north - bounds.south) }));
    return { ...path, points, minX: points.reduce((v, p) => Math.min(v, p.x), Infinity), maxX: points.reduce((v, p) => Math.max(v, p.x), -Infinity), minY: points.reduce((v, p) => Math.min(v, p.y), Infinity), maxY: points.reduce((v, p) => Math.max(v, p.y), -Infinity) };
  });
  const isWater = (x: number, y: number) => water.some(poly => {
    if (!s.water || !poly.closed || x < poly.minX || x > poly.maxX || y < poly.minY || y > poly.maxY) return false;
    let inside = false;
    for (let i = 0, j = poly.points.length - 1; i < poly.points.length; j = i++) {
      const a = poly.points[i]!, b = poly.points[j]!;
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  });
  // Surface-following hatches; mutually exclusive elevation inks leave water clear.
  const rows = Math.min(1800, Math.ceil(extentY * scale / spacing)), columns = Math.min(1800, Math.max(w * 2, Math.ceil(extentX * scale / 0.3)));
  for (let row = 0; row <= rows; row++) {
    const y = row / rows;
    let ink = -1, run: Vertex[] = [], shadow: Vertex[] = [];
    for (let col = 0; col <= columns; col++) {
      const x = col / columns, elevation = sample(x, y), wet = isWater(x, y);
      const next = wet ? 4 : s.bands ? Math.min(2, Math.floor((elevation - low) / Math.max(1, high - low) * 3)) : -1;
      const p = project(x, y, elevation);
      if (next !== ink) { emit(run, ink); run = []; ink = next; }
      if (ink >= 0) run.push(p);
      const slope = (sample(Math.min(1, x + 1 / (w - 1)), y) - sample(Math.max(0, x - 1 / (w - 1)), y)) / (metresX * 2 / (w - 1));
      if (s.shading && !wet && slope > 0.12 && (slope > 0.5 || row % 2 === 0)) shadow.push(p);
      else { emit(shadow, 3); shadow = []; }
    }
    emit(run, ink); emit(shadow, 3);
  }
  // Contours intersect the same terrain triangles, preserving their real elevations.
  const segments = new Map<number, [Vertex, Vertex][]>();
  for (const ids of triangles) {
    const elevations = ids.map(i => heights[i]!);
    for (let level = Math.ceil(Math.min(...elevations) / interval) * interval; level < Math.max(...elevations); level += interval) {
      const crossings: Vertex[] = [];
      for (let edge = 0; edge < 3; edge++) {
        const ia = ids[edge]!, ib = ids[(edge + 1) % 3]!, za = heights[ia]!, zb = heights[ib]!;
        if ((za >= level) === (zb >= level)) continue;
        const t = (level - za) / (zb - za), a = mesh[ia]!, b = mesh[ib]!;
        crossings.push(mix(a, b, t));
      }
      if (crossings.length === 2) { const list = segments.get(level) ?? []; list.push([crossings[0]!, crossings[1]!]); segments.set(level, list); }
    }
  }
  // Join before visibility clipping to avoid a pen lift at every mesh edge.
  for (const list of segments.values()) {
    const key = (p: Vertex) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
    const ends = new Map<string, number[]>();
    list.forEach((pair, i) => pair.forEach(p => { const k = key(p); const entry = ends.get(k) ?? []; entry.push(i); ends.set(k, entry); }));
    const used = new Set<number>();
    const walk = (i: number, start: Vertex) => {
      const line = [start];
      while (!used.has(i)) {
        used.add(i);
        const pair = list[i]!, next = key(pair[0]) === key(line[line.length - 1]!) ? pair[1] : pair[0];
        line.push(next);
        const candidate = ends.get(key(next))?.find(j => !used.has(j));
        if (candidate === undefined) break;
        i = candidate;
      }
      emit(line, 5);
    };
    list.forEach((pair, i) => { const end = pair.find(p => ends.get(key(p))!.length === 1); if (end && !used.has(i)) walk(i, end); });
    list.forEach((pair, i) => { if (!used.has(i)) walk(i, pair[0]); });
  }
  for (const path of water) {
    if (!s.water) break;
    let run: Vertex[] = [];
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i]!, b = path.points[i + 1]!;
      const count = Math.min(5000, Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * Math.max(w, h) * 2)));
      for (let j = 0; j <= count; j++) {
        const t = j / count, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        if (x < 0 || x > 1 || y < 0 || y > 1) { emit(run, 4); run = []; } else run.push(project(x, y, sample(x, y)));
      }
    }
    emit(run, 4);
  }
  const edges = [Array.from({ length: w }, (_, x) => x), Array.from({ length: h }, (_, y) => y * w + w - 1), Array.from({ length: w }, (_, x) => (h - 1) * w + w - 1 - x), Array.from({ length: h }, (_, y) => (h - 1 - y) * w)];
  const rims = s.shape === 'circle' ? Array.from({ length: 256 }, (_, i) => {
    return [i, i + 1].map(j => { const angle = j / 256 * Math.PI * 2, x = 0.5 + 0.5 * Math.cos(angle), y = 0.5 + 0.5 * Math.sin(angle); return project(x, y, sample(x, y)); });
  }) : edges.map(edge => edge.map(i => mesh[i]!));
  for (const points of rims) emit(points, 5);
  if (base) {
    // Cut walls descend to one flat datum, rather than following the terrain rim.
    const bottomLevel = -base / Math.cos(tilt);
    const topLevel = Math.max(0, (high - low) / unit * exaggeration * scale);
    const maximumWallHeight = s.clipBaseDepth ? clamp(s.maxBaseDepth, 1, 50) / Math.cos(tilt) : Infinity;
    const wallPoint = (p: Vertex, level: number) => {
      const datum = project(p.u, p.v, low);
      return { ...datum, y: datum.y - level * Math.cos(tilt), z: datum.z + level * Math.sin(tilt) };
    };
    for (let level = bottomLevel; level <= topLevel; level += 0.5 / Math.cos(tilt)) {
      let run: Vertex[] = [];
      for (const rim of rims) for (let i = 1; i < rim.length; i++) {
        const a = rim[i - 1]!, b = rim[i]!;
        if (b.x >= a.x) { emit(run, 5); run = []; continue; }
        const za = (sample(a.u, a.v) - low) / unit * exaggeration * scale;
        const zb = (sample(b.u, b.v) - low) / unit * exaggeration * scale;
        const dz = zb - za, upperLevel = level + maximumWallHeight;
        let startT = 0, endT = 1;
        if (Math.abs(dz) < 1e-9) {
          if (za < level || za > upperLevel) { emit(run, 5); run = []; continue; }
        } else {
          const first = (level - za) / dz, second = (upperLevel - za) / dz;
          startT = Math.max(0, Math.min(first, second));
          endT = Math.min(1, Math.max(first, second));
          if (startT > endT) { emit(run, 5); run = []; continue; }
        }
        const start = startT ? mix(a, b, startT) : a;
        const end = endT < 1 ? mix(a, b, endT) : b;
        const p = wallPoint(start, level), q = wallPoint(end, level);
        if (run.length && Math.hypot(run[run.length - 1]!.x - p.x, run[run.length - 1]!.y - p.y) > 1e-5) { emit(run, 5); run = []; }
        if (!run.length) run.push(p);
        run.push(q);
        if (endT < 1) { emit(run, 5); run = []; }
      }
      emit(run, 5);
    }
    if (s.clipBaseDepth) {
      // The clipped lower silhouette follows the terrain edge at a constant
      // paper-space depth, so steep sections cannot create an oversized base.
      for (const rim of rims) {
        let run: Vertex[] = [];
        for (let i = 1; i < rim.length; i++) {
          const a = rim[i - 1]!, b = rim[i]!;
          if (b.x >= a.x) { emit(run, 5); run = []; continue; }
          const clipped = [a, b].map(point => {
            const surfaceLevel = (sample(point.u, point.v) - low) / unit * exaggeration * scale;
            return wallPoint(point, Math.max(bottomLevel, surfaceLevel - maximumWallHeight));
          });
          if (!run.length) run.push(clipped[0]!);
          run.push(clipped[1]!);
        }
        emit(run, 5);
      }
    }
    // Corner/silhouette edges close the sides without vertical stripes on a round rim.
    for (const rim of rims) {
      const a = rim[0]!, b = rim[rim.length - 1]!;
      if (b.x < a.x && s.shape !== 'circle') {
        const clippedBottom = (point: Vertex) => {
          if (!s.clipBaseDepth) return bottomLevel;
          const surfaceLevel = (sample(point.u, point.v) - low) / unit * exaggeration * scale;
          return Math.max(bottomLevel, surfaceLevel - maximumWallHeight);
        };
        emit([a, wallPoint(a, clippedBottom(a))], 5); emit([b, wallPoint(b, clippedBottom(b))], 5);
      }
    }
  }
  return { paths, generator: 'topography.relief', generatedAt: new Date().toISOString() };
}
