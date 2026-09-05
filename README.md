# Plotbox

Plotbox is a local, single-user React and FastAPI application that turns deterministic artwork
recipes into inspectable plot plans and validated G-code files. It also ships as a Home Assistant
app/add-on and provides a separate, guarded FluidNC commissioning workspace.

The implemented offline vertical slice preserves:

```text
ProjectRecipe -> DesignDocument -> PlotPlan -> GcodeProgram
```

It creates an A3 landscape project, generates deterministic procedural modes including hierarchical
Glyphscape artwork, imports a safe SVG subset, or converts bounded PNG/JPEG sources at a physical
plot resolution using edge, centerline, hatch, crosshatch, squiggle, tone-contour, single-line
circular-scribble, or quantized color-region geometry. Work runs as cancellable background jobs. Vector designs continue through physical
pen-pass planning, pen-down/travel preview, and validated
FluidNC/Grbl-compatible G-code or per-pass SVG export. Every generated G-code file is parsed back and
blocked if reconstruction differs from the `PlotPlan`.

## Requirements

- Python 3.12 or newer.
- Node.js 22 or newer.
- `pnpm` 10.15.
- `uv` (install with `python -m pip install uv`).
- GNU Make for the canonical commands. On Windows, the equivalent underlying commands can also be
  run directly from `Makefile`.

## Setup

```bash
make setup
pnpm --filter @plotterapp/web exec playwright install chromium
```

`make setup` uses the committed `uv.lock` and `pnpm-lock.yaml`. The normal application and all tests
run without internet access after dependencies and Playwright Chromium are installed.

## Start the local app

```bash
make dev
```

Open:

- Frontend: <http://127.0.0.1:5173>
- Local API and interactive schema: <http://127.0.0.1:8000/docs>
- Health endpoint: <http://127.0.0.1:8000/api/health>

Projects default to `.plotterapp-data/projects`. Override the location with
`PLOTTERAPP_PROJECTS_ROOT`. Each project is an ordinary `.plotter` directory containing readable
`project.json`, disposable content-keyed caches, and validated exports.

The **Projects** page lists every saved project. Names can be changed without changing the stable
project ID or directory path. Deletion requires a second explicit confirmation and permanently
removes only the selected project directory, including its local sources, caches, and exports.

## Artwork workflow

1. Create an A3 project.
2. Either keep/edit seed `codex-vertical-slice-1`, or choose an SVG, PNG, or JPEG source.
3. For SVG, select fill treatment (`ignore`, `outline`, `hatch`, or `crosshatch`) and stroke
   treatment (`centerline`, `outline`, or `parallel`).
4. For raster sources, crop, rotate, fit, scale, choose a grayscale channel, and tune invert,
   contrast, gamma, blur, sharpen, global/adaptive threshold, and morphology settings. Preview the
   preprocessing result, then choose and tune a raster vectorization algorithm.
5. Choose draft, standard, or export quality and start generation, preprocessing, or vectorization.
   Progress is streamed from the local service; Cancel stops work at the next cooperative
   checkpoint.
6. Inspect the source overlay, physical raster sampling readout, or vector design/import warnings.
7. For vector designs, assign physical pens, hide/solo/enable passes, drag or button-reorder them,
   and merge/split layer mappings. Quantized colors receive perceptual nearest-pen suggestions, but
   remain fully manually assignable. Applying pass changes replans without rerunning conversion.
   Enable physical-pen overprint to preview mapped colors in pass order.
8. Export either the per-pass/combined SVG ZIP or the validated G-code ZIP.
9. Save, reopen, and reproduce the output.

The bundle contains:

- `01-black.nc`
- `02-cyan.nc`
- `combined.nc` with exactly one `M0` pen-change pause
- `dry-run.nc`, which never lowers the pen
- `page-boundary.nc`, which never lowers the pen
- `manifest.json` with file, design, plan, and validation hashes

Validated files are also written to the project’s `exports/` directory.

SVG archives contain one SVG for each enabled pass plus `combined.svg`. Source SVG files are stored
immutably by SHA-256 under the project’s `assets/` directory.

## SVG support and diagnostics

The current importer supports physical root units/viewBox, paths, lines, polylines, polygons,
rectangles (including rounded corners), circles, ellipses, relative/absolute path commands, arcs,
nested transforms, inherited presentation styles, local `<use>` references, dashed strokes,
deterministic text outlines through the bundled Plotter 5x7 fixture font, and stable top-level group
names.

