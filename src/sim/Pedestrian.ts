import type { Vec2 } from '../core/math';

export type PedestrianState = 'walking' | 'waiting' | 'crossing';

/** Simulation-only pedestrian data; navigation and rendering live outside this class. */
export class Pedestrian {
  readonly pos: Vec2;
  readonly prevPos: Vec2;
  heading: number;
  path: Vec2[];
  /** Index of the waypoint currently being approached. */
  pathIndex = 1;
  state: PedestrianState = 'walking';
  crossingNodeId: number | null = null;
  crossingRoadId: number | null = null;
  crossingProgress = 0;
  previousCornerId: number;

  constructor(
    readonly id: number,
    path: Vec2[],
    /** Preferred walking speed in m/s. Waiting pedestrians retain this value. */
    readonly speed: number,
    public targetCornerId: number,
    previousCornerId = targetCornerId,
  ) {
    this.path = path.map((p) => ({ ...p }));
    this.pos = { ...(this.path[0] ?? { x: 0, y: 0 }) };
    this.prevPos = { ...this.pos };
    const next = this.path[1] ?? this.pos;
    this.heading = Math.atan2(next.y - this.pos.y, next.x - this.pos.x);
    this.previousCornerId = previousCornerId;
  }
}
