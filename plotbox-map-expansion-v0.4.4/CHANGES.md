# Plotbox map expansion v0.4.3

- Fixed the PowerShell apply helper so it automatically discovers the Plotbox repository when launched from inside the extracted package folder or another repository subdirectory.
- Feature payload is unchanged from v0.4.2.

# Package v0.4.2

- Replaced the Python apply helper with a native PowerShell apply script.
- No feature or renderer changes from the v0.4.1 map expansion payload.

# Changes included

## OSM tags/features

- Highway classes: motorway/trunk, primary, secondary/tertiary, residential, service, footway/path,
  pedestrian, cycleway and track.
- `bridge=yes` and `tunnel=yes` plot treatments.
- Rail: `rail`, `light_rail`, `tram`, `subway`, `narrow_gauge`.
- Water areas: `natural=water|bay`, water/landuse lake/reservoir/pond/basin and riverbank.
- Waterways: river, stream, canal, drain, ditch.
- `natural=coastline`.
- Woodland/forest, farmland, meadow/grass, residential and industrial/commercial/retail landuse,
  cemetery/graveyard, parking, wetland, parks/gardens/nature reserves.
- Administrative boundary ways and relation member ways.
- Power line/minor line and tower/pole symbols.
- Aeroway runways/taxiways.
- Piers, breakwaters and seawalls.
- POIs: worship, stations, peaks, historic sites, castles/ruins, lighthouses, wind turbines,
  schools, hospitals, trees and monuments.

## Plot treatments

- Road centerline, casing/double line, classified, dashed and dotted.
- Bridge edge ticks and tunnel dash treatment.
- Rail single, double, sleepers and classified.
- Polygon outline, hatch, outline+hatch, crosshatch and plotter-safe stipple.
- Water ripple/parallel clipped lines.
- Building offset/shadow outline.
- Configurable code-level landuse hatch angle/spacing differentiation.
- Boundary solid/dashed/dotted/dash-dot.
- Procedural vector POI symbols.

## Physical filtering

- Minimum line length in final page mm.
- Minimum polygon area in final page mm2.
- Minimum POI spacing in final page mm.
- Vertex simplification in final page mm.
- Minimum gap setting is included in the persisted/UI model for future collision pruning.

## Terrain/topography

- `TerrainProvider` protocol.
- AWS Terrarium provider with bounded tile and grid budgets.
- In-memory tile cache.
- Marching-squares vector contour generation.
- Contour interval, index contour cadence, resolution, simplification, minimum length and optional
  elevation range.
- Separate `terrain-contour` and `terrain-index-contour` semantic layers.
- Progress stages for terrain download, contour generation and geometry filtering.
- Existing job cancellation is forwarded into map/terrain generation.

## UI

Collapsible sections for presets, transport, buildings, water, landuse, boundaries/infrastructure,
points of interest, terrain/topography, plot treatments and detail filtering.

Presets: Street map, Figure ground, Hydrology, Topographic, Rail, Landscape and Urban detail.
Presets mutate ordinary settings; they do not introduce separate renderers.

## Dependencies

No new Python or frontend package dependency is required. Pillow is already present and is used to
decode Terrarium PNG tiles.

## Limitations

- OSM multipolygon assembly is not generalized. Administrative boundary relations are rendered from
  their member ways, while complex water/landuse multipolygon relations are not yet assembled.
- The optional `minimum_gap_mm` setting is persisted and exposed but is not yet used for global
  geometry collision pruning; doing that naively would add expensive pairwise comparisons.
- Terrain tiles are cached in-process, not frozen into the project snapshot. Re-generating terrain
  therefore requires network access unless tiles remain in the process cache.
- POIs intentionally use simple symbols only; labels and external icon assets are not introduced.
- Stipple is a deterministic physical grid of small cross marks, not centroidal/Voronoi stippling.


## v0.4.4

- Changed the PowerShell apply helper to require an explicit `ProjectPath` argument.
- Removed automatic repository-root discovery.
- Supports both positional and `-ProjectPath` invocation.
- Feature payload remains unchanged from v0.4.3.
- Fixed patch matching on Windows CRLF checkouts while preserving the repository's original line-ending style.
