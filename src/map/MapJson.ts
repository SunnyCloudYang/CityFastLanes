import type { TurnType } from './Lane';
import type { SignalPhase } from './Signals';
import type { Bounds, DecorType, MapDecor, MapDef, MapNode, MapRoad } from './types';
import type { Vec2 } from '../core/math';

const MAP_KEYS = ['version', 'id', 'name', 'seed', 'nodes', 'roads', 'decor', 'bounds'];
const NODE_KEYS = ['id', 'x', 'y', 'signalPhases'];
const ROAD_KEYS = ['id', 'from', 'to', 'speedLimit', 'lanes', 'bridge', 'control', 'oneWay'];
const VEC_KEYS = ['x', 'y'];
const DECOR_KEYS = ['type', 'polygon', 'height'];
const BOUNDS_KEYS = ['minX', 'minY', 'maxX', 'maxY'];
const PHASE_KEYS = ['groups', 'turns', 'green', 'yellow', 'allRed'];
const DECOR_TYPES = new Set(['block', 'building', 'park', 'water']);
const TURN_TYPES = new Set(['straight', 'left', 'right', 'uturn']);

/** Validates and serializes a map using stable, human-readable two-space JSON. */
export function serializeMap(def: MapDef): string {
  return JSON.stringify(normalizeMap(def), null, 2);
}

/** Parses version 1 maps and legacy maps without a version field. */
export function parseMap(json: string): MapDef {
  if (typeof json !== 'string') throw new Error('Map JSON must be a string');
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid map JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeMap(value);
}

function normalizeMap(value: unknown): MapDef {
  const source = record(value, 'Map', MAP_KEYS);
  if (source.version !== undefined && source.version !== 1) throw new Error('Map.version must be 1 when provided');
  const def: MapDef = {
    id: text(source.id, 'Map.id'),
    name: text(source.name, 'Map.name'),
    seed: finite(source.seed, 'Map.seed'),
    nodes: list(source.nodes, 'Map.nodes').map((node, i) => mapNode(node, i)),
    roads: [],
    decor: list(source.decor, 'Map.decor').map((item, i) => mapDecor(item, i)),
    bounds: mapBounds(source.bounds),
  };
  if (source.version !== undefined) def.version = 1;

  const nodeIds = new Set<number>();
  for (const node of def.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Map.nodes contains duplicate id ${node.id}`);
    nodeIds.add(node.id);
  }
  const roadIds = new Set<number>();
  const roads = list(source.roads, 'Map.roads');
  for (let i = 0; i < roads.length; i++) {
    const road = mapRoad(roads[i], i, nodeIds);
    if (roadIds.has(road.id)) throw new Error(`Map.roads contains duplicate id ${road.id}`);
    roadIds.add(road.id);
    def.roads.push(road);
  }
  return def;
}

function mapNode(value: unknown, index: number): MapNode {
  const path = `Map.nodes[${index}]`;
  const source = record(value, path, NODE_KEYS);
  const node: MapNode = {
    id: identifier(source.id, `${path}.id`),
    x: finite(source.x, `${path}.x`),
    y: finite(source.y, `${path}.y`),
  };
  if (source.signalPhases !== undefined) {
    const phases = list(source.signalPhases, `${path}.signalPhases`);
    if (phases.length === 0) throw new Error(`${path}.signalPhases must not be empty`);
    node.signalPhases = phases.map((phase, i) => signalPhase(phase, `${path}.signalPhases[${i}]`));
  }
  return node;
}

function signalPhase(value: unknown, path: string): SignalPhase {
  const source = record(value, path, PHASE_KEYS);
  const phase: SignalPhase = {
    groups: list(source.groups, `${path}.groups`).map((group, i) => {
      const n = finite(group, `${path}.groups[${i}]`);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${path}.groups[${i}] must be a non-negative integer`);
      return n;
    }),
  };
  if (source.turns !== undefined) {
    phase.turns = list(source.turns, `${path}.turns`).map((turn, i) => {
      if (typeof turn !== 'string' || !TURN_TYPES.has(turn)) {
        throw new Error(`${path}.turns[${i}] has an unknown turn type`);
      }
      return turn as TurnType;
    });
  }
  if (source.green !== undefined) phase.green = positive(source.green, `${path}.green`);
  if (source.yellow !== undefined) phase.yellow = nonNegative(source.yellow, `${path}.yellow`);
  if (source.allRed !== undefined) phase.allRed = nonNegative(source.allRed, `${path}.allRed`);
  return phase;
}

