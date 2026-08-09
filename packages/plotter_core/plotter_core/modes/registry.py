from __future__ import annotations

from functools import lru_cache

from plotter_core.models import DesignDocument, ModeSettings, ProjectRecipe
from plotter_core.modes.base import (
    CancellationSignal,
    ModeManifest,
    ModePlugin,
    ProgressCallback,
)


class ModeRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, ModePlugin] = {}

    def register(self, plugin: ModePlugin) -> None:
        mode_id = plugin.manifest.id
        if mode_id in self._plugins:
            raise ValueError(f"mode {mode_id} is already registered")
        self._plugins[mode_id] = plugin

    def get(self, mode_id: str) -> ModePlugin:
        try:
            return self._plugins[mode_id]
        except KeyError as error:
            raise ValueError(f"unsupported procedural mode: {mode_id}") from error

    def manifests(self) -> list[ModeManifest]:
        return [self._plugins[mode_id].manifest for mode_id in sorted(self._plugins)]

    def prepare_settings(self, settings: ModeSettings) -> ModeSettings:
        return self.get(settings.mode_id).prepare_settings(settings)

    def generate(
        self,
        recipe: ProjectRecipe,
        *,
        progress: ProgressCallback | None = None,
        cancellation: CancellationSignal | None = None,
    ) -> DesignDocument:
        return self.get(recipe.mode.mode_id).generate(
            recipe,
            progress=progress,
            cancellation=cancellation,
        )


@lru_cache(maxsize=1)
def get_mode_registry() -> ModeRegistry:
    from plotter_core.glyphscape.hybrid_mode import map_glyphscape_plugin
    from plotter_core.glyphscape.mode import glyphscape_plugin
    from plotter_core.modes.builtin import (
        flow_field_plugin,
        guilloche_plugin,
        test_pattern_plugin,
        topographic_plugin,
        truchet_plugin,
    )

    registry = ModeRegistry()
    for plugin in (
        test_pattern_plugin(),
        flow_field_plugin(),
        topographic_plugin(),
        truchet_plugin(),
        guilloche_plugin(),
        glyphscape_plugin(),
        map_glyphscape_plugin(),
    ):
        registry.register(plugin)
    return registry
