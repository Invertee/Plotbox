from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw
from plotter_core.gcode import export_gcode_bundle
from plotter_core.generator import generate_test_design
from plotter_core.models import MachineProfile, ProjectRecipe
from plotter_core.planning import build_plot_plan

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "fixtures"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def write_raster_fixtures() -> None:
    raster_directory = FIXTURE_ROOT / "raster"
    raster_directory.mkdir(parents=True, exist_ok=True)

    line_art = Image.new("L", (96, 64), 255)
    line_draw = ImageDraw.Draw(line_art)
    line_draw.rectangle((8, 8, 87, 55), outline=20, width=5)
    line_draw.line((8, 32, 87, 32), fill=65, width=3)
    line_draw.arc((31, 15, 65, 49), 0, 300, fill=35, width=3)
    line_art.save(raster_directory / "line-art.png", format="PNG")

    grayscale = Image.new("L", (128, 80), 255)
    for y in range(grayscale.height):
        for x in range(grayscale.width):
            radial = min(1.0, ((x - 64) ** 2 + (y - 40) ** 2) ** 0.5 / 72)
            grayscale.putpixel((x, y), round(35 + 220 * radial))
    grayscale.save(raster_directory / "grayscale-tone.png", format="PNG")

    poster = Image.new("RGB", (120, 80), "white")
    poster_draw = ImageDraw.Draw(poster)
    poster_draw.rectangle((8, 8, 55, 71), fill="#d93636")
    poster_draw.ellipse((65, 9, 112, 70), fill="#315fc0")
    poster.save(raster_directory / "two-color-poster.png", format="PNG")

    transparent = Image.new("RGBA", (80, 60), (255, 255, 255, 0))
    transparent_draw = ImageDraw.Draw(transparent)
    transparent_draw.polygon(((10, 50), (40, 8), (70, 50)), fill=(20, 20, 20, 220))
    transparent.save(raster_directory / "transparent-line-art.png", format="PNG")


def main() -> None:
    write_raster_fixtures()
    recipe = ProjectRecipe(
        project_id="vertical-slice-a3",
        name="A3 vertical slice acceptance",
        mode={"seed": "codex-vertical-slice-1", "quality": "export"},
    )
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())

    write_json(FIXTURE_ROOT / "projects" / "vertical-slice-a3.json", recipe.model_dump(mode="json"))
    write_json(FIXTURE_ROOT / "designs" / "vertical-slice-a3.json", design.model_dump(mode="json"))
    write_json(FIXTURE_ROOT / "plot-plans" / "vertical-slice-a3.json", plan.model_dump(mode="json"))
    gcode_directory = FIXTURE_ROOT / "gcode" / "vertical-slice-a3"
    gcode_directory.mkdir(parents=True, exist_ok=True)
    for program in bundle.programs:
        (gcode_directory / program.filename).write_text(
            program.text, encoding="utf-8", newline="\n"
        )
    write_json(gcode_directory / "manifest.json", bundle.manifest.model_dump(mode="json"))
    combined = next(program for program in bundle.programs if program.filename == "combined.nc")
    write_json(
        gcode_directory / "reconstructed-toolpath-summary.json",
        {
            "draw_path_count": len(combined.reconstructed_toolpath.draw_paths),
            "draw_segment_count": combined.statistics.draw_segment_count,
            "travel_segment_count": combined.statistics.travel_segment_count,
            "pause_count": combined.statistics.pause_count,
            "final_z_mm": combined.reconstructed_toolpath.final_z_mm,
            "max_xy_error_mm": combined.validation.max_xy_error_mm,
        },
    )
    write_json(
        FIXTURE_ROOT / "golden-hashes.json",
        {
            "design_sha256": design.metadata.normalized_sha256,
            "plot_plan_sha256": plan.normalized_sha256,
            "manifest_sha256": bundle.manifest.manifest_sha256,
            "program_sha256": {program.filename: program.sha256 for program in bundle.programs},
        },
    )


if __name__ == "__main__":
    main()
