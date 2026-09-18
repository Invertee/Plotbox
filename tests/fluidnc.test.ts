import { describe, expect, it } from 'vitest';
import { fluidNCHttpUrl, fluidNCWebSocketCandidates, normalizeFluidNCUrl, parseFluidNCStatus } from '../apps/web/src/fluidnc';

describe('FluidNC addressing', () => {
  it('uses the root WebSocket endpoint and preserves explicit ports', () => {
    expect(normalizeFluidNCUrl('192.168.1.206')).toBe('ws://192.168.1.206/');
    expect(normalizeFluidNCUrl('ws://fluidnc.local:8080/ws')).toBe('ws://fluidnc.local:8080/');
  });

  it('offers legacy port 81 as a fallback', () => {
    expect(fluidNCWebSocketCandidates('192.168.1.206')).toEqual(['ws://192.168.1.206/', 'ws://192.168.1.206:81/']);
  });

  it('derives the HTTP endpoint used for SD and command requests', () => {
    expect(fluidNCHttpUrl('ws://192.168.1.206:81/')).toBe('http://192.168.1.206/');
  });
});

describe('FluidNC status parsing', () => {
  it('derives work coordinates from machine position and work offset', () => {
    expect(parseFluidNCStatus('<Idle|MPos:10.000,20.000,3.000|WCO:1.000,2.000,0.500>')).toMatchObject({
      state: 'Idle',
      workPosition: { x: 9, y: 18, z: 2.5 },
    });
  });
});
