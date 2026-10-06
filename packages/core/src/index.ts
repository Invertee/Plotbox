export type ProjectMode = 'generative' | 'raster' | 'svg' | 'map' | 'topography' | 'isometric' | 'linocut' | 'engraving';
export type Orientation = 'portrait' | 'landscape';
export type PaperPreset = 'A4' | 'A3' | 'A2' | 'custom';
export type PaperColour = 'white' | 'black' | 'grey' | 'blue' | 'navy';
export type BorderPattern = 'straight' | 'waves' | 'dotted' | 'scallops';

export const BLADE_ANGLE_STEPS = [5, 10, 15, 20, 30, 45, 60, 90] as const;

export const PAPER_COLOURS: Record<PaperColour, string> = {
  white: '#fffdf8',
  black: '#1c1d1f',
  grey: '#aeb2b5',
  blue: '#8eb6d9',
  navy: '#10172d',
};

export interface Point {
  x: number;
  y: number;
  /** Normalized vertical offset for upright furniture on isometric road tiles. */
  elevation?: number;
  /** Screen-facing foliage offset; stays round when its ground tile rotates. */
  billboardX?: number;
  /** Normalised tool pressure (0–1). Paint-capable G-code maps this to Z. */
  pressure?: number;
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
  fill: 'hatch' | 'crosshatch' | 'scanlines' | 'dither' | 'stipple' | 'tonal-dashes' | 'solid' | 'outline' | 'none';
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
  /** Optional so projects saved before paper colours were introduced remain compatible. */
  paperColour?: PaperColour;
}

export interface BorderSettings {
  /** Draw the selected border pattern. */
  enabled: boolean;
  /** Remove artwork beneath the border band, leaving the paper untouched. */
  whitespace: boolean;
  pattern: BorderPattern;
  /** Distance from the paper edge to the outside of the border band. */
  insetMm: number;
  /** Width of the untouched band. */
  whitespaceWidthMm: number;
  /** Wave/scallop depth. */
  amplitudeMm: number;
  /** Distance between repeated dots or curves. */
  spacingMm: number;
  passId: string;
}

export const DEFAULT_BORDER: BorderSettings = {
  enabled: false,
  whitespace: false,
  pattern: 'straight',
  insetMm: 10,
  whitespaceWidthMm: 8,
  amplitudeMm: 2,
  spacingMm: 8,
  passId: 'pass-1',
};

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
  /** Defaults to pen for older projects. */
  mediaType?: 'pen' | 'paint' | 'blade' | 'rotary';
  /** Manual Dremel switching, or controller-managed M3/M5 spindle commands. */
  rotaryControl?: 'manual' | 'gcode';
  rotaryRpm?: number;
  rotarySpinupSeconds?: number;
  /**
   * Angular spacing between manual straight-blade positions. Blade paths are
   * split and grouped from 0° up to 180°; smaller steps follow curves more
   * closely but require more manual re-indexing pauses.
   */
  bladeAngleStep?: number;
  /** Paint-container position in the machine's work coordinates. */
  paintWellX?: number;
  paintWellY?: number;
  /** Z used to dip the brush into the paint container. */
  paintWellZ?: number;
  /** Optional dwell after dipping, in seconds. */
  paintDipDwellSeconds?: number;
  /** Maximum painted distance between dips. Zero disables distance reloads. */
  paintReloadDistanceMm?: number;
  /** Enable per-point pressure produced by paint-aware image algorithms. */
  paintUsePressure?: boolean;
  /** Z at full pressure; zDown remains the light-contact height. */
  paintMaxPressureZ?: number;
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
  /** Optional original paint, retained by coloured glyph snapshots. */
  stroke?: string;
  fill?: string;
  /** An opaque paper cutout: masks artwork behind it without a pen pass. */
  paper?: boolean;
}

