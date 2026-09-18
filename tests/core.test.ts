import { describe, expect, it } from 'vitest';
import { createDefaultState, paperDimensions } from '@plotter/core';

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
});
