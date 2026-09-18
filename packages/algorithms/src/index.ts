import type { CanvasSettings, PlotGeometry, PlotLayer, PlotPath, Point, SourcePath } from '@plotter/core';
import { drawableBounds, type Bounds } from '@plotter/geometry';
export { DEFAULT_COLOUR_TREATMENT, colourPassId, separateColours, generateColourSeparation, ensureColourPasses } from './colourSeparation';
export { traceRasterContours, type RasterContourOptions } from './rasterContours';

export type ControlDefinition = {
  key: string;
  label: string;
  type: 'number' | 'range' | 'boolean' | 'textarea' | 'select';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  default: number | string | boolean;
};

export interface AlgorithmDefinition {
  id: string;
  name: string;
  group: 'foundation' | 'raster' | 'generative';
  controls: ControlDefinition[];
  worker?: boolean;
}

export const ALGORITHMS: AlgorithmDefinition[] = [
  { id: 'raster.colour-separation', name: 'Colour separation', group: 'raster', worker: true, controls: [
    { key: 'colourCount', label: 'Palette colours', type: 'range', min: 2, max: 16, step: 1, default: 8 },
    { key: 'minRegionPixels', label: 'Minimum region (pixels)', type: 'number', min: 1, max: 10000, step: 1, default: 12 },
    { key: 'skipPaper', label: 'Leave pale paper unplotted', type: 'boolean', default: true },
    { key: 'paperCutoff', label: 'Paper brightness', type: 'range', min: 70, max: 100, step: 1, unit: '%', default: 90 },
    { key: 'cleanEdges', label: 'Clean isolated edge speckles', type: 'boolean', default: true },
  ] },
  { id: 'generative.test-pattern', name: 'Plotter test pattern', group: 'foundation', controls: [
    { key: 'spacing', label: 'Grid spacing', type: 'range', min: 5, max: 30, step: 1, unit: 'mm', default: 15 },
  ] },
  { id: 'raster.edge', name: 'Edge drawing', group: 'raster', worker: true, controls: [{ key: 'edgeThreshold', label: 'Edge threshold', type: 'range', min: 10, max: 240, step: 1, default: 70 }] },
  { id: 'raster.contours', name: 'Contour tracing', group: 'raster', worker: true, controls: [
    { key: 'edgeThreshold', label: 'Edge threshold', type: 'range', min: 10, max: 240, step: 1, default: 55 },
    { key: 'minimumLength', label: 'Minimum line length', type: 'range', min: 0, max: 20, step: 0.25, unit: 'mm', default: 1 },
    { key: 'simplification', label: 'Line smoothing', type: 'range', min: 0, max: 2, step: 0.05, unit: 'mm', default: 0.15 },
  ] },
  { id: 'raster.hatch', name: 'Hatching', group: 'raster', worker: true, controls: [
    { key: 'spacing', label: 'Spacing', type: 'range', min: 0.5, max: 10, step: 0.25, unit: 'mm', default: 2.5 },
    { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
  ] },
  { id: 'raster.crosshatch', name: 'Crosshatching', group: 'raster', worker: true, controls: [
    { key: 'spacing', label: 'Spacing', type: 'range', min: 0.5, max: 10, step: 0.25, unit: 'mm', default: 3 },
    { key: 'angle', label: 'First angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
    { key: 'secondAngle', label: 'Second angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 135 },
  ] },
  { id: 'raster.adaptive-crosshatch', name: 'Adaptive crosshatching', group: 'raster', worker: true, controls: [{ key: 'spacing', label: 'Base spacing', type: 'range', min: 1, max: 12, step: 0.5, unit: 'mm', default: 4 }] },
  { id: 'raster.dither', name: 'Dithered dots', group: 'raster', worker: true, controls: [
    { key: 'spacing', label: 'Dot spacing', type: 'range', min: 0.3, max: 8, step: 0.1, unit: 'mm', default: 1.5 },
    { key: 'markSize', label: 'Mark size', type: 'range', min: 0.1, max: 8, step: 0.1, unit: 'mm', default: 0.45 },
    { key: 'markStyle', label: 'Mark style', type: 'select', options: [{ value: 'point', label: 'Single pen dot' }, { value: 'cross', label: 'Cross' }, { value: 'ring', label: 'Round mark' }], default: 'point' },
    { key: 'overlap', label: 'Shadow overlap', type: 'range', min: 0, max: 1, step: 0.05, default: 0.25 },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 482923 },
  ] },
  { id: 'raster.stipple', name: 'Stippling', group: 'raster', worker: true, controls: [
    { key: 'count', label: 'Sample count', type: 'range', min: 100, max: 30000, step: 100, default: 6000 },
    { key: 'markSize', label: 'Mark size', type: 'range', min: 0.1, max: 8, step: 0.1, unit: 'mm', default: 0.5 },
    { key: 'markStyle', label: 'Mark style', type: 'select', options: [{ value: 'point', label: 'Single pen dot' }, { value: 'cross', label: 'Cross' }, { value: 'ring', label: 'Round mark' }], default: 'point' },
    { key: 'overlap', label: 'Shadow overlap', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.35, max: 3, step: 0.05, default: 1 },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 482923 },
  ] },
  { id: 'raster.tonal-dashes', name: 'Tonal dashes', group: 'raster', worker: true, controls: [
    { key: 'spacing', label: 'Base spacing', type: 'range', min: 0.6, max: 10, step: 0.1, unit: 'mm', default: 1.6 },
    { key: 'density', label: 'Dash density', type: 'range', min: 0.1, max: 3, step: 0.05, default: 1.15 },
    { key: 'dashLength', label: 'Maximum dash', type: 'range', min: 0.4, max: 16, step: 0.1, unit: 'mm', default: 3.5 },
    { key: 'minDashLength', label: 'Minimum dash', type: 'range', min: 0.05, max: 8, step: 0.05, unit: 'mm', default: 0.35 },
    { key: 'angle', label: 'Base angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 0 },
    { key: 'angleVariation', label: 'Angle variation', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 70 },
    { key: 'overlap', label: 'Shadow overlap', type: 'range', min: 0, max: 1, step: 0.05, default: 0.55 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.35, max: 3, step: 0.05, default: 0.85 },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 482923 },
  ] },
  { id: 'raster.scanlines', name: 'Scanlines', group: 'raster', worker: true, controls: [{ key: 'spacing', label: 'Line spacing', type: 'range', min: 0.5, max: 8, step: 0.25, unit: 'mm', default: 2 }] },
  { id: 'raster.spiroglyph', name: 'Spiroglyph', group: 'raster', worker: true, controls: [
    { key: 'lineSpacing', label: 'Line spacing', type: 'range', min: 0.5, max: 8, step: 0.1, unit: 'mm', default: 1.8 },
    { key: 'frequency', label: 'Wave frequency', type: 'range', min: 4, max: 160, step: 1, default: 48 },
    { key: 'amplitude', label: 'Maximum wave width', type: 'range', min: 0, max: 6, step: 0.05, unit: 'mm', default: 0.75 },
    { key: 'minimumAmplitude', label: 'Minimum wave width', type: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', default: 0 },
    { key: 'smoothing', label: 'Tone smoothing', type: 'range', min: 0, max: 40, step: 1, default: 8 },
    { key: 'shadowThreshold', label: 'Shadow threshold', type: 'range', min: 0, max: 220, step: 1, default: 45 },
    { key: 'highlightThreshold', label: 'Highlight threshold', type: 'range', min: 35, max: 255, step: 1, default: 220 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.3, max: 3, step: 0.05, default: 1 },
    { key: 'sampleStep', label: 'Curve resolution', type: 'range', min: 0.2, max: 2.5, step: 0.05, unit: 'mm', default: 0.55 },
    { key: 'innerRadius', label: 'Centre opening', type: 'range', min: 0, max: 25, step: 0.5, unit: 'mm', default: 1.5 },
    { key: 'rotation', label: 'Start angle', type: 'range', min: -180, max: 180, step: 1, unit: '°', default: -90 },
    { key: 'centreX', label: 'Centre offset X', type: 'range', min: -40, max: 40, step: 0.5, unit: 'mm', default: 0 },
    { key: 'centreY', label: 'Centre offset Y', type: 'range', min: -40, max: 40, step: 0.5, unit: 'mm', default: 0 },
    { key: 'shape', label: 'Spiral shape', type: 'select', options: [{ value: 'ellipse', label: 'Fit safe area' }, { value: 'circle', label: 'Circle' }], default: 'ellipse' },
    { key: 'direction', label: 'Direction', type: 'select', options: [{ value: 'outward', label: 'Centre outward' }, { value: 'inward', label: 'Edge inward' }], default: 'outward' },
    { key: 'phase', label: 'Wave phase', type: 'range', min: 0, max: 360, step: 1, unit: '°', default: 0 },
  ] },
  { id: 'generative.flow-field', name: 'Flow field', group: 'generative', controls: [
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 7421 },
    { key: 'particles', label: 'Particles', type: 'range', min: 20, max: 1200, step: 10, default: 280 },
    { key: 'steps', label: 'Steps', type: 'range', min: 10, max: 250, step: 5, default: 70 },
    { key: 'stepSize', label: 'Step size', type: 'range', min: 0.2, max: 5, step: 0.1, unit: 'mm', default: 1.5 },
    { key: 'fieldScale', label: 'Field scale', type: 'range', min: 5, max: 100, step: 1, unit: 'mm', default: 35 },
  ] },
  { id: 'generative.truchet', name: 'Truchet tiles', group: 'generative', controls: [
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 33881 },
    { key: 'tileSize', label: 'Tile size', type: 'range', min: 4, max: 40, step: 1, unit: 'mm', default: 14 },
    { key: 'density', label: 'Density', type: 'range', min: 0.1, max: 1, step: 0.05, default: 0.9 },
  ] },
  { id: 'generative.guilloche', name: 'Guilloché', group: 'generative', controls: [
    { key: 'frequency', label: 'Frequency', type: 'range', min: 2, max: 32, step: 1, default: 11 },
    { key: 'lobes', label: 'Lobes', type: 'range', min: 2, max: 24, step: 1, default: 7 },
    { key: 'amplitude', label: 'Amplitude', type: 'range', min: 1, max: 30, step: 0.5, unit: 'mm', default: 12 },
    { key: 'rings', label: 'Rings', type: 'range', min: 1, max: 20, step: 1, default: 7 },
  ] },
  { id: 'generative.turtle', name: 'TurtleToy script', group: 'generative', worker: true, controls: [
    { key: 'script', label: 'TurtleToy code', type: 'textarea', default: "Canvas.setpenopacity(1);\n\nconst turtle = new Turtle();\nturtle.penup();\nturtle.goto(-50, -20);\nturtle.pendown();\n\nfunction walk(i) {\n  turtle.forward(100);\n  turtle.right(144);\n  return i < 4;\n}" },
    { key: 'ignoreFirstDraw', label: 'Ignore first draw line', type: 'boolean', default: false },
  ] },
];

