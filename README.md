# Plotbox

Plotbox is a local-first browser application for turning generated artwork and raster images into pen-plotter-ready G-code. Its canonical artwork format is vector geometry measured in millimetres; the preview and G-code exporter consume that same geometry.

- Local project list with A4, A3, A2 and custom paper sizes, portrait/landscape orientation and a 10 mm default safe margin
- SQLite project persistence and debounced autosave
- Zoomable/pannable SVG preview with pen-colour and physical line-width rendering
- Viewport zoom that scales and pans the entire sheet while keeping plot geometry unchanged
- Editable pens and passes, including Z up/down and feed rates
- Combined or per-pass G-code with configurable origin, park position and pen-change pause
- A built-in physical test pattern
- Raster preprocessing: brightness, contrast, gamma, blur, threshold and inversion
- Raster contain, cover and stretch fitting with independent scale and millimetre offsets
- Worker-based edge, contour-tracing, hatch, crosshatch, adaptive crosshatch, dither, stipple, tonal-dash and scanline vectorisation
- Continuous spiroglyph image rendering with adjustable line spacing, wave frequency, smoothing, tone thresholds, amplitude, shape and placement
- Continuous scribble image rendering: a drifting, irregular looping path over a tone-weighted point cloud, with loose highlight coverage and overlapping shadows. Loop density accounts for the selected pen width; smaller loops follow tonal boundaries without a visible tile grid. Covers the placed image within safe margins; accepts up to 2400-pixel source resolution. Fine detail size is in millimetres, so pen width and plot size determine the smallest visible features. Extremely dense jobs report a point-budget error instead of leaving an incomplete drawing. Preview paths are cached in bounded chunks, and fine pens display at their actual width.
- Optional continuous-scribble under-colour passes: separates the source palette into solid, clipped colour fills for thicker pens, orders those passes before the fine scribble pass, and leaves pale paper blank when requested.
- Seeded flow-field, Truchet and guilloché generators
- Standard TurtleToy script execution through the `turtletoy` package in a disposable worker
- SVG import with named-group decomposition, transform flattening and editable per-layer treatments
- Map place search and bounded feature import with classified OpenStreetMap roads, railways, buildings, water, parks and boundaries
- OpenStreetMap-only, terrain-only, or combined downloads, with plot-ready contours at selectable 5–200 m intervals and separate index-contour layers
- Large-area map selection beyond 50 mi²; OpenStreetMap detail automatically scales from local streets and buildings to regional roads, railways, water, waterways and administrative boundaries
- Per-layer outline, hatch, crosshatch and stipple treatments with independent pen-pass assignment
- Shared path optimisation before G-code generation

## Map provider configuration

Map imports are initiated only when the user submits a place search or chooses a result. Search responses, Overpass extracts and requested elevation tiles are cached in SQLite. Plotbox identifies its requests, limits public Nominatim traffic to one request per second, bounds imports to 1,000 km²/60 km across, and displays attribution for the selected sources. Regions up to 25 km² retain full OSM detail; larger requests omit buildings, paths and minor roads, with overview-scale requests retaining major roads, railways, water, waterways and administrative boundaries. Terrain contours are generated locally from keyless [Mapzen Terrain Tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/); the source is a global bare-earth elevation mosaic whose resolution varies by location.

Provider endpoints can be changed without rebuilding the app:

```bash
NOMINATIM_URL=https://your-nominatim.example
OVERPASS_URL=https://your-overpass.example/api/interpreter
TERRAIN_TILE_URL=https://your-terrain.example/terrarium/{z}/{x}/{y}.png
PLOTBOX_USER_AGENT="Plotbox/0.2 (your contact URL or email)"
```

Review the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), [Overpass API guidance](https://wiki.openstreetmap.org/wiki/Overpass_API), and [Terrain Tiles source attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) before distributing or operating Plotbox for multiple users. A self-hosted or commercial provider is recommended beyond light personal use of OSM services.

## Run locally

Requirements: Node.js 24 or newer and npm 11 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The API runs at <http://127.0.0.1:8787> and creates `data/plotter.sqlite` on first use.

## Validation

```bash
npm test
npm run typecheck
npm run build
```

The production server serves `apps/web/dist` after a build:

```bash
npm run build
npm start
```

Open <http://127.0.0.1:8787>.

## Home Assistant add-on

This repository is also a Home Assistant add-on repository. Add the repository URL in **Settings → Apps → App store → ⋮ → Repositories**, then install **Plotbox**. The add-on stores its SQLite database in Home Assistant's persistent `/data` volume, so projects survive upgrades and restarts.

Plotbox publishes TCP port `8787` and does not use Home Assistant Ingress. Point your Home Assistant reverse proxy at the add-on's port, or use the add-on's **Open Web UI** button for a direct local URL. The app is served from `/`, so proxy it as its own host or location without a path prefix. WebSocket forwarding is needed for direct FluidNC control from the browser.

The add-on settings expose the Nominatim and Overpass endpoints and the identifying User-Agent used for map imports. Keep the defaults for light personal use, or set them to a self-hosted/commercial provider as described above.

## TurtleToy scripts

Plotbox accepts standard TurtleToy code using `Canvas`, `new Turtle()`, and an optional `walk(i)` function. The official-compatible `turtletoy` npm package captures the resulting lines directly into Plotbox geometry. Scripts are intended for trusted local use and run in a disposable Web Worker so a new render can terminate the previous job.

## Repository layout

```text
apps/web          React/Vite editor and render worker
apps/server       Fastify API and SQLite persistence
packages/core     Project and canonical geometry types
packages/geometry Geometry processing and path ordering
packages/algorithms Seeded vector generators and algorithm metadata
packages/gcode    Deterministic machine output
tests             Core algorithm and G-code tests
```


### Colour separation for flat artwork

In a raster project, select **Vectorisation → Colour separation**. Start with 6–8 palette colours, then use **Colours & pieces** to set a treatment and pen pass for each colour. Every detected colour gets an automatic pass; set its physical pen colour, width and calibration under **Pens & passes**. Individual connected pieces can override the colour treatment or use a separate pass. Selecting a piece highlights it in the preview; choose the empty option to see all pieces normally.

Treatments include hatching, crosshatching, dense fill, outline only and no fill, with optional outlines. Hatch spacing and angle are independent per colour or piece. Dense fill uses spacing of 85% of the assigned pen width. Existing combined and split G-code exports support these passes, and intentional gaps are preserved during path optimisation.

The algorithm uses deterministic, weighted CIELAB palette clustering, conservative edge cleanup and four-connected component separation. It intersects hatch lines with each region’s boundaries using even–odd filling, so interior holes remain unfilled. Segments are clipped to the paper’s safe area. Transparent pixels and, optionally, pale neutral paper remain blank. Grayscale preprocessing is bypassed. Images use the editor’s existing maximum processing dimension of 1000 pixels; minimum region size is measured at that resolution.

This separates connected colour shapes rather than recognising semantic objects. Small omitted regions become blank; thin details may require a smaller pen or denser hatching. Outlines follow pixel boundaries; dense fill is a pen-line approximation, and real coverage depends on the pen and paper. Changing palette/segmentation settings or replacing the source resets colour treatments and automatic pens, so finish separation before calibrating those pens. Placement changes retain treatments.
