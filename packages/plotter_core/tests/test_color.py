import pytest
from plotter_core.color import delta_e, hex_to_rgb, rgb_to_lab, suggest_nearest_pen
from plotter_core.models import PenProfile


def test_lab_color_distance_is_perceptual_and_deterministic() -> None:
    assert hex_to_rgb("#00A6C8") == (0, 166, 200)
    black = rgb_to_lab((0, 0, 0))
    white = rgb_to_lab((255, 255, 255))
    assert round(black.lightness, 6) == 0
    assert white.lightness == pytest.approx(100)
    assert delta_e(black, white) == pytest.approx(100)


def test_nearest_pen_suggestion_does_not_change_source_color() -> None:
    pens = [
        PenProfile(
            pen_id="red",
            name="Red",
            display_color="#d92f2f",
            tip_width_mm=0.5,
        ),
        PenProfile(
            pen_id="blue",
            name="Blue",
            display_color="#2455b5",
            tip_width_mm=0.5,
        ),
    ]
    suggestion = suggest_nearest_pen("#e04035", pens)
    assert suggestion is not None
    assert suggestion.pen_id == "red"
    assert suggestion.display_color == "#d92f2f"
    assert suggestion.delta_e > 0
