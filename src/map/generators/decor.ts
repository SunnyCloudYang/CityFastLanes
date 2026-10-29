import type { Random } from '../../core/Random';
import { insetPolygon, lerpVec, type Vec2 } from '../../core/math';
import { ROAD_HALF_WIDTH, SIDEWALK_WIDTH } from '../constants';
import type { Bounds, MapDecor } from '../types';

export interface BlockDecorOptions {
  parkChance?: number;
  /** Distance scale used to make central buildings taller. */
  maxRadius: number;
}

/** Adds a block footprint, then either a park or deterministic building lots. */
export function decorateBlocks(blocks: Vec2[][], rng: Random, options: BlockDecorOptions): MapDecor[] {
  const decor: MapDecor[] = [];
  const maxR = Math.max(1, options.maxRadius);
  for (const quad of blocks) {
    const block = insetPolygon(quad, ROAD_HALF_WIDTH);
    decor.push({ type: 'block', polygon: block });
    const lot = insetPolygon(block, SIDEWALK_WIDTH);
    if (rng.chance(options.parkChance ?? 0.1)) {
      decor.push({ type: 'park', polygon: lot });
      continue;
    }
    const mid = lerpVec(quad[0], quad[2], 0.5);
    const downtown = 1 - Math.min(1, Math.hypot(mid.x, mid.y) / maxR);
    const nx = rng.int(2, 3);
    const ny = rng.int(2, 3);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (rng.chance(0.08)) continue;
        const sub = [
          bilinear(lot, i / nx, j / ny),
          bilinear(lot, (i + 1) / nx, j / ny),
          bilinear(lot, (i + 1) / nx, (j + 1) / ny),
          bilinear(lot, i / nx, (j + 1) / ny),
        ];
        decor.push({
          type: 'building',
          polygon: insetPolygon(sub, 1.2),
          height: rng.range(5, 12) + downtown * rng.range(4, 28),
        });
      }
    }
  }
  return decor;
}

export function boundsForPoints(points: Vec2[], margin = 24): Bounds {
  if (points.length === 0) return { minX: -margin, minY: -margin, maxX: margin, maxY: margin };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs) - margin,
    minY: Math.min(...ys) - margin,
    maxX: Math.max(...xs) + margin,
    maxY: Math.max(...ys) + margin,
  };
}

function bilinear(q: Vec2[], u: number, v: number): Vec2 {
  return lerpVec(lerpVec(q[0], q[1], u), lerpVec(q[3], q[2], u), v);
}
