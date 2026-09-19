import { useMemo, useRef, useState } from 'react';
import { LockKeyhole, Minus, Plus } from 'lucide-react';

const TILE_SIZE = 256;
const MAP_WIDTH = 260;
const MAP_HEIGHT = 180;

export type MapView = { latitude: number; longitude: number; zoom: number };
export type MapBounds = { north: number; south: number; east: number; west: number };

function clampLatitude(latitude: number) { return Math.max(-85, Math.min(85, latitude)); }
function wrapLongitude(longitude: number) { return ((longitude + 180) % 360 + 360) % 360 - 180; }

function toWorld(latitude: number, longitude: number, zoom: number) {
  const size = TILE_SIZE * 2 ** zoom;
  const sine = Math.sin(clampLatitude(latitude) * Math.PI / 180);
  return {
    x: (longitude + 180) / 360 * size,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size,
  };
}

function fromWorld(x: number, y: number, zoom: number) {
  const size = TILE_SIZE * 2 ** zoom;
  const longitude = wrapLongitude(x / size * 360 - 180);
  const n = Math.PI - 2 * Math.PI * y / size;
  return { latitude: clampLatitude(180 / Math.PI * Math.atan(Math.sinh(n))), longitude };
}

function selectionSize(aspect: number) {
  const maxWidth = MAP_WIDTH - 42;
  const maxHeight = MAP_HEIGHT - 42;
  return aspect > maxWidth / maxHeight
    ? { width: maxWidth, height: maxWidth / aspect }
    : { width: maxHeight * aspect, height: maxHeight };
}

export function boundsForView(view: MapView, aspect: number): MapBounds {
  const centre = toWorld(view.latitude, view.longitude, view.zoom);
  const selection = selectionSize(aspect);
  const topLeft = fromWorld(centre.x - selection.width / 2, centre.y - selection.height / 2, view.zoom);
  const bottomRight = fromWorld(centre.x + selection.width / 2, centre.y + selection.height / 2, view.zoom);
  return { north: topLeft.latitude, south: bottomRight.latitude, west: topLeft.longitude, east: bottomRight.longitude };
}

export function dimensionsForBounds(bounds: MapBounds) {
  const latitudeKm = (bounds.north - bounds.south) * 111.32;
  const centreLatitude = (bounds.north + bounds.south) / 2 * Math.PI / 180;
  const longitudeKm = (bounds.east - bounds.west) * 111.32 * Math.cos(centreLatitude);
  return { widthKm: longitudeKm, heightKm: latitudeKm, areaKm2: longitudeKm * latitudeKm };
}

export function MapRegionPicker({ view, aspect, busy, hasImport, onChange, onDownload }: {
  view: MapView;
  aspect: number;
  busy: boolean;
  hasImport: boolean;
  onChange: (view: MapView) => void;
  onDownload: (bounds: MapBounds) => void;
}) {
  const drag = useRef<{ x: number; y: number; worldX: number; worldY: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const centre = toWorld(view.latitude, view.longitude, view.zoom);
  const selection = selectionSize(aspect);
  const selectedBounds = boundsForView(view, aspect);
  const dimensions = dimensionsForBounds(selectedBounds);
  const tiles = useMemo(() => {
    const firstX = Math.floor((centre.x - MAP_WIDTH / 2) / TILE_SIZE);
    const lastX = Math.floor((centre.x + MAP_WIDTH / 2) / TILE_SIZE);
    const firstY = Math.floor((centre.y - MAP_HEIGHT / 2) / TILE_SIZE);
    const lastY = Math.floor((centre.y + MAP_HEIGHT / 2) / TILE_SIZE);
    const count = 2 ** view.zoom;
    const result: Array<{ key: string; url: string; left: number; top: number }> = [];
    for (let y = firstY; y <= lastY; y += 1) for (let x = firstX; x <= lastX; x += 1) {
      if (y < 0 || y >= count) continue;
      const wrappedX = ((x % count) + count) % count;
      result.push({ key: `${view.zoom}-${x}-${y}`, url: `https://tile.openstreetmap.org/${view.zoom}/${wrappedX}/${y}.png`, left: x * TILE_SIZE - centre.x + MAP_WIDTH / 2, top: y * TILE_SIZE - centre.y + MAP_HEIGHT / 2 });
    }
    return result;
  }, [centre.x, centre.y, view.zoom]);

  const zoomBy = (amount: number) => onChange({ ...view, zoom: Math.max(10, Math.min(18, view.zoom + amount)) });
  return <div className="map-picker-shell">
    <div className={`map-picker ${dragging ? 'dragging' : ''}`} role="application" aria-label="Map region picker"
      onWheel={(event) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1 : -1); }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, worldX: centre.x, worldY: centre.y }; setDragging(true); }}
      onPointerMove={(event) => { if (!drag.current) return; const next = fromWorld(drag.current.worldX - (event.clientX - drag.current.x), drag.current.worldY - (event.clientY - drag.current.y), view.zoom); onChange({ ...view, ...next }); }}
      onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); drag.current = undefined; setDragging(false); }}
      onPointerCancel={() => { drag.current = undefined; setDragging(false); }}>
      {tiles.map((tile) => <img key={tile.key} src={tile.url} alt="" draggable={false} style={{ left: tile.left, top: tile.top }} />)}
      <div className="map-shade" />
      <div className="map-selection" style={{ width: selection.width, height: selection.height }}><span /></div>
      <div className="map-zoom" onPointerDown={(event) => event.stopPropagation()}><button type="button" title="Zoom in" disabled={view.zoom >= 18} onClick={() => zoomBy(1)}><Plus /></button><button type="button" title="Zoom out" disabled={view.zoom <= 10} onClick={() => zoomBy(-1)}><Minus /></button></div>
      <span className="map-level">z{view.zoom}</span>
    </div>
    <div className="map-picker-meta"><span>Drag to position · scroll to zoom</span><span>{dimensions.widthKm.toFixed(dimensions.widthKm < 10 ? 1 : 0)} × {dimensions.heightKm.toFixed(dimensions.heightKm < 10 ? 1 : 0)} km · {(dimensions.areaKm2 / 2.58999).toFixed(dimensions.areaKm2 < 100 ? 1 : 0)} mi²</span></div>
    <button type="button" className="button primary full map-lock" disabled={busy} onClick={() => onDownload(selectedBounds)}><LockKeyhole size={15} /> {busy ? 'Downloading map…' : hasImport ? 'Reset & download region' : 'Lock & download region'}</button>
  </div>;
}
