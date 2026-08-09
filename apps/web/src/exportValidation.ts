import type { MachineProfile, PageSettings } from "./types";

export function validateProfile(profile: MachineProfile, page: PageSettings): string | null {
  if (profile.work_width_mm < page.width_mm || profile.work_height_mm < page.height_mm) {
    return "The A3 page does not fit inside the configured export work area.";
  }
  if (profile.pen_actuator.up_mm <= profile.pen_actuator.down_mm) {
    return "Pen-up Z must be greater than pen-down Z.";
  }
  if (profile.precision_decimals < 0 || profile.precision_decimals > 6) {
    return "Precision must be between 0 and 6 decimals.";
  }
  return null;
}