export const VECTOR_ALGORITHMS: AlgorithmDefinition[] = [
  { id: 'vector.outline', name: 'Outline', group: 'foundation', controls: [] },
  { id: 'vector.hatch', name: 'Hatching', group: 'foundation', controls: [
    { key: 'spacing', label: 'Spacing', type: 'range', min: 0.5, max: 12, step: 0.25, unit: 'mm', default: 2.5 },
    { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
  ] },
  { id: 'vector.crosshatch', name: 'Crosshatching', group: 'foundation', controls: [
    { key: 'spacing', label: 'Spacing', type: 'range', min: 0.5, max: 12, step: 0.25, unit: 'mm', default: 3 },
    { key: 'angle', label: 'First angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
    { key: 'secondAngle', label: 'Second angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 135 },
  ] },
  { id: 'vector.stipple', name: 'Stippling', group: 'foundation', controls: [
    { key: 'spacing', label: 'Spacing', type: 'range', min: 0.75, max: 12, step: 0.25, unit: 'mm', default: 3 },
    { key: 'density', label: 'Density', type: 'range', min: 0.1, max: 1, step: 0.05, default: 0.7 },
    { key: 'markSize', label: 'Mark size', type: 'range', min: 0.1, max: 8, step: 0.1, unit: 'mm', default: 0.5 },
    { key: 'markStyle', label: 'Mark style', type: 'select', options: [{ value: 'point', label: 'Single pen dot' }, { value: 'cross', label: 'Cross' }, { value: 'ring', label: 'Round mark' }], default: 'point' },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 7421 },
  ] },
];

export function algorithmDefaults(id: string): Record<string, number | string | boolean> {
  return Object.fromEntries(([...ALGORITHMS, ...VECTOR_ALGORITHMS].find((item) => item.id === id)?.controls ?? []).map((control) => [control.key, control.default]));
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

const numberSetting = (settings: Record<string, number | string | boolean>, key: string, fallback: number) => Number(settings[key] ?? fallback);
const path = (id: string, points: Point[], passId: string, channel?: string, closed = false): PlotPath => ({ id, points, passId, layerId: 'layer-1', channel, closed });
const geometry = (generator: string, paths: PlotPath[]): PlotGeometry => ({ generator, paths, generatedAt: new Date().toISOString() });

export type SpiroglyphSample = (x: number, y: number) => number;

/**
 * Turns a luminance sampler into a single, plotter-friendly Archimedean spiral.
 * Image tone controls a high-frequency radial wave: dark areas widen the wave,
 * while highlights settle back onto the underlying spiral.
 */
export function generateSpiroglyph(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  sample: SpiroglyphSample,
  passId = 'pass-1',
): PlotGeometry {
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 1.8));
  const frequency = Math.max(1, numberSetting(settings, 'frequency', 48));
  const maximumAmplitude = Math.max(0, numberSetting(settings, 'amplitude', 0.75));
  const minimumAmplitude = Math.min(maximumAmplitude, Math.max(0, numberSetting(settings, 'minimumAmplitude', 0)));
  const sampleStep = Math.max(0.1, numberSetting(settings, 'sampleStep', 0.55));
  const smoothing = Math.max(0, Math.round(numberSetting(settings, 'smoothing', 8)));
  const shadowThreshold = Math.max(0, Math.min(254, numberSetting(settings, 'shadowThreshold', 45)));
  const highlightThreshold = Math.max(shadowThreshold + 1, Math.min(255, numberSetting(settings, 'highlightThreshold', 220)));
  const tonePower = Math.max(0.05, numberSetting(settings, 'tonePower', 1));
  const innerRadius = Math.max(0, numberSetting(settings, 'innerRadius', 1.5));
  const rotation = numberSetting(settings, 'rotation', -90) * Math.PI / 180;
  const phase = numberSetting(settings, 'phase', 0) * Math.PI / 180;
  const centreX = (bounds.minX + bounds.maxX) / 2 + numberSetting(settings, 'centreX', 0);
  const centreY = (bounds.minY + bounds.maxY) / 2 + numberSetting(settings, 'centreY', 0);
  const halfWidth = Math.max(0, Math.min(centreX - bounds.minX, bounds.maxX - centreX));
  const halfHeight = Math.max(0, Math.min(centreY - bounds.minY, bounds.maxY - centreY));
  const circularRadius = Math.min(halfWidth, halfHeight);
  const radiusX = String(settings.shape ?? 'ellipse') === 'circle' ? circularRadius : halfWidth;
  const radiusY = String(settings.shape ?? 'ellipse') === 'circle' ? circularRadius : halfHeight;
  const limitingRadius = Math.min(radiusX, radiusY);
  const usableRadius = Math.max(0, limitingRadius - maximumAmplitude - 0.05);
  if (usableRadius <= innerRadius || radiusX <= 0 || radiusY <= 0) return geometry('raster.spiroglyph', []);

  const turns = Math.max(1, (usableRadius - innerRadius) / spacing);
  const maximumAngle = turns * Math.PI * 2;
  const estimatedLength = Math.PI * (radiusX + radiusY) * turns / 2;
  const pointCount = Math.max(64, Math.min(220_000, Math.ceil(estimatedLength / sampleStep)));
  const rawTone = new Float32Array(pointCount + 1);
  const basePoints: Point[] = new Array(pointCount + 1);

  for (let index = 0; index <= pointCount; index += 1) {
    const progress = index / pointCount;
    const radialProgress = String(settings.direction ?? 'outward') === 'inward' ? 1 - progress : progress;
    const angle = rotation + progress * maximumAngle;
    const radius = innerRadius + radialProgress * (usableRadius - innerRadius);
    const scaleX = radiusX / limitingRadius;
    const scaleY = radiusY / limitingRadius;
    const point = { x: centreX + Math.cos(angle) * radius * scaleX, y: centreY + Math.sin(angle) * radius * scaleY };
    basePoints[index] = point;
    const luminance = Math.max(0, Math.min(255, sample(point.x, point.y)));
    rawTone[index] = Math.pow(Math.max(0, Math.min(1, (highlightThreshold - luminance) / (highlightThreshold - shadowThreshold))), tonePower);
  }

  let tones: Float32Array = rawTone;
  if (smoothing > 0) {
    tones = new Float32Array(rawTone.length);
    const prefix = new Float64Array(rawTone.length + 1);
    for (let index = 0; index < rawTone.length; index += 1) {
      prefix[index + 1] = prefix[index]! + rawTone[index]!;
    }
    for (let index = 0; index < rawTone.length; index += 1) {
      const from = Math.max(0, index - smoothing);
      const to = Math.min(rawTone.length - 1, index + smoothing);
      tones[index] = (prefix[to + 1]! - prefix[from]!) / (to - from + 1);
    }
  }

  const points = basePoints.map((basePoint, index) => {
    const progress = index / pointCount;
    const angle = rotation + progress * maximumAngle;
    const tone = tones[index] ?? 0;
    const amplitude = tone <= 0 ? 0 : minimumAmplitude + (maximumAmplitude - minimumAmplitude) * tone;
    const wave = Math.sin(progress * turns * Math.PI * 2 * frequency + phase) * amplitude;
    const scaleX = radiusX / limitingRadius;
    const scaleY = radiusY / limitingRadius;
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, basePoint.x + Math.cos(angle) * wave * scaleX)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, basePoint.y + Math.sin(angle) * wave * scaleY)),
    };
  });

  return geometry('raster.spiroglyph', [{ id: 'spiroglyph-0', points, passId, layerId: 'layer-1', channel: 'primary' }]);
}

