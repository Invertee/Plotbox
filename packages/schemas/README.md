# Shared schema contract

The backend Pydantic models are authoritative. Regenerate the committed JSON Schema documents with:

```bash
uv run python scripts/export_schemas.py
```

The strict TypeScript transport interfaces in `apps/web/src/types.ts` mirror these versioned
schemas, including job state, compact geometry, asset/SVG settings, palette/pass settings, and SVG
export bundles. Raster preprocessing and six-algorithm vectorization recipe settings, plus the
separately cached physical-scale preview, are included in `project-recipe.schema.json` and
`raster-preview.schema.json`. Versioned procedural-mode groups, parameters, presets, and UI hints
are captured in `mode-manifest.schema.json`; durable mode values and their parameter-schema version
are part of `project-recipe.schema.json`. Backend serialization tests and frontend strict
compilation guard both sides of the contract. A later milestone may replace this checked-in mirror
with generated TypeScript.

`fluidnc-settings.schema.json` is the durable controller endpoint contract. The FluidNC action,
commissioning-test, and axis-calibration request/result schemas document the bounded commissioning
API; they are deliberately separate from `project-recipe.schema.json` and the canonical artwork
pipeline.

The project schema remains version 1 for this slice because the changes are additive and all new
fields have validated defaults. Existing version-1 project files therefore load without migration;
future incompatible changes must increment the project schema and add a migration.
