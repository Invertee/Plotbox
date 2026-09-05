from __future__ import annotations

import json
from pathlib import Path

from plotter_core.models import (
    CompactGeometry,
    DesignDocument,
    ExportBundle,
    GcodeProgram,
    JobState,
    MachineProfile,
    PlotPlan,
    ProjectRecipe,
    RasterPreview,
    SvgExportBundle,
)
from plotter_core.modes import ModeManifest
from plotterapp_api.fluidnc import (
    AxisCalibrationRequest,
    AxisCalibrationResult,
    FluidNCActionRequest,
    FluidNCActionResult,
    FluidNCProgramResult,
    FluidNCSettings,
)
from plotterapp_api.fluidnc_tests import FluidNCCommissioningTestRequest
from plotterapp_api.schemas import SendGcodeRequest

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages" / "schemas"
MODELS = {
    "project-recipe": ProjectRecipe,
    "design-document": DesignDocument,
    "plot-plan": PlotPlan,
    "machine-profile": MachineProfile,
    "gcode-program": GcodeProgram,
    "export-bundle": ExportBundle,
    "job-state": JobState,
    "compact-geometry": CompactGeometry,
    "raster-preview": RasterPreview,
    "svg-export-bundle": SvgExportBundle,
    "mode-manifest": ModeManifest,
    "fluidnc-settings": FluidNCSettings,
    "fluidnc-commissioning-test-request": FluidNCCommissioningTestRequest,
    "fluidnc-action-request": FluidNCActionRequest,
    "fluidnc-action-result": FluidNCActionResult,
    "fluidnc-program-result": FluidNCProgramResult,
    "axis-calibration-request": AxisCalibrationRequest,
    "axis-calibration-result": AxisCalibrationResult,
    "send-gcode-request": SendGcodeRequest,
}


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, model in MODELS.items():
        schema = model.model_json_schema()
        (OUTPUT / f"{name}.schema.json").write_text(
            json.dumps(schema, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )


if __name__ == "__main__":
    main()
