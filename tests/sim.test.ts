import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../src/core/math';
import { findRoute } from '../src/map/Pathfinding';
import { MAPS } from '../src/map/maps';
import { RoadNetwork } from '../src/map/RoadNetwork';
import { idm } from '../src/sim/ai/IDM';
import { satMTV } from '../src/sim/Collision';
import type { Vehicle } from '../src/sim/Vehicle';
import { World } from '../src/sim/World';

const P = { a: 1.5, b: 2, T: 1.3, s0: 2 };

describe('IDM', () => {
  it('accelerates on a free road and brakes near an obstacle', () => {
    expect(idm(0, 14, Infinity, 0, P)).toBeCloseTo(1.5);
    expect(idm(14, 14, Infinity, 0, P)).toBeCloseTo(0);
    expect(idm(10, 14, 5, 10, P)).toBeLessThan(-2);
  });
});

function motorOverlaps(w: World): number {
  const motors = w.vehicles.filter((v) => !v.isBike);
  let n = 0;
  for (let i = 0; i < motors.length; i++) {
    for (let j = i + 1; j < motors.length; j++) {
      const a: Vehicle = motors[i];
      const b: Vehicle = motors[j];
      if (Math.abs(a.pos.x - b.pos.x) > 8 || Math.abs(a.pos.y - b.pos.y) > 8) continue;
      const mtv = satMTV(a.corners(), b.corners());
      if (mtv && Math.hypot(mtv.x, mtv.y) > 0.3) n++;
    }
  }
  return n;
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
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

function sidewalkEntries(w: World): number {
  const blocks = w.def.decor.filter((item) => item.type === 'block');
  let count = 0;
  for (const vehicle of w.vehicles) {
    if (vehicle.controller !== 'ai' || vehicle.lane?.kind !== 'road') continue;
    if (blocks.some((block) => pointInPolygon(vehicle.pos, block.polygon))) count++;
  }
  return count;
}

function mixedOverlaps(w: World): number {
  let n = 0;
  const vehicles = w.vehicles;
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const a = vehicles[i];
      const b = vehicles[j];
      if (a.isBike === b.isBike) continue;
      if (Math.abs(a.pos.x - b.pos.x) > 8 || Math.abs(a.pos.y - b.pos.y) > 8) continue;
      const mtv = satMTV(a.corners(), b.corners());
      if (mtv && Math.hypot(mtv.x, mtv.y) > 0.3) n++;
    }
  }
  return n;
}

describe('M2 traffic rules', () => {
  it('builds parallel lanes, class-specific connectors and protected phases', () => {
    const net = new RoadNetwork(MAPS[0].build());
    expect(net.roadLanes.some((lane) => lane.laneCount === 2 && lane.right !== null)).toBe(true);
    expect(net.connectors.some((lane) => lane.traffic === 'bike')).toBe(true);
    expect(net.connectors.some((lane) => lane.traffic === 'motor')).toBe(true);
    expect(net.signals.some((signal) => signal.phases.length === 4)).toBe(true);
  });

  it('uses MOBIL to overtake with smooth lane transitions', () => {
    const w = new World(MAPS[0].build(), 50, 10);
    for (let i = 0; i < 60 * 60; i++) w.step(1 / 60);
    expect(w.vehicles.reduce((sum, v) => sum + v.laneChanges, 0)).toBeGreaterThan(0);
  });
});

describe.each(MAPS)('map $id', (entry) => {
  it('every road lane can reach every other', () => {
    const net = new RoadNetwork(entry.build());
    const lanes = net.roadLanes;
    for (let i = 0; i < 40; i++) {
      const a = lanes[(i * 7) % lanes.length];
      const b = lanes[(i * 13 + 5) % lanes.length];
      if (a !== b) expect(findRoute(a, b)).not.toBeNull();
    }
  });

  it('traffic keeps flowing without motor vehicles overlapping', () => {
    const w = new World(entry.build(), 70, 20);
    expect(w.count(false)).toBeGreaterThanOrEqual(60);
    let overlaps = 0;
    let crossClassOverlaps = 0;
    let sidewalkCount = 0;
    let speedSum = 0;
    let samples = 0;
    for (let i = 0; i < 60 * 120; i++) {
      w.step(1 / 60);
      if (i % 30 === 0) {
        overlaps += motorOverlaps(w);
        crossClassOverlaps += mixedOverlaps(w);
        sidewalkCount += sidewalkEntries(w);
      }
      if (i > 60 * 60 && i % 60 === 0) {
        for (const v of w.vehicles) speedSum += v.speed;
        samples += w.vehicles.length;
      }
    }
    const meanSpeed = speedSum / samples;
    const maxStuck = Math.max(...w.vehicles.map((v) => v.stuckTime));
    console.log(
      `${entry.id}: vehicles=${w.vehicles.length} meanSpeed=${meanSpeed.toFixed(2)} overlaps=${overlaps} mixed=${crossClassOverlaps} sidewalk=${sidewalkCount} maxStuck=${maxStuck.toFixed(1)}`,
    );
    expect(meanSpeed).toBeGreaterThan(2);
    expect(overlaps).toBeLessThan(5);
    expect(crossClassOverlaps).toBeLessThan(20);
    expect(sidewalkCount).toBe(0);
    expect(maxStuck).toBeLessThan(90);
  });

  it('a released player vehicle rejoins traffic', () => {
    const w = new World(entry.build(), 30, 5);
    const v = w.vehicles[0];
    w.takeControl(v);
    v.input.throttle = 1;
    v.input.steer = 0.4;
    for (let i = 0; i < 120; i++) w.step(1 / 60);
    w.releaseControl(v);
    for (let i = 0; i < 60 * 20; i++) w.step(1 / 60);
    expect(v.controller).toBe('ai');
    expect(v.lane).not.toBeNull();
  });
});
