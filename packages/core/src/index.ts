export type ProjectMode = 'generative' | 'raster' | 'svg' | 'map';
export type Orientation = 'portrait' | 'landscape';
export type PaperPreset = 'A4' | 'A3' | 'A2' | 'custom';

export interface Point {
  x: number;
  y: number;
}

export interface PlotPath {
  id: string;
  points: Point[];
  closed?: boolean;
  layerId: string;
  passId: string;
  channel?: string;
  /** Preserve intentional gaps in masked fills during G-code optimisation. */
  preserveGaps?: boolean;
}

export interface PlotGeometry {
  paths: PlotPath[];
  generatedAt: string;
  generator: string;
  colourSeparation?: ColourSeparationResult;
}

export interface ColourTreatment {
  enabled: boolean;
  fill: 'hatch' | 'crosshatch' | 'dither' | 'stipple' | 'tonal-dashes' | 'solid' | 'outline' | 'none';
  spacing: number;
  angle: number;
  outline: boolean;
  passId?: string;
  algorithmSettings?: Record<string, number | string | boolean>;
}

export interface ColourSeparationSettings {
  colours: Record<string, Partial<ColourTreatment>>;
  regions: Record<string, Partial<ColourTreatment>>;
}

export interface ColourSeparationResult {
  palette: { id: string; colour: string; pixels: number }[];
  regions: { id: string; colourId: string; pixels: number; x: number; y: number }[];
}

export interface CanvasSettings {
  preset: PaperPreset;
  orientation: Orientation;
  widthMm: number;
  heightMm: number;
  marginMm: number;
}

export interface PenProfile {
  id: string;
  name: string;
  color: string;
  widthMm: number;
  zUp: number;
  zDown: number;
  xyFeed: number;
  /** Feed rate used while lifting the pen. */
  zUpFeed?: number;
  /** Feed rate used while lowering the pen. */
  zDownFeed?: number;
  /** Legacy shared Z feed rate, retained for older saved projects. */
  zFeed?: number;
}

export interface PlotPass {
  id: string;
  name: string;
  penId: string;
  enabled: boolean;
}

export interface SourcePath {
  id: string;
  points: Point[];
  closed: boolean;
}

export interface PlotLayer {
  id: string;
  name: string;
  visible: boolean;
  algorithmId: string;
  passId: string;
  secondaryPassId?: string;
  algorithmSettings?: Record<string, number | string | boolean>;
  sourcePaths?: SourcePath[];
  sourceCategory?: string;
}

export interface MapSettings {
  query: string;
  radiusKm: number;
  dataSource?: 'openstreetmap' | 'terrain' | 'both';
  /** Legacy setting retained so older saved projects can be migrated. */
  includeTopography?: boolean;
  contourInterval?: number;
  latitude?: number;
  longitude?: number;
  zoom?: number;
}

export interface PreprocessSettings {
  brightness: number;
  contrast: number;
  gamma: number;
  blur: number;
  threshold: number;
  invert: boolean;
}

export const DEFAULT_PREPROCESS: PreprocessSettings = {
  brightness: 0,
  contrast: 0,
  gamma: 1,
  blur: 0,
  threshold: 128,
  invert: false,
};

export interface RasterPlacementSettings {
  fit: 'contain' | 'cover' | 'stretch';
  scalePercent: number;
  offsetXmm: number;
  offsetYmm: number;
}

export const DEFAULT_RASTER_PLACEMENT: RasterPlacementSettings = {
  fit: 'contain',
  scalePercent: 100,
  offsetXmm: 0,
  offsetYmm: 0,
};

/** Controls how TurtleToy's 200 × 200 logical drawing space maps to the drawable paper area. */
export interface TurtlePlacementSettings {
  fit: 'contain' | 'cover' | 'stretch';
  scalePercent: number;
  offsetXmm: number;
  offsetYmm: number;
}