function arc(cx: number, cy: number, radius: number, from: number, to: number, segments = 16): Point[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / segments;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

function stippleMarkPaths(point: Point, size: number, style: string): Point[][] {
  const radius = Math.max(0.025, size / 2);
  if (style === 'cross') {
    const arm = radius * 0.8;
    return [
      [{ x: point.x - arm, y: point.y - arm }, { x: point.x + arm, y: point.y + arm }],
      [{ x: point.x - arm, y: point.y + arm }, { x: point.x + arm, y: point.y - arm }],
    ];
  }
  if (style === 'ring') return [arc(point.x, point.y, radius, 0, Math.PI * 2, 12)];
  return [[{ x: point.x - 0.01, y: point.y }, { x: point.x + 0.01, y: point.y }]];
}

export function generateAlgorithm(id: string, canvas: CanvasSettings, settings: Record<string, number | string | boolean>, passIds: string[]): PlotGeometry {
  const bounds = drawableBounds(canvas.widthMm, canvas.heightMm, canvas.marginMm);
  const primary = passIds[0] ?? 'pass-1';
  const secondary = passIds[1] ?? primary;
  const paths: PlotPath[] = [];
  if (id === 'generative.test-pattern') {
    const spacing = numberSetting(settings, 'spacing', 15);
    paths.push(path('border', [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }], primary, 'primary', true));
    for (let x = bounds.minX; x <= bounds.maxX; x += spacing) paths.push(path(`grid-v-${x}`, [{ x, y: bounds.minY }, { x, y: bounds.maxY }], primary));
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) paths.push(path(`grid-h-${y}`, [{ x: bounds.minX, y }, { x: bounds.maxX, y }], secondary, 'secondary'));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    for (let r = 5; r < Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.25; r += 5) paths.push(path(`circle-${r}`, arc(cx, cy, r, 0, Math.PI * 2, 48), primary, 'primary', true));
  } else if (id === 'generative.flow-field') {
    const random = mulberry32(numberSetting(settings, 'seed', 7421));
    const particles = numberSetting(settings, 'particles', 280);
    const steps = numberSetting(settings, 'steps', 70);
    const stepSize = numberSetting(settings, 'stepSize', 1.5);
    const scale = numberSetting(settings, 'fieldScale', 35);
    for (let i = 0; i < particles; i += 1) {
      let x = bounds.minX + random() * (bounds.maxX - bounds.minX);
      let y = bounds.minY + random() * (bounds.maxY - bounds.minY);
      const points: Point[] = [{ x, y }];
      for (let step = 0; step < steps; step += 1) {
        const angle = Math.sin(x / scale + numberSetting(settings, 'seed', 1)) * Math.PI + Math.cos(y / scale) * Math.PI;
        x += Math.cos(angle) * stepSize;
        y += Math.sin(angle) * stepSize;
        if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) break;
        points.push({ x, y });
      }
      if (points.length > 2) paths.push(path(`flow-${i}`, points, i % 5 === 0 ? secondary : primary, i % 5 === 0 ? 'accent' : 'primary'));
    }
  } else if (id === 'generative.truchet') {
    const size = numberSetting(settings, 'tileSize', 14);
    const random = mulberry32(numberSetting(settings, 'seed', 33881));
    const density = numberSetting(settings, 'density', 0.9);
    let index = 0;
    for (let y = bounds.minY; y + size <= bounds.maxY; y += size) {
      for (let x = bounds.minX; x + size <= bounds.maxX; x += size) {
        if (random() > density) continue;
        if (random() > 0.5) {
          paths.push(path(`truchet-${index++}-a`, arc(x, y, size / 2, 0, Math.PI / 2), primary));
          paths.push(path(`truchet-${index++}-b`, arc(x + size, y + size, size / 2, Math.PI, Math.PI * 1.5), secondary, 'secondary'));
        } else {
          paths.push(path(`truchet-${index++}-a`, arc(x + size, y, size / 2, Math.PI / 2, Math.PI), primary));
          paths.push(path(`truchet-${index++}-b`, arc(x, y + size, size / 2, -Math.PI / 2, 0), secondary, 'secondary'));
        }
      }
    }
  } else if (id === 'generative.guilloche') {
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const maximum = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
    const frequency = numberSetting(settings, 'frequency', 11);
    const lobes = numberSetting(settings, 'lobes', 7);
    const amplitude = numberSetting(settings, 'amplitude', 12);
    const rings = numberSetting(settings, 'rings', 7);
    for (let ring = 0; ring < rings; ring += 1) {
      const base = Math.max(5, maximum - amplitude - ring * (maximum / Math.max(rings, 1)) * 0.45);
      const points = Array.from({ length: 721 }, (_, i) => {
        const t = (i / 720) * Math.PI * 2;
        const radius = base + Math.sin(t * frequency + ring * 0.37) * amplitude * Math.cos(t * lobes);
        return { x: cx + Math.cos(t) * radius, y: cy + Math.sin(t) * radius };
      });
      paths.push(path(`guilloche-${ring}`, points, ring % 2 ? secondary : primary, ring % 2 ? 'secondary' : 'primary', true));
    }
  }
  return geometry(id, paths);
}

