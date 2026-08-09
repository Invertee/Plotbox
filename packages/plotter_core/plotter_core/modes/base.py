from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol, cast, runtime_checkable

from pydantic import Field, model_validator

from plotter_core.models import (
    DesignDocument,
    ModeParameterValue,
    ModeSettings,
    ProjectRecipe,
    StrictModel,
)
from plotter_core.modes.random import NamedRandomStreams, normalize_seed

ProgressCallback = Callable[[str, int | None, int | None], None]
ParameterMigration = Callable[[dict[str, ModeParameterValue]], dict[str, ModeParameterValue]]
ComplexityEstimator = Callable[["GenerationContext"], "ComplexityEstimate"]


class QualityLevel(StrEnum):
    DRAFT = "draft"
    STANDARD = "standard"
    EXPORT = "export"


class QualityMapping(StrictModel):
    density_scale: float = Field(gt=0)
    sampling_scale: float = Field(gt=0)
    label: str = Field(min_length=1)


class ComplexityEstimate(StrictModel):
    paths: int = Field(ge=0)
    vertices: int = Field(ge=0)
    relative_work: float = Field(ge=0)


@runtime_checkable
class CancellationSignal(Protocol):
    @property
    def cancelled(self) -> bool: ...

    def checkpoint(self) -> None: ...


class ModeParameterOption(StrictModel):
    value: str = Field(min_length=1)
    label: str = Field(min_length=1)


class ModeParameterGroup(StrictModel):
    group_id: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    label: str = Field(min_length=1)
    description: str = ""


class ModeParameter(StrictModel):
    key: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    label: str = Field(min_length=1)
    kind: Literal["number", "integer", "boolean", "enum", "seed", "color", "role", "range"]
    group: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    default: ModeParameterValue
    description: str = ""
    unit: str = ""
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = Field(default=None, gt=0)
    options: list[ModeParameterOption] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_definition(self) -> ModeParameter:
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError(f"{self.key}: minimum must not exceed maximum")
        if self.kind == "integer":
            if isinstance(self.default, bool) or not isinstance(self.default, int):
                raise ValueError(f"{self.key}: integer default must be an integer")
        elif self.kind == "number":
            if isinstance(self.default, bool) or not isinstance(self.default, (int, float)):
                raise ValueError(f"{self.key}: number default must be numeric")
        elif self.kind == "boolean":
            if not isinstance(self.default, bool):
                raise ValueError(f"{self.key}: boolean default must be a boolean")
        elif self.kind in {"enum", "role"}:
            if not isinstance(self.default, str):
                raise ValueError(f"{self.key}: selection default must be a string")
            option_values = [option.value for option in self.options]
            if not option_values or len(option_values) != len(set(option_values)):
                raise ValueError(f"{self.key}: selection options must be present and unique")
            if self.default not in option_values:
                raise ValueError(f"{self.key}: default must be one of the declared options")
        elif self.kind in {"seed", "color"}:
            if not isinstance(self.default, str):
                raise ValueError(f"{self.key}: text default must be a string")
            if self.kind == "color" and not re.fullmatch(r"#[0-9a-fA-F]{6}", self.default):
                raise ValueError(f"{self.key}: color default must use #RRGGBB")
        elif self.kind == "range":
            if (
                not isinstance(self.default, list)
                or len(self.default) != 2
                or any(
                    isinstance(value, bool) or not isinstance(value, (int, float))
                    for value in self.default
                )
            ):
                raise ValueError(f"{self.key}: range default must contain two numbers")
            if self.default[0] > self.default[1]:
                raise ValueError(f"{self.key}: range default must be ordered")
        self.validate_value(self.default)
        return self

    def validate_value(self, value: ModeParameterValue) -> None:
        values: list[float]
        if self.kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{self.key} must be an integer")
            values = [float(value)]
        elif self.kind == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{self.key} must be numeric")
            values = [float(value)]
        elif self.kind == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{self.key} must be a boolean")
            return
        elif self.kind in {"enum", "role"}:
            if not isinstance(value, str) or value not in {option.value for option in self.options}:
                raise ValueError(f"{self.key} must be one of the declared options")
            return
        elif self.kind == "seed":
            if not isinstance(value, str) or not value.strip():
                raise ValueError("seed must not be empty")
            return
        elif self.kind == "color":
            if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                raise ValueError(f"{self.key} must use #RRGGBB")
            return
        else:
            if (
                not isinstance(value, list)
                or len(value) != 2
                or any(
                    isinstance(item, bool) or not isinstance(item, (int, float)) for item in value
                )
            ):
                raise ValueError(f"{self.key} must contain two numbers")
            values = [float(value[0]), float(value[1])]
            if values[0] > values[1]:
                raise ValueError(f"{self.key} must be ordered")
        for item in values:
            if self.minimum is not None and item < self.minimum:
                raise ValueError(f"{self.key} must be at least {self.minimum}")
            if self.maximum is not None and item > self.maximum:
                raise ValueError(f"{self.key} must be at most {self.maximum}")