export const DEFAULT_TURTLE_PLACEMENT: TurtlePlacementSettings = {
  fit: 'contain',
  scalePercent: 100,
  offsetXmm: 0,
  offsetYmm: 0,
};

export interface GCodeSettings {
  origin: 'top-left' | 'bottom-left';
  travelFeed: number;
  /** Maximum gap (in mm) between smoothly aligned paths that may be plotted without lifting. */
  pathJoinTolerance?: number;
  parkX: number;
  parkY: number;
  pauseBetweenPasses: boolean;
  pauseCommand: string;
  includeComments: boolean;
}

export interface ProjectState {
  canvas: CanvasSettings;
  pens: PenProfile[];
  passes: PlotPass[];
  layers: PlotLayer[];
  geometry: PlotGeometry;
  algorithmId: string;
  algorithmSettings: Record<string, number | string | boolean>;
  preprocess: PreprocessSettings;
  rasterPlacement: RasterPlacementSettings;
  turtlePlacement: TurtlePlacementSettings;
  sourceImage?: string;
  colourSeparation?: ColourSeparationSettings;
  sourceName?: string;
  sourceAttribution?: string;
  mapSettings: MapSettings;
  gcode: GCodeSettings;
  viewport: { zoom: number; x: number; y: number };
}

export interface ProjectSummary {
  id: string;
  name: string;
  mode: ProjectMode;
  widthMm: number;
  heightMm: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project extends ProjectSummary {
  state: ProjectState;
}

export const PAPER_SIZES: Record<Exclude<PaperPreset, 'custom'>, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
};

export function paperDimensions(preset: PaperPreset, orientation: Orientation, custom?: [number, number]): [number, number] {
  const base = preset === 'custom' ? (custom ?? [210, 297]) : PAPER_SIZES[preset];
  const [short, long] = [Math.min(base[0], base[1]), Math.max(base[0], base[1])];
  return orientation === 'portrait' ? [short, long] : [long, short];
}

const defaultPen = (id: string, name: string, color: string): PenProfile => ({
  id,
  name,
  color,
  widthMm: 0.3,
  zUp: 0,
  zDown: -10,
  xyFeed: 2500,
  zUpFeed: 600,
  zDownFeed: 600,
});

export function createDefaultState(mode: ProjectMode, canvas: CanvasSettings): ProjectState {
  const pens = [defaultPen('pen-black', 'Black fineliner', '#15171a'), defaultPen('pen-blue', 'Blue fineliner', '#2762d7')];
  const passes: PlotPass[] = [
    { id: 'pass-1', name: 'Pass 1', penId: pens[0]!.id, enabled: true },
    { id: 'pass-2', name: 'Pass 2', penId: pens[1]!.id, enabled: true },
  ];
  const initialAlgorithm = mode === 'raster' ? 'raster.hatch' : mode === 'svg' || mode === 'map' ? 'vector.layers' : 'generative.test-pattern';
  return {
    canvas,
    pens,
    passes,
    layers: [{ id: 'layer-1', name: 'Artwork', visible: true, algorithmId: mode === 'svg' || mode === 'map' ? 'vector.outline' : initialAlgorithm, passId: passes[0]!.id }],
    geometry: { paths: [], generatedAt: new Date(0).toISOString(), generator: 'none' },
    algorithmId: initialAlgorithm,
    algorithmSettings: {},
    preprocess: { ...DEFAULT_PREPROCESS },
    rasterPlacement: { ...DEFAULT_RASTER_PLACEMENT },
    turtlePlacement: { ...DEFAULT_TURTLE_PLACEMENT },
    mapSettings: { query: '', radiusKm: 1, dataSource: 'both', includeTopography: true, contourInterval: 10 },
    gcode: { origin: 'bottom-left', travelFeed: 5000, pathJoinTolerance: 0.15, parkX: 0, parkY: 0, pauseBetweenPasses: true, pauseCommand: 'M0', includeComments: true },
    viewport: { zoom: 1, x: 0, y: 0 },
  };
}

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
