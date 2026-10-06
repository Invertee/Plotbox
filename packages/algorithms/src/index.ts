import { hatchSourcePath } from './vectorHatching';
import { ISOMETRIC_MAZE, generateIsometricMaze } from './isometricMaze';
export { ISOMETRIC_MAZE, generateIsometricMaze, buildIsometricMaze } from './isometricMaze';
export type { MazeCell, IsometricMazeLayout } from './isometricMaze';
import type { CanvasSettings, PlotGeometry, PlotLayer, PlotPath, Point, SourcePath } from '@plotter/core';
export { formatMapCoordinates, generateMapAnnotations, generateMapTitle, mapAnnotationBackgrounds, mapTitleBackground, maskPathsBehindMapAnnotations, maskPathsBehindMapTitle, MAP_ANNOTATION_FONT_OPTIONS, MAP_MARKER_OPTIONS } from './mapAnnotations';
import { drawableBounds, type Bounds } from '@plotter/geometry';
export { DEFAULT_COLOUR_TREATMENT, colourPassId, scribbleColourPassId, separateColours, generateColourSeparation, generateScribbleColourUnderlay, ensureColourPasses, ensureScribbleColourPasses } from './colourSeparation';
export { traceRasterContours, type RasterContourOptions } from './rasterContours';
export { generateTonalAreaFill, type TonalAreaFillOptions } from './tonalAreaFill';
export { generateColourTonalAreaFill, type ColourTonalAreaFillOptions } from './colourTonalAreaFill';
export { generateContinuousScribble } from './continuousScribble';
export { generateStraightLinePortrait } from './straightLinePortrait';

