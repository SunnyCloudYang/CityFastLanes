import { Random } from '../../core/Random';
import { insetPolygon, type Vec2 } from '../../core/math';
import { INTERSECTION_RADIUS, ROAD_HALF_WIDTH, SIDEWALK_WIDTH } from '../constants';
import type { MapDecor, MapDef, MapNode, MapRoad } from '../types';
import { boundsForPoints, decorateBlocks } from './decor';

export interface RadialOptions {
  id: string;
  name: string;
  seed: number;
  /** Defaults to 8. */
  spokes?: number;
  /** Number of circular roads, either 2 or 3. Defaults to 3. */
  rings?: 2 | 3;
  ringSpacing?: number;
  speedLimit?: number;
  parkChance?: number;
  /** Adds two one-way outer arcs while retaining bidirectional alternatives. */
  singleWay?: boolean;
}

export function generateRadial(options: RadialOptions): MapDef {
  const spokes = options.spokes ?? 8;
  const rings = options.rings ?? 3;
  const spacing = options.ringSpacing ?? 64;
  if (!Number.isInteger(spokes) || spokes < 6 || spokes > 12) throw new Error('Radial spokes must be an integer in 6..12');
  if (!Number.isFinite(spacing) || spacing < 40) throw new Error('Radial ringSpacing must be finite and at least 40');
  const speedLimit = options.speedLimit ?? 13.9;
  const gatewayRadius = (rings + 0.9) * spacing;
  const angle = (spoke: number) => -Math.PI / 2 + (spoke * Math.PI * 2) / spokes;
  const point = (radius: number, spoke: number): Vec2 => ({
    x: Math.cos(angle(spoke)) * radius,
    y: Math.sin(angle(spoke)) * radius,
  });
  const ringId = (ring: number, spoke: number) => 1 + ring * spokes + ((spoke + spokes) % spokes);
  const gatewayId = (spoke: number) => 1 + rings * spokes + spoke;

  const nodes: MapNode[] = [{ id: 0, x: 0, y: 0 }];
  for (let ring = 0; ring < rings; ring++) {
    for (let spoke = 0; spoke < spokes; spoke++) {
      nodes.push({ id: ringId(ring, spoke), ...point((ring + 1) * spacing, spoke) });
    }
  }
  for (let spoke = 0; spoke < spokes; spoke++) nodes.push({ id: gatewayId(spoke), ...point(gatewayRadius, spoke) });

  const roads: MapRoad[] = [];
  const addRoad = (from: number, to: number, oneWay = false) => {
    const road: MapRoad = { id: roads.length, from, to, speedLimit };
    if (oneWay) road.oneWay = true;
    roads.push(road);
  };
  for (let ring = 0; ring < rings; ring++) {
    for (let spoke = 0; spoke < spokes; spoke++) {
      addRoad(ring === 0 ? 0 : ringId(ring - 1, spoke), ringId(ring, spoke));
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let spoke = 0; spoke < spokes; spoke++) {
      const oneWay = options.singleWay === true && ring === rings - 1 && (spoke === 1 || spoke === Math.floor(spokes / 2));
      addRoad(ringId(ring, spoke), ringId(ring, spoke + 1), oneWay);
    }
  }
  for (let spoke = 0; spoke < spokes; spoke++) addRoad(ringId(rings - 1, spoke), gatewayId(spoke));

  const blocks: Vec2[][] = [];
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let spoke = 0; spoke < spokes; spoke++) {
      blocks.push([
        nodes[ringId(ring, spoke)],
        nodes[ringId(ring + 1, spoke)],
        nodes[ringId(ring + 1, spoke + 1)],
        nodes[ringId(ring, spoke + 1)],
      ]);
    }
  }
  const centre = insetPolygon(
    Array.from({ length: spokes }, (_, spoke) => point(spacing, spoke)),
    Math.max(INTERSECTION_RADIUS, ROAD_HALF_WIDTH + SIDEWALK_WIDTH),
  );
  const decor: MapDecor[] = [{ type: 'park', polygon: centre }];
  decor.push(
    ...decorateBlocks(blocks, new Random(options.seed), {
      parkChance: options.parkChance ?? 0.14,
      maxRadius: gatewayRadius,
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
