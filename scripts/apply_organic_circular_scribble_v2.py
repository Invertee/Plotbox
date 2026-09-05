from __future__ import annotations

from pathlib import Path

SOURCE_PATH = Path("packages/plotter_core/plotter_core/importers/raster_vectorize.py")
TEST_PATH = Path("packages/plotter_core/tests/test_circular_scribble.py")

NEW_FUNCTION = '''def _circular_scribble_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    """Trace one organic tone-aware curl along a meandering serpentine carrier."""

    settings = recipe.raster_vectorize
    placement = preview.placement
    maximum_radius = min(
        settings.squiggle_amplitude_mm,
        placement.width_mm / 4,
        placement.height_mm / 4,
    )
    if maximum_radius <= 0:
        return VectorizationResult(paths=[], removed_segments=1)

    minimum_radius = maximum_radius * 0.36
    light_pitch = max(0.3, settings.squiggle_wavelength_mm)
    dark_pitch = max(0.22, min(light_pitch * 0.28, maximum_radius * 0.68))
    nominal_lane_spacing = max(settings.squiggle_spacing_mm, maximum_radius * 0.72)

    min_center_x = placement.x_mm + maximum_radius
    max_center_x = placement.x_mm + placement.width_mm - maximum_radius
    min_center_y = placement.y_mm + maximum_radius
    max_center_y = placement.y_mm + placement.height_mm - maximum_radius
    horizontal_span = max_center_x - min_center_x
    vertical_span = max_center_y - min_center_y
    if horizontal_span <= 0 or vertical_span < 0:
        return VectorizationResult(paths=[], removed_segments=1)

    row_count = max(1, math.floor(vertical_span / nominal_lane_spacing) + 1)
    if row_count == 1:
        baselines = [(min_center_y + max_center_y) / 2]
    else:
        gap_weights = [
            max(
                0.65,
                0.92
                + 0.18 * math.sin((gap + 1) * 1.61803398875 + 0.31)
                + 0.08 * math.sin((gap + 1) * 0.713 + 1.17),
            )
            for gap in range(row_count - 1)
        ]
        weight_total = sum(gap_weights)
        baselines = [min_center_y]
        accumulated = 0.0
        for weight in gap_weights:
            accumulated += weight
            baselines.append(min_center_y + vertical_span * accumulated / weight_total)

    pixels = cast(Any, image.load())
    points: list[FloatPoint] = []
    phase = 0.0
    carrier_distance = 0.0
    smoothed_darkness: float | None = None
    previous_center: FloatPoint | None = None
    previous_pitch: float | None = None
    phase_step = {
        "draft": math.tau / 18,
        "standard": math.tau / 24,
        "export": math.tau / 32,
    }[recipe.mode.quality]
    tone_smoothing_distance = max(0.45, maximum_radius * 1.8)
    wave_amplitude = min(maximum_radius * 0.62, nominal_lane_spacing * 0.26)

    def clamp_point(x: float, y: float) -> FloatPoint:
        return (
            min(placement.x_mm + placement.width_mm, max(placement.x_mm, x)),
            min(placement.y_mm + placement.height_mm, max(placement.y_mm, y)),
        )

    def darkness_at(point: FloatPoint) -> float:
        raw_darkness = (
            1.0
            - _sample_luminance(
                pixels,
                image.width,
                image.height,
                placement,
                point,
            )
            / 255.0
        )
        floor = settings.squiggle_min_darkness
        if raw_darkness <= floor:
            return 0.0
        return min(1.0, max(0.0, (raw_darkness - floor) / max(1e-9, 1.0 - floor)))

    def lane_terms(x: float, row: int) -> tuple[float, float]:
        baseline = baselines[row]
        if horizontal_span <= 0:
            return baseline, 0.0
        clearance = min(baseline - min_center_y, max_center_y - baseline)
        amplitude = min(wave_amplitude, max(0.0, clearance * 0.72))
        if amplitude <= 0:
            return baseline, 0.0

        u = min(1.0, max(0.0, (x - min_center_x) / horizontal_span))
        row_phase = row * 1.32471795724
        frequency_a = 1.13 + 0.11 * (row % 5)
        frequency_b = 2.71 + 0.09 * ((row * 3) % 7)
        frequency_c = 6.17 + 0.07 * ((row * 5) % 6)
        angle_a = math.tau * frequency_a * u + row_phase
        angle_b = math.tau * frequency_b * u + row_phase * 0.47 + 1.21
        angle_c = math.tau * frequency_c * u + row_phase * 1.31 + 0.63
        offset = amplitude * (
            0.56 * math.sin(angle_a)
            + 0.29 * math.sin(angle_b)
            + 0.15 * math.sin(angle_c)
        )
        slope = amplitude * math.tau / horizontal_span * (
            0.56 * frequency_a * math.cos(angle_a)
            + 0.29 * frequency_b * math.cos(angle_b)
            + 0.15 * frequency_c * math.cos(angle_c)
        )
        return baseline + offset, slope

    def lane_tangent(x: float, row: int, direction: float) -> FloatPoint:
        _, slope = lane_terms(x, row)
        magnitude = math.hypot(1.0, slope)
        return direction / magnitude, direction * slope / magnitude

    def emit_point(center: FloatPoint, tangent: FloatPoint, row: int) -> float:
        nonlocal carrier_distance
        nonlocal phase
        nonlocal previous_center
        nonlocal previous_pitch
        nonlocal smoothed_darkness

        tangent_x, tangent_y = tangent
        normal_x, normal_y = -tangent_y, tangent_x
        sample_offset = maximum_radius * 0.42
        raw_darkness = (
            0.46 * darkness_at(center)
            + 0.135
            * darkness_at(
                clamp_point(
                    center[0] + normal_x * sample_offset,
                    center[1] + normal_y * sample_offset,
                )
            )
            + 0.135
            * darkness_at(
                clamp_point(
                    center[0] - normal_x * sample_offset,
                    center[1] - normal_y * sample_offset,
                )
            )
            + 0.135
            * darkness_at(
                clamp_point(
                    center[0] + tangent_x * sample_offset,
                    center[1] + tangent_y * sample_offset,
                )
            )
            + 0.135
            * darkness_at(
                clamp_point(
                    center[0] - tangent_x * sample_offset,
                    center[1] - tangent_y * sample_offset,
                )
            )
        )

        distance_step = 0.0
        if previous_center is not None:
            distance_step = math.hypot(
                center[0] - previous_center[0],
                center[1] - previous_center[1],
            )
            carrier_distance += distance_step

        if smoothed_darkness is None:
            smoothed_darkness = raw_darkness
        else:
            smoothing = 1.0 - math.exp(-distance_step / tone_smoothing_distance)
            smoothed_darkness += smoothing * (raw_darkness - smoothed_darkness)

        tone = min(1.0, max(0.0, smoothed_darkness))
        radius_tone = (
            tone if settings.squiggle_modulation in {"amplitude", "both"} else 0.0
        )
        pitch_tone = (
            tone if settings.squiggle_modulation in {"frequency", "both"} else 0.0
        )
        radius = maximum_radius - (maximum_radius - minimum_radius) * radius_tone
        pitch = light_pitch - (light_pitch - dark_pitch) * pitch_tone

        organic_position = carrier_distance / max(maximum_radius, 0.1)
        radius_scale = (
            0.88
            + 0.07 * math.sin(organic_position * 0.37 + row * 1.11)
            + 0.05 * math.sin(organic_position * 0.91 + row * 0.43 + 1.7)
        )
        pitch_scale = (
            0.94
            + 0.14 * math.sin(organic_position * 0.19 + row * 0.83 + 0.4)
            + 0.08 * math.sin(organic_position * 0.47 + row * 1.37 + 2.1)
        )
        radius = max(minimum_radius * 0.72, min(maximum_radius, radius * radius_scale))
        pitch = max(dark_pitch * 0.72, min(light_pitch * 1.22, pitch * pitch_scale))

        if previous_pitch is not None and distance_step > 0:
            phase += math.tau * distance_step / max(0.1, (previous_pitch + pitch) / 2)

        angle = (
            phase
            + 0.13 * math.sin(organic_position * 0.43 + row * 1.17)
            + 0.05 * math.sin(phase * 0.41 + row * 0.67)
        )
        tangent_radius = radius * (
            0.84
            + 0.10 * math.sin(phase * 0.61 + row * 1.29 + 0.8)
            + 0.04 * math.sin(phase * 1.73 + organic_position * 0.11)
        )
        normal_radius = radius * (
            0.88
            + 0.08 * math.sin(phase * 0.73 + row * 0.53)
            + 0.04 * math.sin(phase * 1.91 + organic_position * 0.17 + 1.4)
        )
        point = clamp_point(
            center[0]
            + tangent_x * tangent_radius * math.sin(angle)
            + normal_x * normal_radius * math.cos(angle),
            center[1]
            + tangent_y * tangent_radius * math.sin(angle)
            + normal_y * normal_radius * math.cos(angle),
        )
        if not points or point != points[-1]:
            points.append(point)

        previous_center = center
        previous_pitch = pitch
        return pitch

    def target_advance(pitch: float, row: int) -> float:
        irregularity = (
            0.87
            + 0.07
            * math.sin(carrier_distance / max(maximum_radius * 2.3, 0.2) + row)
            + 0.04
            * math.sin(
                carrier_distance / max(maximum_radius * 0.91, 0.1) + row * 1.7
            )
        )
        return max(0.01, pitch * phase_step * irregularity / math.tau)

    row_start_x = min_center_x
    current_pitch = light_pitch
    for row, baseline in enumerate(baselines):
        del baseline
        _checkpoint(checkpoint, "circular-scribble-lanes", row, row_count)
        direction = 1.0 if row % 2 == 0 else -1.0

        if row + 1 < row_count:
            gap = baselines[row + 1] - baselines[row]
            turn_depth = min(
                horizontal_span * 0.45,
                max(maximum_radius * 1.1, gap * 0.65),
            )
            end_x = (
                max_center_x - turn_depth
                if direction > 0
                else min_center_x + turn_depth
            )
        else:
            turn_depth = 0.0
            end_x = max_center_x if direction > 0 else min_center_x

        if direction * (end_x - row_start_x) < 0:
            end_x = row_start_x

        x = row_start_x
        if row > 0 and x != end_x:
            _, slope = lane_terms(x, row)
            x_step = target_advance(current_pitch, row) / math.hypot(1.0, slope)
            x = (
                min(end_x, x + x_step)
                if direction > 0
                else max(end_x, x - x_step)
            )

        while True:
            center_y, slope = lane_terms(x, row)
            tangent = lane_tangent(x, row, direction)
            current_pitch = emit_point((x, center_y), tangent, row)
            if math.isclose(x, end_x, abs_tol=1e-9):
                break

            x_step = target_advance(current_pitch, row) / math.hypot(1.0, slope)
            next_x = x + direction * x_step
            if direction > 0 and next_x > end_x:
                next_x = end_x
            elif direction < 0 and next_x < end_x:
                next_x = end_x
            x = next_x

        if row + 1 >= row_count:
            continue

        start_y, start_slope = lane_terms(end_x, row)
        end_y, end_slope = lane_terms(end_x, row + 1)
        start_dx = direction * turn_depth * math.pi
        end_dx = -direction * turn_depth * math.pi
        start_dy = start_slope * start_dx
        end_dy = end_slope * end_dx

        def transition_terms(t: float) -> tuple[FloatPoint, FloatPoint, float]:
            t2 = t * t
            t3 = t2 * t
            h00 = 2 * t3 - 3 * t2 + 1
            h10 = t3 - 2 * t2 + t
            h01 = -2 * t3 + 3 * t2
            h11 = t3 - t2
            center_x = end_x + direction * turn_depth * math.sin(math.pi * t)
            center_y = (
                h00 * start_y
                + h10 * start_dy
                + h01 * end_y
                + h11 * end_dy
            )

            dx_dt = direction * turn_depth * math.pi * math.cos(math.pi * t)
            dy_dt = (
                (6 * t2 - 6 * t) * start_y
                + (3 * t2 - 4 * t + 1) * start_dy
                + (-6 * t2 + 6 * t) * end_y
                + (3 * t2 - 2 * t) * end_dy
            )
            speed = math.hypot(dx_dt, dy_dt)
            if speed <= 1e-12:
                tangent = (-direction, 0.0)
            else:
                tangent = (dx_dt / speed, dy_dt / speed)
            return (center_x, center_y), tangent, speed

        t = 0.0
        while t < 1.0:
            _, _, speed = transition_terms(t)
            parameter_step = target_advance(current_pitch, row) / max(speed, 1e-9)
            parameter_step = min(0.12, max(0.004, parameter_step))
            t = min(1.0, t + parameter_step)
            center, tangent, _ = transition_terms(t)
            current_pitch = emit_point(center, tangent, row)

        row_start_x = end_x

    _checkpoint(checkpoint, "circular-scribble-lanes", row_count, row_count)
    return VectorizationResult(paths=[points] if len(points) >= 2 else [])


'''

