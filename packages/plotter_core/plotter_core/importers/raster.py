from __future__ import annotations

import base64
import hashlib
import io
import math
import warnings
from collections.abc import Callable

from PIL import Image, ImageEnhance, ImageFilter, ImageOps, UnidentifiedImageError

from plotter_core.models import (
    ProjectRecipe,
    RasterPlacement,
    RasterPreview,
    RasterPreviewWarning,
)

ProgressCallback = Callable[[str, int | None, int | None], None]

MAX_SOURCE_PIXELS = 100_000_000
MAX_SOURCE_DIMENSION = 32_768
MAX_OUTPUT_DIMENSION = 8_192
QUALITY_SAMPLING_MULTIPLIER = {"draft": 0.5, "standard": 1.0, "export": 1.5}


def effective_pen_width_mm(recipe: ProjectRecipe) -> float:
    active_pen_widths = [
        pen.tip_width_mm
        for pen in recipe.pen_palette
        if any(
            plot_pass.enabled and plot_pass.pen_profile_id == pen.pen_id
            for plot_pass in recipe.passes
        )
    ]
    return min(active_pen_widths or [pen.tip_width_mm for pen in recipe.pen_palette] or [0.5])


def _checkpoint(
    callback: ProgressCallback | None,
    stage: str,
    completed: int,
    total: int,
) -> None:
    if callback is not None:
        callback(stage, completed, total)


def _expected_format(media_type: str) -> str:
    try:
        return {"image/png": "PNG", "image/jpeg": "JPEG"}[media_type]
    except KeyError as error:
        raise ValueError("raster preprocessing requires a PNG or JPEG asset") from error


def _decode(content: bytes, media_type: str) -> tuple[Image.Image, int, list[RasterPreviewWarning]]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            source = Image.open(io.BytesIO(content))
            if source.format != _expected_format(media_type):
                raise ValueError(
                    f"decoded raster format {source.format!r} does not match {media_type!r}"
                )
            width, height = source.size
            if (
                width <= 0
                or height <= 0
                or width > MAX_SOURCE_DIMENSION
                or height > MAX_SOURCE_DIMENSION
                or width * height > MAX_SOURCE_PIXELS
            ):
                raise ValueError(
                    "raster dimensions exceed the bounded decode limit "
                    f"({MAX_SOURCE_DIMENSION}px per side, {MAX_SOURCE_PIXELS} pixels)"
                )
            frame_count = int(getattr(source, "n_frames", 1))
            source.seek(0)
            source.load()
            image = ImageOps.exif_transpose(source).copy()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ValueError("raster dimensions exceed Pillow's safe decode limit") from error
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("raster asset could not be decoded") from error

    result_warnings: list[RasterPreviewWarning] = []
    if frame_count > 1:
        result_warnings.append(
            RasterPreviewWarning(
                code="animated-raster-first-frame",
                message=f"Animated raster has {frame_count} frames; only the first frame is used.",
            )
        )
    return image, frame_count, result_warnings


def _crop_box(recipe: ProjectRecipe, width: int, height: int) -> tuple[int, int, int, int]:
    crop = recipe.raster_preprocess.crop
    left = min(width - 1, math.floor(crop.x * width))
    top = min(height - 1, math.floor(crop.y * height))
    right = min(width, max(left + 1, math.ceil((crop.x + crop.width) * width)))
    bottom = min(height, max(top + 1, math.ceil((crop.y + crop.height) * height)))
    return left, top, right, bottom


def _placement(recipe: ProjectRecipe, image_width: int, image_height: int) -> RasterPlacement:
    safe_width = recipe.page.width_mm - 2 * recipe.page.margin_mm
    safe_height = recipe.page.height_mm - 2 * recipe.page.margin_mm
    source_aspect = image_width / image_height
    safe_aspect = safe_width / safe_height
    fit_mode = recipe.raster_preprocess.fit_mode
    if fit_mode == "stretch":
        width_mm, height_mm = safe_width, safe_height
    elif (fit_mode == "contain" and source_aspect >= safe_aspect) or (
        fit_mode == "cover" and source_aspect < safe_aspect
    ):
        width_mm = safe_width
        height_mm = width_mm / source_aspect
    else:
        height_mm = safe_height
        width_mm = height_mm * source_aspect
    scale = recipe.raster_preprocess.scale_percent / 100
    width_mm *= scale
    height_mm *= scale
    return RasterPlacement(
        x_mm=(recipe.page.width_mm - width_mm) / 2,
        y_mm=(recipe.page.height_mm - height_mm) / 2,
        width_mm=width_mm,
        height_mm=height_mm,
    )


