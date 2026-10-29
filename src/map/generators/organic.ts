import { Random } from '../../core/Random';
import { add, distance, normalize, rightOf, scale, sub } from '../../core/math';
import type { MapDef } from '../types';
import { generateGrid } from './grid';

export interface OrganicOptions {
  id: string;
  name: string;
  seed: number;
  cols?: number;
  rows?: number;
  spacing?: number;
  jitter?: number;
  removeRatio?: number;
  curveChance?: number;
  curveBend?: number;
  parkChance?: number;
  speedLimit?: number;
  lanes?: number;
}

/** A reproducible pruned jitter-grid with gently curved local streets. */
export function generateOrganic(options: OrganicOptions): MapDef {
  const def = generateGrid({
    id: options.id,
    name: options.name,
    seed: options.seed,
    cols: options.cols ?? 7,
    rows: options.rows ?? 6,
    spacing: options.spacing ?? 64,
    jitter: options.jitter ?? 9,
    removeRatio: options.removeRatio ?? 0.18,
    parkChance: options.parkChance ?? 0.2,
    speedLimit: options.speedLimit ?? 11.5,
    lanes: options.lanes ?? 1,
  });
  const rng = new Random(options.seed ^ 0x9e3779b9);
  const curveChance = options.curveChance ?? 0.34;
  const maxBend = options.curveBend ?? 6;
  for (const road of def.roads) {
    if (!rng.chance(curveChance)) continue;
    const a = def.nodes[road.from];
    const b = def.nodes[road.to];
    const delta = sub(b, a);
    const tangent = normalize(delta);
    const normal = rightOf(tangent);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const sign = rng.chance(0.5) ? 1 : -1;
    const bend = Math.min(maxBend, distance(a, b) * 0.12) * rng.range(0.65, 1) * sign;
    road.control = add(midpoint, scale(normal, bend));
  }
  def.version = 1;
  return def;
}
