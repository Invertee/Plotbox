/// <reference lib="webworker" />
import type { CanvasSettings, ColourSeparationSettings, PenProfile, PlotPass, PlotGeometry, PlotPath, Point, PreprocessSettings, RasterPlacementSettings, TurtlePlacementSettings } from '@plotter/core';
import { calculateImagePlacement, drawableBounds, type Bounds } from '@plotter/geometry';
import { generateSpiroglyph, generateColourSeparation } from '@plotter/algorithms';
import { turtleDraw } from 'turtletoy';

type Job = {
  jobId: number;
  algorithmId: string;
  canvas: CanvasSettings;
  settings: Record<string, number | string | boolean>;
  preprocess: PreprocessSettings;
  rasterPlacement: RasterPlacementSettings;
  turtlePlacement: TurtlePlacementSettings;
  passIds: string[];
  imageData?: ImageData;
  colourSeparation?: ColourSeparationSettings;
  passes: PlotPass[];
  pens: PenProfile[];
};

const scope = self as unknown as DedicatedWorkerGlobalScope;
const progress = (jobId: number, value: number, message: string) => scope.postMessage({ type: 'progress', jobId, value, message });
const numberSetting = (settings: Job['settings'], key: string, fallback: number) => Number(settings[key] ?? fallback);
const stringSetting = (settings: Job['settings'], key: string, fallback: string) => String(settings[key] ?? fallback);
const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

function markPaths(x: number, y: number, size: number, style: string): Point[][] {
  const radius = Math.max(0.025, size / 2);
  if (style === 'cross') {
    const arm = radius * 0.8;
    return [
      [{ x: x - arm, y: y - arm }, { x: x + arm, y: y + arm }],
      [{ x: x - arm, y: y + arm }, { x: x + arm, y: y - arm }],
    ];
  }
  if (style === 'ring') {
    return [Array.from({ length: 13 }, (_, index) => {
      const angle = index / 12 * Math.PI * 2;
      return { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius };
    })];
  }
  // Plotters need a tiny pen-down move to make a reliably visible single dot.
  return [[{ x: x - 0.01, y }, { x: x + 0.01, y }]];
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function preprocessImage(image: ImageData, options: PreprocessSettings): Float32Array {
  const result = new Float32Array(image.width * image.height);
  const contrast = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast));
  for (let i = 0; i < result.length; i += 1) {
    const offset = i * 4;
    let value = (image.data[offset]! * 0.2126 + image.data[offset + 1]! * 0.7152 + image.data[offset + 2]! * 0.0722);
    value = contrast * (value - 128) + 128 + options.brightness;
    value = 255 * Math.pow(Math.max(0, Math.min(255, value)) / 255, 1 / Math.max(0.05, options.gamma));
    result[i] = options.invert ? 255 - value : value;
  }
  const radius = Math.min(8, Math.max(0, Math.round(options.blur)));
  if (!radius) return result;
  const blurred = new Float32Array(result.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      let total = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px >= 0 && px < image.width && py >= 0 && py < image.height) { total += result[py * image.width + px]!; count += 1; }
        }
      }
      blurred[y * image.width + x] = total / count;
    }
  }
  return blurred;
}

