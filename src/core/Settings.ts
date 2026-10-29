import type { SketchStyle } from '../render/sketch/SketchRenderer';

export interface Settings {
  mapId: string;
  cars: number;
  bikes: number;
  style: SketchStyle;
  night: number;
  sketch: boolean;
}

const KEY = 'city-fast-lanes.settings.v1';
const STYLES: SketchStyle[] = ['pencil', 'pen', 'blueprint', 'charcoal'];

export function loadSettings(storage?: Storage): Settings {
  const fallback: Settings = { mapId: 'downtown', cars: 70, bikes: 20, style: 'pencil', night: 0, sketch: true };
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    const value: unknown = target ? JSON.parse(target.getItem(KEY) ?? '{}') : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const data = value as Record<string, unknown>;
    const urlMap = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('map');
    return {
      mapId: urlMap || stringValue(data.mapId, fallback.mapId),
      cars: numberValue(data.cars, 0, 160, fallback.cars),
      bikes: numberValue(data.bikes, 0, 80, fallback.bikes),
      style: STYLES.includes(data.style as SketchStyle) ? (data.style as SketchStyle) : fallback.style,
      night: numberValue(data.night, 0, 1, fallback.night),
      sketch: typeof data.sketch === 'boolean' ? data.sketch : fallback.sketch,
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: Settings, storage?: Storage): void {
  try {
    (storage ?? localStorage).setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing/quota errors must never interrupt the simulation.
  }
}

function numberValue(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}