export type IsometricRole = 'building' | 'terrain' | 'road-straight' | 'road-corner' | 'road-tee' | 'road-cross' | 'road-end';
export type IsometricTerrain = 'park' | 'water' | 'shore' | 'feature';
export interface IsometricTile {
  id: string;
  glyphId: string;
  u: number;
  v: number;
  rotation: number;
  roadMask?: number;
}
export interface IsometricGlyph {
  id: string;
  name: string;
  categoryId?: string;
  categoryName?: string;
  /** Artwork pack shared by buildings, roads and landscape tiles. */
  collectionId?: string;
  role: IsometricRole;
  terrain?: IsometricTerrain;
  /** Land-facing edges, clockwise from +u. */
  shoreMask?: number;
  treeLined?: boolean;
  paths: SourcePath[];
}
export interface IsometricSettings {
  algorithm: 'city' | 'ordered';
  fit: 'square' | 'edges';
  cells: number;
  angle: number;
  sourceAngle: number;
  buildingScale: number;
  blockSize: number;
  roadLayout: 'blocks' | 'avenues';
  clusterDepth: number;
  density: number;
  districtSize: number;
  showGrid: boolean;
  groundSurface: 'pavement' | 'grass';
  buildingCategories: string[];
  roadCategories: string[];
  buildingPassId: string;
  roadPassId: string;
  gridPassId: string;
  useGlyphColours: boolean;
  colourPasses: Record<string, string>;
  fillMode: 'outline' | 'hatch';
  fillSpacing: number;
  landscape: 'city' | 'coast' | 'lake';
  waterCoverage: number;
  waterFeatures: boolean;
  greenSpacesPerBlock: number;
  treeLinedStreets: boolean;
  /** Undefined follows the generator; an array is a saved, editable layout. */
  tiles?: IsometricTile[];
}
export const DEFAULT_ISOMETRIC: IsometricSettings = {
  algorithm: 'city', fit: 'square', cells: 12, angle: 30, sourceAngle: 30,
  buildingScale: 0.72, blockSize: 4, roadLayout: 'blocks', clusterDepth: 2,
  density: 85, districtSize: 2, showGrid: false, groundSurface: 'pavement',
  buildingCategories: [], roadCategories: [], buildingPassId: 'pass-1', roadPassId: 'pass-1', gridPassId: 'pass-2',
  useGlyphColours: true, colourPasses: {}, fillMode: 'hatch', fillSpacing: 0.65,
  landscape: 'city', waterCoverage: 40, waterFeatures: true,
  greenSpacesPerBlock: 2, treeLinedStreets: true,
};

export function isometricLayers(): PlotLayer[] {
  return ['grid', 'terrain', 'roads', 'buildings'].map(name => ({
    id: `iso-${name}`, name: name[0]!.toUpperCase() + name.slice(1), visible: true,
    algorithmId: 'isometric.city', passId: name === 'grid' ? 'pass-2' : 'pass-1',
  }));
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

export type MapShape = 'rectangle' | 'square' | 'circle';

export interface MapSettings {
  shape?: MapShape;
  /** Shape of the last successful download, independent of the next selection. */
  importedShape?: MapShape;
  relief?: ReliefSettings;
  terrain?: TerrainData;
  query: string;
  radiusKm: number;
  dataSource?: 'openstreetmap' | 'terrain' | 'both';
  /** Legacy setting retained so older saved projects can be migrated. */
  includeTopography?: boolean;
  contourInterval?: number;
  latitude?: number;
  longitude?: number;
  zoom?: number;
  /** Geographic footprint of the downloaded map; older projects may store its centre as a zero-area fallback. */
  bounds?: { north: number; south: number; east: number; west: number };
}

/** Regular north-to-south elevation grid, in metres, over geographic bounds. */
export interface TerrainData {
  width: number;
  height: number;
  elevations: number[];
  bounds: { north: number; south: number; east: number; west: number };
  water?: Array<{ closed: boolean; points: Array<[number, number]> }>;
}

export interface ReliefSettings {
  shape?: MapShape;
  rotation: number;
  tilt: number;
  exaggeration: number;
  contourInterval: number;
  spacing: number;
  baseDepth: number;
  clipBaseDepth: boolean;
  maxBaseDepth: number;
  shading: boolean;
  bands: boolean;
  water: boolean;
}

export const DEFAULT_RELIEF: ReliefSettings = {
  rotation: 45, tilt: 35.264, exaggeration: 2, contourInterval: 20,
  spacing: 0.7, baseDepth: 3, clipBaseDepth: false, maxBaseDepth: 15,
  shading: true, bands: true, water: true,
};

export function reliefLayers(): PlotLayer[] {
  return ['Low elevations', 'Middle elevations', 'High elevations', 'Slope shading', 'Water', 'Contours & base'].map((name, i) => ({
    id: `relief-${i}`, name, visible: true, algorithmId: 'topography.relief', passId: `relief-pass-${i}`,
  }));
}

export interface MapTitleSettings {
  enabled: boolean;
  text: string;
  position: 'top' | 'bottom';
  font: string;
  titleSizeMm: number;
  showCoordinates: boolean;
  subtitleSizeMm: number;
  passId: string;
}

/** A paper-space marker rendered on top of an imported map. Positions are
 * percentages of the drawable area so annotations survive paper resizing. */
export interface MapAnnotation {
  id: string;
  /** Glyphbox asset identity and a normalized plot-ready snapshot. */
  glyphId?: string;
  glyphName?: string;
  glyphPaths?: SourcePath[];
  /** Legacy built-in marker identifier retained for saved-project migration. */
  markerType: string;
  label: string;
  xPercent: number;
  yPercent: number;
  markerSizeMm: number;
  labelSizeMm: number;
  font: string;
  /** Reserve a paper-coloured rounded box behind the marker and label. */
  background?: boolean;
  /** Space between the annotation artwork and its background border. */
  backgroundPaddingMm?: number;
  /** Corner radius of the background border. */
  backgroundRadiusMm?: number;
  passId: string;
  visible: boolean;
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
  isometric?: IsometricSettings;
  /** Project-owned paths keep drawings reproducible if Glyphbox changes. */
  isometricGlyphs?: IsometricGlyph[];
  canvas: CanvasSettings;
  /** Optional so projects saved before plot borders were introduced remain compatible. */
  border?: BorderSettings;
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
  /** Optional so maps saved before annotations were introduced still load. */
  mapAnnotations?: MapAnnotation[];
  /** Optional so maps saved before title blocks were introduced still load. */
  mapTitle?: MapTitleSettings;
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
  mediaType: 'pen',
});

