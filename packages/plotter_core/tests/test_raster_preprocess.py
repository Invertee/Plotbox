from __future__ import annotations

import base64
import io

import pytest
from PIL import Image
from plotter_core.importers.raster import preprocess_raster
from plotter_core.models import NormalizedCrop, ProjectRecipe


def _png_fixture(*, width: int = 80, height: int = 40) -> bytes:
    image = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    for x in range(width):
        for y in range(height):
            image.putpixel(
                (x, y),
                (x * 255 // max(width - 1, 1), y * 255 // max(height - 1, 1), 64, 255),
            )
    image.putpixel((0, 0), (0, 0, 0, 0))
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def _jpeg_fixture() -> bytes:
    image = Image.new("RGB", (32, 24), (90, 130, 170))
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG")
    return encoded.getvalue()


def test_preprocess_respects_crop_rotation_page_scale_and_physical_quality() -> None:
    recipe = ProjectRecipe(project_id="raster-scale", name="Raster scale")
    recipe.page.width_mm = 100
    recipe.page.height_mm = 80
    recipe.page.margin_mm = 10
    recipe.mode.mode_id = "import.raster"
    recipe.mode.quality = "draft"
    recipe.raster_preprocess.crop = NormalizedCrop(x=0.25, width=0.5)
    recipe.raster_preprocess.rotation_degrees = 90

    draft = preprocess_raster(
        _png_fixture(),
        "image/png",
        recipe,
        source_sha256="a" * 64,
    )
    assert draft.crop_box_px == (20, 0, 60, 40)
    assert draft.placement.width_mm == pytest.approx(60)
    assert draft.placement.height_mm == pytest.approx(60)
    assert (draft.placement.x_mm, draft.placement.y_mm) == pytest.approx((20, 10))
    assert (draft.processed_width_px, draft.processed_height_px) == (180, 180)
    assert draft.mm_per_pixel_x == pytest.approx(1 / 3)
    assert draft.preview_sha256

    recipe.mode.quality = "export"
    exported = preprocess_raster(
        _png_fixture(),
        "image/png",
        recipe,
        source_sha256="a" * 64,
    )
    assert exported.processed_width_px == 540
    assert exported.processed_height_px == 540
    assert exported.preview_sha256 != draft.preview_sha256


def test_preprocess_applies_channels_tone_threshold_and_transparency_warning() -> None:
    recipe = ProjectRecipe(project_id="raster-tone", name="Raster tone")
    recipe.mode.mode_id = "import.raster"
    recipe.raster_preprocess.channel = "red"
    recipe.raster_preprocess.invert = True
    recipe.raster_preprocess.contrast = 1.4
    recipe.raster_preprocess.gamma = 1.8
    recipe.raster_preprocess.blur_radius_px = 0.5
    recipe.raster_preprocess.sharpen_amount = 0.5
    recipe.raster_preprocess.threshold_mode = "adaptive"
    recipe.raster_preprocess.morphology = "open"
    recipe.raster_preprocess.morphology_radius_px = 1

    preview = preprocess_raster(
        _png_fixture(width=24, height=16),
        "image/png",
        recipe,
        source_sha256="b" * 64,
    )
    decoded = Image.open(io.BytesIO(base64.b64decode(preview.preview_png_base64)))
    assert decoded.mode == "L"
    assert set(decoded.getdata()) <= {0, 255}
    assert "transparent-background-composited" in {warning.code for warning in preview.warnings}


def test_bounded_decode_rejects_excessive_source_dimensions(monkeypatch) -> None:
    monkeypatch.setattr("plotter_core.importers.raster.MAX_SOURCE_PIXELS", 100)
    recipe = ProjectRecipe(project_id="bounded", name="Bounded")
    with pytest.raises(ValueError, match="bounded decode limit"):
        preprocess_raster(
            _png_fixture(width=11, height=10),
            "image/png",
            recipe,
            source_sha256="c" * 64,
        )


def test_declared_raster_type_must_match_decoded_format() -> None:
    recipe = ProjectRecipe(project_id="mismatch", name="Mismatch")
    with pytest.raises(ValueError, match="does not match"):
        preprocess_raster(
            _png_fixture(),
            "image/jpeg",
            recipe,
            source_sha256="d" * 64,
        )


def test_jpeg_decode_uses_the_same_preprocessing_contract() -> None:
    recipe = ProjectRecipe(project_id="jpeg", name="JPEG")
    preview = preprocess_raster(
        _jpeg_fixture(),
        "image/jpeg",
        recipe,
        source_sha256="e" * 64,
    )
    assert (preview.source_width_px, preview.source_height_px) == (32, 24)
    assert base64.b64decode(preview.preview_png_base64).startswith(b"\x89PNG")
