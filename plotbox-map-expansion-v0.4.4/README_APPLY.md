# Plotbox map expansion v0.4.4

This package is an overlay/apply bundle for the Plotbox `main` branch. It was prepared against
`Invertee/Plotbox` main commit `46ec79a947260afb6b12162d87e8e866b3321625`.

## Apply

You can run the script from the extracted package folder, the Plotbox repository root, or any subfolder beneath the repository. It automatically locates the Plotbox checkout by walking upward.

For example, from the extracted package folder:

```powershell
.\apply_plotbox_map_expansion.ps1
```

The PowerShell apply script automatically finds the Plotbox repository and then:

1. Extends the existing Pydantic OSM settings model with grouped map features, plot treatments,
   POI, terrain and physical detail controls.
2. Updates the matching TypeScript `OsmSettings` interface.
3. Replaces the existing OSM renderer with the extended vector/path renderer.
4. Adds the AWS Terrarium terrain provider and marching-squares contour generator.
5. Replaces the map controls with compact collapsible sections and editable presets.
6. Forwards job cancellation into OSM/terrain generation.
7. Bumps the web/Home Assistant/API version to `0.4.1` for cache busting.
8. Regenerates schemas and formats the frontend automatically when `uv` / `pnpm` are available.

Then review and verify:

```bash
git diff --check
make verify
git status
```

If `uv` was not available while applying, run:

```bash
uv run python scripts/export_schemas.py
```

If `pnpm` was not available while applying, run:

```bash
pnpm --filter @plotterapp/web exec prettier --write src/maps/MapControls.tsx src/types.ts src/index.css
```

Then commit normally.

## Overlay files

The `overlay/` directory contains complete replacement/new files for:

- `packages/plotter_core/plotter_core/maps/osm.py`
- `packages/plotter_core/plotter_core/maps/terrain.py`
- `packages/plotter_core/tests/test_osm_extended.py`
- `apps/web/src/maps/MapControls.tsx`

The apply script performs smaller targeted edits to existing model, API, type, stylesheet, export,
README and version files so the whole repository does not need to be duplicated in this zip.

## Terrain source

The implementation uses the public AWS Open Data Terrain Tiles Terrarium endpoint and decodes
Terrarium elevations using `(R * 256 + G + B / 256) - 32768`. Terrain is converted directly to
vector contours; no elevation raster is added to plot output.


## PowerShell application (v0.4.4)

The apply script now requires the Plotbox repository root explicitly. It no longer searches parent directories.

From the extracted package directory:

```powershell
.\apply_plotbox_map_expansion.ps1 "C:\Users\Sam\Desktop\Pen Plotter\plotbox"
```

The named form is equivalent:

```powershell
.\apply_plotbox_map_expansion.ps1 -ProjectPath "C:\Users\Sam\Desktop\Pen Plotter\plotbox"
```

The supplied path must contain the Plotbox `packages`, `apps`, and `services` files expected by this package.

The v0.4.4 patcher normalizes CRLF/LF only while matching source blocks and writes files back using the line-ending style already present in each target file. This fixes the `Expected source block was not found` failure caused by Windows Git line-ending conversion.