def _processing_size(
    recipe: ProjectRecipe,
    placement: RasterPlacement,
) -> tuple[int, int, bool]:
    pen_width = effective_pen_width_mm(recipe)
    samples = (
        recipe.raster_preprocess.sampling_pixels_per_pen_width
        * QUALITY_SAMPLING_MULTIPLIER[recipe.mode.quality]
    )
    desired_width = max(1, math.ceil(placement.width_mm * samples / pen_width))
    desired_height = max(1, math.ceil(placement.height_mm * samples / pen_width))
    maximum_pixels = int(recipe.raster_preprocess.maximum_megapixels * 1_000_000)
    limit_scale = min(
        1.0,
        MAX_OUTPUT_DIMENSION / desired_width,
        MAX_OUTPUT_DIMENSION / desired_height,
        math.sqrt(maximum_pixels / (desired_width * desired_height)),
    )
    return (
        max(1, math.floor(desired_width * limit_scale)),
        max(1, math.floor(desired_height * limit_scale)),
        limit_scale < 1,
    )


def _extract_channel(image: Image.Image, channel: str) -> tuple[Image.Image, bool]:
    had_transparency = image.mode in {"RGBA", "LA"} or "transparency" in image.info
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    background.alpha_composite(rgba)
    rgb = background.convert("RGB")
    if channel == "luminance":
        return ImageOps.grayscale(rgb), had_transparency
    return rgb.getchannel({"red": "R", "green": "G", "blue": "B"}[channel]), had_transparency


def preprocess_color_image(
    content: bytes,
    media_type: str,
    recipe: ProjectRecipe,
) -> tuple[Image.Image, RasterPlacement, list[RasterPreviewWarning]]:
    """Prepare deterministic RGB pixels with the same crop, placement, and scale as the preview."""

    source, frame_count, result_warnings = _decode(content, media_type)
    if frame_count > 1:
        # _decode already reports that only frame zero is used.
        source.seek(0)
    image = source.crop(_crop_box(recipe, *source.size))
    if recipe.raster_preprocess.rotation_degrees:
        image = image.rotate(-recipe.raster_preprocess.rotation_degrees, expand=True)
    placement = _placement(recipe, image.width, image.height)
    output_width, output_height, was_capped = _processing_size(recipe, placement)
    if was_capped:
        result_warnings.append(
            RasterPreviewWarning(
                code="processing-resolution-capped",
                message=(
                    "Physical sampling resolution exceeded the configured processing budget and "
                    "was reduced."
                ),
            )
        )
    image = image.resize((output_width, output_height), Image.Resampling.LANCZOS)
    had_transparency = image.mode in {"RGBA", "LA"} or "transparency" in image.info
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    background.alpha_composite(rgba)
    image = background.convert("RGB")
    if had_transparency:
        result_warnings.append(
            RasterPreviewWarning(
                code="transparent-background-composited",
                message="Transparent pixels were composited over white.",
            )
        )
    settings = recipe.raster_preprocess
    if settings.invert:
        image = ImageOps.invert(image)
    if settings.contrast != 1:
        image = ImageEnhance.Contrast(image).enhance(settings.contrast)
    if settings.gamma != 1:
        inverse_gamma = 1 / settings.gamma
        lookup = [round(255 * ((value / 255) ** inverse_gamma)) for value in range(256)]
        image = image.point(lookup * 3)
    if settings.blur_radius_px > 0:
        image = image.filter(ImageFilter.GaussianBlur(settings.blur_radius_px))
    if settings.sharpen_amount > 0:
        image = image.filter(
            ImageFilter.UnsharpMask(
                radius=1.5,
                percent=round(settings.sharpen_amount * 100),
                threshold=2,
            )
        )
    if settings.threshold_mode != "none" or settings.morphology != "none":
        result_warnings.append(
            RasterPreviewWarning(
                code="color-binary-controls-ignored",
                message="Threshold and morphology controls do not apply to color quantization.",
            )
        )
    return image, placement, result_warnings


