import type { Vec2 } from '../core/math';
import type { SignalPhase } from './Signals';

export interface MapNode {
  id: number;
  x: number;
  y: number;
  /** Optional fixed-time phases; omitted nodes use two-phase control. */
  signalPhases?: SignalPhase[];
}

/** A road with a configurable number of lanes in each direction. */
export interface MapRoad {
  id: number;
  from: number;
  to: number;
  speedLimit: number;
  /** Number of lanes per direction (total lanes for a one-way road). Defaults to one. */
  lanes?: number;
  bridge?: boolean;
  /** Optional quadratic Bézier control point. */
  control?: Vec2;
  /** When true, only lanes from `from` to `to` are generated. */
  oneWay?: boolean;
}

export type DecorType = 'block' | 'building' | 'park' | 'water';

export interface MapDecor {
  type: DecorType;
  polygon: Vec2[];
  height?: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MapDef {
  /** JSON format version. Omitted by legacy maps, otherwise must be 1. */
  version?: 1;
  id: string;
  name: string;
  seed: number;
  nodes: MapNode[];
  roads: MapRoad[];
  decor: MapDecor[];
  bounds: Bounds;
}