class ModePreset(StrictModel):
    schema_version: Literal[1] = 1
    preset_id: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    version: int = Field(ge=1)
    mode_id: str = Field(pattern=r"^[a-z][a-z0-9.-]*$")
    mode_version: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    parameter_schema_version: int = Field(ge=1)
    seed: str | None = None
    parameters: dict[str, ModeParameterValue] = Field(default_factory=dict)


class ModeManifest(StrictModel):
    schema_version: Literal[1] = 1
    kind: Literal["generator", "importer"] = "generator"
    id: str = Field(pattern=r"^[a-z][a-z0-9.-]*$")
    version: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    category: str = "procedural"
    quality_levels: list[QualityLevel] = Field(min_length=1)
    semantic_roles: list[str] = Field(default_factory=list)
    parameter_schema_version: int = Field(default=1, ge=1)
    parameter_groups: list[ModeParameterGroup] = Field(default_factory=list)
    parameters: list[ModeParameter] = Field(default_factory=list)
    presets: list[ModePreset] = Field(default_factory=list)
    quality_mappings: dict[QualityLevel, QualityMapping] = Field(default_factory=dict)
    default_complexity: ComplexityEstimate | None = None
    algorithms: list[str] = Field(default_factory=list)
    parameter_schema: dict[str, object] | None = None

    @model_validator(mode="after")
    def validate_manifest(self) -> ModeManifest:
        group_ids = [group.group_id for group in self.parameter_groups]
        if len(group_ids) != len(set(group_ids)):
            raise ValueError("mode parameter group IDs must be unique")
        parameter_keys = [parameter.key for parameter in self.parameters]
        if len(parameter_keys) != len(set(parameter_keys)):
            raise ValueError("mode parameter keys must be unique")
        unknown_groups = {
            parameter.group for parameter in self.parameters if parameter.group not in group_ids
        }
        if unknown_groups:
            raise ValueError(f"mode parameters reference unknown groups: {sorted(unknown_groups)}")
        seed_parameters = [parameter for parameter in self.parameters if parameter.kind == "seed"]
        if len(seed_parameters) > 1:
            raise ValueError("a mode may declare at most one seed control")
        preset_ids = [preset.preset_id for preset in self.presets]
        if len(preset_ids) != len(set(preset_ids)):
            raise ValueError("mode preset IDs must be unique")
        definitions = {parameter.key: parameter for parameter in self.parameters}
        seed_definition = next(
            (parameter for parameter in self.parameters if parameter.kind == "seed"),
            None,
        )
        for preset in self.presets:
            if preset.mode_id != self.id or preset.mode_version != self.version:
                raise ValueError(f"preset {preset.preset_id} targets a different mode version")
            if preset.parameter_schema_version != self.parameter_schema_version:
                raise ValueError(f"preset {preset.preset_id} uses a different parameter schema")
            unknown = set(preset.parameters).difference(definitions)
            if unknown:
                raise ValueError(
                    f"preset {preset.preset_id} contains unknown parameters: {sorted(unknown)}"
                )
            for key, value in preset.parameters.items():
                if definitions[key].kind == "seed":
                    raise ValueError(f"preset {preset.preset_id} must store seed in its seed field")
                definitions[key].validate_value(value)
            if preset.seed is not None:
                if seed_definition is None:
                    raise ValueError(f"preset {preset.preset_id} supplies an undeclared seed")
                seed_definition.validate_value(preset.seed)
        return self


@dataclass(frozen=True)
class GenerationContext:
    recipe: ProjectRecipe
    quality: QualityLevel
    parameters: Mapping[str, ModeParameterValue]
    progress: ProgressCallback | None = None
    cancellation: CancellationSignal | None = None

    @property
    def random(self) -> NamedRandomStreams:
        return NamedRandomStreams(
            seed=self.recipe.mode.seed,
            mode_id=self.recipe.mode.mode_id,
        )

    def checkpoint(self, stage: str, completed: int | None, total: int | None) -> None:
        if self.cancellation is not None:
            self.cancellation.checkpoint()
        if self.progress is not None:
            self.progress(stage, completed, total)


