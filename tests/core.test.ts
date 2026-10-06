import { describe, expect, it } from 'vitest';
import { createDefaultState, PAPER_COLOURS, paperDimensions } from '@plotter/core';

describe('paper configuration', () => {
  it('orients standard paper sizes in millimetres', () => {
    expect(paperDimensions('A4', 'portrait')).toEqual([210, 297]);
    expect(paperDimensions('A3', 'landscape')).toEqual([420, 297]);
    expect(paperDimensions('A2', 'portrait')).toEqual([420, 594]);
  });

  it('starts with safe machine defaults', () => {
    const state = createDefaultState('generative', { preset: 'A4', orientation: 'portrait', widthMm: 210, heightMm: 297, marginMm: 10 });
    expect(state.pens[0]).toMatchObject({ zUp: 0, zDown: -10 });
    expect(state.gcode.pauseBetweenPasses).toBe(true);
  });

  it('starts linocut projects with a slow, shallow indexed blade pass', () => {
    const state = createDefaultState('linocut', { preset: 'A4', orientation: 'portrait', widthMm: 210, heightMm: 297, marginMm: 10 });
    expect(state.algorithmId).toBe('vector.layers');
    expect(state.passes).toHaveLength(1);
    expect(state.pens[0]).toMatchObject({ mediaType: 'blade', zDown: -1, xyFeed: 500, bladeAngleStep: 15 });
  });

  it('provides preview colours for every supported paper colour', () => {
    expect(Object.keys(PAPER_COLOURS)).toEqual(['white', 'black', 'grey', 'blue', 'navy']);
  });
});
