import { NumericInput } from "../NumericInput";
import { useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { OsmBounds, OsmPlaceResult, ProjectRecipe } from "../types";

interface MapControlsProps {
  project: ProjectRecipe;
  busy: boolean;
  lastFetchUsedCache: boolean | null;
  places: OsmPlaceResult[];
  lastPlaceSearchUsedCache: boolean | null;
  searchBusy: boolean;
  onChange: (project: ProjectRecipe) => void;
  onFetch: () => void;
  onSearch: (query: string) => void;
  onGenerate: () => void;
}

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_REQUEST_AREA_KM2 = 100;
const MAP_SIZE_PRESETS = [
  { label: "Small", areaKm2: 1 },
  { label: "Medium", areaKm2: 5 },
  { label: "Large", areaKm2: 25 },
  { label: "Extra large", areaKm2: 100 },
] as const;

const MAP_STYLE_PRESETS = [
  "street",
  "figure-ground",
  "hydrology",
  "topographic",
  "rail",
  "landscape",
  "urban-detail",
] as const;

type MapPreset = (typeof MAP_STYLE_PRESETS)[number];
type FeatureKey = keyof ProjectRecipe["osm"]["features"];

type ToggleDefinition = {
  key: FeatureKey;
  label: string;
};

const TRANSPORT_TOGGLES: ToggleDefinition[] = [
  { key: "road_motorways", label: "Motorways / trunk" },
  { key: "road_primary", label: "Primary roads" },
  { key: "road_secondary", label: "Secondary / tertiary" },
  { key: "road_residential", label: "Residential roads" },
  { key: "road_service", label: "Service roads" },
  { key: "footpaths", label: "Footpaths" },
  { key: "pedestrian_paths", label: "Pedestrian paths" },
  { key: "cycleways", label: "Cycleways" },
  { key: "tracks", label: "Tracks" },
  { key: "rail", label: "Rail" },
  { key: "aeroway", label: "Runways / taxiways" },
  { key: "maritime", label: "Piers / breakwaters / seawalls" },
];

const WATER_TOGGLES: ToggleDefinition[] = [
  { key: "water_areas", label: "Water areas" },
  { key: "waterways", label: "Rivers / streams / canals" },
  { key: "coastline", label: "Coastline" },
];

const LANDUSE_TOGGLES: ToggleDefinition[] = [
  { key: "parks", label: "Parks" },
  { key: "woodland", label: "Woodland / forest" },
  { key: "farmland", label: "Farmland" },
  { key: "meadow", label: "Meadow / grass" },
  { key: "residential_landuse", label: "Residential landuse" },
  { key: "industrial_landuse", label: "Industrial / commercial" },
  { key: "cemetery", label: "Cemeteries" },
  { key: "parking", label: "Parking areas" },
  { key: "wetlands", label: "Wetlands" },
];

const INFRASTRUCTURE_TOGGLES: ToggleDefinition[] = [
  { key: "boundaries", label: "Administrative boundaries" },
  { key: "power_lines", label: "Power lines" },
  { key: "power_nodes", label: "Power towers / poles" },
];

const POI_TOGGLES: ToggleDefinition[] = [
  { key: "poi_worship", label: "Places of worship" },
  { key: "poi_stations", label: "Railway stations" },
  { key: "poi_peaks", label: "Peaks" },
  { key: "poi_historic", label: "Historic sites" },
  { key: "poi_castles", label: "Castles / ruins" },
  { key: "poi_lighthouses", label: "Lighthouses" },
  { key: "poi_wind_turbines", label: "Wind turbines" },
  { key: "poi_schools", label: "Schools" },
  { key: "poi_hospitals", label: "Hospitals" },
  { key: "poi_trees", label: "Trees" },
  { key: "poi_monuments", label: "Monuments" },
];

function osmAreaKm2(bounds: OsmBounds): number {
  const height = ((bounds.north - bounds.south) * Math.PI * EARTH_RADIUS_M) / 180;
  const centerLatitude = ((bounds.north + bounds.south) * Math.PI) / 360;
  const width =
    ((bounds.east - bounds.west) * Math.PI * EARTH_RADIUS_M * Math.cos(centerLatitude)) / 180;
  return Math.abs(width * height) / 1_000_000;
}

function sameBounds(first: OsmBounds, second: OsmBounds): boolean {
  const tolerance = 0.000_000_1;
  return (
    Math.abs(first.south - second.south) < tolerance &&
    Math.abs(first.west - second.west) < tolerance &&
    Math.abs(first.north - second.north) < tolerance &&
    Math.abs(first.east - second.east) < tolerance
  );
}

function selectionFromMap(map: MapLibreMap, host: HTMLDivElement, pageAspect: number): OsmBounds {
  let width = host.clientWidth * 0.68;
  let height = width / pageAspect;
  const maximumHeight = host.clientHeight * 0.72;
  if (height > maximumHeight) {
    height = maximumHeight;
    width = height * pageAspect;
  }
  const centerX = host.clientWidth / 2;
  const centerY = host.clientHeight / 2;
  const northwest = map.unproject([centerX - width / 2, centerY - height / 2]);
  const southeast = map.unproject([centerX + width / 2, centerY + height / 2]);
  return {
    south: southeast.lat,
    west: northwest.lng,
    north: northwest.lat,
    east: southeast.lng,
  };
}

function fitMapToSelection(
  map: MapLibreMap,
  host: HTMLDivElement,
  bounds: OsmBounds,
  pageAspect: number,
): void {
  let width = host.clientWidth * 0.68;
  let height = width / pageAspect;
  const maximumHeight = host.clientHeight * 0.72;
  if (height > maximumHeight) {
    height = maximumHeight;
    width = height * pageAspect;
  }
  map.fitBounds(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    {
      padding: {
        top: (host.clientHeight - height) / 2,
        right: (host.clientWidth - width) / 2,
        bottom: (host.clientHeight - height) / 2,
        left: (host.clientWidth - width) / 2,
      },
      duration: 0,
    },
  );
}

function boundsForArea(
  center: { latitude: number; longitude: number },
  areaKm2: number,
  aspect: number,
): OsmBounds {
  const heightKm = Math.sqrt(areaKm2 / aspect);
  const widthKm = heightKm * aspect;
  const latitudeSpan = heightKm / 111.195;
  const longitudeSpan = widthKm / (111.195 * Math.cos((center.latitude * Math.PI) / 180));
  return {
    south: Math.max(-85, center.latitude - latitudeSpan / 2),
    west: Math.max(-180, center.longitude - longitudeSpan / 2),
    north: Math.min(85, center.latitude + latitudeSpan / 2),
    east: Math.min(180, center.longitude + longitudeSpan / 2),
  };
}

function presetFeatures(
  current: ProjectRecipe["osm"]["features"],
  preset: MapPreset,
): ProjectRecipe["osm"]["features"] {
  const cleared = Object.fromEntries(
    Object.keys(current).map((key) => [key, false]),
  ) as unknown as ProjectRecipe["osm"]["features"];
  const withLegacyGroups = { ...cleared, roads: true, water: true };
  switch (preset) {
    case "street":
      return {
        ...withLegacyGroups,
        road_motorways: true,
        road_primary: true,
        road_secondary: true,
        road_residential: true,
        road_service: true,
        buildings: true,
        rail: true,
        water_areas: true,
        waterways: true,
      };
    case "figure-ground":
      return { ...cleared, buildings: true };
    case "hydrology":
      return { ...cleared, water: true, water_areas: true, waterways: true, coastline: true };
    case "topographic":
      return {
        ...withLegacyGroups,
        road_primary: true,
        road_secondary: true,
        road_residential: true,
        footpaths: true,
        tracks: true,
        waterways: true,
        poi_peaks: true,
        points_of_interest: true,
      };
    case "rail":
      return {
        ...cleared,
        roads: true,
        road_primary: true,
        road_secondary: true,
        rail: true,
        points_of_interest: true,
        poi_stations: true,
      };
    case "landscape":
      return {
        ...cleared,
        water: true,
        water_areas: true,
        waterways: true,
        woodland: true,
        parks: true,
        farmland: true,
      };
    case "urban-detail":
      return {
        ...withLegacyGroups,
        road_primary: true,
        road_secondary: true,
        road_residential: true,
        road_service: true,
        footpaths: true,
        pedestrian_paths: true,
        buildings: true,
        rail: true,
        parking: true,
        points_of_interest: true,
        poi_worship: true,
        poi_stations: true,
        poi_historic: true,
        poi_schools: true,
        poi_hospitals: true,
        poi_monuments: true,
      };
  }
}

function ToggleGrid({
  definitions,
  project,
  updateFeature,
}: {
  definitions: ToggleDefinition[];
  project: ProjectRecipe;
  updateFeature: (key: FeatureKey, checked: boolean) => void;
}) {
  return (
    <div className="feature-toggle-grid">
      {definitions.map(({ key, label }) => (
        <label className="checkbox-row" key={key}>
          <input
            aria-label={`Include ${label}`}
            type="checkbox"
            checked={project.osm.features[key]}
            onChange={(event) => updateFeature(key, event.target.checked)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

export function MapControls({
  project,
  busy,
  lastFetchUsedCache,
  places,
  lastPlaceSearchUsedCache,
  searchBusy,
  onChange,
  onFetch,
  onSearch,
  onGenerate,
}: MapControlsProps) {
  const mapHost = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<MapLibreMap | null>(null);
  const latestProject = useRef(project);
  const latestOnChange = useRef(onChange);
  const [placeQuery, setPlaceQuery] = useState("");
  const [selectionChanged, setSelectionChanged] = useState(false);
  latestProject.current = project;
  latestOnChange.current = onChange;
  const bounds = project.osm.selection.bounds;
  const center = {
    latitude: (bounds.south + bounds.north) / 2,
    longitude: (bounds.west + bounds.east) / 2,
  };
  const areaKm2 = useMemo(() => osmAreaKm2(bounds), [bounds]);
  const updateOsm = (changes: Partial<ProjectRecipe["osm"]>) =>
    onChange({ ...project, osm: { ...project.osm, ...changes } });
  const updateFeature = (key: FeatureKey, checked: boolean) =>
    updateOsm({ features: { ...project.osm.features, [key]: checked }, preset_id: null });
  const updateRender = (changes: Partial<ProjectRecipe["osm"]["render"]>) =>
    updateOsm({ render: { ...project.osm.render, ...changes }, preset_id: null });
  const updateDetail = (changes: Partial<ProjectRecipe["osm"]["detail"]>) =>
    updateOsm({ detail: { ...project.osm.detail, ...changes }, preset_id: null });
  const updateTerrain = (changes: Partial<ProjectRecipe["osm"]["terrain"]>) =>
    updateOsm({ terrain: { ...project.osm.terrain, ...changes }, preset_id: null });
  const updatePoi = (changes: Partial<ProjectRecipe["osm"]["poi"]>) =>
    updateOsm({ poi: { ...project.osm.poi, ...changes }, preset_id: null });

  const updateSelection = (nextBounds: OsmBounds) => {
    if (sameBounds(bounds, nextBounds)) return;
    setSelectionChanged(true);
    updateOsm({
      selection: { ...project.osm.selection, bounds: nextBounds },
      snapshot: null,
    });
  };
  const updateCenter = (field: "latitude" | "longitude", value: number) => {
    if (!Number.isFinite(value)) return;
    const latitudeSpan = bounds.north - bounds.south;
    const longitudeSpan = bounds.east - bounds.west;
    const latitude = field === "latitude" ? value : center.latitude;
    const longitude = field === "longitude" ? value : center.longitude;
    updateSelection({
      south: latitude - latitudeSpan / 2,
      west: longitude - longitudeSpan / 2,
      north: latitude + latitudeSpan / 2,
      east: longitude + longitudeSpan / 2,
    });
  };

  const applyPreset = (preset: MapPreset) => {
    const features = presetFeatures(project.osm.features, preset);
    const terrainEnabled = preset === "topographic" || preset === "landscape";
    updateOsm({
      preset_id: preset,
      features,
      terrain: { ...project.osm.terrain, enabled: terrainEnabled },
      render: {
        ...project.osm.render,
        road_line_treatment: preset === "figure-ground" ? "centerline" : "classified",
        water_treatment:
          preset === "hydrology" ? "outline-hatch" : project.osm.render.water_treatment,
      },
    });
  };

  useEffect(() => {
    if (project.osm.snapshot && sameBounds(project.osm.snapshot.bounds, bounds)) {
      setSelectionChanged(false);
    }
  }, [bounds, project.osm.snapshot]);

  useEffect(() => {
    if (!mapHost.current || typeof WebGLRenderingContext === "undefined") return;
    let disposed = false;
    let map: MapLibreMap | undefined;
    void import("maplibre-gl").then(({ Map, NavigationControl }) => {
      if (disposed || !mapHost.current) return;
      map = new Map({
        container: mapHost.current,
        center: [
          latestProject.current.osm.selection.bounds.west,
          latestProject.current.osm.selection.bounds.south,
        ],
        zoom: 13,
        style: {
          version: 8,
          sources: {
            "openstreetmap-standard": {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [
            {
              id: "openstreetmap-standard",
              type: "raster",
              source: "openstreetmap-standard",
            },
          ],
        },
        attributionControl: { compact: true },
      });
      mapInstance.current = map;
      map.addControl(new NavigationControl({ showCompass: true }), "top-right");
      map.on("load", () => {
        const current = latestProject.current;
        if (!map || !mapHost.current) return;
        fitMapToSelection(
          map,
          mapHost.current,
          current.osm.selection.bounds,
          current.page.width_mm / current.page.height_mm,
        );
      });
      map.on("moveend", () => {
        const current = latestProject.current;
        if (!map || !mapHost.current) return;
        const nextBounds = selectionFromMap(
          map,
          mapHost.current,
          current.page.width_mm / current.page.height_mm,
        );
        if (sameBounds(current.osm.selection.bounds, nextBounds)) return;
        setSelectionChanged(true);
        latestOnChange.current({
          ...current,
          osm: {
            ...current.osm,
            selection: { ...current.osm.selection, bounds: nextBounds },
            snapshot: null,
          },
        });
      });
    });
    return () => {
      disposed = true;
      mapInstance.current = null;
      map?.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapInstance.current;
    const host = mapHost.current;
    if (!map || !host) return;
    fitMapToSelection(map, host, bounds, project.page.width_mm / project.page.height_mm);
  }, [bounds, project.page.height_mm, project.page.width_mm]);

  const snapshotMatchesSelection =
    project.osm.snapshot !== null && sameBounds(project.osm.snapshot.bounds, bounds);
  const needsDownload = selectionChanged || !snapshotMatchesSelection;

  return (
    <>
      <fieldset>
        <legend>Map extent</legend>
        <form
          className="place-search"
          onSubmit={(event) => {
            event.preventDefault();
            const query = placeQuery.trim();
            if (query.length >= 2) onSearch(query);
          }}
        >
          <label>
            Search for a place
            <div className="place-search-row">
              <input
                aria-label="Search for a place"
                type="search"
                value={placeQuery}
                placeholder="Town, postcode, landmark…"
                onChange={(event) => setPlaceQuery(event.target.value)}
              />
              <button type="submit" disabled={busy || searchBusy || placeQuery.trim().length < 2}>
                {searchBusy ? "Searching…" : "Search"}
              </button>
            </div>
          </label>
        </form>
        {places.length > 0 && (
          <div className="place-results" aria-label="Place search results">
            {places.map((place) => (
              <button
                type="button"
                key={`${place.osm_type ?? "place"}-${place.osm_id ?? place.display_name}`}
                onClick={() => {
                  const latitudeSpan = bounds.north - bounds.south;
                  const longitudeSpan = bounds.east - bounds.west;
                  updateSelection({
                    south: place.latitude - latitudeSpan / 2,
                    west: place.longitude - longitudeSpan / 2,
                    north: place.latitude + latitudeSpan / 2,
                    east: place.longitude + longitudeSpan / 2,
                  });
                }}
              >
                {place.display_name}
              </button>
            ))}
            {lastPlaceSearchUsedCache !== null && (
              <small>
                {lastPlaceSearchUsedCache ? "Cached search results" : "New search results"}
              </small>
            )}
          </div>
        )}
        <div className={`map-selector${busy ? " is-busy" : ""}`}>
          <div ref={mapHost} className="maplibre-host" aria-label="Interactive map selector" />
          <div
            className="page-ratio-overlay"
            style={{ aspectRatio: `${project.page.width_mm} / ${project.page.height_mm}` }}
            aria-hidden="true"
          />
          <span>Orange box = download area</span>
        </div>
        <small className="map-attribution">
          Basemap ©{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>
        </small>
        <p className="field-help map-help">
          Drag or zoom the map. The orange box updates the area automatically when you stop.
        </p>
        <div className="field-row">
          <label>
            Latitude
            <NumericInput
              aria-label="Map centre latitude"
              type="number"
              step="0.0001"
              min="-85"
              max="85"
              value={Number(center.latitude.toFixed(7))}
              onChange={(event) => updateCenter("latitude", Number(event.target.value))}
            />
          </label>
          <label>
            Longitude
            <NumericInput
              aria-label="Map centre longitude"
              type="number"
              step="0.0001"
              min="-180"
              max="180"
              value={Number(center.longitude.toFixed(7))}
              onChange={(event) => updateCenter("longitude", Number(event.target.value))}
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            Page rotation
            <NumericInput
              aria-label="Map page rotation"
              type="number"
              min="-180"
              max="180"
              value={project.osm.selection.rotation_degrees}
              onChange={(event) =>
                updateOsm({
                  selection: {
                    ...project.osm.selection,
                    rotation_degrees: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            Lock
            <select
              aria-label="Map selection lock"
              value={project.osm.selection.lock_mode}
              onChange={(event) =>
                updateOsm({
                  selection: {
                    ...project.osm.selection,
                    lock_mode: event.target.value as "extent" | "scale",
                  },
                })
              }
            >
              <option value="extent">Geographic extent</option>
              <option value="scale">Output scale</option>
            </select>
          </label>
        </div>
        <p className={`map-area ${areaKm2 > 25 ? "over-limit" : ""}`}>
          Download area: <strong>{areaKm2.toFixed(2)} km²</strong> / {MAX_REQUEST_AREA_KM2} km²
          {areaKm2 > 25 && areaKm2 <= MAX_REQUEST_AREA_KM2 && " — larger downloads can take longer"}
          {areaKm2 > MAX_REQUEST_AREA_KM2 && " — choose a smaller area before downloading"}
        </p>
        <div className="map-size-controls" aria-label="Map area size">
          <span>Quick size</span>
          <div>
            {MAP_SIZE_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.areaKm2}
                disabled={busy}
                onClick={() =>
                  updateSelection(
                    boundsForArea(
                      center,
                      preset.areaKm2,
                      project.page.width_mm / project.page.height_mm,
                    ),
                  )
                }
              >
                {preset.label} ({preset.areaKm2} km²)
              </button>
            ))}
          </div>
        </div>
        <div className="action-row map-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const map = mapInstance.current;
              const host = mapHost.current;
              if (map && host) {
                fitMapToSelection(
                  map,
                  host,
                  bounds,
                  project.page.width_mm / project.page.height_mm,
                );
              }
            }}
          >
            Show selected area
          </button>
          <button type="button" disabled={busy || areaKm2 > MAX_REQUEST_AREA_KM2} onClick={onFetch}>
            {busy
              ? "Downloading map data…"
              : needsDownload
                ? "Download and freeze map data"
                : "Download map data again"}
          </button>
        </div>
      </fieldset>

      <fieldset className="map-control-sections">
        <legend>Map features and treatments</legend>

        <details open>
          <summary>Presets</summary>
          <div className="map-preset-grid">
            {MAP_STYLE_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset}
                className={project.osm.preset_id === preset ? "selected" : ""}
                onClick={() => applyPreset(preset)}
              >
                {preset.replaceAll("-", " ")}
              </button>
            ))}
          </div>
          <p className="field-help">Presets only change settings. Every option remains editable.</p>
        </details>

        <details open>
          <summary>Transport</summary>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={project.osm.features.roads}
              onChange={(event) => updateFeature("roads", event.target.checked)}
            />
            Enable roads and paths
          </label>
          <ToggleGrid
            definitions={TRANSPORT_TOGGLES}
            project={project}
            updateFeature={updateFeature}
          />
        </details>

        <details>
          <summary>Buildings</summary>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={project.osm.features.buildings}
              onChange={(event) => updateFeature("buildings", event.target.checked)}
            />
            Buildings
          </label>
          <label>
            Polygon treatment
            <select
              value={project.osm.render.building_treatment}
              onChange={(event) =>
                updateRender({
                  building_treatment: event.target
                    .value as ProjectRecipe["osm"]["render"]["building_treatment"],
                })
              }
            >
              <option value="outline">Outline</option>
              <option value="hatch">Hatch only</option>
              <option value="outline-hatch">Outline + hatch</option>
              <option value="crosshatch">Cross hatch</option>
              <option value="stipple">Stipple</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={project.osm.render.building_shadow_enabled}
              onChange={(event) => updateRender({ building_shadow_enabled: event.target.checked })}
            />
            Offset / shadow outline
          </label>
          {project.osm.render.building_shadow_enabled && (
            <div className="field-row">
              <label>
                Offset mm
                <NumericInput
                  type="number"
                  min="0"
                  step="0.1"
                  value={project.osm.render.building_shadow_offset_mm}
                  onChange={(event) =>
                    updateRender({ building_shadow_offset_mm: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Angle
                <NumericInput
                  type="number"
                  value={project.osm.render.building_shadow_angle_degrees}
                  onChange={(event) =>
                    updateRender({ building_shadow_angle_degrees: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
        </details>

        <details open>
          <summary>Water</summary>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={project.osm.features.water}
              onChange={(event) => updateFeature("water", event.target.checked)}
            />
            Enable water features
          </label>
          <ToggleGrid definitions={WATER_TOGGLES} project={project} updateFeature={updateFeature} />
          <label>
            Water-area treatment
            <select
              value={project.osm.render.water_treatment}
              onChange={(event) =>
                updateRender({
                  water_treatment: event.target
                    .value as ProjectRecipe["osm"]["render"]["water_treatment"],
                })
              }
            >
              <option value="outline">Outline</option>
              <option value="hatch">Hatch only</option>
              <option value="outline-hatch">Outline + hatch</option>
              <option value="crosshatch">Cross hatch</option>
              <option value="stipple">Stipple</option>
              <option value="ripple">Parallel ripple lines</option>
            </select>
          </label>
          {project.osm.render.water_treatment === "ripple" && (
            <div className="field-row">
              <label>
                Ripple spacing mm
                <NumericInput
                  type="number"
                  min="0.2"
                  step="0.1"
                  value={project.osm.render.water_ripple_spacing_mm}
                  onChange={(event) =>
                    updateRender({ water_ripple_spacing_mm: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Ripple angle
                <NumericInput
                  type="number"
                  value={project.osm.render.water_ripple_angle_degrees}
                  onChange={(event) =>
                    updateRender({ water_ripple_angle_degrees: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
        </details>

        <details>
          <summary>Landuse</summary>
          <ToggleGrid
            definitions={LANDUSE_TOGGLES}
            project={project}
            updateFeature={updateFeature}
          />
          <label>
            Landuse polygon treatment
            <select
              value={project.osm.render.landuse_treatment}
              onChange={(event) =>
                updateRender({
                  landuse_treatment: event.target
                    .value as ProjectRecipe["osm"]["render"]["landuse_treatment"],
                })
              }
            >
              <option value="outline">Outline</option>
              <option value="hatch">Hatch only</option>
              <option value="outline-hatch">Outline + hatch</option>
              <option value="crosshatch">Cross hatch</option>
              <option value="stipple">Stipple</option>
            </select>
          </label>
        </details>

        <details>
          <summary>Boundaries and infrastructure</summary>
          <ToggleGrid
            definitions={INFRASTRUCTURE_TOGGLES}
            project={project}
            updateFeature={updateFeature}
          />
          <label>
            Boundary treatment
            <select
              value={project.osm.render.boundary_treatment}
              onChange={(event) =>
                updateRender({
                  boundary_treatment: event.target
                    .value as ProjectRecipe["osm"]["render"]["boundary_treatment"],
                })
              }
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
              <option value="dash-dot">Dash-dot</option>
            </select>
          </label>
        </details>

        <details>
          <summary>Points of interest</summary>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={project.osm.features.points_of_interest}
              onChange={(event) => updateFeature("points_of_interest", event.target.checked)}
            />
            Enable POI symbols
          </label>
          <ToggleGrid definitions={POI_TOGGLES} project={project} updateFeature={updateFeature} />
          <div className="field-row">
            <label>
              Symbol size mm
              <NumericInput
                type="number"
                min="0.5"
                max="10"
                step="0.1"
                value={project.osm.poi.symbol_size_mm}
                onChange={(event) => updatePoi({ symbol_size_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Minimum spacing mm
              <NumericInput
                type="number"
                min="0"
                max="50"
                step="0.1"
                value={project.osm.detail.minimum_poi_spacing_mm}
                onChange={(event) =>
                  updateDetail({ minimum_poi_spacing_mm: Number(event.target.value) })
                }
              />
            </label>
          </div>
        </details>

        <details>
          <summary>Terrain / topography</summary>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={project.osm.terrain.enabled}
              onChange={(event) => updateTerrain({ enabled: event.target.checked })}
            />
            Generate elevation contours
          </label>
          <p className="field-help">
            Uses public AWS Terrarium elevation tiles. Only vector contour paths enter the plot.
          </p>
          <div className="field-row">
            <label>
              Contour interval m
              <NumericInput
                type="number"
                min="1"
                max="500"
                value={project.osm.terrain.contour_interval_m}
                onChange={(event) =>
                  updateTerrain({ contour_interval_m: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Index every N contours
              <NumericInput
                type="number"
                min="1"
                max="20"
                value={project.osm.terrain.index_contour_every}
                onChange={(event) =>
                  updateTerrain({ index_contour_every: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Sample resolution
              <NumericInput
                type="number"
                min="16"
                max="512"
                step="16"
                value={project.osm.terrain.sample_resolution}
                onChange={(event) =>
                  updateTerrain({ sample_resolution: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Simplification mm
              <NumericInput
                type="number"
                min="0"
                step="0.02"
                value={project.osm.terrain.contour_simplification_mm}
                onChange={(event) =>
                  updateTerrain({ contour_simplification_mm: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Minimum contour mm
              <NumericInput
                type="number"
                min="0"
                step="0.2"
                value={project.osm.terrain.minimum_contour_length_mm}
                onChange={(event) =>
                  updateTerrain({ minimum_contour_length_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Provider
              <select value={project.osm.terrain.provider} disabled>
                <option value="aws-terrarium">AWS Terrarium</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              Minimum elevation m
              <NumericInput
                type="number"
                value={project.osm.terrain.elevation_min_m ?? ""}
                placeholder="Auto"
                onChange={(event) =>
                  updateTerrain({
                    elevation_min_m: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Maximum elevation m
              <NumericInput
                type="number"
                value={project.osm.terrain.elevation_max_m ?? ""}
                placeholder="Auto"
                onChange={(event) =>
                  updateTerrain({
                    elevation_max_m: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
        </details>

        <details open>
          <summary>Plot treatments</summary>
          <label>
            Road rendering
            <select
              aria-label="Map road line treatment"
              value={project.osm.render.road_line_treatment}
              onChange={(event) =>
                updateRender({
                  road_line_treatment: event.target
                    .value as ProjectRecipe["osm"]["render"]["road_line_treatment"],
                })
              }
            >
              <option value="centerline">One centerline</option>
              <option value="casing">Double line / casing</option>
              <option value="classified">Classified</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <div className="field-row">
            <label>
              Road casing width mm
              <NumericInput
                type="number"
                min="0.1"
                step="0.1"
                value={project.osm.render.road_width_mm}
                onChange={(event) => updateRender({ road_width_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Rail treatment
              <select
                value={project.osm.render.rail_treatment}
                onChange={(event) =>
                  updateRender({
                    rail_treatment: event.target
                      .value as ProjectRecipe["osm"]["render"]["rail_treatment"],
                  })
                }
              >
                <option value="single">Single line</option>
                <option value="double">Double line</option>
                <option value="sleepers">Line with sleepers</option>
                <option value="classified">Classified</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              Hatch spacing mm
              <NumericInput
                type="number"
                min="0.1"
                step="0.1"
                value={project.osm.render.polygon_hatch_spacing_mm}
                onChange={(event) =>
                  updateRender({ polygon_hatch_spacing_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Hatch angle
              <NumericInput
                type="number"
                value={project.osm.render.polygon_hatch_angle_degrees}
                onChange={(event) =>
                  updateRender({ polygon_hatch_angle_degrees: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Dash length mm
              <NumericInput
                type="number"
                min="0.1"
                step="0.1"
                value={project.osm.render.dash_length_mm}
                onChange={(event) => updateRender({ dash_length_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Dash gap mm
              <NumericInput
                type="number"
                min="0.1"
                step="0.1"
                value={project.osm.render.dash_gap_mm}
                onChange={(event) => updateRender({ dash_gap_mm: Number(event.target.value) })}
              />
            </label>
          </div>
        </details>

        <details open>
          <summary>Detail filtering</summary>
          <div className="field-row">
            <label>
              Minimum line mm
              <NumericInput
                type="number"
                min="0"
                step="0.1"
                value={project.osm.detail.minimum_line_length_mm}
                onChange={(event) =>
                  updateDetail({ minimum_line_length_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Minimum polygon mm²
              <NumericInput
                type="number"
                min="0"
                step="0.1"
                value={project.osm.detail.minimum_polygon_area_mm2}
                onChange={(event) =>
                  updateDetail({ minimum_polygon_area_mm2: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Vertex simplify mm
              <NumericInput
                type="number"
                min="0"
                step="0.01"
                value={project.osm.detail.vertex_simplification_tolerance_mm}
                onChange={(event) =>
                  updateDetail({ vertex_simplification_tolerance_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Optional minimum gap mm
              <NumericInput
                type="number"
                min="0"
                step="0.05"
                value={project.osm.detail.minimum_gap_mm}
                onChange={(event) => updateDetail({ minimum_gap_mm: Number(event.target.value) })}
              />
            </label>
          </div>
          <p className="field-help">
            Filtering happens after geographic geometry is transformed into final page millimetres.
          </p>
        </details>
      </fieldset>

      <section className="snapshot-card" aria-label="OSM snapshot status">
        {project.osm.snapshot && snapshotMatchesSelection && !selectionChanged ? (
          <>
            <strong>Map data is ready</strong>
            <span>{project.osm.snapshot.element_count.toLocaleString()} elements</span>
            <code>{project.osm.snapshot.sha256.slice(0, 16)}</code>
            <small>
              {project.osm.snapshot.attribution} · {project.osm.snapshot.source_date}
            </small>
            {lastFetchUsedCache !== null && (
              <em>{lastFetchUsedCache ? "Reused cached query" : "Downloaded new snapshot"}</em>
            )}
          </>
        ) : selectionChanged ? (
          <>
            <strong>Map area changed</strong>
            <small>Download map data again before creating the map.</small>
          </>
        ) : (
          <>
            <strong>Map data has not been downloaded</strong>
            <small>Download and freeze the selected area before creating the map.</small>
          </>
        )}
      </section>
      <button
        className="primary-button full"
        type="button"
        disabled={busy || needsDownload}
        onClick={onGenerate}
      >
        {busy
          ? "Generating map…"
          : needsDownload
            ? "Download map data first"
            : "Generate map and plan"}
      </button>
    </>
  );
}
