import { Random } from '../../core/Random';
import { insetPolygon, type Vec2 } from '../../core/math';
import { INTERSECTION_RADIUS, LANE_WIDTH, SIDEWALK_WIDTH } from '../constants';
import type { MapDecor, MapDef, MapNode, MapRoad } from '../types';
import { boundsForPoints, decorateBlocks } from './decor';

export interface RingOptions {
  id: string;
  name: string;
  seed: number;
  /** Number of ring junctions; the same number of two-way entrances is added. */
  segments?: number;
  radius?: number;
  entranceLength?: number;
  speedLimit?: number;
  ringSpeedLimit?: number;
  parkChance?: number;
}

export function generateRing(options: RingOptions): MapDef {
  const segments = options.segments ?? 18;
  const radius = options.radius ?? 144;
  const entranceLength = options.entranceLength ?? 64;
  if (!Number.isInteger(segments) || segments < 12 || segments > 24) {
    throw new Error('Ring segments must be an integer in 12..24');
  }
  if (!Number.isFinite(radius) || radius < 70 || !Number.isFinite(entranceLength) || entranceLength < 40) {
    throw new Error('Ring radius and entranceLength are too small or non-finite');
  }
  const speedLimit = options.speedLimit ?? 13.9;
  const ringSpeedLimit = options.ringSpeedLimit ?? 12;
  const angle = (i: number) => -Math.PI / 2 + (i * Math.PI * 2) / segments;
  const point = (r: number, i: number): Vec2 => ({ x: Math.cos(angle(i)) * r, y: Math.sin(angle(i)) * r });
  const ringId = (i: number) => (i + segments) % segments;
  const entranceId = (i: number) => segments + ringId(i);

  const nodes: MapNode[] = [];
  for (let i = 0; i < segments; i++) {
    nodes.push({
      id: ringId(i),
      ...point(radius, i),
      // Ring traffic gets a long progressive window; entering traffic uses a short phase.
      signalPhases: [
        { groups: [0], green: 30 },
        { groups: [1], green: 6 },
      ],
    });
  }
  for (let i = 0; i < segments; i++) nodes.push({ id: entranceId(i), ...point(radius + entranceLength, i) });

  const roads: MapRoad[] = [];
  const halfAngle = Math.PI / segments;
  const controlRadius = radius * (2 - Math.cos(halfAngle));
  for (let i = 0; i < segments; i++) {
    const midAngle = angle(i) + halfAngle;
    roads.push({
      id: roads.length,
      from: ringId(i),
      to: ringId(i + 1),
      speedLimit: ringSpeedLimit,
      lanes: 2,
      oneWay: true,
      control: { x: Math.cos(midAngle) * controlRadius, y: Math.sin(midAngle) * controlRadius },
    });
  }
  // Every entrance is bidirectional: ring traffic can exit and entering traffic can rejoin later.
  for (let i = 0; i < segments; i++) {
    roads.push({ id: roads.length, from: ringId(i), to: entranceId(i), speedLimit });
  }

  const centre = insetPolygon(
    Array.from({ length: segments }, (_, i) => point(radius, i)),
    INTERSECTION_RADIUS + SIDEWALK_WIDTH + LANE_WIDTH,
  );
  const blocks: Vec2[][] = [];
  for (let i = 0; i < segments; i++) {
    blocks.push([
      nodes[ringId(i)],
      nodes[entranceId(i)],
      nodes[entranceId(i + 1)],
      nodes[ringId(i + 1)],
    ]);
  }
  const decor: MapDecor[] = [{ type: 'park', polygon: centre }];
  decor.push(
    ...decorateBlocks(blocks, new Random(options.seed), {
      parkChance: options.parkChance ?? 0.16,
      maxRadius: radius + entranceLength,
      roadInset: INTERSECTION_RADIUS + SIDEWALK_WIDTH + LANE_WIDTH,
    }),
  );
  return {
    version: 1,
    id: options.id,
    name: options.name,
    seed: options.seed,
    nodes,
    roads,
    decor,
    bounds: boundsForPoints(nodes),
  };
}
