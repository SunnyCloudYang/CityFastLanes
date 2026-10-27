import { add, clamp, distance, dot, normalize, scale, sub, type Vec2 } from '../core/math';
import type { Vehicle } from '../sim/Vehicle';
import type { SignalController } from './Signals';

export type LaneKind = 'road' | 'connector';
export type TurnType = 'straight' | 'left' | 'right' | 'uturn';

export interface LanePoint {
  p: Vec2;
  /** Unit tangent. */
  t: Vec2;
}

/**
 * A directed polyline that vehicles follow. Road lanes run between intersections;
 * connector lanes are the curves inside an intersection.
 */
export class Lane {
  readonly cum: number[];
  readonly length: number;
  next: Lane[] = [];
  prev: Lane[] = [];
  /** Connectors at the same node whose paths cross or merge with this one. */
  conflicts: Lane[] = [];
  turn: TurnType = 'straight';
  roadId = -1;
  /** Road lane: the node it drives into. Connector: the node it belongs to. */
  nodeId = -1;
  signal: { ctrl: SignalController; group: number } | null = null;

  /** Vehicles holding a reservation through this connector. */
  readonly holders = new Set<Vehicle>();
  /** AI vehicles currently on this lane; rebuilt every sim step. */
  readonly occupants: Vehicle[] = [];

  constructor(
    readonly id: number,
    readonly kind: LaneKind,
    readonly points: Vec2[],
    public speedLimit: number,
  ) {
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + distance(points[i - 1], points[i]));
    this.length = this.cum[this.cum.length - 1];
  }

  get start(): Vec2 {
    return this.points[0];
  }

  get end(): Vec2 {
    return this.points[this.points.length - 1];
  }

  /** Point at arc length `s`; extrapolates linearly beyond either end. */
  pointAt(s: number): LanePoint {
    const pts = this.points;
    const n = pts.length;
    if (s <= 0) {
      const t = normalize(sub(pts[1], pts[0]));
      return { p: add(pts[0], scale(t, s)), t };
    }
    if (s >= this.length) {
      const t = normalize(sub(pts[n - 1], pts[n - 2]));
      return { p: add(pts[n - 1], scale(t, s - this.length)), t };
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo];
    const u = seg > 0 ? (s - this.cum[lo]) / seg : 0;
    const a = pts[lo];
    const b = pts[hi];
    return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, t: normalize(sub(b, a)) };
  }

  /** Arc length of the closest point. With a hint, only nearby segments are searched. */
  project(p: Vec2, hint?: number): number {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < this.points.length - 1; i++) {
      if (hint !== undefined && (this.cum[i + 1] < hint - 8 || this.cum[i] > hint + 16)) continue;
      const a = this.points[i];
      const ab = sub(this.points[i + 1], a);
      const l2 = dot(ab, ab);
      const u = l2 > 0 ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
      const d = Math.hypot(a.x + ab.x * u - p.x, a.y + ab.y * u - p.y);
      if (d < best) {
        best = d;
        bestS = this.cum[i] + u * Math.sqrt(l2);
      }
    }
    if (best === Infinity) return this.project(p);
    return bestS;
  }
}
