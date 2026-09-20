import { describe, expect, it } from 'vitest';
import { generateGCode, joinContinuousPaths } from '@plotter/gcode';
import { optimisePathOrder } from '@plotter/geometry';
import type { GCodeSettings, PenProfile, PlotGeometry, PlotPass } from '@plotter/core';

const pens: PenProfile[] = [
  { id: 'black', name: 'Black 03', color: '#000', widthMm: 0.3, zUp: 0, zDown: -10, xyFeed: 2500, zFeed: 600 },
  { id: 'blue', name: 'Blue 05', color: '#00f', widthMm: 0.5, zUp: 1, zDown: -8, xyFeed: 2200, zFeed: 500 },
];
const passes: PlotPass[] = [
  { id: 'p1', name: 'Pass 1', penId: 'black', enabled: true },
  { id: 'p2', name: 'Pass 2', penId: 'blue', enabled: true },
];
const geometry: PlotGeometry = { generator: 'test', generatedAt: '', paths: [
  { id: 'a', layerId: 'l', passId: 'p1', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] },
  { id: 'b', layerId: 'l', passId: 'p2', points: [{ x: 30, y: 40 }, { x: 50, y: 60 }] },
] };
const settings: GCodeSettings = { origin: 'bottom-left', travelFeed: 5000, parkX: 0, parkY: 0, pauseBetweenPasses: true, pauseCommand: 'M0', includeComments: true };