source = SOURCE_PATH.read_text()
start = source.index("def _circular_scribble_paths(")
end = source.index("\ndef _interpolate(", start)
SOURCE_PATH.write_text(source[:start] + NEW_FUNCTION + source[end + 1 :])

TEST_APPEND = '''\n\ndef test_circular_scribble_has_rounded_segments_without_straight_loop_bridges() -> None:\n    recipe = _recipe()\n    document = vectorize_raster(\n        _gradient_fixture(),\n        "image/png",\n        recipe,\n        source_sha256="b" * 64,\n    )\n    points = _points(document)\n    lengths = [\n        math.hypot(second[0] - first[0], second[1] - first[1])\n        for first, second in zip(points, points[1:], strict=False)\n    ]\n    non_zero_lengths = [length for length in lengths if length > 1e-9]\n\n    assert len(points) > 1_500\n    assert non_zero_lengths\n    assert max(non_zero_lengths) < 1.8\n    ordered_lengths = sorted(non_zero_lengths)\n    assert ordered_lengths[round((len(ordered_lengths) - 1) * 0.95)] < 1.0\n\n    headings = [\n        math.atan2(second[1] - first[1], second[0] - first[0])\n        for first, second in zip(points, points[1:], strict=False)\n        if first != second\n    ]\n    turns = [\n        (second - first + math.pi) % math.tau - math.pi\n        for first, second in zip(headings, headings[1:], strict=False)\n    ]\n    distinct_turns = {round(turn, 2) for turn in turns if abs(turn) > 1e-4}\n    assert len(distinct_turns) > 40\n'''

tests = TEST_PATH.read_text()
marker = "test_circular_scribble_has_rounded_segments_without_straight_loop_bridges"
if marker not in tests:
    TEST_PATH.write_text(tests.rstrip() + TEST_APPEND + "\n")
