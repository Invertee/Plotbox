import type { ModeManifest, ProjectRecipe } from "./types";

interface ModeGalleryProps {
  modes: ModeManifest[];
  activeModeId: string;
  onSelect: (settings: ProjectRecipe["mode"]) => void;
}

export function ModeGallery({ modes, activeModeId, onSelect }: ModeGalleryProps) {
  const generators = modes.filter(
    (mode) => mode.kind === "generator" && mode.id !== "builtin.test-pattern",
  );

  const select = (manifest: ModeManifest) => {
    const preset = manifest.presets[0];
    const parameters = preset
      ? { ...preset.parameters }
      : Object.fromEntries(
          manifest.parameters
            .filter((parameter) => parameter.kind !== "seed")
            .map((parameter) => [parameter.key, parameter.default]),
        );
    const seedDefinition = manifest.parameters.find((parameter) => parameter.kind === "seed");
    onSelect({
      mode_id: manifest.id,
      version: manifest.version,
      seed: preset?.seed ?? String(seedDefinition?.default ?? "plotterapp-procedural-1"),
      quality: "standard",
      parameter_schema_version: manifest.parameter_schema_version,
      parameters,
    });
  };

  return (
    <fieldset className="mode-gallery">
      <legend>Procedural mode gallery</legend>
      <div className="mode-card-grid">
        {generators.map((mode) => (
          <button
            className={mode.id === activeModeId ? "mode-card active" : "mode-card"}
            type="button"
            key={mode.id}
            aria-pressed={mode.id === activeModeId}
            onClick={() => select(mode)}
          >
            <strong>{mode.name}</strong>
            <span>{mode.description}</span>
            <small>
              {mode.presets.length} preset{mode.presets.length === 1 ? "" : "s"}
              {mode.default_complexity ? ` · ~${mode.default_complexity.paths} paths` : ""}
            </small>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