describe('G-code output', () => {
  it('parks, lifts and pauses between combined passes', () => {
    const [document] = generateGCode('Demo', geometry, passes, pens, settings, 297, false);
    expect(document?.content).toContain('G21');
    expect(document?.content).toContain('G0 Z0 F600');
    expect(document?.content).toContain('G0 X0 Y0 F5000\n; Change pen\nM0');
    expect(document?.content.endsWith('M2\n')).toBe(true);
  });

  it('creates one independently runnable file per pass', () => {
    const documents = generateGCode('Demo', geometry, passes, pens, settings, 297, true);
    expect(documents).toHaveLength(2);
    expect(documents[0]?.filename).toBe('1-pass-1-demo.gcode');
    expect(documents[1]?.filename).toBe('2-pass-2-demo.gcode');
    expect(documents.every((document) => document.content.includes('G0 X0 Y0 F5000'))).toBe(true);
  });

  it('uses independent lift and plunge feeds when configured on a pen', () => {
    const customPens: PenProfile[] = [{ ...pens[0]!, zUpFeed: 900, zDownFeed: 250 }];
    const customPasses: PlotPass[] = [{ ...passes[0]! }];
    const customGeometry: PlotGeometry = { ...geometry, paths: [geometry.paths[0]!] };
    const [document] = generateGCode('Demo', customGeometry, customPasses, customPens, settings, 297);
    expect(document?.content).toContain('G0 Z0 F900');
    expect(document?.content).toContain('G1 Z-10 F250');
  });

  it('reloads paint from its captured well and maps pressure to Z', () => {
    const paint: PenProfile = {
      ...pens[0]!, name: 'Indigo brush', mediaType: 'paint',
      paintWellX: 220, paintWellY: 18, paintWellZ: -14,
      paintDipDwellSeconds: 0.5, paintReloadDistanceMm: 5,
      paintUsePressure: true, paintMaxPressureZ: -12,
    };
    const paintGeometry: PlotGeometry = { ...geometry, paths: [{
      id: 'paint', layerId: 'l', passId: 'p1', points: [
        { x: 10, y: 10, pressure: 0 },
        { x: 14, y: 10, pressure: 0.5 },
        { x: 20, y: 10, pressure: 1 },
      ],
    }] };

    const [document] = generateGCode('Paint', paintGeometry, [passes[0]!], [paint], settings, 297);

    expect(document?.content.match(/; Reload Indigo brush/g)).toHaveLength(2);
    expect(document?.content).toContain('G0 X220 Y18 F5000');
    expect(document?.content).toContain('G1 Z-14 F600');
    expect(document?.content).toContain('G4 P0.5');
    expect(document?.content).toContain('G1 Z-10 F600');
    expect(document?.content).toContain('Z-11');
    expect(document?.content).toContain('Z-12');
  });

  it('rejects an uncalibrated paint pass before producing unsafe motion', () => {
    const paint: PenProfile = { ...pens[0]!, mediaType: 'paint' };
    expect(() => generateGCode('Paint', { ...geometry, paths: [geometry.paths[0]!] }, [passes[0]!], [paint], settings, 297))
      .toThrow('needs a captured paint well X/Y position and dip Z height');
  });

  it('joins aligned paths separated by a tiny gap, avoiding an unnecessary pen lift', () => {
    const paths = [
      { id: 'a', layerId: 'l', passId: 'p1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { id: 'b', layerId: 'l', passId: 'p1', points: [{ x: 10.08, y: 0 }, { x: 20, y: 0 }] },
    ];
    expect(joinContinuousPaths(paths, 0.1)).toHaveLength(1);
    const [document] = generateGCode('Joined', { ...geometry, paths }, [passes[0]!], [pens[0]!], settings, 297);
    expect(document?.content.match(/G1 Z-10 F600/g)).toHaveLength(1);
    expect(document?.content).toContain('G1 X10.08 Y297 F2500');
  });

  it('does not join nearby paths that turn sharply', () => {
    const paths = [
      { id: 'a', layerId: 'l', passId: 'p1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { id: 'b', layerId: 'l', passId: 'p1', points: [{ x: 10, y: 0.05 }, { x: 10, y: 10 }] },
    ];
    expect(joinContinuousPaths(paths, 0.1)).toHaveLength(2);
  });

  it('orders a large path collection without losing or duplicating paths', () => {
    const paths = Array.from({ length: 10_000 }, (_, index) => ({
      id: `path-${index}`,
      layerId: 'l',
      passId: 'p1',
      points: [
        { x: (index * 37) % 297, y: (index * 53) % 210 },
        { x: (index * 37) % 297 + 0.1, y: (index * 53) % 210 + 0.1 },
      ],
    }));
    let finalProgress: [number, number] | undefined;
    const ordered = optimisePathOrder(paths, { x: 0, y: 0 }, (completed, total) => { finalProgress = [completed, total]; });
    expect(ordered).toHaveLength(paths.length);
    expect(new Set(ordered.map((path) => path.id)).size).toBe(paths.length);
    expect(finalProgress).toEqual([paths.length, paths.length]);
  });

  it('assembles G-code above the JavaScript argument-stack limit', () => {
    const paths = Array.from({ length: 30_000 }, (_, index) => ({
      id: `large-${index}`,
      layerId: 'l',
      passId: 'p1',
      points: [
        { x: index % 297, y: Math.floor(index / 297) % 210 },
        { x: index % 297 + 0.01, y: Math.floor(index / 297) % 210 + 0.01 },
      ],
    }));
    const [document] = generateGCode('Large map', { ...geometry, paths }, [passes[0]!], [pens[0]!], { ...settings, pathJoinTolerance: 0 }, 297);
    expect(document?.filename).toBe('large-map.gcode');
    expect(document?.content).toContain('G0 X0 Y297 F5000');
    expect(document?.content.endsWith('M2\n')).toBe(true);
  });

  it('omits invalid TurtleToy coordinates without joining across them', () => {
    const corruptGeometry = { ...geometry, paths: [{
      id: 'corrupt',
      layerId: 'l',
      passId: 'p1',
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: null, y: null },
        { x: 30, y: 30 },
        { x: 40, y: 40 },
      ],
    }] } as unknown as PlotGeometry;

    const [document] = generateGCode('Recovered', corruptGeometry, [passes[0]!], [pens[0]!], settings, 297);

    expect(document?.content).not.toContain('null');
    expect(document?.content).toContain('G1 X20 Y277 F2500');
    expect(document?.content).toContain('G1 X40 Y257 F2500');
    expect(document?.content.match(/G1 Z-10 F600/g)).toHaveLength(2);
  });
});
