import { describe, expect, it } from "vitest";

import { nearestPen } from "./color";
import type { PenProfile } from "./types";

const pens: PenProfile[] = [
  {
    pen_id: "red",
    name: "Red",
    display_color: "#d92f2f",
    tip_width_mm: 0.5,
    draw_feed_mm_min: 1800,
    pen_down_override: null,
    x_offset_mm: 0,
    y_offset_mm: 0,
    notes: "",
  },
  {
    pen_id: "blue",
    name: "Blue",
    display_color: "#2455b5",
    tip_width_mm: 0.5,
    draw_feed_mm_min: 1800,
    pen_down_override: null,
    x_offset_mm: 0,
    y_offset_mm: 0,
    notes: "",
  },
];

describe("nearestPen", () => {
  it("uses perceptual Lab distance", () => {
    expect(nearestPen("#e04035", pens)?.pen_id).toBe("red");
    expect(nearestPen("#315fc0", pens)?.pen_id).toBe("blue");
  });
});
