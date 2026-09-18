export type FluidNCSettings = {
  name: string;
  websocketUrl: string;
};

export type FluidNCPosition = {
  x: number;
  y: number;
  z: number;
};

export type FluidNCStatus = {
  state: string;
  machinePosition?: FluidNCPosition;
  workPosition?: FluidNCPosition;
};

const SETTINGS_KEY = 'plotbox.fluidnc';

export function loadFluidNCSettings(): FluidNCSettings | undefined {
  try {
    const value = window.localStorage.getItem(SETTINGS_KEY);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<FluidNCSettings>;
    if (typeof parsed.websocketUrl !== 'string' || !parsed.websocketUrl) return undefined;
    return {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : 'FluidNC',
      // FluidNC v4 serves its plain WebSocket endpoint from the HTTP server on port 80.
      // Normalizing here also migrates instances saved by earlier Plotbox versions as wss://.
      websocketUrl: normalizeFluidNCUrl(parsed.websocketUrl),
    };
  } catch {
    return undefined;
  }
}

export function saveFluidNCSettings(settings: FluidNCSettings): void {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function normalizeFluidNCUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let url = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
  url = url.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('Enter a FluidNC hostname or IP address.');
  // FluidNC serves its WebSocket at the root path. Plotbox previously forced
  // /ws and port 80, so normalising also repairs those saved settings while
  // preserving a controller's explicitly configured HTTP port.
  return `${parsed.protocol}//${parsed.host}/`;
}

export function fluidNCWebSocketCandidates(value: string): string[] {
  const primary = normalizeFluidNCUrl(value);
  if (!primary) return [];
  const parsed = new URL(primary);
  const candidates = [primary];
  // FluidNC 3.x commonly used a separate WebSocket server on port 81.
  if (parsed.protocol === 'ws:' && (!parsed.port || parsed.port === '80')) candidates.push(`ws://${parsed.hostname}:81/`);
  return [...new Set(candidates)];
}

export function fluidNCHttpUrl(value: string): string {
  const parsed = new URL(normalizeFluidNCUrl(value));
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  // Port 81 is the legacy WebSocket port; HTTP remains on port 80.
  if (parsed.port === '81') parsed.port = '80';
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function parsePosition(value?: string): FluidNCPosition | undefined {
  if (!value) return undefined;
  const coordinates = value.split(',').map(Number);
  if (coordinates.length < 3 || coordinates.some((coordinate) => !Number.isFinite(coordinate))) return undefined;
  return { x: coordinates[0]!, y: coordinates[1]!, z: coordinates[2]! };
}

export function parseFluidNCStatus(line: string): FluidNCStatus | undefined {
  // A WebSocket frame can contain acknowledgements or WebUI metadata around a
  // regular Grbl status report, so extract the report rather than requiring it
  // to be the complete message.
  const match = line.match(/<([^>]+)>/);
  if (!match) return undefined;
  const fields = match[1]!.split('|');
  const values = new Map(fields.slice(1).map((field) => {
    const separator = field.indexOf(':');
    return separator < 0 ? [field.toLowerCase(), ''] : [field.slice(0, separator).toLowerCase(), field.slice(separator + 1)];
  }));
  const machinePosition = parsePosition(values.get('mpos'));
  const workPosition = parsePosition(values.get('wpos'));
  const offset = parsePosition(values.get('wco'));
  const status: FluidNCStatus = { state: fields[0]!.split(':')[0]! };
  if (machinePosition) status.machinePosition = machinePosition;
  if (workPosition) status.workPosition = workPosition;
  else if (machinePosition && offset) status.workPosition = {
      x: machinePosition.x - offset.x,
      y: machinePosition.y - offset.y,
      z: machinePosition.z - offset.z,
    };
  return status;
}