function mapRoad(value: unknown, index: number, nodeIds: Set<number>): MapRoad {
  const path = `Map.roads[${index}]`;
  const source = record(value, path, ROAD_KEYS);
  const from = identifier(source.from, `${path}.from`);
  const to = identifier(source.to, `${path}.to`);
  if (!nodeIds.has(from)) throw new Error(`${path}.from references missing node ${from}`);
  if (!nodeIds.has(to)) throw new Error(`${path}.to references missing node ${to}`);
  if (from === to) throw new Error(`${path} must connect two different nodes`);
  const road: MapRoad = {
    id: identifier(source.id, `${path}.id`),
    from,
    to,
    speedLimit: positive(source.speedLimit, `${path}.speedLimit`),
  };
  if (source.lanes !== undefined) {
    const lanes = finite(source.lanes, `${path}.lanes`);
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 4) {
      throw new Error(`${path}.lanes must be an integer in 1..4`);
    }
    road.lanes = lanes;
  }
  if (source.bridge !== undefined) road.bridge = boolean(source.bridge, `${path}.bridge`);
  if (source.oneWay !== undefined) road.oneWay = boolean(source.oneWay, `${path}.oneWay`);
  if (source.control !== undefined) road.control = vec(source.control, `${path}.control`);
  return road;
}

function mapDecor(value: unknown, index: number): MapDecor {
  const path = `Map.decor[${index}]`;
  const source = record(value, path, DECOR_KEYS);
  const type = text(source.type, `${path}.type`);
  if (!DECOR_TYPES.has(type)) throw new Error(`${path}.type has an unknown decor type`);
  const polygon = list(source.polygon, `${path}.polygon`).map((point, i) => vec(point, `${path}.polygon[${i}]`));
  if (polygon.length < 3) throw new Error(`${path}.polygon must contain at least three points`);
  const decor: MapDecor = { type: type as DecorType, polygon };
  if (source.height !== undefined) decor.height = nonNegative(source.height, `${path}.height`);
  return decor;
}

function mapBounds(value: unknown): Bounds {
  const source = record(value, 'Map.bounds', BOUNDS_KEYS);
  const bounds: Bounds = {
    minX: finite(source.minX, 'Map.bounds.minX'),
    minY: finite(source.minY, 'Map.bounds.minY'),
    maxX: finite(source.maxX, 'Map.bounds.maxX'),
    maxY: finite(source.maxY, 'Map.bounds.maxY'),
  };
  if (bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) {
    throw new Error('Map.bounds must have positive width and height');
  }
  return bounds;
}

function vec(value: unknown, path: string): Vec2 {
  const source = record(value, path, VEC_KEYS);
  return { x: finite(source.x, `${path}.x`), y: finite(source.y, `${path}.y`) };
}

function record(value: unknown, path: string, allowedKeys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const source = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`${path} contains unsupported field ${key}`);
  }
  return source;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function identifier(value: unknown, path: string): number {
  const id = finite(value, path);
  if (!Number.isSafeInteger(id)) throw new Error(`${path} must be a safe integer`);
  return id;
}

function positive(value: unknown, path: string): number {
  const n = finite(value, path);
  if (n <= 0) throw new Error(`${path} must be greater than zero`);
  return n;
}

function nonNegative(value: unknown, path: string): number {
  const n = finite(value, path);
  if (n < 0) throw new Error(`${path} must not be negative`);
  return n;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}
