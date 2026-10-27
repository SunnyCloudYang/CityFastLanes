import type { Vec2 } from '../core/math';

export interface MapNode {
  id: number;
  x: number;
  y: number;
}

/** A two-way road with one lane in each direction. */
export interface MapRoad {
  id: number;
  from: number;
  to: number;
  speedLimit: number;
  bridge?: boolean;
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
  id: string;
  name: string;
  seed: number;
  nodes: MapNode[];
  roads: MapRoad[];
  decor: MapDecor[];
  bounds: Bounds;
}