@runtime_checkable
class ModePlugin(Protocol):
    @property
    def manifest(self) -> ModeManifest: ...

    def prepare_settings(self, settings: ModeSettings) -> ModeSettings: ...

    def estimate(self, recipe: ProjectRecipe) -> ComplexityEstimate: ...

    def generate(
        self,
        recipe: ProjectRecipe,
        *,
        progress: ProgressCallback | None = None,
        cancellation: CancellationSignal | None = None,
    ) -> DesignDocument: ...


ModeGenerator = Callable[[GenerationContext], DesignDocument]


@dataclass(frozen=True)
class BuiltinModePlugin:
    manifest: ModeManifest
    generator: ModeGenerator
    parameter_migrations: Mapping[int, ParameterMigration]
    complexity_estimator: ComplexityEstimator | None = None

    def prepare_settings(self, settings: ModeSettings) -> ModeSettings:
        if settings.mode_id != self.manifest.id:
            raise ValueError(
                f"mode settings for {settings.mode_id} cannot be used with {self.manifest.id}"
            )
        if settings.version != self.manifest.version:
            raise ValueError(
                f"unsupported {settings.mode_id} version {settings.version}; "
                f"expected {self.manifest.version}"
            )
        version = settings.parameter_schema_version
        if version > self.manifest.parameter_schema_version:
            raise ValueError(
                f"unsupported future parameter schema version {version} for {settings.mode_id}"
            )
        parameters = dict(settings.parameters)
        while version < self.manifest.parameter_schema_version:
            migration = self.parameter_migrations.get(version)
            if migration is None:
                raise ValueError(
                    f"no parameter migration from version {version} for {settings.mode_id}"
                )
            parameters = migration(parameters)
            version += 1
        definitions = {parameter.key: parameter for parameter in self.manifest.parameters}
        unknown = set(parameters).difference(definitions)
        if unknown:
            raise ValueError(
                f"unknown parameters for {settings.mode_id}: {', '.join(sorted(unknown))}"
            )
        for parameter in self.manifest.parameters:
            if parameter.kind == "seed":
                parameter.validate_value(settings.seed)
                continue
            parameters.setdefault(parameter.key, parameter.default)
            parameter.validate_value(parameters[parameter.key])
        return settings.model_copy(
            update={
                "seed": normalize_seed(settings.seed),
                "parameter_schema_version": self.manifest.parameter_schema_version,
                "parameters": parameters,
            }
        )

    def generate(
        self,
        recipe: ProjectRecipe,
        *,
        progress: ProgressCallback | None = None,
        cancellation: CancellationSignal | None = None,
    ) -> DesignDocument:
        settings = self.prepare_settings(recipe.mode)
        prepared_recipe = recipe.model_copy(update={"mode": settings})
        context = GenerationContext(
            recipe=prepared_recipe,
            quality=QualityLevel(settings.quality),
            parameters=settings.parameters,
            progress=progress,
            cancellation=cancellation,
        )
        estimate = self._estimate_context(context)
        path_budget = cast(int, settings.parameters.get("path_budget", 50_000))
        vertex_budget = cast(int, settings.parameters.get("vertex_budget", 1_000_000))
        if estimate.paths > path_budget or estimate.vertices > vertex_budget:
            raise ValueError(
                "estimated procedural complexity exceeds the configured budget "
                f"({estimate.paths} paths/{estimate.vertices} vertices; "
                f"limits {path_budget}/{vertex_budget})"
            )
        document = self.generator(context)
        paths = sum(len(layer.paths) for layer in document.layers)
        vertices = sum(len(path.commands) for layer in document.layers for path in layer.paths)
        if paths > path_budget or vertices > vertex_budget:
            raise ValueError(
                "generated procedural complexity exceeds the configured budget "
                f"({paths} paths/{vertices} vertices; limits {path_budget}/{vertex_budget})"
            )
        return document

    def estimate(self, recipe: ProjectRecipe) -> ComplexityEstimate:
        settings = self.prepare_settings(recipe.mode)
        prepared_recipe = recipe.model_copy(update={"mode": settings})
        return self._estimate_context(
            GenerationContext(
                recipe=prepared_recipe,
                quality=QualityLevel(settings.quality),
                parameters=settings.parameters,
            )
        )

    def _estimate_context(self, context: GenerationContext) -> ComplexityEstimate:
        if self.complexity_estimator is not None:
            return self.complexity_estimator(context)
        if self.manifest.default_complexity is not None:
            mapping = self.manifest.quality_mappings.get(context.quality)
            scale = mapping.density_scale * mapping.sampling_scale if mapping else 1.0
            return ComplexityEstimate(
                paths=round(self.manifest.default_complexity.paths * scale),
                vertices=round(self.manifest.default_complexity.vertices * scale),
                relative_work=self.manifest.default_complexity.relative_work * scale,
            )
        return ComplexityEstimate(paths=0, vertices=0, relative_work=0)