def _adaptive_threshold(image: Image.Image, window: int, offset: int) -> Image.Image:
    local_mean = image.filter(ImageFilter.BoxBlur((window - 1) / 2))
    source = image.tobytes()
    means = local_mean.tobytes()
    output = bytes(
        255 if value >= mean - offset else 0 for value, mean in zip(source, means, strict=True)
    )
    return Image.frombytes("L", image.size, output)


def _process_tone(image: Image.Image, recipe: ProjectRecipe) -> Image.Image:
    settings = recipe.raster_preprocess
    if settings.invert:
        image = ImageOps.invert(image)
    if settings.contrast != 1:
        image = ImageEnhance.Contrast(image).enhance(settings.contrast)
    if settings.gamma != 1:
        inverse_gamma = 1 / settings.gamma
        lookup = [round(255 * ((value / 255) ** inverse_gamma)) for value in range(256)]
        image = image.point(lookup)
    if settings.blur_radius_px > 0:
        image = image.filter(ImageFilter.GaussianBlur(settings.blur_radius_px))
    if settings.sharpen_amount > 0:
        image = image.filter(
            ImageFilter.UnsharpMask(
                radius=1.5,
                percent=round(settings.sharpen_amount * 100),
                threshold=2,
            )
        )
    if settings.threshold_mode == "global":
        image = image.point(lambda value: 255 if value >= settings.threshold else 0)
    elif settings.threshold_mode == "adaptive":
        image = _adaptive_threshold(
            image,
            settings.adaptive_window_px,
            settings.adaptive_offset,
        )
    if settings.morphology != "none" and settings.morphology_radius_px > 0:
        size = settings.morphology_radius_px * 2 + 1
        if settings.morphology == "open":
            image = image.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size))
        else:
            image = image.filter(ImageFilter.MinFilter(size)).filter(ImageFilter.MaxFilter(size))
    return image


def preprocess_raster(
    content: bytes,
    media_type: str,
    recipe: ProjectRecipe,
    *,
    source_sha256: str,
    checkpoint: ProgressCallback | None = None,
) -> RasterPreview:
    """Decode and preprocess one raster into a physically scaled, cacheable preview."""

    _checkpoint(checkpoint, "decode-raster", 0, 5)
    source, frame_count, result_warnings = _decode(content, media_type)
    source_width, source_height = source.size
    _checkpoint(checkpoint, "crop-and-rotate", 1, 5)
    crop_box = _crop_box(recipe, source_width, source_height)
    image = source.crop(crop_box)
    if recipe.raster_preprocess.rotation_degrees:
        image = image.rotate(-recipe.raster_preprocess.rotation_degrees, expand=True)
    placement = _placement(recipe, image.width, image.height)
    output_width, output_height, was_capped = _processing_size(recipe, placement)
    if was_capped:
        result_warnings.append(
            RasterPreviewWarning(
                code="processing-resolution-capped",
                message=(
                    "Physical sampling resolution exceeded the configured processing budget and "
                    "was reduced."
                ),
            )
        )
    _checkpoint(checkpoint, "resample-raster", 2, 5)
    image = image.resize((output_width, output_height), Image.Resampling.LANCZOS)
    image, had_transparency = _extract_channel(image, recipe.raster_preprocess.channel)
    if had_transparency:
        result_warnings.append(
            RasterPreviewWarning(
                code="transparent-background-composited",
                message="Transparent pixels were composited over white.",
            )
        )
    _checkpoint(checkpoint, "tone-adjustments", 3, 5)
    image = _process_tone(image, recipe)
    _checkpoint(checkpoint, "encode-preview", 4, 5)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG", optimize=False)
    png = encoded.getvalue()
    _checkpoint(checkpoint, "raster-preview-ready", 5, 5)
    return RasterPreview(
        project_id=recipe.project_id,
        source_asset_sha256=source_sha256,
        source_width_px=source_width,
        source_height_px=source_height,
        frame_count=frame_count,
        crop_box_px=crop_box,
        processed_width_px=output_width,
        processed_height_px=output_height,
        mm_per_pixel_x=placement.width_mm / output_width,
        mm_per_pixel_y=placement.height_mm / output_height,
        pen_width_mm=effective_pen_width_mm(recipe),
        placement=placement,
        preview_png_base64=base64.b64encode(png).decode("ascii"),
        preview_sha256=hashlib.sha256(png).hexdigest(),
        warnings=result_warnings,
    )
