from __future__ import annotations

import base64
import hashlib
import io
import json
import zipfile
from typing import Literal

from plotter_core.gcode.parser import parse_gcode, reconstruct_toolpath
from plotter_core.gcode.validation import validate_profile_for_page, validate_program
from plotter_core.gcode.writer import FluidncZWriter, pass_filename
from plotter_core.models import (
    ExportBundle,
    ExportManifest,
    ExportManifestEntry,
    GcodeProgram,
    GcodeStatistics,
    MachineProfile,
    PlannedPath,
    PlotPlan,
    ProjectRecipe,
    canonical_sha256,
)


def _build_program(
    filename: str,
    text: str,
    profile: MachineProfile,
    expected_paths: list[PlannedPath],
    tolerance: float,
) -> GcodeProgram:
    instructions = parse_gcode(text)
    reconstructed = reconstruct_toolpath(instructions, profile)
    validation = validate_program(instructions, reconstructed, profile, expected_paths, tolerance)
    if not validation.valid:
        messages = "; ".join(issue.message for issue in validation.issues if issue.blocking)
        raise ValueError(f"generated {filename} failed round-trip validation: {messages}")
    return GcodeProgram(
        filename=filename,
        text=text,
        parsed_instructions=instructions,
        reconstructed_toolpath=reconstructed,
        validation=validation,
        statistics=GcodeStatistics(
            instruction_count=len(instructions),
            draw_segment_count=sum(1 for segment in reconstructed.segments if segment.pen_down),
            travel_segment_count=sum(
                1 for segment in reconstructed.segments if not segment.pen_down
            ),
            pause_count=reconstructed.pause_count,
            byte_count=len(text.encode("utf-8")),
        ),
        sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
    )


def _deterministic_zip(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for filename in sorted(files):
            info = zipfile.ZipInfo(filename=filename, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[filename])
    return buffer.getvalue()


def export_gcode_bundle(
    recipe: ProjectRecipe,
    plan: PlotPlan,
    profile: MachineProfile,
) -> ExportBundle:
    validate_profile_for_page(profile, plan.page.width_mm, plan.page.height_mm)
    writer = FluidncZWriter(profile, recipe.name)
    tolerance = max(0.001, 0.75 * 10 ** (-profile.precision_decimals))
    programs: list[GcodeProgram] = []
    entries: list[ExportManifestEntry] = []

    def add(
        filename: str,
        text: str,
        expected: list[PlannedPath],
        kind: Literal["pass", "combined", "dry-run", "page-boundary"],
        pass_id: str | None = None,
    ) -> None:
        program = _build_program(filename, text, profile, expected, tolerance)
        programs.append(program)
        entries.append(
            ExportManifestEntry(
                filename=filename,
                sha256=program.sha256,
                byte_count=program.statistics.byte_count,
                kind=kind,
                pass_id=pass_id,
            )
        )

    if recipe.export.separate_pass_files:
        for index, plot_pass in enumerate(plan.passes, start=1):
            filename = pass_filename(index, plot_pass)
            add(
                filename,
                writer.pass_program(plot_pass),
                plot_pass.ordered_paths,
                "pass",
                plot_pass.pass_id,
            )
    all_paths = [path for plot_pass in plan.passes for path in plot_pass.ordered_paths]
    if recipe.export.combined_file:
        add(
            "combined.nc",
            writer.combined_program(plan.passes),
            all_paths,
            "combined",
        )
    if recipe.export.dry_run:
        add("dry-run.nc", writer.dry_run_program(plan), [], "dry-run")
    if recipe.export.page_boundary:
        add("page-boundary.nc", writer.boundary_program(plan), [], "page-boundary")

    manifest = ExportManifest(
        project_id=recipe.project_id,
        design_sha256=plan.source_design_sha256,
        plot_plan_sha256=plan.normalized_sha256,
        profile_id=profile.profile_id,
        round_trip_tolerance_mm=tolerance,
        valid=all(program.validation.valid for program in programs),
        entries=entries,
    )
    manifest = manifest.model_copy(update={"manifest_sha256": canonical_sha256(manifest)})
    manifest_bytes = (json.dumps(manifest.model_dump(mode="json"), indent=2) + "\n").encode()
    archive_files = {program.filename: program.text.encode() for program in programs}
    archive_files["manifest.json"] = manifest_bytes
    archive = _deterministic_zip(archive_files)
    return ExportBundle(
        manifest=manifest,
        programs=programs,
        archive_base64=base64.b64encode(archive).decode("ascii"),
    )
