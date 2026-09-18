import type { CanvasSettings, ColourSeparationResult, ColourSeparationSettings, ColourTreatment, PenProfile, PlotGeometry, PlotPass, Point, RasterPlacementSettings } from '@plotter/core';
import { calculateImagePlacement, drawableBounds, type Bounds } from '@plotter/geometry';

export const DEFAULT_COLOUR_TREATMENT: ColourTreatment = { enabled: true, fill: 'hatch', spacing: 1.2, angle: 45, outline: false };
type ImagePixels = { width: number; height: number; data: Uint8ClampedArray };
type Triple = [number, number, number];
type Edge = [Point, Point];
export const colourPassId = (id: string) => `colour-pass-${id}`;
const distance = (a: Triple, b: Triple) => a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0);
const bounded = (v: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;

// CIELAB keeps perceptually similar highlights/shadows together more naturally than RGB.
function lab(rgb: Triple): Triple {
  const [r, g, b] = rgb.map(v => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }) as Triple;
  const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : v * 841 / 108 + 4 / 29;
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = f(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = f((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function separateColours(image: ImagePixels, settings: Record<string, number | string | boolean>) {
  const { width, height, data } = image;
  if (width < 1 || height < 1 || data.length !== width * height * 4) throw new Error('Invalid colour image.');
  const count = Math.round(bounded(settings.colourCount, 8, 2, 16));
  const paperCutoff = bounded(settings.paperCutoff, 90, 70, 100);
  const labels = new Int32Array(width * height).fill(-1);
  const keys = new Int32Array(labels.length).fill(-1);
  const histogram = new Map<number, { rgb: Triple; count: number; lab: Triple; cluster: number }>();
  for (let i = 0; i < labels.length; i++) {
    const alpha = data[i * 4 + 3]! / 255;
    if (alpha < 0.1) continue;
    const rgb = [0, 1, 2].map(c => data[i * 4 + c]! * alpha + 255 * (1 - alpha)) as Triple;
    // Only neutral, pale pixels are paper: pale yellow and skin remain eligible.
    if (settings.skipPaper !== false && Math.min(...rgb) >= paperCutoff * 2.55 && Math.max(...rgb) - Math.min(...rgb) < 20) continue;
    const key = (Math.floor(rgb[0] / 8) << 10) | (Math.floor(rgb[1] / 8) << 5) | Math.floor(rgb[2] / 8);
    keys[i] = key;
    const bin = histogram.get(key);
    if (bin) { bin.count++; for (let c = 0; c < 3; c++) bin.rgb[c] = bin.rgb[c]! + rgb[c]!; }
    else histogram.set(key, { rgb, count: 1, lab: [0, 0, 0], cluster: 0 });
  }
  const bins = [...histogram.values()];
  for (const bin of bins) { bin.rgb = bin.rgb.map(v => v / bin.count) as Triple; bin.lab = lab(bin.rgb); }
  bins.sort((a, b) => b.count - a.count);
  const centres: Triple[] = bins.length ? [[...bins[0]!.lab]] : [];
  while (centres.length < Math.min(count, bins.length)) {
    let best = bins[0]!; let score = -1;
    for (const bin of bins) {
      const candidate = Math.min(...centres.map(c => distance(bin.lab, c))) * Math.sqrt(bin.count);
      if (candidate > score) { score = candidate; best = bin; }
    }
    if (score <= 0) break;
    centres.push([...best.lab]);
  }
  for (let iteration = 0; iteration < 18; iteration++) {
    const sums = centres.map(() => ({ lab: [0, 0, 0] as Triple, count: 0 }));
    let changed = false;
    for (const bin of bins) {
      let nearest = 0; let best = Infinity;
      centres.forEach((centre, i) => { const d = distance(bin.lab, centre); if (d < best) { best = d; nearest = i; } });
      changed ||= bin.cluster !== nearest;
      bin.cluster = nearest;
      const sum = sums[nearest]!;
      sum.count += bin.count;
      for (let c = 0; c < 3; c++) sum.lab[c] = sum.lab[c]! + bin.lab[c]! * bin.count;
    }
    sums.forEach((sum, i) => { if (sum.count) centres[i] = sum.lab.map(v => v / sum.count) as Triple; });
    if (!changed && iteration > 0) break;
  }
  const totals = centres.map((_, index) => ({ index, rgb: [0, 0, 0] as Triple, count: 0 }));
  for (const bin of bins) { const sum = totals[bin.cluster]!; sum.count += bin.count; for (let c = 0; c < 3; c++) sum.rgb[c] = sum.rgb[c]! + bin.rgb[c]! * bin.count; }
  const sorted = totals.filter(t => t.count).sort((a, b) => centres[b.index]![0] - centres[a.index]![0]);
  const remap = new Map(sorted.map((t, i) => [t.index, i]));
  const palette: ColourSeparationResult['palette'] = sorted.map((t, i) => ({ id: String(i), colour: '#' + t.rgb.map(v => Math.round(v / t.count).toString(16).padStart(2, '0')).join(''), pixels: 0 }));
  for (let i = 0; i < labels.length; i++) if (keys[i]! >= 0) labels[i] = remap.get(histogram.get(keys[i]!)!.cluster)!;

  // Conservative majority cleanup removes isolated anti-alias speckles without filling holes.
  if (settings.cleanEdges !== false) {
    const original = labels.slice();
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (original[i]! < 0) continue;
      const votes = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = original[i + dy * width + dx]!; if (v >= 0) votes.set(v, (votes.get(v) ?? 0) + 1); }
      for (const [v, n] of votes) if (n >= 6) labels[i] = v;
    }
  }
  const regionLabels = new Int32Array(labels.length).fill(-1);
  const queue = new Int32Array(labels.length);
  const regions: ColourSeparationResult['regions'] = [];
  const minPixels = Math.round(bounded(settings.minRegionPixels, 12, 1, 10000));
  for (let start = 0; start < labels.length; start++) {
    if (labels[start]! < 0 || regionLabels[start] !== -1) continue;
    const colour = labels[start]!;
    let head = 0; let tail = 1; let sx = 0; let sy = 0;
    queue[0] = start; regionLabels[start] = -2;
    while (head < tail) {
      const pixel = queue[head++]!; const x = pixel % width; const y = Math.floor(pixel / width);
      sx += x + 0.5; sy += y + 0.5;
      const visit = (next: number) => { if (labels[next] === colour && regionLabels[next] === -1) { regionLabels[next] = -2; queue[tail++] = next; } };
      if (x > 0) visit(pixel - 1); if (x + 1 < width) visit(pixel + 1); if (y > 0) visit(pixel - width); if (y + 1 < height) visit(pixel + width);
    }
    if (tail < minPixels) continue;
    const index = regions.length;
    regions.push({ id: `region-${colour}-${start}`, colourId: String(colour), pixels: tail, x: sx / tail / width, y: sy / tail / height });
    palette[colour]!.pixels += tail;
    for (let i = 0; i < tail; i++) regionLabels[queue[i]!] = index;
  }
  return { palette, regions, regionLabels, width, height };
}

// Clip segments, never clamp vertices: off-page outlines must not become margin lines.
function clip(a: Point, b: Point, bounds: Bounds): Edge | undefined {
  let lo = 0; let hi = 1;
  const dx = b.x - a.x; const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - bounds.minX], [dx, bounds.maxX - a.x], [-dy, a.y - bounds.minY], [dy, bounds.maxY - a.y]] as [number, number][]) {
    if (p === 0) { if (q < 0) return; continue; }
    const t = q / p; if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo >= hi) return;
  }
  return [{ x: a.x + lo * dx, y: a.y + lo * dy }, { x: a.x + hi * dx, y: a.y + hi * dy }];
}

