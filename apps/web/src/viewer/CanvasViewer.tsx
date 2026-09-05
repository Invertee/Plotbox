import { useEffect, useRef, useState } from "react";

import type {
  DesignDocument,
  GcodeProgram,
  PageSettings,
  PlotPlan,
  Point,
  RasterPreview,
} from "../types";
import { fitTransform, pageToCanvas, type ViewTransform } from "./transform";

export type ViewerMode = "design" | "toolpath" | "reconstruction";

interface CanvasViewerProps {
  page: PageSettings;
  mode: ViewerMode;
  design: DesignDocument | null;
  plan: PlotPlan | null;
  reconstructed: GcodeProgram | null;
  rasterPreview: RasterPreview | null;
  showTravel: boolean;
  overprint: boolean;
  renderToken: number;
  onRendered: (token: number) => void;
}

const WIDTH = 900;
const HEIGHT = 610;

function tracePoints(
  context: CanvasRenderingContext2D,
  points: Point[],
  page: PageSettings,
  transform: ViewTransform,
): void {
  const first = points[0];
  if (!first) return;
  const start = pageToCanvas(first, page, transform);
  context.beginPath();
  context.moveTo(start.x, start.y);
  for (const point of points.slice(1)) {
    const canvasPoint = pageToCanvas(point, page, transform);
    context.lineTo(canvasPoint.x, canvasPoint.y);
  }
  context.stroke();
}