export function createDefaultState(mode: ProjectMode, canvas: CanvasSettings): ProjectState {
  const pens = mode === 'linocut'
    ? [{ ...defaultPen('blade-straight', 'Straight lino blade', '#9b3125'), widthMm: 1, zDown: -1, xyFeed: 500, zDownFeed: 150, mediaType: 'blade' as const, bladeAngleStep: 15 }]
    : mode === 'engraving'
      ? [{ ...defaultPen('rotary-1', 'Rotary engraving bit', '#547d91'), widthMm: 0.5, zUp: 3, zDown: -0.1, xyFeed: 300, zUpFeed: 600, zDownFeed: 100, mediaType: 'rotary' as const, rotaryControl: 'manual' as const, rotaryRpm: 12000, rotarySpinupSeconds: 2 }]
    : [defaultPen('pen-black', 'Black fineliner', '#15171a'), defaultPen('pen-blue', 'Blue fineliner', '#2762d7')];
  const passes: PlotPass[] = mode === 'linocut' || mode === 'engraving'
    ? [{ id: 'pass-1', name: mode === 'engraving' ? 'Engrave pass 1' : 'Cut pass 1', penId: pens[0]!.id, enabled: true }]
    : [
      { id: 'pass-1', name: 'Pass 1', penId: pens[0]!.id, enabled: true },
      { id: 'pass-2', name: 'Pass 2', penId: pens[1]!.id, enabled: true },
    ];
  if (mode === 'topography') {
    const colours = ['#d7a371', '#bc774c', '#965536', '#735441', '#267d89', '#302820'];
    pens.splice(0, pens.length, ...reliefLayers().map((layer, i) => defaultPen(`relief-pen-${i}`, layer.name, colours[i]!)));
    passes.splice(0, passes.length, ...reliefLayers().map((layer, i) => ({ id: layer.passId, name: layer.name, penId: pens[i]!.id, enabled: true })));
  }
  const initialAlgorithm = mode === 'topography' ? 'topography.relief' : mode === 'isometric' ? 'isometric.city' : mode === 'engraving' ? 'raster.tonal-area-fill' : mode === 'raster' ? 'raster.hatch' : mode === 'svg' || mode === 'map' || mode === 'linocut' ? 'vector.layers' : 'generative.test-pattern';
  return {
    canvas,
    border: { ...DEFAULT_BORDER, passId: passes[0]!.id },
    pens,
    passes,
    layers: mode === 'topography' ? reliefLayers() : mode === 'isometric' ? isometricLayers() : [{ id: 'layer-1', name: 'Artwork', visible: true, algorithmId: mode === 'svg' || mode === 'map' || mode === 'linocut' ? 'vector.outline' : initialAlgorithm, passId: passes[0]!.id }],
    geometry: { paths: [], generatedAt: new Date(0).toISOString(), generator: 'none' },
    algorithmId: initialAlgorithm,
    algorithmSettings: {},
    ...(mode === 'isometric' ? { isometric: { ...DEFAULT_ISOMETRIC }, isometricGlyphs: [] } : {}),
    preprocess: { ...DEFAULT_PREPROCESS },
    rasterPlacement: { ...DEFAULT_RASTER_PLACEMENT },
    turtlePlacement: { ...DEFAULT_TURTLE_PLACEMENT },
    mapSettings: { query: '', radiusKm: 1, dataSource: 'both', includeTopography: true, contourInterval: mode === 'topography' ? 20 : 10, ...(mode === 'topography' ? { relief: { ...DEFAULT_RELIEF } } : {}) },
    mapAnnotations: [],
    mapTitle: { enabled: false, text: '', position: 'top', font: 'single-line', titleSizeMm: 8, showCoordinates: false, subtitleSizeMm: 3, passId: passes[0]!.id },
    gcode: { origin: 'bottom-left', travelFeed: 5000, pathJoinTolerance: 0.15, parkX: 0, parkY: 0, pauseBetweenPasses: true, pauseCommand: 'M0', includeComments: true },
    viewport: { zoom: 1, x: 0, y: 0 },
  };
}

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
