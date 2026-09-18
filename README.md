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
- Worker-based edge, hatch, crosshatch, adaptive crosshatch, dither, stipple, tonal-dash and scanline vectorisation
- Continuous spiroglyph image rendering with adjustable line spacing, wave frequency, smoothing, tone thresholds, amplitude, shape and placement
- Seeded flow-field, Truchet and guilloché generators
- Standard TurtleToy script execution through the `turtletoy` package in a disposable worker
- SVG import with named-group decomposition, transform flattening and editable per-layer treatments
- OpenStreetMap place search and bounded feature import with classified roads, railways, buildings, water, parks and boundaries
- Per-layer outline, hatch, crosshatch and stipple treatments with independent pen-pass assignment
- Shared path optimisation before G-code generation

## Map provider configuration

Map imports are initiated only when the user submits a place search or chooses a result. Search responses and Overpass extracts are cached in SQLite. Plotbox identifies its requests, limits public Nominatim traffic to one request per second, restricts imports to a 0.1–5 km radius, and displays OpenStreetMap attribution.

Provider endpoints can be changed without rebuilding the app:

```bash
NOMINATIM_URL=https://your-nominatim.example
OVERPASS_URL=https://your-overpass.example/api/interpreter
PLOTBOX_USER_AGENT="Plotbox/0.2 (your contact URL or email)"
```

Review the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) and the [Overpass API guidance](https://wiki.openstreetmap.org/wiki/Overpass_API) before distributing or operating Plotbox for multiple users. A self-hosted or commercial provider is recommended beyond light personal use.

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