export type ControlDefinition = {
  key: string;
  label: string;
  type: 'number' | 'range' | 'boolean' | 'textarea' | 'select';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  visibleWhen?: { key: string; value: number | string | boolean };
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
  ISOMETRIC_MAZE,
  { id: 'raster.straight-lines', name: 'Straight line sketch', group: 'raster', worker: true, controls: [
    { key: 'lineDensity', label: 'Lines', type: 'range', min: 0.2, max: 3, step: 0.1, default: 1.2 },
    { key: 'tonePower', label: 'Tone contrast', type: 'range', min: 0.5, max: 2.5, step: 0.05, default: 1 },
    { key: 'detailSize', label: 'Fine detail size', type: 'range', min: 0.35, max: 2, step: 0.05, unit: 'mm', default: 0.7 },
    { key: 'lineLength', label: 'Line length', type: 'range', min: 0.5, max: 10, step: 0.1, unit: 'mm', default: 2.8 },
    { key: 'paperCutoff', label: 'Leave pale areas blank above', type: 'range', min: 180, max: 255, step: 1, default: 245 },
    { key: 'secondPass', label: 'Add overlapping definition pass', type: 'boolean', default: false },
    { key: 'definitionStrength', label: 'Definition strength', type: 'range', min: 0.2, max: 2, step: 0.1, default: 0.8, visibleWhen: { key: 'secondPass', value: true } },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 482923 },
  ] },
  { id: 'raster.continuous-scribble', name: 'Continuous scribble', group: 'raster', worker: true, controls: [
    { key: 'colourUnderlay', label: 'Add colour passes behind scribble', type: 'boolean', default: false },
    { key: 'underlayColourCount', label: 'Under-colour palette', type: 'range', min: 2, max: 12, step: 1, default: 6 },
    { key: 'underlayMinRegionPixels', label: 'Under-colour minimum region', type: 'number', min: 1, max: 10000, step: 1, default: 24 },
    { key: 'underlaySkipPaper', label: 'Leave pale paper uncoloured', type: 'boolean', default: true },
    { key: 'underlayPaperCutoff', label: 'Under-colour paper brightness', type: 'range', min: 70, max: 100, step: 1, unit: '%', default: 90 },
    { key: 'underlayAngle', label: 'Under-colour fill angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
    { key: 'skipWhite', label: 'Skip white / pale areas', type: 'boolean', default: false },
    { key: 'detailSize', label: 'Fine detail size', type: 'range', min: 0.25, max: 3, step: 0.05, unit: 'mm', default: 0.8 },
    { key: 'highlightSize', label: 'Highlight loop size', type: 'range', min: 1, max: 10, step: 0.1, unit: 'mm', default: 3.5 },
    { key: 'shadowDensity', label: 'Shadow density', type: 'range', min: 0.5, max: 4, step: 0.1, default: 1.5 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.35, max: 3, step: 0.05, default: 1 },
    { key: 'detailSensitivity', label: 'Detail contrast threshold', type: 'range', min: 0.03, max: 0.5, step: 0.01, default: 0.15 },
    { key: 'curveStep', label: 'Curve step', type: 'range', min: 0.05, max: 0.5, step: 0.01, unit: 'mm', default: 0.18 },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 482923 },
  ] },
  { id: 'raster.paint-scribble', name: 'Paint · pressure scribble', group: 'raster', worker: true, controls: [
    { key: 'skipWhite', label: 'Skip white / pale areas', type: 'boolean', default: true },
    { key: 'detailSize', label: 'Fine detail size', type: 'range', min: 0.25, max: 3, step: 0.05, unit: 'mm', default: 1.2 },
    { key: 'highlightSize', label: 'Highlight loop size', type: 'range', min: 1, max: 10, step: 0.1, unit: 'mm', default: 4.5 },
    { key: 'shadowDensity', label: 'Shadow density', type: 'range', min: 0.5, max: 4, step: 0.1, default: 1.2 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.35, max: 3, step: 0.05, default: 1 },
    { key: 'detailSensitivity', label: 'Detail contrast threshold', type: 'range', min: 0.03, max: 0.5, step: 0.01, default: 0.15 },
    { key: 'curveStep', label: 'Curve step', type: 'range', min: 0.05, max: 0.5, step: 0.01, unit: 'mm', default: 0.22 },
    { key: 'minimumPressure', label: 'Highlight pressure', type: 'range', min: 0, max: 1, step: 0.05, default: 0.1 },
    { key: 'maximumPressure', label: 'Shadow pressure', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
    { key: 'pressurePower', label: 'Pressure response', type: 'range', min: 0.3, max: 3, step: 0.05, default: 1 },
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 482923 },
  ] },
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
  { id: 'raster.tonal-area-fill', name: 'Tonal area fill', group: 'raster', worker: true, controls: [
    { key: 'levels', label: 'Tone levels', type: 'range', min: 1, max: 6, step: 1, default: 3 },
    { key: 'highlightThreshold', label: 'Lightest filled tone', type: 'range', min: 80, max: 255, step: 1, default: 225 },
    { key: 'shadowThreshold', label: 'Darkest tone', type: 'range', min: 0, max: 220, step: 1, default: 70 },
    { key: 'spacing', label: 'Fill spacing', type: 'range', min: 0.2, max: 5, step: 0.05, unit: 'mm', default: 0.55 },
    { key: 'angle', label: 'First fill angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
    { key: 'angleStep', label: 'Angle between tones', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 60 },
    { key: 'closeRadius', label: 'Close small gaps', type: 'range', min: 0, max: 4, step: 1, unit: 'px', default: 1 },
    { key: 'minimumRegionPixels', label: 'Minimum area', type: 'number', min: 1, max: 10000, step: 1, unit: 'px', default: 6 },
    { key: 'minimumStroke', label: 'Minimum fill stroke', type: 'range', min: 0, max: 5, step: 0.05, unit: 'mm', default: 0.2 },
    { key: 'includeContours', label: 'Trace detail edges', type: 'boolean', default: true },
    { key: 'edgeThreshold', label: 'Detail edge threshold', type: 'range', min: 10, max: 240, step: 1, default: 55, visibleWhen: { key: 'includeContours', value: true } },
    { key: 'minimumContourLength', label: 'Minimum edge length', type: 'range', min: 0, max: 20, step: 0.25, unit: 'mm', default: 0.5, visibleWhen: { key: 'includeContours', value: true } },
    { key: 'contourSimplification', label: 'Edge smoothing', type: 'range', min: 0, max: 2, step: 0.05, unit: 'mm', default: 0.12, visibleWhen: { key: 'includeContours', value: true } },
  ] },
  { id: 'raster.colour-tonal-area-fill', name: 'Colour tonal area fill', group: 'raster', worker: true, controls: [
    { key: 'colourCount', label: 'Palette colours', type: 'range', min: 2, max: 12, step: 1, default: 6 },
    { key: 'minRegionPixels', label: 'Minimum colour region', type: 'number', min: 1, max: 10000, step: 1, unit: 'px', default: 12 },
    { key: 'skipPaper', label: 'Leave pale paper unplotted', type: 'boolean', default: true },
    { key: 'paperCutoff', label: 'Paper brightness', type: 'range', min: 70, max: 100, step: 1, unit: '%', default: 90, visibleWhen: { key: 'skipPaper', value: true } },
    { key: 'cleanEdges', label: 'Clean isolated colour speckles', type: 'boolean', default: true },
    { key: 'levels', label: 'Tone levels per colour', type: 'range', min: 1, max: 6, step: 1, default: 3 },
    { key: 'highlightThreshold', label: 'Lightest filled tone', type: 'range', min: 80, max: 255, step: 1, default: 250 },
    { key: 'shadowThreshold', label: 'Darkest tone', type: 'range', min: 0, max: 220, step: 1, default: 70 },
    { key: 'spacing', label: 'Fill spacing', type: 'range', min: 0.2, max: 5, step: 0.05, unit: 'mm', default: 0.55 },
    { key: 'angle', label: 'First fill angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 45 },
    { key: 'angleStep', label: 'Angle between tones', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 60 },
    { key: 'closeRadius', label: 'Close small gaps', type: 'range', min: 0, max: 4, step: 1, unit: 'px', default: 1 },
    { key: 'minimumRegionPixels', label: 'Minimum tonal area', type: 'number', min: 1, max: 10000, step: 1, unit: 'px', default: 4 },
    { key: 'minimumStroke', label: 'Minimum fill stroke', type: 'range', min: 0, max: 5, step: 0.05, unit: 'mm', default: 0.2 },
    { key: 'includeContours', label: 'Trace detail edges per colour', type: 'boolean', default: true },
    { key: 'edgeThreshold', label: 'Detail edge threshold', type: 'range', min: 10, max: 240, step: 1, default: 55, visibleWhen: { key: 'includeContours', value: true } },
    { key: 'minimumContourLength', label: 'Minimum edge length', type: 'range', min: 0, max: 20, step: 0.25, unit: 'mm', default: 0.5, visibleWhen: { key: 'includeContours', value: true } },
    { key: 'contourSimplification', label: 'Edge smoothing', type: 'range', min: 0, max: 2, step: 0.05, unit: 'mm', default: 0.12, visibleWhen: { key: 'includeContours', value: true } },
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
  { id: 'raster.scanlines', name: 'Scanlines', group: 'raster', worker: true, controls: [
    { key: 'style', label: 'Tone style', type: 'select', options: [{ value: 'waves', label: 'Waves' }, { value: 'blocks', label: 'Blocks' }], default: 'waves' },
    { key: 'spacing', label: 'Line spacing', type: 'range', min: 0.5, max: 8, step: 0.25, unit: 'mm', default: 2 },
    { key: 'angle', label: 'Line angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 0 },
    { key: 'maximumWidth', label: 'Maximum tone width', type: 'range', min: 0, max: 7, step: 0.05, unit: 'mm', default: 1.2 },
    { key: 'minimumWidth', label: 'Minimum wave width', type: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', default: 0, visibleWhen: { key: 'style', value: 'waves' } },
    { key: 'waveLength', label: 'Wave length', type: 'range', min: 0.5, max: 20, step: 0.1, unit: 'mm', default: 3.7, visibleWhen: { key: 'style', value: 'waves' } },
    { key: 'phase', label: 'Wave phase', type: 'range', min: 0, max: 360, step: 1, unit: '°', default: 0, visibleWhen: { key: 'style', value: 'waves' } },
    { key: 'blockSpacing', label: 'Block spacing', type: 'range', min: 0.15, max: 5, step: 0.05, unit: 'mm', default: 0.55, visibleWhen: { key: 'style', value: 'blocks' } },
    { key: 'minimumGap', label: 'Minimum line gap', type: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', default: 0.35 },
    { key: 'sampleStep', label: 'Curve resolution', type: 'range', min: 0.1, max: 2.5, step: 0.05, unit: 'mm', default: 0.45, visibleWhen: { key: 'style', value: 'waves' } },
    { key: 'smoothing', label: 'Tone smoothing', type: 'range', min: 0, max: 8, step: 0.1, unit: 'mm', default: 0.6 },
    { key: 'shadowThreshold', label: 'Shadow threshold', type: 'range', min: 0, max: 220, step: 1, default: 35 },
    { key: 'highlightThreshold', label: 'Highlight threshold', type: 'range', min: 35, max: 255, step: 1, default: 225 },
    { key: 'skipWhiteAreas', label: 'Skip white / blank areas', type: 'boolean', default: false },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.3, max: 3, step: 0.05, default: 0.9 },
  ] },
  { id: 'raster.paint-scanlines', name: 'Paint · pressure scanlines', group: 'raster', worker: true, controls: [
    { key: 'style', label: 'Tone style', type: 'select', options: [{ value: 'waves', label: 'Waves' }, { value: 'blocks', label: 'Blocks' }], default: 'waves' },
    { key: 'spacing', label: 'Line spacing', type: 'range', min: 0.5, max: 12, step: 0.25, unit: 'mm', default: 3 },
    { key: 'angle', label: 'Line angle', type: 'range', min: 0, max: 180, step: 1, unit: '°', default: 0 },
    { key: 'maximumWidth', label: 'Maximum tone width', type: 'range', min: 0, max: 10, step: 0.05, unit: 'mm', default: 2 },
    { key: 'minimumWidth', label: 'Minimum wave width', type: 'range', min: 0, max: 5, step: 0.05, unit: 'mm', default: 0, visibleWhen: { key: 'style', value: 'waves' } },
    { key: 'waveLength', label: 'Wave length', type: 'range', min: 0.5, max: 25, step: 0.1, unit: 'mm', default: 5 },
    { key: 'phase', label: 'Wave phase', type: 'range', min: 0, max: 360, step: 1, unit: '°', default: 0 },
    { key: 'blockSpacing', label: 'Block spacing', type: 'range', min: 0.15, max: 5, step: 0.05, unit: 'mm', default: 0.8 },
    { key: 'minimumGap', label: 'Minimum line gap', type: 'range', min: 0, max: 5, step: 0.05, unit: 'mm', default: 0.5 },
    { key: 'sampleStep', label: 'Curve resolution', type: 'range', min: 0.1, max: 2.5, step: 0.05, unit: 'mm', default: 0.55 },
    { key: 'smoothing', label: 'Tone smoothing', type: 'range', min: 0, max: 8, step: 0.1, unit: 'mm', default: 0.8 },
    { key: 'shadowThreshold', label: 'Shadow threshold', type: 'range', min: 0, max: 220, step: 1, default: 35 },
    { key: 'highlightThreshold', label: 'Highlight threshold', type: 'range', min: 35, max: 255, step: 1, default: 225 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.3, max: 3, step: 0.05, default: 0.9 },
    { key: 'minimumPressure', label: 'Highlight pressure', type: 'range', min: 0, max: 1, step: 0.05, default: 0.1 },
    { key: 'maximumPressure', label: 'Shadow pressure', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
    { key: 'pressurePower', label: 'Pressure response', type: 'range', min: 0.3, max: 3, step: 0.05, default: 1 },
  ] },
  { id: 'raster.spiroglyph', name: 'Spiroglyph', group: 'raster', worker: true, controls: [
    { key: 'spiralCount', label: 'Interleaved spirals', type: 'select', options: [{ value: '1', label: 'Single' }, { value: '2', label: 'Double' }, { value: '3', label: 'Three' }, { value: '4', label: 'Four' }, { value: '5', label: 'Five' }, { value: '6', label: 'Six' }], default: '1' },
    { key: 'lineSpacing', label: 'Line spacing', type: 'range', min: 0.5, max: 8, step: 0.1, unit: 'mm', default: 1.8 },
    { key: 'frequency', label: 'Wave frequency', type: 'range', min: 4, max: 160, step: 1, default: 48 },
    { key: 'amplitude', label: 'Maximum wave width', type: 'range', min: 0, max: 6, step: 0.05, unit: 'mm', default: 0.75 },
    { key: 'minimumGap', label: 'Minimum line gap', type: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', default: 0.25 },
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
  { id: 'raster.spiral-blocks', name: 'Spiral blocks', group: 'raster', worker: true, controls: [
    { key: 'spiralCount', label: 'Interleaved spirals', type: 'select', options: [{ value: '1', label: 'Single' }, { value: '2', label: 'Double' }, { value: '3', label: 'Three' }, { value: '4', label: 'Four' }, { value: '5', label: 'Five' }, { value: '6', label: 'Six' }], default: '1' },
    { key: 'lineSpacing', label: 'Line spacing', type: 'range', min: 0.6, max: 8, step: 0.1, unit: 'mm', default: 2.2 },
    { key: 'blockSpacing', label: 'Block spacing', type: 'range', min: 0.15, max: 3, step: 0.05, unit: 'mm', default: 0.4 },
    { key: 'blockWidth', label: 'Maximum block width', type: 'range', min: 0, max: 7, step: 0.05, unit: 'mm', default: 1.75 },
    { key: 'minimumGap', label: 'Minimum line gap', type: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', default: 0.35 },
    { key: 'smoothing', label: 'Tone smoothing', type: 'range', min: 0, max: 8, step: 0.1, unit: 'mm', default: 0.8 },
    { key: 'shadowThreshold', label: 'Shadow threshold', type: 'range', min: 0, max: 220, step: 1, default: 35 },
    { key: 'highlightThreshold', label: 'Highlight threshold', type: 'range', min: 35, max: 255, step: 1, default: 225 },
    { key: 'tonePower', label: 'Tone response', type: 'range', min: 0.3, max: 3, step: 0.05, default: 0.85 },
    { key: 'innerRadius', label: 'Centre opening', type: 'range', min: 0, max: 25, step: 0.5, unit: 'mm', default: 1.5 },
    { key: 'rotation', label: 'Start angle', type: 'range', min: -180, max: 180, step: 1, unit: '°', default: -90 },
    { key: 'centreX', label: 'Centre offset X', type: 'range', min: -40, max: 40, step: 0.5, unit: 'mm', default: 0 },
    { key: 'centreY', label: 'Centre offset Y', type: 'range', min: -40, max: 40, step: 0.5, unit: 'mm', default: 0 },
    { key: 'shape', label: 'Spiral shape', type: 'select', options: [{ value: 'ellipse', label: 'Fit safe area' }, { value: 'circle', label: 'Circle' }], default: 'ellipse' },
    { key: 'direction', label: 'Direction', type: 'select', options: [{ value: 'outward', label: 'Centre outward' }, { value: 'inward', label: 'Edge inward' }], default: 'outward' },
  ] },
  { id: 'generative.flow-field', name: 'Flow field', group: 'generative', controls: [
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 7421 },
    { key: 'fieldStyle', label: 'Field shape', type: 'select', options: [
      { value: 'organic', label: 'Organic currents' },
      { value: 'rain', label: 'Static rain' },
      { value: 'waterfall', label: 'Waterfall' },
      { value: 'radial', label: 'Radial burst' },
      { value: 'vortex', label: 'Vortex' },
      { value: 'four-vortex', label: 'Four-way vortex' },
      { value: 'diamond', label: 'Diamond saddle' },
      { value: 'magnetic', label: 'Magnetic field' },
    ], default: 'organic' },
    { key: 'particles', label: 'Particles', type: 'range', min: 20, max: 1200, step: 10, default: 280 },
    { key: 'steps', label: 'Steps', type: 'range', min: 10, max: 250, step: 5, default: 70 },
    { key: 'stepSize', label: 'Step size', type: 'range', min: 0.2, max: 5, step: 0.1, unit: 'mm', default: 1.5 },
    { key: 'fieldScale', label: 'Field scale', type: 'range', min: 5, max: 100, step: 1, unit: 'mm', default: 35 },
    { key: 'trailStyle', label: 'Trail style', type: 'select', options: [
      { value: 'continuous', label: 'Continuous lines' },
      { value: 'dashes', label: 'Broken particle trails' },
    ], default: 'dashes' },
    { key: 'dashLength', label: 'Stroke length', type: 'range', min: 0.4, max: 12, step: 0.2, unit: 'mm', default: 3.2, visibleWhen: { key: 'trailStyle', value: 'dashes' } },
    { key: 'dashGap', label: 'Gap between strokes', type: 'range', min: 0.2, max: 12, step: 0.2, unit: 'mm', default: 1.2, visibleWhen: { key: 'trailStyle', value: 'dashes' } },
    { key: 'colourMode', label: 'Colour arrangement', type: 'select', options: [
      { value: 'cycle', label: 'Cycle pen passes' },
      { value: 'random', label: 'Random per trail' },
      { value: 'single', label: 'Single pen' },
    ], default: 'cycle' },
  ] },
  { id: 'generative.truchet', name: 'Truchet tiles', group: 'generative', controls: [
    { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, step: 1, default: 33881 },
    { key: 'tileSize', label: 'Tile size', type: 'range', min: 4, max: 40, step: 1, unit: 'mm', default: 14 },
    { key: 'density', label: 'Density', type: 'range', min: 0.1, max: 1, step: 0.05, default: 0.9 },
    { key: 'lineCount', label: 'Lines per band', type: 'range', min: 1, max: 9, step: 1, default: 1 },
    { key: 'lineSpacing', label: 'Line spacing', type: 'range', min: 0.2, max: 4, step: 0.1, unit: 'mm', default: 1.2 },
    { key: 'colourMode', label: 'Colour arrangement', type: 'select', options: [
      { value: 'curves', label: 'Alternate curves' },
      { value: 'lines', label: 'Alternate parallel lines' },
      { value: 'tiles', label: 'Alternate tiles' },
      { value: 'random', label: 'Random by tile' },
      { value: 'single', label: 'Single colour' },
    ], default: 'curves' },
    { key: 'mirror', label: 'Mirror symmetry', type: 'select', options: [
      { value: 'none', label: 'None' },
      { value: 'horizontal', label: 'Left ↔ right' },
      { value: 'vertical', label: 'Top ↔ bottom' },
      { value: 'both', label: 'Four-way' },
    ], default: 'none' },
    { key: 'variation', label: 'Orientation variation', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
  ] },
  { id: 'generative.guilloche', name: 'Guilloché', group: 'generative', controls: [
    { key: 'design', label: 'Pattern design', type: 'select', options: [
      { value: 'rose', label: 'Rose engine' },
      { value: 'barleycorn', label: 'Barleycorn weave' },
      { value: 'moire', label: 'Moiré rosette' },
      { value: 'petal', label: 'Petal wheel' },
      { value: 'spirograph', label: 'Spirograph' },
      { value: 'spiral', label: 'Spiral vortex' },
    ], default: 'rose' },
    { key: 'frequency', label: 'Frequency', type: 'range', min: 2, max: 32, step: 1, default: 11 },
    { key: 'lobes', label: 'Lobes', type: 'range', min: 2, max: 24, step: 1, default: 7 },
    { key: 'amplitude', label: 'Amplitude', type: 'range', min: 1, max: 30, step: 0.5, unit: 'mm', default: 12 },
    { key: 'rings', label: 'Pattern lines', type: 'range', min: 1, max: 32, step: 1, default: 10 },
    { key: 'lineCount', label: 'Parallel lines per curve', type: 'range', min: 1, max: 8, step: 1, default: 2 },
    { key: 'lineSpacing', label: 'Parallel line spacing', type: 'range', min: 0.2, max: 3, step: 0.1, unit: 'mm', default: 0.7 },
    { key: 'colourMode', label: 'Colour arrangement', type: 'select', options: [
      { value: 'rings', label: 'Alternate pattern lines' },
      { value: 'parallel', label: 'Cycle parallel passes' },
      { value: 'segments', label: 'Colour curve segments' },
      { value: 'single', label: 'Single pen' },
    ], default: 'rings' },
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

function dashPolyline(points: Point[], dashLength: number, gapLength: number): Point[][] {
  if (points.length < 2) return [];
  const dash = Math.max(0.05, dashLength);
  const cycle = dash + Math.max(0, gapLength);
  const segments: Point[][] = [];
  let segment: Point[] = [];
  let distance = 0;
  const flush = () => {
    if (segment.length > 1) segments.push(segment);
    segment = [];
  };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-8) continue;
    let along = 0;
    while (along < length - 1e-8) {
      const phase = (distance + along) % cycle;
      const drawing = phase < dash;
      const boundary = drawing ? dash - phase : cycle - phase;
      const amount = Math.min(length - along, Math.max(1e-6, boundary));
      const from = along / length;
      const to = (along + amount) / length;
      const first = { x: start.x + dx * from, y: start.y + dy * from };
      const last = { x: start.x + dx * to, y: start.y + dy * to };
      if (drawing) {
        if (!segment.length) segment.push(first);
        segment.push(last);
      } else flush();
      along += amount;
    }
    distance += length;
  }
  flush();
  return segments;
}

function greatestCommonDivisor(first: number, second: number): number {
  let a = Math.abs(Math.trunc(first));
  let b = Math.abs(Math.trunc(second));
  while (b) [a, b] = [b, a % b];
  return Math.max(1, a);
}

/** Attach normalised, tone-driven brush pressure without changing XY geometry. */
export function addPaintPressure(
  source: PlotGeometry,
  sample: (x: number, y: number) => number,
  settings: Record<string, number | string | boolean>,
  generator: string,
): PlotGeometry {
  const minimum = Math.max(0, Math.min(1, numberSetting(settings, 'minimumPressure', 0.1)));
  const maximum = Math.max(minimum, Math.min(1, numberSetting(settings, 'maximumPressure', 1)));
  const power = Math.max(0.05, numberSetting(settings, 'pressurePower', 1));
  return {
    ...source,
    generator,
    paths: source.paths.map((item) => ({
      ...item,
      points: item.points.map((point) => {
        const luminance = Math.max(0, Math.min(255, sample(point.x, point.y)));
        const tone = Math.pow(1 - luminance / 255, power);
        return { ...point, pressure: minimum + (maximum - minimum) * tone };
      }),
    })),
  };
}

export type SpiroglyphSample = (x: number, y: number) => number;

type SpiralSamplePoint = {
  point: Point;
  progress: number;
  angle: number;
  radial: Point;
};

function sampleSpiral(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  radialClearance: number,
  sampleStep: number,
): { points: SpiralSamplePoint[]; turns: number } | undefined {
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 1.8));
  const innerRadius = Math.max(0, numberSetting(settings, 'innerRadius', 1.5));
  const rotation = numberSetting(settings, 'rotation', -90) * Math.PI / 180;
  const centreX = (bounds.minX + bounds.maxX) / 2 + numberSetting(settings, 'centreX', 0);
  const centreY = (bounds.minY + bounds.maxY) / 2 + numberSetting(settings, 'centreY', 0);
  const halfWidth = Math.max(0, Math.min(centreX - bounds.minX, bounds.maxX - centreX));
  const halfHeight = Math.max(0, Math.min(centreY - bounds.minY, bounds.maxY - centreY));
  const circularRadius = Math.min(halfWidth, halfHeight);
  const radiusX = String(settings.shape ?? 'ellipse') === 'circle' ? circularRadius : halfWidth;
  const radiusY = String(settings.shape ?? 'ellipse') === 'circle' ? circularRadius : halfHeight;
  const limitingRadius = Math.min(radiusX, radiusY);
  const usableRadius = Math.max(0, limitingRadius - radialClearance - 0.05);
  if (usableRadius <= innerRadius || radiusX <= 0 || radiusY <= 0 || limitingRadius <= 0) return undefined;

  const turns = Math.max(1, (usableRadius - innerRadius) / spacing);
  const maximumAngle = turns * Math.PI * 2;
  const scaleX = radiusX / limitingRadius;
  const scaleY = radiusY / limitingRadius;
  const inward = String(settings.direction ?? 'outward') === 'inward';
  const radialRange = usableRadius - innerRadius;
  const points: SpiralSamplePoint[] = [];
  let progress = 0;

  // Advance by physical distance rather than fixed angle. Fixed-angle sampling
  // oversamples the centre and loses image detail toward the outer turns.
  while (progress < 1 && points.length < 220_000) {
    const radialProgress = inward ? 1 - progress : progress;
    const angle = rotation + progress * maximumAngle;
    const radius = innerRadius + radialProgress * radialRange;
    const radialX = Math.cos(angle) * scaleX;
    const radialY = Math.sin(angle) * scaleY;
    const radialLength = Math.hypot(radialX, radialY) || 1;
    points.push({
      point: { x: centreX + radialX * radius, y: centreY + radialY * radius },
      progress,
      angle,
      radial: { x: radialX / radialLength, y: radialY / radialLength },
    });

    const radialDerivative = inward ? -radialRange : radialRange;
    const dx = scaleX * (Math.cos(angle) * radialDerivative - Math.sin(angle) * radius * maximumAngle);
    const dy = scaleY * (Math.sin(angle) * radialDerivative + Math.cos(angle) * radius * maximumAngle);
    const speed = Math.max(0.001, Math.hypot(dx, dy));
    const maximumProgressStep = 1 / (turns * 32);
    progress = Math.min(1, progress + Math.min(maximumProgressStep, Math.max(1e-7, sampleStep / speed)));
  }

  if (points.at(-1)?.progress !== 1) {
    const angle = rotation + maximumAngle;
    const radius = inward ? innerRadius : usableRadius;
    const radialX = Math.cos(angle) * scaleX;
    const radialY = Math.sin(angle) * scaleY;
    const radialLength = Math.hypot(radialX, radialY) || 1;
    points.push({ point: { x: centreX + radialX * radius, y: centreY + radialY * radius }, progress: 1, angle, radial: { x: radialX / radialLength, y: radialY / radialLength } });
  }
  return { points, turns };
}

function smoothTones(rawTone: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return rawTone;
  const tones = new Float32Array(rawTone.length);
  const prefix = new Float64Array(rawTone.length + 1);
  for (let index = 0; index < rawTone.length; index += 1) prefix[index + 1] = prefix[index]! + rawTone[index]!;
  for (let index = 0; index < rawTone.length; index += 1) {
    const from = Math.max(0, index - radius);
    const to = Math.min(rawTone.length - 1, index + radius);
    tones[index] = (prefix[to + 1]! - prefix[from]!) / (to - from + 1);
  }
  return tones;
}

function interleavedSpiralSettings(
  settings: Record<string, number | string | boolean>,
): Record<string, number | string | boolean>[] {
  const count = Math.max(1, Math.min(6, Math.round(numberSetting(settings, 'spiralCount', 1))));
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 1.8));
  const rotation = numberSetting(settings, 'rotation', -90);
  return Array.from({ length: count }, (_, index) => ({
    ...settings,
    // Wider individual pitches plus angular offsets keep the requested visible
    // spacing between every neighboring arm.
    lineSpacing: spacing * count,
    rotation: rotation + index * 360 / count,
  }));
}

function spiralPassIds(passIds: string | string[]): string[] {
  if (Array.isArray(passIds)) return passIds.length ? passIds : ['pass-1'];
  return [passIds];
}

function scanlineRange(bounds: Bounds, origin: Point, direction: Point): [number, number] | undefined {
  let from = Number.NEGATIVE_INFINITY;
  let to = Number.POSITIVE_INFINITY;
  const clipAxis = (coordinate: number, delta: number, minimum: number, maximum: number) => {
    if (Math.abs(delta) < 1e-9) return coordinate >= minimum && coordinate <= maximum;
    const first = (minimum - coordinate) / delta;
    const second = (maximum - coordinate) / delta;
    from = Math.max(from, Math.min(first, second));
    to = Math.min(to, Math.max(first, second));
    return from <= to;
  };
  if (!clipAxis(origin.x, direction.x, bounds.minX, bounds.maxX)) return undefined;
  if (!clipAxis(origin.y, direction.y, bounds.minY, bounds.maxY)) return undefined;
  return [from, to];
}

/**
 * Encodes image tone on parallel lines using either a continuous wave or
 * perpendicular out-and-back blocks. Width is capped so adjacent lines retain
 * the requested clear gap.
 */
export function generateScanlines(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  sample: SpiroglyphSample,
  passId = 'pass-1',
): PlotGeometry {
  const style = String(settings.style ?? 'waves');
  const spacing = Math.max(0.25, numberSetting(settings, 'spacing', 2));
  const minimumGap = Math.max(0, numberSetting(settings, 'minimumGap', 0.35));
  const maximumWidth = Math.min(Math.max(0, numberSetting(settings, 'maximumWidth', 1.2)), Math.max(0, spacing - minimumGap));
  const maximumExcursion = maximumWidth / 2;
  const minimumWidth = Math.min(maximumWidth, Math.max(0, numberSetting(settings, 'minimumWidth', 0)));
  const shadowThreshold = Math.max(0, Math.min(254, numberSetting(settings, 'shadowThreshold', 35)));
  const highlightThreshold = Math.max(shadowThreshold + 1, Math.min(255, numberSetting(settings, 'highlightThreshold', 225)));
  const tonePower = Math.max(0.05, numberSetting(settings, 'tonePower', 0.9));
  const skipWhiteAreas = Boolean(settings.skipWhiteAreas ?? false);
  const angle = numberSetting(settings, 'angle', 0) * Math.PI / 180;
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  const corners = [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ];
  const projections = corners.map(point => (point.x - centre.x) * normal.x + (point.y - centre.y) * normal.y);
  const minimumOffset = Math.min(...projections);
  const maximumOffset = Math.max(...projections);
  const firstOffset = Math.ceil(minimumOffset / spacing) * spacing;
  const sampleDistance = style === 'blocks'
    ? Math.max(0.1, numberSetting(settings, 'blockSpacing', 0.55))
    : Math.max(0.1, numberSetting(settings, 'sampleStep', 0.45));
  const smoothingRadius = Math.max(0, Math.round(numberSetting(settings, 'smoothing', 0.6) / sampleDistance));
  const waveLength = Math.max(0.1, numberSetting(settings, 'waveLength', 3.7));
  const phase = numberSetting(settings, 'phase', 0) * Math.PI / 180;
  const paths: PlotPath[] = [];
  let row = 0;

  for (let offset = firstOffset; offset <= maximumOffset + 1e-6; offset += spacing) {
    const origin = { x: centre.x + normal.x * offset, y: centre.y + normal.y * offset };
    const range = scanlineRange(bounds, origin, direction);
    if (!range || range[1] - range[0] < 0.05) continue;
    const distances: number[] = [];
    for (let distance = range[0]; distance < range[1]; distance += sampleDistance) distances.push(distance);
    distances.push(range[1]);
    const rawTone = new Float32Array(distances.length);
    for (let index = 0; index < distances.length; index += 1) {
      const distance = distances[index]!;
      const luminance = Math.max(0, Math.min(255, sample(origin.x + direction.x * distance, origin.y + direction.y * distance)));
      rawTone[index] = Math.pow(Math.max(0, Math.min(1, (highlightThreshold - luminance) / (highlightThreshold - shadowThreshold))), tonePower);
    }
    const tones = smoothTones(rawTone, smoothingRadius);
    let points: Point[] = [];
    let segment = 0;
    const finishSegment = () => {
      if (points.length > 1) paths.push(path(`scanline-${row}-${segment}`, points, passId, 'primary'));
      points = [];
      segment += 1;
    };
    for (let index = 0; index < distances.length; index += 1) {
      const distance = distances[index]!;
      const baseline = { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance };
      const tone = tones[index] ?? 0;
      const hasTone = tone > 0.002;
      if (skipWhiteAreas && !hasTone) {
        finishSegment();
        continue;
      }
      if (style === 'blocks') {
        points.push(baseline);
        if (hasTone && maximumExcursion > 0) {
          const side = (index + row) % 2 === 0 ? 1 : -1;
          const excursion = maximumExcursion * tone * side;
          points.push({
            x: Math.max(bounds.minX, Math.min(bounds.maxX, baseline.x + normal.x * excursion)),
            y: Math.max(bounds.minY, Math.min(bounds.maxY, baseline.y + normal.y * excursion)),
          });
          points.push(baseline);
        }
      } else {
        const width = tone <= 0 ? 0 : minimumWidth + (maximumWidth - minimumWidth) * tone;
        const excursion = Math.sin(distance / waveLength * Math.PI * 2 + phase) * width / 2;
        points.push({
          x: Math.max(bounds.minX, Math.min(bounds.maxX, baseline.x + normal.x * excursion)),
          y: Math.max(bounds.minY, Math.min(bounds.maxY, baseline.y + normal.y * excursion)),
        });
      }
    }
    finishSegment();
    row += 1;
  }

  return geometry('raster.scanlines', paths);
}

/**
 * Turns a luminance sampler into one or more interleaved, plotter-friendly
 * Archimedean spirals.
 * Image tone controls a high-frequency radial wave: dark areas widen the wave,
 * while highlights settle back onto the underlying spiral.
 */
function generateSpiroglyphArm(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  sample: SpiroglyphSample,
  passId = 'pass-1',
): PlotGeometry {
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 1.8));
  const frequency = Math.max(1, numberSetting(settings, 'frequency', 48));
  const minimumGap = Math.max(0, numberSetting(settings, 'minimumGap', 0.25));
  const requestedAmplitude = Math.max(0, numberSetting(settings, 'amplitude', 0.75));
  const maximumAmplitude = Math.min(requestedAmplitude, Math.max(0, (spacing - minimumGap) / 2));
  const minimumAmplitude = Math.min(maximumAmplitude, Math.max(0, numberSetting(settings, 'minimumAmplitude', 0)));
  const sampleStep = Math.max(0.1, numberSetting(settings, 'sampleStep', 0.55));
  const smoothing = Math.max(0, Math.round(numberSetting(settings, 'smoothing', 8)));
  const shadowThreshold = Math.max(0, Math.min(254, numberSetting(settings, 'shadowThreshold', 45)));
  const highlightThreshold = Math.max(shadowThreshold + 1, Math.min(255, numberSetting(settings, 'highlightThreshold', 220)));
  const tonePower = Math.max(0.05, numberSetting(settings, 'tonePower', 1));
  const phase = numberSetting(settings, 'phase', 0) * Math.PI / 180;
  const spiral = sampleSpiral(bounds, settings, maximumAmplitude, sampleStep);
  if (!spiral) return geometry('raster.spiroglyph', []);
  const rawTone = new Float32Array(spiral.points.length);

  for (let index = 0; index < spiral.points.length; index += 1) {
    const point = spiral.points[index]!.point;
    const luminance = Math.max(0, Math.min(255, sample(point.x, point.y)));
    rawTone[index] = Math.pow(Math.max(0, Math.min(1, (highlightThreshold - luminance) / (highlightThreshold - shadowThreshold))), tonePower);
  }

  const tones = smoothTones(rawTone, smoothing);

  const points = spiral.points.map((spiralPoint, index) => {
    const tone = tones[index] ?? 0;
    const amplitude = tone <= 0 ? 0 : minimumAmplitude + (maximumAmplitude - minimumAmplitude) * tone;
    const wave = Math.sin(spiralPoint.progress * spiral.turns * Math.PI * 2 * frequency + phase) * amplitude;
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, spiralPoint.point.x + spiralPoint.radial.x * wave)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, spiralPoint.point.y + spiralPoint.radial.y * wave)),
    };
  });

  return geometry('raster.spiroglyph', [{ id: 'spiroglyph-0', points, passId, layerId: 'layer-1', channel: 'primary' }]);
}

export function generateSpiroglyph(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  sample: SpiroglyphSample,
  passIds: string | string[] = 'pass-1',
): PlotGeometry {
  const passes = spiralPassIds(passIds);
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 1.8));
  const minimumGap = Math.max(0, numberSetting(settings, 'minimumGap', 0.25));
  const safeAmplitude = Math.min(
    Math.max(0, numberSetting(settings, 'amplitude', 0.75)),
    Math.max(0, (spacing - minimumGap) / 2),
  );
  const paths = interleavedSpiralSettings(settings).flatMap((armSettings, armIndex) => {
    const result = generateSpiroglyphArm(bounds, { ...armSettings, amplitude: safeAmplitude }, sample, passes[armIndex % passes.length]);
    return result.paths.map(item => ({ ...item, id: `spiroglyph-${armIndex}`, channel: `spiral-${armIndex + 1}` }));
  });
  return geometry('raster.spiroglyph', paths);
}

