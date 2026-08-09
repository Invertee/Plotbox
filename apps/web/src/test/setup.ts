import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

const canvasContext = {
  beginPath: vi.fn(),
  bezierCurveTo: vi.fn(),
  clearRect: vi.fn(),
  closePath: vi.fn(),
  fillRect: vi.fn(),
  lineTo: vi.fn(),
  moveTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  setLineDash: vi.fn(),
  stroke: vi.fn(),
  strokeRect: vi.fn(),
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  lineCap: "round",
  lineJoin: "round",
  shadowColor: "",
  shadowBlur: 0,
};

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(() => canvasContext),
});
