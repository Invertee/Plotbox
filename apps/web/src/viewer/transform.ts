import type { PageSettings, Point } from "../types";

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function fitTransform(
  page: PageSettings,
  viewportWidth: number,
  viewportHeight: number,
  padding = 32,
): ViewTransform {
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const scale = Math.min(availableWidth / page.width_mm, availableHeight / page.height_mm);
  return {
    scale,
    offsetX: (viewportWidth - page.width_mm * scale) / 2,
    offsetY: (viewportHeight - page.height_mm * scale) / 2,
  };
}

export function pageToCanvas(point: Point, page: PageSettings, transform: ViewTransform): Point {
  return {
    x: transform.offsetX + point.x * transform.scale,
    y: transform.offsetY + (page.height_mm - point.y) * transform.scale,
  };
}