/**
 * Encodes tone as alternating radial excursions from one or more continuous,
 * interleaved spirals.
 * The result behaves like a dense sequence of blocks in shadows, but remains a
 * single uninterrupted pen path and reserves a configurable gap between turns.
 */
function generateSpiralBlocksArm(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  sample: SpiroglyphSample,
  passId = 'pass-1',
): PlotGeometry {
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 2.2));
  const blockSpacing = Math.max(0.1, numberSetting(settings, 'blockSpacing', 0.4));
  const minimumGap = Math.max(0, numberSetting(settings, 'minimumGap', 0.35));
  const blockWidth = Math.min(Math.max(0, numberSetting(settings, 'blockWidth', 1.75)), Math.max(0, spacing - minimumGap));
  const shadowThreshold = Math.max(0, Math.min(254, numberSetting(settings, 'shadowThreshold', 35)));
  const highlightThreshold = Math.max(shadowThreshold + 1, Math.min(255, numberSetting(settings, 'highlightThreshold', 225)));
  const tonePower = Math.max(0.05, numberSetting(settings, 'tonePower', 0.85));
  const smoothingRadius = Math.max(0, Math.round(numberSetting(settings, 'smoothing', 0.8) / blockSpacing));
  const spiral = sampleSpiral(bounds, settings, blockWidth / 2, blockSpacing);
  if (!spiral) return geometry('raster.spiral-blocks', []);

  const rawTone = new Float32Array(spiral.points.length);
  for (let index = 0; index < spiral.points.length; index += 1) {
    const point = spiral.points[index]!.point;
    const luminance = Math.max(0, Math.min(255, sample(point.x, point.y)));
    rawTone[index] = Math.pow(Math.max(0, Math.min(1, (highlightThreshold - luminance) / (highlightThreshold - shadowThreshold))), tonePower);
  }
  const tones = smoothTones(rawTone, smoothingRadius);
  const points: Point[] = [];
  for (let index = 0; index < spiral.points.length; index += 1) {
    const spiralPoint = spiral.points[index]!;
    const tone = tones[index] ?? 0;
    points.push(spiralPoint.point);
    if (tone <= 0.002 || blockWidth <= 0) continue;
    const side = index % 2 === 0 ? 1 : -1;
    const excursion = blockWidth * tone / 2 * side;
    points.push({
      x: Math.max(bounds.minX, Math.min(bounds.maxX, spiralPoint.point.x + spiralPoint.radial.x * excursion)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, spiralPoint.point.y + spiralPoint.radial.y * excursion)),
    });
    points.push(spiralPoint.point);
  }

  return geometry('raster.spiral-blocks', [{ id: 'spiral-blocks-0', points, passId, layerId: 'layer-1', channel: 'primary' }]);
}

