import { NumericInput } from "./NumericInput";
import type {
  ModeManifest,
  ModeParameterDefinition,
  ModeParameterValue,
  ProjectRecipe,
} from "./types";

interface GeneratedModeControlsProps {
  manifest: ModeManifest;
  settings: ProjectRecipe["mode"];
  onChange: (settings: ProjectRecipe["mode"]) => void;
}

function numericValue(value: ModeParameterValue): number {
  return typeof value === "number" ? value : Number(value);
}

function parameterValue(
  definition: ModeParameterDefinition,
  settings: ProjectRecipe["mode"],
): ModeParameterValue {
  if (definition.kind === "seed") return settings.seed;
  return settings.parameters[definition.key] ?? definition.default;
}

export function GeneratedModeControls({
  manifest,
  settings,
  onChange,
}: GeneratedModeControlsProps) {
  const update = (definition: ModeParameterDefinition, value: ModeParameterValue) => {
    if (definition.kind === "seed") {
      onChange({
        ...settings,
        version: manifest.version,
        seed: String(value),
        parameter_schema_version: manifest.parameter_schema_version,
      });
      return;
    }
    onChange({
      ...settings,
      version: manifest.version,
      parameter_schema_version: manifest.parameter_schema_version,
      parameters: { ...settings.parameters, [definition.key]: value },
    });
  };

  const applyPreset = (presetId: string) => {
    const preset = manifest.presets.find((item) => item.preset_id === presetId);
    if (!preset) return;
    onChange({
      ...settings,
      version: manifest.version,
      seed: preset.seed ?? settings.seed,
      parameter_schema_version: preset.parameter_schema_version,
      parameters: { ...preset.parameters },
    });
  };

  const renderControl = (definition: ModeParameterDefinition) => {
    const value = parameterValue(definition, settings);
    const describedBy = definition.description ? `${definition.key}-help` : undefined;
    if (definition.kind === "boolean") {
      return (
        <label className="checkbox-row" key={definition.key}>
          <NumericInput
            title={definition.description || undefined}
            aria-label={definition.label}
            aria-describedby={describedBy}
            type="checkbox"
            checked={value === true}
            onChange={(event) => update(definition, event.target.checked)}
          />
          {definition.label}
        </label>
      );
    }
    if (definition.kind === "enum" || definition.kind === "role") {
      return (
        <label key={definition.key}>
          {definition.label}
          <select
            title={definition.description || undefined}
            aria-label={definition.label}
            aria-describedby={describedBy}
            value={String(value)}
            onChange={(event) => update(definition, event.target.value)}
          >
            {definition.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {definition.description && (
            <span className="field-help" id={describedBy}>
              {definition.description}
            </span>
          )}
        </label>
      );
    }
    if (definition.kind === "range") {
      const range = Array.isArray(value) ? value : [0, 0];
      return (
        <div key={definition.key}>
          <span className="field-label">{definition.label}</span>
          <div className="field-row">
            {[0, 1].map((index) => (
              <label key={index}>
                {index === 0 ? "Minimum" : "Maximum"}
                <NumericInput
                  title={definition.description || undefined}
                  aria-label={`${definition.label} ${index === 0 ? "minimum" : "maximum"}`}
                  type="number"
                  min={definition.minimum ?? undefined}
                  max={definition.maximum ?? undefined}
                  step={definition.step ?? "any"}
                  value={range[index] ?? 0}
                  onChange={(event) => {
                    const next = [...range];
                    next[index] =
                      index === 0
                        ? Math.min(Number(event.target.value), range[1] ?? 0)
                        : Math.max(Number(event.target.value), range[0] ?? 0);
                    update(definition, next);
                  }}
                />
              </label>
            ))}
          </div>
        </div>
      );
    }
    return (
      <label key={definition.key}>
        {definition.label}
        <NumericInput
          title={definition.description || undefined}
          aria-label={definition.label}
          aria-describedby={describedBy}
          type={
            definition.kind === "color"
              ? "color"
              : definition.kind === "number" || definition.kind === "integer"
                ? "number"
                : "text"
          }
          min={definition.minimum ?? undefined}
          max={definition.maximum ?? undefined}
          step={definition.step ?? (definition.kind === "integer" ? 1 : undefined)}
          value={
            definition.kind === "number" || definition.kind === "integer"
              ? numericValue(value)
              : String(value)
          }
          onChange={(event) =>
            update(
              definition,
              definition.kind === "number" || definition.kind === "integer"
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
        {definition.description && (
          <span className="field-help" id={describedBy}>
            {definition.description}
          </span>
        )}
      </label>
    );
  };

  return (
    <>
      {manifest.presets.length > 0 && (
        <fieldset>
          <legend>{manifest.name} presets</legend>
          <label>
            Preset
            <select
              aria-label={`${manifest.name} preset`}
              defaultValue=""
              onChange={(event) => applyPreset(event.target.value)}
            >
              <option value="">Custom</option>
              {manifest.presets.map((preset) => (
                <option key={preset.preset_id} value={preset.preset_id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}
      {manifest.parameter_groups.map((group) => (
        <fieldset key={group.group_id}>
          <legend>{group.label}</legend>
          {group.description && <p className="field-help">{group.description}</p>}
          {manifest.parameters
            .filter((parameter) => parameter.group === group.group_id)
            .map(renderControl)}
        </fieldset>
      ))}
    </>
  );
}
