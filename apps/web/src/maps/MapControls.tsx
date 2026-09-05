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

      <fieldset>
        <legend>Map features</legend>
        <div className="feature-toggle-grid">
          {(Object.keys(project.osm.features) as (keyof ProjectRecipe["osm"]["features"])[]).map(
            (feature) => (
              <label className="checkbox-row" key={feature}>
                <input
                  aria-label={`Include ${feature}`}
                  type="checkbox"
                  checked={project.osm.features[feature]}
                  onChange={(event) =>
                    updateOsm({
                      features: { ...project.osm.features, [feature]: event.target.checked },
                    })
                  }
                />
                {feature}
              </label>
            ),
          )}
        </div>
        <label>
          Road line treatment
          <select
            aria-label="Map road line treatment"
            value={project.osm.render.road_line_treatment}
            onChange={(event) =>
              updateOsm({
                render: {
                  ...project.osm.render,
                  road_line_treatment: event.target
                    .value as ProjectRecipe["osm"]["render"]["road_line_treatment"],
                },
              })
            }
          >
            <option value="centerline">One centerline</option>
            <option value="casing">Two casing lines</option>
            <option value="parallel">Parallel lines</option>
          </select>
        </label>
        {project.osm.render.road_line_treatment !== "centerline" && (
          <label>
            Physical road width mm
            <NumericInput
              aria-label="Map road width"
              type="number"
              min="0.1"
              step="0.1"
              value={project.osm.render.road_width_mm}
              onChange={(event) =>
                updateOsm({
                  render: {
                    ...project.osm.render,
                    road_width_mm: Number(event.target.value),
                  },
                })
              }
            />
          </label>
        )}
        {(["building", "water", "park"] as const).map((feature) => {
          const key = `${feature}_treatment` as const;
          return (
            <label key={feature}>
              {feature === "building" ? "Building" : feature === "water" ? "Water" : "Park"}{" "}
              polygons
              <select
                aria-label={`Map ${feature} treatment`}
                value={project.osm.render[key]}
                onChange={(event) =>
                  updateOsm({
                    render: {
                      ...project.osm.render,
                      [key]: event.target.value as "outline" | "hatch",
                    },
                  })
                }
              >
                <option value="outline">Outline</option>
                <option value="hatch">Outline + hatch</option>
              </select>
            </label>
          );
        })}
        <div className="field-row">
          <label>
            Hatch spacing mm
            <NumericInput
              aria-label="Map polygon hatch spacing"
              type="number"
              min="0.1"
              step="0.1"
              value={project.osm.render.polygon_hatch_spacing_mm}
              onChange={(event) =>
                updateOsm({
                  render: {
                    ...project.osm.render,
                    polygon_hatch_spacing_mm: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            Hatch angle
            <NumericInput
              aria-label="Map polygon hatch angle"
              type="number"
              value={project.osm.render.polygon_hatch_angle_degrees}
              onChange={(event) =>
                updateOsm({
                  render: {
                    ...project.osm.render,
                    polygon_hatch_angle_degrees: Number(event.target.value),
                  },
                })
              }
            />
          </label>
        </div>
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
