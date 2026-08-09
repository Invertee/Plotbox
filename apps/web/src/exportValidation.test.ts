import { describe, expect, it } from "vitest";

import { validateProfile } from "./exportValidation";
import type { MachineProfile, PageSettings } from "./types";

const page: PageSettings = {
  schema_version: 1,
  preset: "A3",
  orientation: "landscape",
  width_mm: 420,
  height_mm: 297,
  margin_mm: 10,
};

const profile: MachineProfile = {
  schema_version: 1,
  profile_id: "fluidnc-z-axis-a3",
  name: "FluidNC A3",
  dialect: "fluidnc-grbl",
  work_width_mm: 430,
  work_height_mm: 310,
  origin_corner: "lower-left",
  invert_x: false,
  invert_y: false,
  precision_decimals: 3,
  motion: {
    travel_command: "G0",
    draw_command: "G1",
    draw_feed_mm_min: 1800,
    travel_feed_mm_min: 6000,
  },
  pen_actuator: {
    kind: "z_axis",
    up_mm: 5,
    down_mm: 0,
    lift_feed_mm_min: 900,
    lower_feed_mm_min: 400,
    dwell_after_up_ms: 80,
    dwell_after_down_ms: 120,
  },
  park: { enabled: false, x_mm: 0, y_mm: 0 },
  macros: {
    header: ["G21", "G90", "G17", "G94"],
    pause: "M0 ({message})",
    footer: ["M2"],
  },
  allowed_commands: ["G0", "G1", "G4", "G17", "G21", "G90", "G94", "M0", "M2"],
};

describe("export profile validation", () => {
  it("accepts the bundled A3 profile", () => {
    expect(validateProfile(profile, page)).toBeNull();
  });

  it("blocks a work area smaller than A3", () => {
    expect(validateProfile({ ...profile, work_width_mm: 300 }, page)).toContain("does not fit");
  });

  it("blocks an inverted Z lift configuration", () => {
    expect(
      validateProfile(
        {
          ...profile,
          pen_actuator: { ...profile.pen_actuator, up_mm: -1 },
        },
        page,
      ),
    ).toContain("Pen-up Z");
  });
});
