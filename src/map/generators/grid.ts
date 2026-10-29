import { Random } from '../../core/Random';
import { type Vec2 } from '../../core/math';
import { ROAD_HALF_WIDTH, roadHalfWidth } from '../constants';
import { protectedLeftPhases } from '../Signals';
import type { MapDecor, MapDef, MapNode, MapRoad } from '../types';
import { decorateBlocks } from './decor';

export interface GridOptions {
  id: string;
  name: string;
  seed: number;
  cols: number;
  rows: number;
  spacing: number;
  /** Random node displacement in metres, for organic layouts. */
  jitter?: number;
  /** Probability of deleting an interior road (keeps the graph connected). */
  removeRatio?: number;
  parkChance?: number;
  speedLimit?: number;
  /** Lanes per direction; defaults to one. */
  lanes?: number;
  /** Use separate protected-left phases at four-way intersections. */
  protectedLeft?: boolean;
  /** Additional carriageway clearance reserved for subsequently curved roads. */
  roadClearance?: number;
  /** A north-south river after column `afterCol`, crossed only on `bridgeRows`. */
  river?: { afterCol: number; width: number; bridgeRows: number[] };
}

export function generateGrid(o: GridOptions): MapDef {
  const rng = new Random(o.seed);
  const jitter = o.jitter ?? 0;
  const speedLimit = o.speedLimit ?? 13.9;
  const river = o.river;
  const riverW = river?.width ?? 0;
  const totalW = (o.cols - 1) * o.spacing + riverW;
  const totalH = (o.rows - 1) * o.spacing;
  const idOf = (c: number, r: number) => r * o.cols + c;
  const onBank = (c: number) => !!river && (c === river.afterCol || c === river.afterCol + 1);

  const nodes: MapNode[] = [];
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const shift = river && c > river.afterCol ? riverW : 0;
      nodes.push({
        id: idOf(c, r),
        x: c * o.spacing + shift - totalW / 2 + (onBank(c) ? 0 : rng.range(-jitter, jitter)),
        y: r * o.spacing - totalH / 2 + rng.range(-jitter, jitter),
      });
    }
  }

  let roads: MapRoad[] = [];
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols - 1; c++) {
      const bridge = !!river && c === river.afterCol;
      if (bridge && !river!.bridgeRows.includes(r)) continue;
      roads.push({ id: 0, from: idOf(c, r), to: idOf(c + 1, r), speedLimit, lanes: o.lanes, bridge });
    }
  }
  for (let c = 0; c < o.cols; c++) {
    for (let r = 0; r < o.rows - 1; r++)
      roads.push({ id: 0, from: idOf(c, r), to: idOf(c, r + 1), speedLimit, lanes: o.lanes });
  }
  if (o.removeRatio) roads = pruneRoads(roads, nodes.length, o.removeRatio, rng);
  roads.forEach((road, i) => (road.id = i));
  if (o.protectedLeft) {
    for (const node of nodes) {
      const degree = roads.filter((r) => r.from === node.id || r.to === node.id).length;
      if (degree >= 4) node.signalPhases = protectedLeftPhases();
    }
  }

  const pos = (c: number, r: number): Vec2 => ({ x: nodes[idOf(c, r)].x, y: nodes[idOf(c, r)].y });
  const blocks: Vec2[][] = [];
  for (let r = 0; r < o.rows - 1; r++) {
    for (let c = 0; c < o.cols - 1; c++) {
      if (river && c === river.afterCol) continue;
      blocks.push([pos(c, r), pos(c + 1, r), pos(c + 1, r + 1), pos(c, r + 1)]);
    }
  }
  const decor: MapDecor[] = decorateBlocks(blocks, rng, {
    parkChance: o.parkChance,
    maxRadius: Math.max(totalW, totalH) * 0.6,
    roadInset: roadHalfWidth({ lanes: o.lanes }) + (o.roadClearance ?? 0),
  });

  if (river) {
    const xl = nodes[idOf(river.afterCol, 0)].x + ROAD_HALF_WIDTH + 2;
    const xr = nodes[idOf(river.afterCol + 1, 0)].x - ROAD_HALF_WIDTH - 2;
    const y0 = -totalH / 2 - 90;
    const y1 = totalH / 2 + 90;
    decor.push({ type: 'water', polygon: [{ x: xl, y: y0 }, { x: xr, y: y0 }, { x: xr, y: y1 }, { x: xl, y: y1 }] });
  }

  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const margin = 24;
  return {
    id: o.id,
    name: o.name,
    seed: o.seed,
    nodes,
    roads,
    decor,
    bounds: {
      minX: Math.min(...xs) - margin,
      minY: Math.min(...ys) - margin,
      maxX: Math.max(...xs) + margin,
      maxY: Math.max(...ys) + margin,
    },
  };
}

/** Randomly removes roads while keeping every node at degree >= 2 and the graph connected. */
function pruneRoads(roads: MapRoad[], nodeCount: number, ratio: number, rng: Random): MapRoad[] {
  const alive = new Set(roads);
  const degree = new Array<number>(nodeCount).fill(0);
  for (const r of roads) {
    degree[r.from]++;
    degree[r.to]++;
  }
  for (const road of rng.shuffle([...roads])) {
    if (road.bridge || !rng.chance(ratio)) continue;
    if (degree[road.from] <= 2 || degree[road.to] <= 2) continue;
    alive.delete(road);
    if (!isConnected(alive, nodeCount)) {
      alive.add(road);
      continue;
    }
    degree[road.from]--;
    degree[road.to]--;
  }
  return roads.filter((r) => alive.has(r));
}

function isConnected(roads: Set<MapRoad>, nodeCount: number): boolean {
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const r of roads) {
    adj[r.from].push(r.to);
    adj[r.to].push(r.from);
  }
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    for (const n of adj[stack.pop()!]) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen.size === nodeCount;
}
