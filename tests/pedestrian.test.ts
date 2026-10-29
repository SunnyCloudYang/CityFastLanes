import { describe, expect, it } from 'vitest';
import { angleOf, distance } from '../src/core/math';
import type { Lane } from '../src/map/Lane';
import type { MapDef } from '../src/map/types';
import { Pedestrian } from '../src/sim/Pedestrian';
import { PEDESTRIAN_SNAPSHOT_STRIDE } from '../src/sim/protocol';
import { Vehicle } from '../src/sim/Vehicle';
import { World } from '../src/sim/World';

function twoNodeMap(): MapDef {
  return {
    id: 'pedestrian-test',
    name: 'Pedestrian test',
    seed: 11,
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 100, y: 0 },
    ],
    roads: [{ id: 7, from: 0, to: 1, speedLimit: 14 }],
    decor: [],
    bounds: { minX: -20, minY: -20, maxX: 120, maxY: 20 },
  };
}

function approach(world: World): Lane {
  const lane = world.net.roadLanes.find(
    (candidate) => candidate.nodeId === 1 && candidate.start.x < candidate.end.x,
  );
  if (!lane) throw new Error('Missing test approach');
  return lane;
}

function addVehicle(world: World, lane: Lane, frontDistance: number, speed: number): Vehicle {
  const s = lane.length - frontDistance - 2.15;
  const { p, t } = lane.pointAt(s);
  const vehicle = new Vehicle('car', { ...p }, angleOf(t), 0xffffff, 1);
  vehicle.lane = lane;
  vehicle.s = s;
  vehicle.speed = speed;
  world.vehicles.push(vehicle);
  world.targetMotor = Math.max(world.targetMotor, world.count(false));
  return vehicle;
}

function addCrossing(world: World, state: 'waiting' | 'crossing'): Pedestrian {
  const path = [
    { x: 91, y: -5.5 },
    { x: 91, y: 5.5 },
  ];
  const pedestrian = new Pedestrian(100, path, 1.4, 0);
  pedestrian.state = state;
  pedestrian.crossingNodeId = 1;
  pedestrian.crossingRoadId = 7;
  world.pedestrians.length = 0;
  world.pedestrians.push(pedestrian);
  return pedestrian;
}

describe('M3 pedestrians', () => {
  it('creates the default population as pure simulation data with valid walking speeds', () => {
    const world = new World(twoNodeMap(), 0, 0);
    expect(world.pedestrians).toHaveLength(Math.min(60, world.net.nodes.size * 2));
    expect(new Set(world.pedestrians.map((pedestrian) => pedestrian.id)).size).toBe(world.pedestrians.length);
    for (const pedestrian of world.pedestrians) {
      expect(pedestrian.speed).toBeGreaterThanOrEqual(1.2);
      expect(pedestrian.speed).toBeLessThanOrEqual(1.6);
      expect(pedestrian.path.length).toBeGreaterThanOrEqual(2);
      expect(pedestrian.pathIndex).toBe(1);
      expect(pedestrian.prevPos).toEqual(pedestrian.pos);
    }
    expect(PEDESTRIAN_SNAPSHOT_STRIDE).toBe(5);
  });

  it('moves along road-side sidewalks rather than in the carriageway', () => {
    const world = new World(twoNodeMap(), 0, 0);
    const pedestrian = [...world.pedestrians].sort(
      (a, b) => Math.min(b.pos.x, 100 - b.pos.x) - Math.min(a.pos.x, 100 - a.pos.x),
    )[0];
    const start = { ...pedestrian.pos };
    const sidewalkY = pedestrian.pos.y;
    expect(Math.abs(sidewalkY)).toBeCloseTo(5.5, 8);
    for (const point of pedestrian.path) expect(point.y).toBeCloseTo(sidewalkY, 8);

    for (let i = 0; i < 30; i++) world.step(1 / 60);
    expect(distance(start, pedestrian.pos)).toBeGreaterThan(0.5);
    expect(pedestrian.pos.y).toBeCloseTo(sidewalkY, 8);
    expect(distance(pedestrian.prevPos, pedestrian.pos)).toBeGreaterThan(0);
  });

  it('waits for an approaching vehicle before committing to a crosswalk', () => {
    const world = new World(twoNodeMap(), 0, 0);
    const pedestrian = addCrossing(world, 'waiting');
    addVehicle(world, approach(world), 5, 8);
    world.step(1 / 60);
    expect(pedestrian.state).toBe('waiting');
    expect(pedestrian.crossingProgress).toBe(0);
    expect(pedestrian.pos).toEqual({ x: 91, y: -5.5 });
  });

  it('makes an approaching vehicle brake and stop before an active crossing', () => {
    const world = new World(twoNodeMap(), 0, 0);
    const pedestrian = addCrossing(world, 'crossing');
    const lane = approach(world);
    const vehicle = addVehicle(world, lane, 25, 10);

    for (let i = 0; i < 360; i++) world.step(1 / 60);
    expect(pedestrian.state).toBe('crossing');
    expect(pedestrian.crossingProgress).toBeGreaterThan(0.3);
    expect(vehicle.speed).toBeLessThan(1);
    expect(lane.length - vehicle.s - vehicle.spec.length / 2).toBeGreaterThan(0.5);
  });
});
