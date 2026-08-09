from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from plotter_core.glyphscape.models import (
    Glyph,
    GlyphFamilyManifest,
    GlyphMetadataValue,
    GlyphParameterValue,
)
from plotter_core.modes import CancellationSignal, NamedRandomStreams, QualityLevel, normalize_seed


@dataclass(frozen=True)
class GlyphGenerationContext:
    glyph_id: str
    family_id: str
    seed: str
    width_mm: float
    height_mm: float
    quality: QualityLevel
    parameters: Mapping[str, GlyphParameterValue]
    cancellation: CancellationSignal | None = None

    def __post_init__(self) -> None:
        if not self.glyph_id:
            raise ValueError("glyph ID must not be empty")
        if not self.family_id:
            raise ValueError("glyph family ID must not be empty")
        if self.width_mm <= 0 or self.height_mm <= 0:
            raise ValueError("glyph dimensions must be positive")
        object.__setattr__(self, "seed", normalize_seed(self.seed))

    @property
    def random(self) -> NamedRandomStreams:
        return NamedRandomStreams(
            seed=self.seed,
            mode_id=f"glyph-family.{self.family_id}.{self.glyph_id}",
        )

    def checkpoint(self) -> None:
        if self.cancellation is not None:
            self.cancellation.checkpoint()


@runtime_checkable
class GlyphFamily(Protocol):
    @property
    def manifest(self) -> GlyphFamilyManifest: ...

    def prepare_parameters(
        self,
        parameters: Mapping[str, GlyphParameterValue] | None = None,
    ) -> dict[str, GlyphParameterValue]: ...

    def generate(
        self,
        glyph_id: str,
        *,
        seed: str,
        width_mm: float,
        height_mm: float,
        quality: QualityLevel,
        parameters: Mapping[str, GlyphParameterValue] | None = None,
        cancellation: CancellationSignal | None = None,
    ) -> Glyph: ...


GlyphGenerator = Callable[[GlyphGenerationContext], Glyph]


@dataclass(frozen=True)
class BuiltinGlyphFamily:
    manifest: GlyphFamilyManifest
    generator: GlyphGenerator

    def prepare_parameters(
        self,
        parameters: Mapping[str, GlyphParameterValue] | None = None,
    ) -> dict[str, GlyphParameterValue]:
        prepared = dict(parameters or {})
        definitions = {parameter.key: parameter for parameter in self.manifest.parameters}
        unknown = set(prepared).difference(definitions)
        if unknown:
            raise ValueError(
                f"unknown parameters for glyph family {self.manifest.family_id}: {sorted(unknown)}"
            )
        for parameter in self.manifest.parameters:
            prepared.setdefault(parameter.key, parameter.default)
            parameter.validate_value(prepared[parameter.key])
        return prepared

    def generate(
        self,
        glyph_id: str,
        *,
        seed: str,
        width_mm: float,
        height_mm: float,
        quality: QualityLevel,
        parameters: Mapping[str, GlyphParameterValue] | None = None,
        cancellation: CancellationSignal | None = None,
    ) -> Glyph:
        requested_size = max(width_mm, height_mm)
        if (
            requested_size < self.manifest.minimum_size_mm
            or requested_size > self.manifest.maximum_size_mm
        ):
            raise ValueError(
                f"glyph family {self.manifest.family_id} size must be between "
                f"{self.manifest.minimum_size_mm} and {self.manifest.maximum_size_mm} mm"
            )
        context = GlyphGenerationContext(
            glyph_id=glyph_id,
            family_id=self.manifest.family_id,
            seed=seed,
            width_mm=width_mm,
            height_mm=height_mm,
            quality=quality,
            parameters=self.prepare_parameters(parameters),
            cancellation=cancellation,
        )
        context.checkpoint()
        glyph = self.generator(context)
        self._validate_output(glyph, context)
        context.checkpoint()
        return glyph

    def _validate_output(self, glyph: Glyph, context: GlyphGenerationContext) -> None:
        if glyph.glyph_id != context.glyph_id:
            raise ValueError("glyph family returned a different glyph ID")
        if (
            glyph.family_id != self.manifest.family_id
            or glyph.family_version != self.manifest.version
        ):
            raise ValueError("glyph family returned incompatible family identity")
        emitted_roles = {group.semantic_role for group in glyph.role_paths}
        unknown_roles = emitted_roles.difference(self.manifest.semantic_roles)
        if unknown_roles:
            raise ValueError(
                f"glyph family emitted undeclared semantic roles: {sorted(unknown_roles)}"
            )
        emitted_connections = {port.connection_type for port in glyph.ports}
        unknown_connections = emitted_connections.difference(self.manifest.connection_types)
        if unknown_connections:
            raise ValueError(
                f"glyph family emitted undeclared connection types: {sorted(unknown_connections)}"
            )
        if glyph.allowed_scale_range != self.manifest.allowed_scale_range:
            raise ValueError("glyph scale range does not match its family manifest")
        if glyph.allowed_rotation_range != self.manifest.allowed_rotation_range:
            raise ValueError("glyph rotation range does not match its family manifest")
        if glyph.complexity_score > self.manifest.maximum_complexity_score:
            raise ValueError("glyph complexity exceeds its family manifest")
        if glyph.local_bounds.width_mm > context.width_mm + 1e-9:
            raise ValueError("glyph width exceeds its requested envelope")
        if glyph.local_bounds.height_mm > context.height_mm + 1e-9:
            raise ValueError("glyph height exceeds its requested envelope")


class GlyphFamilyRegistry:
    def __init__(self) -> None:
        self._families: dict[str, GlyphFamily] = {}

    def register(self, family: GlyphFamily) -> None:
        family_id = family.manifest.family_id
        if family_id in self._families:
            raise ValueError(f"glyph family {family_id} is already registered")
        self._families[family_id] = family

    def get(self, family_id: str) -> GlyphFamily:
        try:
            return self._families[family_id]
        except KeyError as error:
            raise ValueError(f"unsupported glyph family: {family_id}") from error

    def manifests(self) -> list[GlyphFamilyManifest]:
        return [self._families[family_id].manifest for family_id in sorted(self._families)]

    def generate(
        self,
        family_id: str,
        glyph_id: str,
        *,
        seed: str,
        width_mm: float,
        height_mm: float,
        quality: QualityLevel,
        parameters: Mapping[str, GlyphParameterValue] | None = None,
        cancellation: CancellationSignal | None = None,
    ) -> Glyph:
        return self.get(family_id).generate(
            glyph_id,
            seed=seed,
            width_mm=width_mm,
            height_mm=height_mm,
            quality=quality,
            parameters=parameters,
            cancellation=cancellation,
        )


def glyph_metadata(
    context: GlyphGenerationContext,
    **values: GlyphMetadataValue,
) -> dict[str, GlyphMetadataValue]:
    """Return stable provenance fields for built-in family output."""
    return {
        "seed": context.seed,
        "quality": context.quality.value,
        **values,
    }
