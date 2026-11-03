import { angleOf, type Vec2 } from '../src/core/math';
import type { Lane } from '../src/map/Lane';
import type { MapDef } from '../src/map/types';
import { Vehicle } from '../src/sim/Vehicle';
import type { World } from '../src/sim/World';

/** Even-odd point-in-polygon test for sidewalk and block-clearance assertions. */
export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Small-map factory; overrides replace the defaults wholesale. */
export function makeMap(overrides: Pick<MapDef, 'nodes' | 'roads'> & Partial<MapDef>): MapDef {
  return {
    id: 'test-map',
    name: 'Test map',
    seed: 5,
    decor: [],
    bounds: { minX: -110, minY: -110, maxX: 110, maxY: 110 },
    ...overrides,
  };
}

export interface TestVehicleOptions {
  s: number;
  speed?: number;
  /** 1 aligns with the lane tangent, -1 reverses it for wrong-way tests. */
  direction?: 1 | -1;
  /** Track the lane so AI-side logic can act on the vehicle. */
  trackLane?: boolean;
}

export function addVehicle(world: World, lane: Lane, options: TestVehicleOptions): Vehicle {
  const direction = options.direction ?? 1;
  const { p, t } = lane.pointAt(options.s);
  const vehicle = new Vehicle('car', { ...p }, angleOf(t) + (direction < 0 ? Math.PI : 0), 0xffffff, 1);
  vehicle.speed = options.speed ?? 5;
  if (options.trackLane) {
    vehicle.lane = lane;
    vehicle.s = options.s;
  }
  world.vehicles.push(vehicle);
  if (options.trackLane) world.targetMotor = Math.max(world.targetMotor, world.count(false));
  return vehicle;
}
