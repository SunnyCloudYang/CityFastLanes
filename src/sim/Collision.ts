import { centroid, dot, sub, type Vec2 } from '../core/math';

/**
 * Separating-axis test between two convex polygons.
 * Returns the minimum translation that pushes `a` out of `b`, or null if disjoint.
 */
export function satMTV(a: Vec2[], b: Vec2[]): Vec2 | null {
  let minOverlap = Infinity;
  let axis: Vec2 | null = null;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const l = Math.hypot(ex, ey);
      if (l < 1e-9) continue;
      const n = { x: -ey / l, y: ex / l };
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const v of a) {
        const d = dot(v, n);
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const v of b) {
        const d = dot(v, n);
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (overlap <= 0) return null;
      if (overlap < minOverlap) {
        minOverlap = overlap;
        axis = n;
      }
    }
  }
  if (!axis) return null;
  if (dot(sub(centroid(a), centroid(b)), axis) < 0) axis = { x: -axis.x, y: -axis.y };
  return { x: axis.x * minOverlap, y: axis.y * minOverlap };
}