function rasterGeometry(job: Job): PlotGeometry {
  if (!job.imageData) throw new Error('Import an image before running a raster algorithm.');
  if (job.algorithmId === 'raster.colour-separation') {
    progress(job.jobId, 0.1, 'Separating colours and connected regions');
    return generateColourSeparation(job.imageData, job.canvas, job.rasterPlacement, job.settings, job.colourSeparation, job.passes, job.pens);
  }
  progress(job.jobId, 0.04, 'Preprocessing image');
  const luminance = preprocessImage(job.imageData, job.preprocess);
  const { width, height } = job.imageData;
  const bounds = drawableBounds(job.canvas.widthMm, job.canvas.heightMm, job.canvas.marginMm);
  const drawWidth = bounds.maxX - bounds.minX;
  const drawHeight = bounds.maxY - bounds.minY;
  const placement = calculateImagePlacement(width, height, bounds, job.rasterPlacement);
  const primary = job.passIds[0] ?? 'pass-1';
  const secondary = job.passIds[1] ?? primary;
  const paths: PlotPath[] = [];
  let pathIndex = 0;
  const sample = (x: number, y: number) => {
    if (x < placement.x || x > placement.x + placement.width || y < placement.y || y > placement.y + placement.height) return 255;
    const px = Math.max(0, Math.min(width - 1, Math.round(((x - placement.x) / placement.width) * (width - 1))));
    const py = Math.max(0, Math.min(height - 1, Math.round(((y - placement.y) / placement.height) * (height - 1))));
    return luminance[py * width + px] ?? 255;
  };
  const addPath = (points: Point[], passId = primary, channel = 'primary') => {
    if (points.length > 1) paths.push({ id: `raster-${pathIndex++}`, points, passId, layerId: 'layer-1', channel });
  };
  const addMark = (x: number, y: number, size: number, style: string, passId = primary, channel = 'primary') => {
    markPaths(x, y, size, style).forEach((points) => addPath(points, passId, channel));
  };
  // Keep the dot-based modes continuous. A hard `sample < threshold` cutoff is
  // suitable for hatching, but leaves stipples/dither almost empty after a bright
  // gamma adjustment. Raising the threshold now increases the tonal density.
  const toneAt = (x: number, y: number) => clamp((255 - sample(x, y)) / Math.max(10, 255 - job.preprocess.threshold));
  const hatch = (angleDegrees: number, spacing: number, cutoff: number, passId = primary, channel = 'primary') => {
    const angle = angleDegrees * Math.PI / 180;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const normal = { x: -direction.y, y: direction.x };
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const extent = Math.hypot(drawWidth, drawHeight);
    let row = 0;
    for (let offset = -extent; offset <= extent; offset += Math.max(0.25, spacing)) {
      let current: Point[] = [];
      for (let distance = -extent; distance <= extent; distance += 0.8) {
        const point = { x: cx + normal.x * offset + direction.x * distance, y: cy + normal.y * offset + direction.y * distance };
        const inside = point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
        if (inside && sample(point.x, point.y) < cutoff) current.push(point);
        else if (current.length) { addPath(current, passId, channel); current = []; }
      }
      addPath(current, passId, channel);
      row += 1;
      if (row % 20 === 0) progress(job.jobId, Math.min(0.9, 0.15 + row / (extent * 2 / spacing) * 0.7), 'Tracing hatch lines');
    }
  };

  const threshold = job.preprocess.threshold;
  if (job.algorithmId === 'raster.spiroglyph') {
    progress(job.jobId, 0.2, 'Sampling spiral tones');
    return generateSpiroglyph(bounds, job.settings, sample, primary);
  } else if (job.algorithmId === 'raster.hatch') {
    hatch(numberSetting(job.settings, 'angle', 45), numberSetting(job.settings, 'spacing', 2.5), threshold);
  } else if (job.algorithmId === 'raster.crosshatch') {
    const spacing = numberSetting(job.settings, 'spacing', 3);
    hatch(numberSetting(job.settings, 'angle', 45), spacing, Math.min(230, threshold + 35));
    hatch(numberSetting(job.settings, 'secondAngle', 135), spacing, Math.max(20, threshold - 35), secondary, 'secondary');
  } else if (job.algorithmId === 'raster.adaptive-crosshatch') {
    const spacing = numberSetting(job.settings, 'spacing', 4);
    hatch(0, spacing, 210);
    hatch(60, spacing, 145, secondary, 'mid');
    hatch(120, spacing, 80, primary, 'dark');
  } else if (job.algorithmId === 'raster.scanlines') {
    const spacing = numberSetting(job.settings, 'spacing', 2);
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      const points: Point[] = [];
      for (let x = bounds.minX; x <= bounds.maxX; x += 0.7) {
        const tone = sample(x, y);
        points.push({ x, y: y + (1 - tone / 255) * spacing * 0.7 * Math.sin(x * 1.7) });
      }
      addPath(points);
    }
  } else if (job.algorithmId === 'raster.edge') {
    const step = Math.max(0.6, Math.min(drawWidth / width, drawHeight / height) * 2);
    const edgeThreshold = numberSetting(job.settings, 'edgeThreshold', 70);
    for (let y = bounds.minY + step; y < bounds.maxY - step; y += step) {
      let current: Point[] = [];
      for (let x = bounds.minX + step; x < bounds.maxX - step; x += step) {
        const gx = sample(x + step, y) - sample(x - step, y);
        const gy = sample(x, y + step) - sample(x, y - step);
        if (Math.hypot(gx, gy) > edgeThreshold) current.push({ x, y });
        else if (current.length) { addPath(current); current = []; }
      }
      addPath(current);
    }
  } else if (job.algorithmId === 'raster.dither') {
    const spacing = Math.max(0.15, numberSetting(job.settings, 'spacing', 1.5));
    const markSize = numberSetting(job.settings, 'markSize', 0.45);
    const markStyle = stringSetting(job.settings, 'markStyle', 'point');
    const overlap = clamp(numberSetting(job.settings, 'overlap', 0.25));
    const random = mulberry32(numberSetting(job.settings, 'seed', 482923));
    const bayer = [[0, 128, 32, 160], [192, 64, 224, 96], [48, 176, 16, 144], [240, 112, 208, 80]];
    let row = 0;
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      let column = 0;
      for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
        const tone = toneAt(x, y);
        if (tone * 255 > bayer[row % 4]![column % 4]!) {
          const marks = 1 + Math.floor(tone * overlap * 3);
          for (let mark = 0; mark < marks; mark += 1) {
            const jitter = mark === 0 ? 0 : markSize * overlap * 0.65;
            addMark(x + (random() - 0.5) * jitter, y + (random() - 0.5) * jitter, markSize, markStyle);
          }
        }
        column += 1;
      }
      row += 1;
    }
  } else if (job.algorithmId === 'raster.stipple') {
    const random = mulberry32(numberSetting(job.settings, 'seed', 482923));
    const count = numberSetting(job.settings, 'count', 3500);
    const markSize = numberSetting(job.settings, 'markSize', 0.5);
    const markStyle = stringSetting(job.settings, 'markStyle', 'point');
    const overlap = clamp(numberSetting(job.settings, 'overlap', 0.35));
    const tonePower = Math.max(0.05, numberSetting(job.settings, 'tonePower', 1));
    for (let i = 0; i < count; i += 1) {
      const x = bounds.minX + random() * drawWidth;
      const y = bounds.minY + random() * drawHeight;
      const darkness = Math.pow(toneAt(x, y), tonePower);
      if (random() < darkness) {
        const marks = 1 + Math.floor(darkness * overlap * 3);
        for (let mark = 0; mark < marks; mark += 1) {
          const jitter = mark === 0 ? 0 : markSize * overlap * 0.8;
          addMark(x + (random() - 0.5) * jitter, y + (random() - 0.5) * jitter, markSize * (0.55 + darkness * 0.45), markStyle);
        }
      }
      if (i % 500 === 0) progress(job.jobId, 0.15 + i / count * 0.75, 'Distributing stipples');
    }
  } else if (job.algorithmId === 'raster.tonal-dashes') {
    const spacing = Math.max(0.25, numberSetting(job.settings, 'spacing', 1.6));
    const density = Math.max(0.01, numberSetting(job.settings, 'density', 1.15));
    const maximum = Math.max(0.05, numberSetting(job.settings, 'dashLength', 3.5));
    const minimum = Math.min(maximum, Math.max(0.02, numberSetting(job.settings, 'minDashLength', 0.35)));
    const baseAngle = numberSetting(job.settings, 'angle', 0) * Math.PI / 180;
    const angleVariation = numberSetting(job.settings, 'angleVariation', 70) * Math.PI / 180;
    const overlap = clamp(numberSetting(job.settings, 'overlap', 0.55));
    const tonePower = Math.max(0.05, numberSetting(job.settings, 'tonePower', 0.85));
    const random = mulberry32(numberSetting(job.settings, 'seed', 482923));
    const candidates = Math.min(120000, Math.ceil(drawWidth * drawHeight / (spacing * spacing) * density));
    for (let i = 0; i < candidates; i += 1) {
      const x = bounds.minX + random() * drawWidth;
      const y = bounds.minY + random() * drawHeight;
      const darkness = Math.pow(toneAt(x, y), tonePower);
      if (random() >= darkness) continue;
      const marks = random() < darkness * overlap ? 2 : 1;
      for (let mark = 0; mark < marks; mark += 1) {
        const jitter = mark === 0 ? 0 : spacing * overlap * 0.7;
        const cx = x + (random() - 0.5) * jitter;
        const cy = y + (random() - 0.5) * jitter;
        const tone = Math.pow(toneAt(cx, cy), tonePower);
        const length = minimum + (maximum - minimum) * (0.2 + tone * 0.8) * (0.55 + random() * 0.75);
        const angle = baseAngle + (random() - 0.5) * angleVariation;
        const dx = Math.cos(angle) * length / 2;
        const dy = Math.sin(angle) * length / 2;
        addPath([{ x: clamp(cx - dx, bounds.minX, bounds.maxX), y: clamp(cy - dy, bounds.minY, bounds.maxY) }, { x: clamp(cx + dx, bounds.minX, bounds.maxX), y: clamp(cy + dy, bounds.minY, bounds.maxY) }]);
      }
      if (i % 1000 === 0) progress(job.jobId, 0.15 + i / candidates * 0.75, 'Placing tonal dashes');
    }
  }
  progress(job.jobId, 0.96, `Finalising ${paths.length.toLocaleString()} paths`);
  return { generator: job.algorithmId, paths, generatedAt: new Date().toISOString() };
}