const rotatePoint = (point: Point, angle: number): Point => ({ x: point.x * Math.cos(angle) - point.y * Math.sin(angle), y: point.x * Math.sin(angle) + point.y * Math.cos(angle) });

function hatchSourcePath(source: SourcePath, angleDegrees: number, spacing: number): Point[][] {
  if (!source.closed || source.points.length < 3) return [];
  const angle = angleDegrees * Math.PI / 180;
  const rotated = source.points.map((point) => rotatePoint(point, -angle));
  const minY = Math.min(...rotated.map((point) => point.y));
  const maxY = Math.max(...rotated.map((point) => point.y));
  const lines: Point[][] = [];
  for (let y = Math.ceil(minY / spacing) * spacing; y <= maxY; y += spacing) {
    const intersections: number[] = [];
    for (let index = 0; index < rotated.length; index += 1) {
      const start = rotated[index]!;
      const end = rotated[(index + 1) % rotated.length]!;
      if ((start.y <= y && end.y > y) || (end.y <= y && start.y > y)) intersections.push(start.x + ((y - start.y) / (end.y - start.y)) * (end.x - start.x));
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      lines.push([rotatePoint({ x: intersections[index]!, y }, angle), rotatePoint({ x: intersections[index + 1]!, y }, angle)]);
    }
  }
  return lines;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    if (((currentPoint.y > point.y) !== (previousPoint.y > point.y)) && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x) inside = !inside;
  }
  return inside;
}