Filters, masks, `foreignObject`, CSS, active content, external resources, and clip-path
approximations are reported as structured warnings rather than silently discarded. The fixture font
is deliberately basic and uppercases text; it makes labels deterministic without depending on
host-installed fonts. DTD and entity declarations, oversized files, excessive node counts, and
malformed content are rejected.

## Raster preprocessing

PNG and JPEG assets are identified by content and decoded with explicit source-pixel and dimension
limits before full image allocation. EXIF orientation is normalized, animated inputs use the first
frame with a warning, and transparency is explicitly composited over white.

The preprocessing result is a versioned contract containing source/crop dimensions, lower-left page
placement, output pixel dimensions, millimetres per pixel, warnings, and a PNG preview. Resolution
is derived from page placement, active pen width, sampling density, and draft/standard/export
quality, then bounded by the configured megapixel budget. Preprocessing has its own content-keyed
cache and does not create or replace `DesignDocument`.

Raster vectorization converts that physical preview into a normal `DesignDocument` using one of
ten deterministic algorithms:

- edge drawing with response threshold and small-component removal;
- thresholded centerline skeleton tracing with short-branch pruning;
- tone-clipped hatch and four-angle crosshatch;
- continuous luminance-modulated squiggle scanlines;
- single-line tone-aware circular scribbles with smaller, more closely spaced loops in darker regions;
- multi-level marching-squares tone contours.
- quantized color-region outlines;
- quantized color-region hatching.
- ordered-dithered halftone marks with selectable dots or crosses.

The halftone controls use physical millimetres: grid spacing, minimum and maximum mark size,
mark contrast, gamma, and a highlight threshold. Choose **Contrast bands** to emit separate stable
tone layers; each layer appears in **Pen passes** and can be assigned to a different physical pen.
The converter uses a deterministic ordered pattern, so the same source and settings reproduce the
same design hash. Preprocessing contrast and gamma remain available for broader image correction.

All output coordinates are lower-left-origin page millimetres. The conversion report records path,
removed-component, and removed-segment counts. Changing only vectorizer settings reuses
preprocessing; changing only pass mapping reuses vector geometry. Quantized source colors are stored
as stable semantic roles and preview colors, separately from physical pen profiles.

## OpenStreetMap artwork

Choose **Mapping** to navigate an attributed OpenStreetMap basemap. Submit a town, postcode, or
landmark search and select a result, or enter the selection centre as latitude and longitude. Pan
and zoom until the orange page overlay covers the intended area, then choose **Use page overlay
extent**. Semantic data downloads are limited to 25 km² and happen only when **Download and freeze
map data** is selected.

The basemap is for interactive navigation only; Plotbox does not prefetch or archive tiles. Place
searches are submitted explicitly rather than using autocomplete and are cached locally. Frozen
Overpass data is stored with the project, so later generation and export do not need another network
request. `PLOTTERAPP_OVERPASS_ENDPOINTS` may contain a comma-separated endpoint list, and
`PLOTTERAPP_NOMINATIM_ENDPOINT` may select a compatible search provider.

## Glyphscape artwork

Choose **Glyphscape** in the procedural gallery and start with City Circuit, Industrial Skyline,
Fairground Island, or Mixed Perimeter. The mode places deterministic parameterized glyphs into
macro regions, builds a capacity-aware port graph, routes around physical clearance envelopes,
decorates connectors inside explicit corridors, and fills selected negative space within the
configured path and vertex budgets.

Glyph structures, details, accents, backbone connectors, loop connectors, junctions, and fillers
remain stable semantic layers that can be remapped to physical pens without regenerating the
design. Lock a macro region and advance the regional regeneration step to preserve that region
while changing unlocked regions. See [the Glyphscape workflow](docs/GLYPHSCAPE.md) for controls,
diagnostics, and reproducibility behavior.

## Map-to-Glyphscape artwork

After freezing an OpenStreetMap snapshot in **Mapping**, choose **Map-to-Glyphscape** in the generic
gallery. Circuit Metropolis, Fairground Atlas, and Industrial Borough preserve map roads as locked
connector topology while deterministically replacing buildings and POIs with themed glyphs. Water
and parks can exclude or fill composition space, and the fidelity control ranges from exact
projected road geometry to a strongly stylized physical grid.

Hybrid layers use the normal pass editor, planner, SVG exporter, and validated G-code pipeline. See
[the Map-to-Glyphscape workflow](docs/MAP_TO_GLYPHSCAPE.md) for source, mask, fidelity, and
reproducibility behavior.

## Jobs and disposable cache

