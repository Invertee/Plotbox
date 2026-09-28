import type { ColourSeparationResult, PlotGeometry } from '@plotter/core';
import type { Bounds, ImagePlacement } from '@plotter/geometry';
import { colourPassId, separateColours } from './colourSeparation';
import { generateTonalAreaFill } from './tonalAreaFill';

type ImagePixels = { width: number; height: number; data: Uint8ClampedArray };

export type ColourTonalAreaFillOptions = {
  bounds: Bounds;
  placement: ImagePlacement;
  settings: Record<string, number | string | boolean>;
  onProgress?: (value: number, message: string) => void;
};

const numberSetting = (settings: ColourTonalAreaFillOptions['settings'], key: string, fallback: number) => Number(settings[key] ?? fallback);

/**
 * Runs the existing perceptual colour separation first, then applies the tonal
 * area-fill algorithm independently inside every separated colour. Each colour
 * is assigned to the same automatic pass used by the colour-separation mode.
 */
export function generateColourTonalAreaFill(
  image: ImagePixels,
  luminance: ArrayLike<number>,
  options: ColourTonalAreaFillOptions,
): PlotGeometry {
  if (luminance.length < image.width * image.height) throw new Error('Invalid luminance image for colour tonal fill.');
  options.onProgress?.(0.04, 'Separating colours and connected regions');
  const separated = separateColours(image, {
    colourCount: options.settings.colourCount ?? 6,
    minRegionPixels: options.settings.minRegionPixels ?? 12,
    skipPaper: options.settings.skipPaper ?? true,
    paperCutoff: options.settings.paperCutoff ?? 90,
    cleanEdges: options.settings.cleanEdges ?? true,
  });
  const { palette, regions, regionLabels } = separated;
  const paths: PlotGeometry['paths'] = [];
  const colourSeparation: ColourSeparationResult = { palette, regions };

  const regionColours = regions.map(region => region.colourId);
  palette.forEach((colour, colourIndex) => {
    const eligible = new Uint8Array(image.width * image.height);
    for (let index = 0; index < eligible.length; index += 1) {
      const region = regionLabels[index]!;
      if (region >= 0 && regionColours[region] === colour.id) eligible[index] = 1;
    }
    if (!eligible.some(Boolean)) return;
    const from = 0.1 + colourIndex / Math.max(1, palette.length) * 0.82;
    const span = 0.82 / Math.max(1, palette.length);
    const geometry = generateTonalAreaFill(luminance, image.width, image.height, {
      bounds: options.bounds,
      placement: options.placement,
      passId: colourPassId(colour.id),
      eligibleMask: eligible,
      levels: numberSetting(options.settings, 'levels', 3),
      highlightThreshold: numberSetting(options.settings, 'highlightThreshold', 250),
      shadowThreshold: numberSetting(options.settings, 'shadowThreshold', 70),
      spacing: numberSetting(options.settings, 'spacing', 0.55),
      angle: numberSetting(options.settings, 'angle', 45),
      angleStep: numberSetting(options.settings, 'angleStep', 60),
      closeRadius: numberSetting(options.settings, 'closeRadius', 1),
      minimumRegionPixels: numberSetting(options.settings, 'minimumRegionPixels', 4),
      minimumStroke: numberSetting(options.settings, 'minimumStroke', 0.2),
      includeContours: options.settings.includeContours !== false,
      edgeThreshold: numberSetting(options.settings, 'edgeThreshold', 55),
      minimumContourLength: numberSetting(options.settings, 'minimumContourLength', 0.5),
      contourSimplification: numberSetting(options.settings, 'contourSimplification', 0.12),
      onProgress: (value) => options.onProgress?.(from + value * span, `Filling ${colourIndex + 1} of ${palette.length} colours`),
    });
    for (const path of geometry.paths) paths.push({
      ...path,
      id: `colour-tonal-${paths.length}`,
      channel: `colour-${colour.id}-${path.channel ?? 'fill'}`,
    });
  });

  options.onProgress?.(0.96, `Finalising ${palette.length} colour passes`);
  return {
    generator: 'raster.colour-tonal-area-fill',
    generatedAt: new Date().toISOString(),
    paths,
    colourSeparation,
  };
}