export function generateVectorLayers(layers: PlotLayer[]): PlotGeometry {
  const output: PlotPath[] = [];
  let index = 0;
  for (const layer of layers) {
    if (!layer.visible || !layer.sourcePaths?.length) continue;
    const settings = { ...algorithmDefaults(layer.algorithmId), ...layer.algorithmSettings };
    const add = (points: Point[], passId = layer.passId, channel = 'primary', closed = false) => {
      if (points.length > 1) output.push({ id: `vector-${index++}`, points, passId, layerId: layer.id, channel, closed });
    };
    if (layer.algorithmId === 'vector.outline') {
      layer.sourcePaths.forEach((source) => add(source.points, layer.passId, 'outline', source.closed));
    } else if (layer.algorithmId === 'vector.hatch' || layer.algorithmId === 'vector.crosshatch') {
      const spacing = numberSetting(settings, 'spacing', 2.5);
      const angle = numberSetting(settings, 'angle', 45);
      for (const source of layer.sourcePaths) {
        if (source.closed) hatchSourcePath(source, angle, spacing).forEach((points) => add(points));
        else add(source.points, layer.passId, 'outline');
      }
      if (layer.algorithmId === 'vector.crosshatch') {
        const secondAngle = numberSetting(settings, 'secondAngle', 135);
        for (const source of layer.sourcePaths) if (source.closed) hatchSourcePath(source, secondAngle, spacing).forEach((points) => add(points, layer.secondaryPassId ?? layer.passId, 'secondary'));
      }
    } else if (layer.algorithmId === 'vector.stipple') {
      const spacing = numberSetting(settings, 'spacing', 3);
      const density = numberSetting(settings, 'density', 0.7);
      const markSize = numberSetting(settings, 'markSize', 0.5);
      const markStyle = String(settings.markStyle ?? 'point');
      const random = mulberry32(numberSetting(settings, 'seed', 7421));
      for (const source of layer.sourcePaths) {
        if (!source.closed || source.points.length < 3) { add(source.points, layer.passId, 'outline'); continue; }
        const minX = Math.min(...source.points.map((point) => point.x));
        const maxX = Math.max(...source.points.map((point) => point.x));
        const minY = Math.min(...source.points.map((point) => point.y));
        const maxY = Math.max(...source.points.map((point) => point.y));
        for (let y = minY + spacing / 2; y < maxY; y += spacing) {
          for (let x = minX + spacing / 2; x < maxX; x += spacing) {
            const point = { x: x + (random() - 0.5) * spacing * 0.7, y: y + (random() - 0.5) * spacing * 0.7 };
            if (random() <= density && pointInPolygon(point, source.points)) {
              stippleMarkPaths(point, markSize, markStyle).forEach((points) => add(points, layer.passId, 'stipple', markStyle === 'ring'));
            }
          }
        }
      }
    }
  }
  return geometry('vector.layers', output);
}