Expensive generation, SVG import, raster preprocessing, and raster vectorization calls support
queued/running/terminal job state, progress events at `/api/jobs/{job_id}/events`, and cancellation with
`DELETE /api/jobs/{job_id}`. Results are published only when the captured project revision is still
current.

Operator cache keys include operator/version, input content hash, parameters, and quality. Cache
statistics and bounded pruning are available at `/api/projects/{project_id}/cache`. Cache files are
disposable; source assets and `project.json` are not.

## Home Assistant app/add-on

The repository root is an installable Home Assistant app folder. Copy it beneath the local
`/addons` directory, reload the app store, install **Plotbox**, and use **Open Web UI** or its
sidebar entry. The multi-stage [Dockerfile](Dockerfile) builds the Vite frontend and Python service
for `amd64` and `aarch64`, serving both on internal port 5616.

Ingress handles authentication and your existing Home Assistant reverse proxy handles SSL. The
frontend uses relative asset, API, and event-stream URLs so the changing Ingress session prefix is
preserved. Host port 5616 is published for a trusted reverse proxy such as Nginx Proxy Manager.
The packaged app accepts clients from RFC1918 private networks (including direct `192.168.x.x`
access), loopback, and the Home Assistant/container networks. Keep the app behind a firewall or
trusted reverse proxy because Plotbox has no user accounts; custom deployments can narrow
`PLOTTERAPP_ALLOWED_CLIENT_NETWORKS` to specific CIDRs.

Persistent state lives under Home Assistant's `/data` volume:

- `/data/projects` for ordinary `.plotter` project directories;
- `/data/fluidnc.json` for the controller endpoint;
- each project's `exports/` directory for validated output.

See [Home Assistant app documentation](DOCS.md) for installation, backup, network, and safety notes.

## FluidNC commissioning

Open **Plotter setup** to configure the controller hostname, WebSocket port (normally 81), optional
controller-side TLS, and command timeout. The WebSocket originates in FastAPI, so an HTTPS browser
session never attempts a mixed-content `ws://` connection.

The current allowlisted actions are:

- identity, machine-state, active-mode, and configuration queries;
- a bounded limit-switch check that exits FluidNC limit-reporting mode;
- realtime feed hold;
- all-axis or single-axis homing;
- relative X/Y/Z jogs using the speed and distance limits configured in FluidNC;
- an absolute-Z pen up/down/up cycle with bounded positions and feed.
- named calibration patterns: scale grid, circle/arc, diagonal/skew,

Plotbox does not add a separate confirmation step or jog speed/distance ceiling to these
controller actions. FluidNC remains responsible for the machine configuration and limits.
  backlash ladder, speed, Z-depth/pen pressure, lift delay, registration, pen swatches,
  line spacing, and hatch density. Each pattern has a bounded test area and is constructed
  server-side; there is no raw G-code entry.

The axis calculator uses `corrected = current × commanded / measured`. It only suggests a value;
Plotbox never writes FluidNC firmware settings. Calibration patterns also finish with the pen up and
cannot change work zero. Clear the machine, verify limit inputs and homing direction, and keep a
physical emergency stop available before any motion test.

## Development commands

```bash
make setup
make dev
make lint
make typecheck
make test
make e2e
make verify
```

`make verify` runs Python and TypeScript formatting checks, Ruff and ESLint, strict mypy and
TypeScript checks, pytest/Hypothesis/API tests, Vitest/React Testing Library, and the Playwright
acceptance workflow.

Regenerate intentionally changed schema and golden contracts with:

```bash
uv run python scripts/export_schemas.py
make fixtures
```

Golden artifacts live under `fixtures/`. Do not regenerate them merely to hide a behavioral
regression.

## Product boundary

This repository supports backend FluidNC WebSocket commissioning as described above. From the editor,
an operator can also select one of the app's validated G-code exports and explicitly send it to the
configured FluidNC machine. Plotbox regenerates and independently round-trip validates that selected
file immediately before streaming it. It never accepts raw G-code from the browser and will only begin
when FluidNC reports `Idle`; a successful response means all lines were accepted, not that physical
motion has finished.

It still has no serial/Telnet transport, arbitrary command console, work-zero editor, start-from-current
pen-position mode, firmware configuration writer, unattended plotting, or hardware job recovery.
See [AGENTS.md](AGENTS.md), [architecture decisions](docs/DECISIONS.md), and the
[dithered-halftone ExecPlan](docs/exec-plans/0010-raster-dithered-halftone.md).