export function generateColourSeparation(image: ImagePixels, canvas: CanvasSettings, placementSettings: RasterPlacementSettings, settings: Record<string, number | string | boolean>, treatments: ColourSeparationSettings | undefined, passes: PlotPass[], pens: PenProfile[]): PlotGeometry {
  const separated = separateColours(image, settings);
  const { width, height, regionLabels, palette, regions } = separated;
  const bounds = drawableBounds(canvas.widthMm, canvas.heightMm, canvas.marginMm);
  const placement = calculateImagePlacement(width, height, bounds, placementSettings);
  const edges: Edge[][] = regions.map(() => []);
  const point = (x: number, y: number): Point => ({ x: placement.x + x / width * placement.width, y: placement.y + y / height * placement.height });
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height ? -1 : regionLabels[y * width + x]!;
  // Merge collinear pixel boundaries. Each region owns both outer and hole edges.
  for (let y = 0; y <= height; y++) {
    let x = 0;
    while (x < width) {
      const above = at(x, y - 1); const below = at(x, y); const start = x++;
      while (x < width && at(x, y - 1) === above && at(x, y) === below) x++;
      if (above === below) continue;
      const edge: Edge = [point(start, y), point(x, y)];
      if (above >= 0) edges[above]!.push(edge); if (below >= 0) edges[below]!.push(edge);
    }
  }
  for (let x = 0; x <= width; x++) {
    let y = 0;
    while (y < height) {
      const left = at(x - 1, y); const right = at(x, y); const start = y++;
      while (y < height && at(x - 1, y) === left && at(x, y) === right) y++;
      if (left === right) continue;
      const edge: Edge = [point(x, start), point(x, y)];
      if (left >= 0) edges[left]!.push(edge); if (right >= 0) edges[right]!.push(edge);
    }
  }
  const paths: PlotGeometry['paths'] = [];
  regions.forEach((region, i) => {
    const treatment = { ...DEFAULT_COLOUR_TREATMENT, ...treatments?.colours[region.colourId], ...treatments?.regions[region.id] };
    if (!treatment.enabled) return;
    const passId = treatment.passId ?? colourPassId(region.colourId);
    const pen = pens.find(p => p.id === passes.find(pass => pass.id === passId)?.penId);
    const penWidth = bounded(pen?.widthMm, 0.3, 0.05, 10);
    const add = (a: Point, b: Point) => {
      const segment = clip(a, b, bounds);
      if (segment) paths.push({ id: `colour-${paths.length}`, layerId: 'layer-1', passId, channel: region.id, preserveGaps: true, points: segment });
      if (paths.length > 500_000) throw new Error('Too many colour paths. Increase spacing or the minimum region size.');
    };
    if (treatment.fill === 'outline' || treatment.outline) edges[i]!.forEach(([a, b]) => add(a, b));
    if (treatment.fill === 'none' || treatment.fill === 'outline') return;
    const spacing = treatment.fill === 'solid' ? penWidth * 0.85 : bounded(treatment.spacing, 1.2, 0.1, 20);
    const angle = bounded(treatment.angle, 45, -360, 360);
    for (const degrees of treatment.fill === 'crosshatch' ? [angle, angle + 90] : [angle]) {
      const radians = degrees * Math.PI / 180; const c = Math.cos(radians); const s = Math.sin(radians);
      const rotate = (p: Point): Point => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c });
      const unrotate = (x: number, y: number): Point => ({ x: x * c - y * s, y: x * s + y * c });
      const rotated = edges[i]!.map(([a, b]) => [rotate(a), rotate(b)] as Edge);
      let minY = Infinity; let maxY = -Infinity;
      for (const [a, b] of rotated) { minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y); }
      // Bucket edge intersections by scanline to avoid scanning every edge for every line.
      const first = Math.ceil((minY - spacing / 2) / spacing); const last = Math.floor((maxY - spacing / 2) / spacing);
      const rows = new Map<number, number[]>();
      for (const [a, b] of rotated) {
        if (Math.abs(a.y - b.y) < 1e-10) continue;
        const from = Math.max(first, Math.ceil((Math.min(a.y, b.y) - spacing / 2) / spacing));
        const to = Math.min(last, Math.ceil((Math.max(a.y, b.y) - spacing / 2) / spacing) - 1);
        for (let row = from; row <= to; row++) {
          const y = (row + 0.5) * spacing;
          const intersections = rows.get(row) ?? [];
          intersections.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x)); rows.set(row, intersections);
        }
      }
      for (const [row, intersections] of rows) {
        intersections.sort((a, b) => a - b);
        for (let j = 0; j + 1 < intersections.length; j += 2) {
          const left = intersections[j]! + penWidth / 2; const right = intersections[j + 1]! - penWidth / 2;
          if (right > left) add(unrotate(left, (row + 0.5) * spacing), unrotate(right, (row + 0.5) * spacing));
        }
      }
    }
  });
  return { generator: 'raster.colour-separation', generatedAt: new Date().toISOString(), paths, colourSeparation: { palette, regions } };
}

/** Add only missing automatic passes; keep existing pen calibration and user colours. */
export function ensureColourPasses(palette: ColourSeparationResult['palette'], passes: PlotPass[], pens: PenProfile[]) {
  const nextPasses = [...passes]; const nextPens = [...pens];
  for (const colour of palette) {
    const id = colourPassId(colour.id);
    if (nextPasses.some(p => p.id === id)) continue;
    const penId = `colour-pen-${colour.id}`;
    if (!nextPens.some(p => p.id === penId)) nextPens.push({ ...(pens[0] ?? { widthMm: 0.3, zUp: 0, zDown: -10, xyFeed: 2500, zUpFeed: 600, zDownFeed: 600 }), id: penId, name: `Colour ${Number(colour.id) + 1}`, color: colour.colour });
    nextPasses.push({ id, name: `Colour ${Number(colour.id) + 1}`, penId, enabled: true });
  }
  return { passes: nextPasses, pens: nextPens };
}