export function generateSpiralBlocks(
  bounds: Bounds,
  settings: Record<string, number | string | boolean>,
  sample: SpiroglyphSample,
  passIds: string | string[] = 'pass-1',
): PlotGeometry {
  const passes = spiralPassIds(passIds);
  const spacing = Math.max(0.25, numberSetting(settings, 'lineSpacing', 2.2));
  const minimumGap = Math.max(0, numberSetting(settings, 'minimumGap', 0.35));
  const safeBlockWidth = Math.min(
    Math.max(0, numberSetting(settings, 'blockWidth', 1.75)),
    Math.max(0, spacing - minimumGap),
  );
  const paths = interleavedSpiralSettings(settings).flatMap((armSettings, armIndex) => {
    const result = generateSpiralBlocksArm(bounds, { ...armSettings, blockWidth: safeBlockWidth }, sample, passes[armIndex % passes.length]);
    return result.paths.map(item => ({ ...item, id: `spiral-blocks-${armIndex}`, channel: `spiral-${armIndex + 1}` }));
  });
  return geometry('raster.spiral-blocks', paths);
}

function arc(cx: number, cy: number, radius: number, from: number, to: number, segments = 16): Point[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / segments;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

function truchetRandom(seed: number, column: number, row: number, salt: number): number {
  let value = (Math.trunc(seed) ^ Math.imul(column + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
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
  if (id === ISOMETRIC_MAZE.id) return generateIsometricMaze(canvas, settings, passIds);
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
    const seed = numberSetting(settings, 'seed', 7421);
    const particles = Math.max(1, Math.min(1200, Math.round(numberSetting(settings, 'particles', 280))));
    const steps = Math.max(1, Math.min(250, Math.round(numberSetting(settings, 'steps', 70))));
    const stepSize = Math.max(0.05, numberSetting(settings, 'stepSize', 1.5));
    const scale = Math.max(1, numberSetting(settings, 'fieldScale', 35));
    const fieldStyle = String(settings.fieldStyle ?? 'organic');
    const trailStyle = String(settings.trailStyle ?? 'dashes');
    const colourMode = String(settings.colourMode ?? 'cycle');
    const dashLength = Math.max(0.1, numberSetting(settings, 'dashLength', 3.2));
    const dashGap = Math.max(0, numberSetting(settings, 'dashGap', 1.2));
    const colours = passIds.length ? passIds : [primary];
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const fieldAngle = (x: number, y: number) => {
      const dx = x - cx;
      const dy = y - cy;
      const radiusSquared = dx * dx + dy * dy + scale * scale * 0.04;
      if (fieldStyle === 'rain') return Math.PI / 2 + Math.sin(dx / scale + seed * 0.013) * 0.045;
      if (fieldStyle === 'waterfall') return Math.PI / 2 + Math.sin(dx / scale + dy / scale * 0.22) * 0.42 + Math.sin(dx / scale * 1.7) * 0.12;
      if (fieldStyle === 'radial') return Math.atan2(dy, dx);
      if (fieldStyle === 'vortex') return Math.atan2(dy, dx) + Math.PI / 2 + 0.55 * Math.tanh((Math.hypot(dx, dy) - scale * 0.45) / scale);
      if (fieldStyle === 'four-vortex') {
        const px = Math.PI * dx / scale;
        const py = Math.PI * dy / scale;
        return Math.atan2(-Math.cos(px) * Math.sin(py), Math.sin(px) * Math.cos(py));
      }
      if (fieldStyle === 'diamond') return Math.atan2(-dy, dx);
      if (fieldStyle === 'magnetic') {
        const vx = 3 * dx * dy / radiusSquared;
        const vy = (2 * dy * dy - dx * dx) / radiusSquared;
        return Math.atan2(vy, vx);
      }
      return Math.sin(x / scale + seed * 0.013) * Math.PI + Math.cos(y / scale) * Math.PI;
    };
    for (let i = 0; i < particles; i += 1) {
      let x = bounds.minX + random() * (bounds.maxX - bounds.minX);
      let y = bounds.minY + random() * (bounds.maxY - bounds.minY);
      const points: Point[] = [{ x, y }];
      for (let step = 0; step < steps; step += 1) {
        const angle = fieldAngle(x, y);
        x += Math.cos(angle) * stepSize;
        y += Math.sin(angle) * stepSize;
        if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) break;
        points.push({ x, y });
      }
      if (points.length < 2) continue;
      const passIndex = colourMode === 'single'
        ? 0
        : colourMode === 'random'
          ? Math.floor(truchetRandom(seed, i, 0, 9) * colours.length)
          : i % colours.length;
      const trailPass = colours[passIndex] ?? primary;
      const trails = trailStyle === 'dashes' ? dashPolyline(points, dashLength, dashGap) : [points];
      trails.forEach((trail, segment) => paths.push(path(`flow-${i}-${segment}`, trail, trailPass, `flow-${fieldStyle}`)));
    }
  } else if (id === 'generative.truchet') {
    const size = Math.max(1, numberSetting(settings, 'tileSize', 14));
    const seed = numberSetting(settings, 'seed', 33881);
    const density = Math.max(0, Math.min(1, numberSetting(settings, 'density', 0.9)));
    const lineCount = Math.min(9, Math.max(1, Math.round(numberSetting(settings, 'lineCount', 1))));
    const lineSpacing = Math.min(Math.max(0.05, numberSetting(settings, 'lineSpacing', 1.2)), size / lineCount);
    const colourMode = String(settings.colourMode ?? 'curves');
    const mirror = String(settings.mirror ?? 'none');
    const variation = Math.max(0, Math.min(1, numberSetting(settings, 'variation', 1)));
    const colours = passIds.length ? passIds : [primary];
    const columns = Math.floor((bounds.maxX - bounds.minX) / size);
    const rows = Math.floor((bounds.maxY - bounds.minY) / size);
    const mirrorsX = mirror === 'horizontal' || mirror === 'both';
    const mirrorsY = mirror === 'vertical' || mirror === 'both';
    const startX = mirrorsX ? (bounds.minX + bounds.maxX - columns * size) / 2 : bounds.minX;
    const startY = mirrorsY ? (bounds.minY + bounds.maxY - rows * size) / 2 : bounds.minY;
    const passFor = (tile: number, curve: number, line: number, randomValue: number) => {
      if (colourMode === 'single') return colours[0]!;
      if (colourMode === 'lines') return colours[line % colours.length]!;
      if (colourMode === 'tiles') return colours[tile % colours.length]!;
      if (colourMode === 'random') return colours[Math.floor(randomValue * colours.length) % colours.length]!;
      return colours[curve % colours.length]!;
    };
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const mirrorColumn = columns - 1 - column;
        const mirrorRow = rows - 1 - row;
        const keyColumn = mirrorsX ? Math.min(column, mirrorColumn) : column;
        const keyRow = mirrorsY ? Math.min(row, mirrorRow) : row;
        if (truchetRandom(seed, keyColumn, keyRow, 0) > density) continue;
        const randomOrientation = truchetRandom(seed, keyColumn, keyRow, 1) > 0.5;
        const regularOrientation = (keyColumn + keyRow) % 2 === 0;
        const useRandomOrientation = truchetRandom(seed, keyColumn, keyRow, 2) < variation;
        const reflected = (mirrorsX && column > mirrorColumn) !== (mirrorsY && row > mirrorRow);
        const orientation = (useRandomOrientation ? randomOrientation : regularOrientation) !== reflected;
        const tileIndex = row * columns + column;
        const colourTileIndex = keyRow * columns + keyColumn;
        const swapCurveColours = mirrorsY && row > mirrorRow;
        const tileColourRandom = truchetRandom(seed, keyColumn, keyRow, 3);
        const x = startX + column * size;
        const y = startY + row * size;
        for (let line = 0; line < lineCount; line += 1) {
          const radius = size / 2 + (line - (lineCount - 1) / 2) * lineSpacing;
          if (radius <= 0 || radius >= size) continue;
          const first = orientation
            ? arc(x, y, radius, 0, Math.PI / 2)
            : arc(x + size, y, radius, Math.PI / 2, Math.PI);
          const second = orientation
            ? arc(x + size, y + size, radius, Math.PI, Math.PI * 1.5)
            : arc(x, y + size, radius, -Math.PI / 2, 0);
          paths.push(path(`truchet-${tileIndex}-a-${line}`, first, passFor(colourTileIndex, swapCurveColours ? 1 : 0, line, tileColourRandom), `curve-1-line-${line + 1}`));
          paths.push(path(`truchet-${tileIndex}-b-${line}`, second, passFor(colourTileIndex, swapCurveColours ? 0 : 1, line, tileColourRandom), `curve-2-line-${line + 1}`));
        }
      }
    }
  } else if (id === 'generative.guilloche') {
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const maximum = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
    const frequency = Math.max(2, Math.min(32, Math.round(numberSetting(settings, 'frequency', 11))));
    const lobes = Math.max(2, Math.min(24, Math.round(numberSetting(settings, 'lobes', 7))));
    const amplitude = Math.min(maximum * 0.3, Math.max(0.1, numberSetting(settings, 'amplitude', 12)));
    const rings = Math.max(1, Math.min(32, Math.round(numberSetting(settings, 'rings', 10))));
    const lineCount = Math.max(1, Math.min(8, Math.round(numberSetting(settings, 'lineCount', 2))));
    const lineSpacing = Math.max(0.05, Math.min(3, numberSetting(settings, 'lineSpacing', 0.7)));
    const design = String(settings.design ?? 'rose');
    const colourMode = String(settings.colourMode ?? 'rings');
    const colours = passIds.length ? passIds : [primary];
    const parallelHalfWidth = ((lineCount - 1) * lineSpacing) / 2;
    const outerBase = Math.max(2, maximum - amplitude - parallelHalfWidth - 0.2);
    const innerBase = Math.min(outerBase, Math.max(2, amplitude * 0.6 + parallelHalfWidth));
    const samples = 721 + Math.max(0, frequency - 10) * 32;
    for (let ring = 0; ring < rings; ring += 1) {
      const ringBase = rings === 1 ? (outerBase + innerBase) / 2 : outerBase - ring * (outerBase - innerBase) / (rings - 1);
      for (let line = 0; line < lineCount; line += 1) {
        const lineOffset = (line - (lineCount - 1) / 2) * lineSpacing;
        const base = Math.max(1, ringBase + lineOffset);
        const points = Array.from({ length: samples + 1 }, (_, i) => {
          const u = i / samples;
          const phase = ring * Math.PI * 2 / Math.max(1, rings);
          const t = u * Math.PI * 2;
          if (design === 'spiral') {
            const minimumRadius = Math.max(1, innerBase + lineOffset);
            const maximumRadius = Math.max(minimumRadius + 1, outerBase + lineOffset);
            const theta = u * Math.PI * 2 * frequency + phase;
            const radius = minimumRadius + (maximumRadius - minimumRadius) * u + amplitude * 0.12 * Math.sin(u * Math.PI * 2 * lobes + phase);
            return { x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius };
          }
          if (design === 'spirograph') {
            const divisor = greatestCommonDivisor(frequency, lobes);
            const turns = lobes / divisor;
            const theta = u * Math.PI * 2 * turns + phase;
            const fixedRadius = frequency;
            const rollingRadius = lobes;
            const drawRadius = rollingRadius * Math.min(0.95, Math.max(0.1, amplitude / Math.max(maximum, 1) * 1.7));
            const extent = Math.max(0.01, Math.abs(fixedRadius - rollingRadius) + drawRadius);
            const x = (fixedRadius - rollingRadius) * Math.cos(theta) + drawRadius * Math.cos((fixedRadius - rollingRadius) / rollingRadius * theta);
            const y = (fixedRadius - rollingRadius) * Math.sin(theta) - drawRadius * Math.sin((fixedRadius - rollingRadius) / rollingRadius * theta);
            const targetRadius = Math.max(1, base + amplitude * 0.45);
            return { x: cx + x / extent * targetRadius, y: cy + y / extent * targetRadius };
          }
          let wave: number;
          if (design === 'barleycorn') {
            wave = (Math.sin(t * frequency + phase) + 0.68 * Math.cos(t * lobes - phase)) / 1.68;
          } else if (design === 'moire') {
            wave = (Math.sin(t * frequency + phase) * Math.cos(t * lobes) + 0.42 * Math.sin(t * (frequency + 1) - phase)) / 1.42;
          } else if (design === 'petal') {
            wave = Math.cos(t * lobes + phase);
          } else {
            wave = Math.sin(t * frequency + phase) * Math.cos(t * lobes);
          }
          const radius = base + amplitude * wave;
          return { x: cx + Math.cos(t) * radius, y: cy + Math.sin(t) * radius };
        });
        if (colourMode === 'segments' && colours.length > 1) {
          for (let segment = 0; segment < colours.length; segment += 1) {
            const first = Math.floor(segment * points.length / colours.length);
            const last = Math.floor((segment + 1) * points.length / colours.length);
            const colouredCurve = points.slice(first, last + 1);
            if (colouredCurve.length > 1) paths.push(path(`guilloche-${ring}-${line}-segment-${segment}`, colouredCurve, colours[segment]!, `ring-${ring + 1}-line-${line + 1}-segment-${segment + 1}`));
          }
        } else {
          const passIndex = colourMode === 'single' ? 0 : colourMode === 'parallel' ? (ring * lineCount + line) % colours.length : ring % colours.length;
          paths.push(path(`guilloche-${ring}-${line}`, points, colours[passIndex] ?? primary, `ring-${ring + 1}-line-${line + 1}`, design !== 'spiral'));
        }
      }
    }
  }
  return geometry(id, paths);
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
export { generateIsometric, buildIsometricScene, moveIsometricTile, planIsometricCells, matchRoadGlyph, isometricSettings, ISOMETRIC_ALGORITHMS } from './isometric';

export { generateRelief } from './relief';
