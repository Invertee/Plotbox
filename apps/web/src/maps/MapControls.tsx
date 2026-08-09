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

function osmAreaKm2(bounds: OsmBounds): number {
  const height = ((bounds.north - bounds.south) * Math.PI * EARTH_RADIUS_M) / 180;
  const centerLatitude = ((bounds.north + bounds.south) * Math.PI) / 360;
  const width =
    ((bounds.east - bounds.west) * Math.PI * EARTH_RADIUS_M * Math.cos(centerLatitude)) / 180;
  return Math.abs(width * height) / 1_000_000;
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
  const initialBounds = useRef(project.osm.selection.bounds);
  const [placeQuery, setPlaceQuery] = useState("");
  const bounds = project.osm.selection.bounds;
  const center = {
    latitude: (bounds.south + bounds.north) / 2,
    longitude: (bounds.west + bounds.east) / 2,
  };
  const areaKm2 = useMemo(() => osmAreaKm2(bounds), [bounds]);
  const updateOsm = (changes: Partial<ProjectRecipe["osm"]>) =>
    onChange({ ...project, osm: { ...project.osm, ...changes } });
  const updateCenter = (field: "latitude" | "longitude", value: number) => {
    if (!Number.isFinite(value)) return;
    const latitudeSpan = bounds.north - bounds.south;
    const longitudeSpan = bounds.east - bounds.west;
    const latitude = field === "latitude" ? value : center.latitude;
    const longitude = field === "longitude" ? value : center.longitude;
    updateOsm({
      selection: {
        ...project.osm.selection,
        bounds: {
          south: latitude - latitudeSpan / 2,
          west: longitude - longitudeSpan / 2,
          north: latitude + latitudeSpan / 2,
          east: longitude + longitudeSpan / 2,
        },
      },
      snapshot: null,
    });
  };

  useEffect(() => {
    if (!mapHost.current || typeof WebGLRenderingContext === "undefined") return;
    let disposed = false;
    let map: MapLibreMap | undefined;
    void import("maplibre-gl").then(({ Map, NavigationControl }) => {
      if (disposed || !mapHost.current) return;
      const selected = initialBounds.current;
      map = new Map({
        container: mapHost.current,
        bounds: [
          [selected.west, selected.south],
          [selected.east, selected.north],
        ],
        fitBoundsOptions: { padding: 18 },
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
    });
    return () => {
      disposed = true;
      mapInstance.current = null;
      map?.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 18, duration: 0 },
    );
  }, [bounds.east, bounds.north, bounds.south, bounds.west]);

  const useVisibleMapArea = () => {
    const map = mapInstance.current;
    const host = mapHost.current;
    if (!map || !host) return;
    const pageAspect = project.page.width_mm / project.page.height_mm;
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
    updateOsm({
      selection: {
        ...project.osm.selection,
        bounds: {
          south: southeast.lat,
          west: northwest.lng,
          north: northwest.lat,
          east: southeast.lng,
        },
      },
      snapshot: null,
    });
  };

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
                  updateOsm({
                    selection: {
                      ...project.osm.selection,
                      bounds: {
                        south: place.latitude - latitudeSpan / 2,
                        west: place.longitude - longitudeSpan / 2,
                        north: place.latitude + latitudeSpan / 2,
                        east: place.longitude + longitudeSpan / 2,
                      },
                    },
                    snapshot: null,
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
        <div className="map-selector">
          <div ref={mapHost} className="maplibre-host" aria-label="Interactive map selector" />
          <div
            className="page-ratio-overlay"
            style={{ aspectRatio: `${project.page.width_mm} / ${project.page.height_mm}` }}
            aria-hidden="true"
          />
          <span>Page selection overlay</span>
        </div>
        <small className="map-attribution">
          Basemap ©{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>
        </small>
        <div className="field-row">
          <label>
            Latitude
            <input
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
            <input
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
            <input
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
          Approximate request area: <strong>{areaKm2.toFixed(2)} km²</strong> / 25 km²
          {areaKm2 > 25 && " — zoom in, then use the page overlay"}
        </p>
        <div className="action-row map-actions">
          <button type="button" disabled={busy} onClick={useVisibleMapArea}>
            Use page overlay extent
          </button>
          <button type="button" disabled={busy || areaKm2 > 25} onClick={onFetch}>
            {busy ? "Downloading map data…" : "Download and freeze map data"}
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
            <input
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
            <input
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
            <input
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
        {project.osm.snapshot ? (
          <>
            <strong>Frozen snapshot ready</strong>
            <span>{project.osm.snapshot.element_count.toLocaleString()} elements</span>
            <code>{project.osm.snapshot.sha256.slice(0, 16)}</code>
            <small>
              {project.osm.snapshot.attribution} · {project.osm.snapshot.source_date}
            </small>
            {lastFetchUsedCache !== null && (
              <em>{lastFetchUsedCache ? "Reused cached query" : "Downloaded new snapshot"}</em>
            )}
          </>
        ) : (
          <>
            <strong>No frozen snapshot</strong>
            <small>Fetching is explicit; changing render rules never redownloads map data.</small>
          </>
        )}
      </section>
      <button
        className="primary-button full"
        type="button"
        disabled={busy || !project.osm.snapshot}
        onClick={onGenerate}
      >
        {busy ? "Generating map…" : "Generate map and plan"}
      </button>
    </>
  );
}