function clipLine(start: Point, end: Point, bounds: Bounds): [Point, Point] | undefined {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const p = [-dx, dx, -dy, dy];
  const q = [start.x - bounds.minX, bounds.maxX - start.x, start.y - bounds.minY, bounds.maxY - start.y];
  let from = 0;
  let to = 1;
  for (let index = 0; index < 4; index += 1) {
    const direction = p[index]!;
    const distance = q[index]!;
    if (direction === 0 && distance < 0) return undefined;
    if (direction === 0) continue;
    const ratio = distance / direction;
    if (direction < 0) from = Math.max(from, ratio);
    else to = Math.min(to, ratio);
    if (from > to) return undefined;
  }
  return [
    { x: start.x + from * dx, y: start.y + from * dy },
    { x: start.x + to * dx, y: start.y + to * dy },
  ];
}

function turtleGeometry(job: Job): PlotGeometry {
  const bounds = drawableBounds(job.canvas.widthMm, job.canvas.heightMm, job.canvas.marginMm);
  const passId = job.passIds[0] ?? 'pass-1';
  const paths: PlotPath[] = [];
  let current: Point[] = [];
  const flush = () => { if (current.length > 1) paths.push({ id: `turtle-${paths.length}`, points: current, passId, layerId: 'layer-1' }); current = []; };
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const scalePercent = Math.max(0.01, job.turtlePlacement.scalePercent / 100);
  const containScale = Math.min(width, height) / 200;
  const coverScale = Math.max(width, height) / 200;
  const scaleX = (job.turtlePlacement.fit === 'stretch' ? width / 200 : job.turtlePlacement.fit === 'cover' ? coverScale : containScale) * scalePercent;
  const scaleY = (job.turtlePlacement.fit === 'stretch' ? height / 200 : job.turtlePlacement.fit === 'cover' ? coverScale : containScale) * scalePercent;
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  const ignoreFirstDraw = job.settings.ignoreFirstDraw === true;
  let drawCount = 0;
  const toPage = (x: number, y: number): Point => ({
    x: centreX + x * scaleX + job.turtlePlacement.offsetXmm,
    y: centreY + y * scaleY + job.turtlePlacement.offsetYmm,
  });
  const appendLine = (x1: number, y1: number, x2: number, y2: number) => {
    const startOnPage = toPage(x1, y1);
    const endOnPage = toPage(x2, y2);
    // Some TurtleToy scripts deliberately finish by moving to an undefined or
    // infinite coordinate. Letting that reach clipping creates a NaN point,
    // which is persisted as null and appears as a line to the page origin.
    if (![startOnPage.x, startOnPage.y, endOnPage.x, endOnPage.y].every(Number.isFinite)) {
      flush();
      return;
    }
    const clipped = clipLine(startOnPage, endOnPage, bounds);
    if (!clipped) { flush(); return; }
    const [start, end] = clipped;
    // TurtleToy can emit setup moves that are outside the page or have no
    // length.  They are not visible drawing, so they must not consume the
    // "ignore first draw line" option.
    if (Math.hypot(end.x - start.x, end.y - start.y) <= 0.001) return;
    if (ignoreFirstDraw && drawCount++ === 0) return;
    const previous = current[current.length - 1];
    if (!previous || Math.hypot(previous.x - start.x, previous.y - start.y) > 0.001) {
      flush();
      current = [start];
    }
    current.push(end);
  };
  progress(job.jobId, 0.2, 'Executing TurtleToy code');
  let script = String(job.settings.script ?? '');
  // Preserve projects created with Plotbox's original single-turtle compatibility API.
  if (/\bturtle\s*\./.test(script) && !/\bnew\s+Turtle\s*\(/.test(script)) script = `const turtle = new Turtle();\n${script}`;
  let executionError: unknown;
  turtleDraw(script, {
    maxSteps: 250_000,
    onDrawLine: appendLine,
    onStepError: (error) => { executionError = error; },
  });
  if (executionError) throw executionError;
  flush();
  return { generator: job.algorithmId, paths, generatedAt: new Date().toISOString() };
}

scope.onmessage = (event: MessageEvent<Job>) => {
  const job = event.data;
  try {
    progress(job.jobId, 0.01, 'Starting render');
    const result = job.algorithmId === 'generative.turtle' ? turtleGeometry(job) : rasterGeometry(job);
    scope.postMessage({ type: 'complete', jobId: job.jobId, result });
  } catch (error) {
    scope.postMessage({ type: 'error', jobId: job.jobId, message: error instanceof Error ? error.message : String(error) });
  }
};