export function CanvasViewer({
  page,
  mode,
  design,
  plan,
  reconstructed,
  rasterPreview,
  showTravel,
  overprint,
  renderToken,
  onRendered,
}: CanvasViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState(() => fitTransform(page, WIDTH, HEIGHT));
  const [rasterImage, setRasterImage] = useState<HTMLImageElement | null>(null);
  const dragOrigin = useRef<Point | null>(null);

  const fit = () => setTransform(fitTransform(page, WIDTH, HEIGHT));

  useEffect(() => {
    fit();
    // Page changes intentionally reset the physical viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.width_mm, page.height_mm]);

  useEffect(() => {
    if (!rasterPreview) {
      setRasterImage(null);
      return;
    }
    const image = new Image();
    image.onload = () => setRasterImage(image);
    image.src = `data:image/png;base64,${rasterPreview.preview_png_base64}`;
  }, [rasterPreview]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = "#e8e3d7";
    context.fillRect(0, 0, WIDTH, HEIGHT);

    const pageOrigin = pageToCanvas({ x: 0, y: page.height_mm }, page, transform);
    context.fillStyle = "#fffdf7";
    context.shadowColor = "rgba(21, 29, 20, .18)";
    context.shadowBlur = 18;
    context.fillRect(
      pageOrigin.x,
      pageOrigin.y,
      page.width_mm * transform.scale,
      page.height_mm * transform.scale,
    );
    context.shadowBlur = 0;

    const safeStart = pageToCanvas(
      { x: page.margin_mm, y: page.height_mm - page.margin_mm },
      page,
      transform,
    );
    context.strokeStyle = "#cfc7b6";
    context.lineWidth = 1;
    context.setLineDash([4, 4]);
    context.strokeRect(
      safeStart.x,
      safeStart.y,
      (page.width_mm - page.margin_mm * 2) * transform.scale,
      (page.height_mm - page.margin_mm * 2) * transform.scale,
    );
    context.setLineDash([]);
    context.lineCap = "round";
    context.lineJoin = "round";

    if (mode === "design" && rasterPreview && rasterImage) {
      const topLeft = pageToCanvas(
        {
          x: rasterPreview.placement.x_mm,
          y: rasterPreview.placement.y_mm + rasterPreview.placement.height_mm,
        },
        page,
        transform,
      );
      context.save();
      context.beginPath();
      context.rect(
        pageOrigin.x,
        pageOrigin.y,
        page.width_mm * transform.scale,
        page.height_mm * transform.scale,
      );
      context.clip();
      context.globalAlpha = 0.88;
      context.drawImage(
        rasterImage,
        topLeft.x,
        topLeft.y,
        rasterPreview.placement.width_mm * transform.scale,
        rasterPreview.placement.height_mm * transform.scale,
      );
      context.restore();
    }

    if (mode === "design" && design) {
      context.save();
      if (overprint) context.globalCompositeOperation = "multiply";
      for (const layer of design.layers) {
        if (!layer.visible) continue;
        context.strokeStyle = layer.preview_color;
        context.lineWidth = Math.max(1, transform.scale * 0.35);
        for (const path of layer.paths) {
          if (path.metadata.mark_kind === "pen-dot") {
            const first = path.commands[0];
            if (first?.kind === "move") {
              const center = pageToCanvas(first.point, page, transform);
              const diameter = Number(path.metadata.dot_diameter_mm ?? 0);
              context.beginPath();
              context.arc(
                center.x,
                center.y,
                Math.max(1, (diameter * transform.scale) / 2),
                0,
                Math.PI * 2,
              );
              context.fillStyle = layer.preview_color;
              context.fill();
            }
            continue;
          }
          context.beginPath();
          for (const command of path.commands) {
            if (command.kind === "close") {
              context.closePath();
              continue;
            }
            const endpoint = pageToCanvas(command.point, page, transform);
            if (command.kind === "move") context.moveTo(endpoint.x, endpoint.y);
            if (command.kind === "line") context.lineTo(endpoint.x, endpoint.y);
            if (command.kind === "quadratic") {
              const control = pageToCanvas(command.control, page, transform);
              context.quadraticCurveTo(control.x, control.y, endpoint.x, endpoint.y);
            }
            if (command.kind === "cubic") {
              const control1 = pageToCanvas(command.control1, page, transform);
              const control2 = pageToCanvas(command.control2, page, transform);
              context.bezierCurveTo(
                control1.x,
                control1.y,
                control2.x,
                control2.y,
                endpoint.x,
                endpoint.y,
              );
            }
          }
          context.stroke();
        }
      }
      context.restore();
    }

    if (mode === "toolpath" && plan) {
      if (showTravel) {
        context.strokeStyle = "rgba(106, 101, 91, .55)";
        context.lineWidth = 1;
        context.setLineDash([5, 5]);
        for (const travel of plan.travel_segments) {
          tracePoints(context, [travel.start, travel.end], page, transform);
        }
        context.setLineDash([]);
      }
      for (const plotPass of plan.passes) {
        context.strokeStyle = plotPass.preview_color;
        context.lineWidth = Math.max(1, transform.scale * 0.32);
        for (const path of plotPass.ordered_paths) {
          if (path.kind === "dot") {
            const dot = path.points[0];
            if (!dot) continue;
            const center = pageToCanvas(dot, page, transform);
            context.beginPath();
            context.arc(
              center.x,
              center.y,
              Math.max(1, ((path.dot_diameter_mm ?? 0) * transform.scale) / 2),
              0,
              Math.PI * 2,
            );
            context.fillStyle = plotPass.preview_color;
            context.fill();
          } else {
            tracePoints(context, path.points, page, transform);
          }
        }
      }
    }

    if (mode === "reconstruction" && reconstructed) {
      for (const segment of reconstructed.reconstructed_toolpath.segments) {
        if (!segment.pen_down && !showTravel) continue;
        context.strokeStyle = segment.pen_down ? "#d4512a" : "rgba(79, 105, 101, .45)";
        context.lineWidth = segment.pen_down ? 1.4 : 1;
        context.setLineDash(segment.pen_down ? [] : [5, 5]);
        tracePoints(context, [segment.start, segment.end], page, transform);
      }
      for (const dot of reconstructed.reconstructed_toolpath.draw_dots) {
        const center = pageToCanvas(dot, page, transform);
        context.beginPath();
        context.arc(center.x, center.y, 2, 0, Math.PI * 2);
        context.fillStyle = "#d4512a";
        context.fill();
      }
      context.setLineDash([]);
    }
  }, [
    design,
    mode,
    overprint,
    page,
    plan,
    rasterImage,
    rasterPreview,
    reconstructed,
    showTravel,
    transform,
  ]);

  useEffect(() => {
    if (renderToken === 0) return;
    const frame = window.requestAnimationFrame(() => onRendered(renderToken));
    return () => window.cancelAnimationFrame(frame);
  }, [onRendered, renderToken]);

  return (
    <div className="viewer-shell">
      <div className="viewer-toolbar">
        <span>
          {mode === "design"
            ? rasterPreview
              ? "Raster preprocessing"
              : "Design geometry"
            : mode === "toolpath"
              ? "PlotPlan"
              : "Parsed G-code"}
        </span>
        <button type="button" onClick={fit}>
          Fit page
        </button>
        <button type="button" onClick={() => setTransform(fitTransform(page, WIDTH, HEIGHT))}>
          Reset view
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        aria-label={`${mode} canvas preview`}
        onWheel={(event) => {
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.12 : 0.89;
          setTransform((current) => ({ ...current, scale: current.scale * factor }));
        }}
        onPointerDown={(event) => {
          dragOrigin.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const previous = dragOrigin.current;
          if (!previous) return;
          setTransform((current) => ({
            ...current,
            offsetX: current.offsetX + event.clientX - previous.x,
            offsetY: current.offsetY + event.clientY - previous.y,
          }));
          dragOrigin.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={() => {
          dragOrigin.current = null;
        }}
      />
    </div>
  );
}
