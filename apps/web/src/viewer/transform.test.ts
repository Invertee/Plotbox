import { describe, expect, it } from "vitest";

import type { PageSettings } from "../types";
import { fitTransform, pageToCanvas } from "./transform";

const page: PageSettings = {
  schema_version: 1,
  preset: "A3",
  orientation: "landscape",
  width_mm: 420,
  height_mm: 297,
  margin_mm: 10,
};

describe("viewer coordinate transform", () => {
  it("fits A3 into the viewport without changing aspect ratio", () => {
    const transform = fitTransform(page, 900, 610, 32);
    expect(transform.scale).toBeCloseTo((610 - 64) / 297);
    expect(transform.offsetX).toBeGreaterThan(32);
    expect(transform.offsetY).toBeCloseTo(32);
  });

  it("maps lower-left page origin below upper-left in Canvas coordinates", () => {
    const transform = fitTransform(page, 900, 610);
    const lowerLeft = pageToCanvas({ x: 0, y: 0 }, page, transform);
    const upperLeft = pageToCanvas({ x: 0, y: 297 }, page, transform);
    expect(lowerLeft.x).toBeCloseTo(upperLeft.x);
    expect(lowerLeft.y).toBeGreaterThan(upperLeft.y);
  });

  it("maps positive X to the right", () => {
    const transform = fitTransform(page, 900, 610);
    const left = pageToCanvas({ x: 10, y: 10 }, page, transform);
    const right = pageToCanvas({ x: 410, y: 10 }, page, transform);
    expect(right.x).toBeGreaterThan(left.x);
    expect(right.y).toBeCloseTo(left.y);
  });
});
