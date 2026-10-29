import { distance, type Vec2 } from '../core/math';
import { Random } from '../core/Random';
import type { Lane } from '../map/Lane';
import { findRoute } from '../map/Pathfinding';
import type { Vehicle } from './Vehicle';
import type { World } from './World';

export type ObjectiveMode = 'delivery' | 'pickup' | 'timed';
export type ObjectiveStatus = 'active' | 'completed' | 'expired';

export interface ObjectiveSnapshot {
  id: number;
  mode: ObjectiveMode;
  status: ObjectiveStatus;
  destination: Vec2;
  destinationLaneId: number;
  destinationS: number;
  /** Complete lane sequence, including the nearest current road lane. */
  route: Lane[];
  routeLaneIds: number[];
  timeLimit: number | null;
  remainingTime: number | null;
}

export interface ObjectivesOptions {
  seed?: number;
  defaultMode?: ObjectiveMode;
  completionRadius?: number;
  minDistance?: number;
  /** Fixed limit for timed objectives. Omit to estimate a limit from route length. */
  timeLimit?: number;
}

/** Generates reachable, single-destination objectives without mutating the world. */
export class Objectives {
  private readonly rng: Random;
  private readonly completionRadius: number;
  private readonly minDistance: number;
  private readonly configuredTimeLimit: number | null;
  private defaultMode: ObjectiveMode;
  private active: ObjectiveSnapshot | null = null;
  private sequence = 0;
  private completed = 0;
  private expired = 0;

  constructor(options: ObjectivesOptions = {}) {
    this.rng = new Random(options.seed ?? 1);
    this.defaultMode = options.defaultMode ?? 'delivery';
    this.completionRadius = positiveOption(options.completionRadius, 7);
    this.minDistance = nonNegativeOption(options.minDistance, 50);
    this.configuredTimeLimit =
      options.timeLimit === undefined ? null : positiveOption(options.timeLimit, 60);
  }

  get current(): ObjectiveSnapshot | null {
    return copyObjective(this.active);
  }

  get completedCount(): number {
    return this.completed;
  }

  get expiredCount(): number {
    return this.expired;
  }

  /** Clears progress and creates the first objective. */
  start(world: World, vehicle: Vehicle, mode: ObjectiveMode = this.defaultMode): ObjectiveSnapshot | null {
    this.active = null;
    this.sequence = 0;
    this.completed = 0;
    this.expired = 0;
    this.defaultMode = mode;
    return this.next(world, vehicle, mode);
  }

  /** Creates the next objective, retaining completion/timeout counts. */
  next(world: World, vehicle: Vehicle, mode?: ObjectiveMode): ObjectiveSnapshot | null {
    const selectedMode = mode ?? this.active?.mode ?? this.defaultMode;
    this.defaultMode = selectedMode;
    this.active = this.generate(world, vehicle, selectedMode);
    return this.current;
  }

  /** Checks arrival first, then advances the timed-objective clock. */
  step(_world: World, vehicle: Vehicle, dt: number): ObjectiveSnapshot | null {
    if (!this.active || this.active.status !== 'active') return this.current;
    if (distance(vehicle.pos, this.active.destination) <= this.completionRadius) {
      this.active.status = 'completed';
      this.completed++;
      return this.current;
    }
    if (this.active.remainingTime !== null && Number.isFinite(dt) && dt > 0) {
      this.active.remainingTime = Math.max(0, this.active.remainingTime - dt);
      if (this.active.remainingTime === 0) {
        this.active.status = 'expired';
        this.expired++;
      }
    }
    return this.current;
  }

  clear(): void {
    this.active = null;
  }

  private generate(world: World, vehicle: Vehicle, mode: ObjectiveMode): ObjectiveSnapshot | null {
    const start = nearestRoadLane(world.net.roadLanes, vehicle.pos);
    if (!start) return null;

    const candidates = this.rng.shuffle(
      world.net.roadLanes
        .filter((lane) => lane.length > this.completionRadius)
        .map((lane) => ({ lane, s: lane.length * this.rng.range(0.35, 0.8) })),
    );
    // A dense/small map may have no candidate beyond minDistance. In that case
    // prefer a reachable objective over failing generation altogether.
    for (const enforceMinDistance of [true, false]) {
      for (const candidate of candidates) {
        const { lane, s } = candidate;
        const destination = lane.pointAt(s).p;
        const directDistance = distance(vehicle.pos, destination);
        if (directDistance <= this.completionRadius) continue;
        if (enforceMinDistance && directDistance < this.minDistance) continue;

        let path: Lane[];
        if (lane === start.lane) {
          // A* intentionally returns null for identical endpoints. A target
          // ahead on the current lane is already reachable with an empty path.
          if (s <= start.s + this.completionRadius) continue;
          path = [];
        } else {
          const route = findRoute(
            start.lane,
            lane,
            Math.max(1, vehicle.spec.desiredSpeed),
            vehicle.isBike ? 'bike' : 'motor',
          );
          if (!route) continue;
          path = route;
        }
        const routeLanes = [start.lane, ...path];
        const timeLimit = mode === 'timed' ? this.timeLimit(routeLanes, vehicle, start.s, s) : null;
        return {
          id: ++this.sequence,
          mode,
          status: 'active',
          destination: { ...destination },
          destinationLaneId: lane.id,
          destinationS: s,
          route: routeLanes,
          routeLaneIds: routeLanes.map((routeLane) => routeLane.id),
          timeLimit,
          remainingTime: timeLimit,
        };
      }
    }
    return null;
  }

  private timeLimit(route: Lane[], vehicle: Vehicle, startS: number, destinationS: number): number {
    if (this.configuredTimeLimit !== null) return this.configuredTimeLimit;
    let routeLength = route.reduce((sum, lane) => sum + lane.length, 0);
    routeLength -= Math.min(startS, route[0].length);
    const destinationLane = route[route.length - 1];
    routeLength -= Math.max(0, destinationLane.length - destinationS);
    const estimatedSpeed = Math.max(2, vehicle.spec.desiredSpeed * 0.6);
    return Math.max(20, Math.max(0, routeLength) / estimatedSpeed + 15);
  }
}

interface NearestLane {
  lane: Lane;
  s: number;
  distance: number;
}

function nearestRoadLane(lanes: readonly Lane[], position: Vec2): NearestLane | null {
  let best: NearestLane | null = null;
  let bestDistanceSquared = Infinity;
  for (const lane of lanes) {
    if (lane.length <= 0) continue;
    const s = lane.project(position);
    const point = lane.pointAt(s).p;
    const dx = point.x - position.x;
    const dy = point.y - position.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      best = { lane, s, distance: Math.sqrt(distanceSquared) };
    }
  }
  return best;
}

function copyObjective(objective: ObjectiveSnapshot | null): ObjectiveSnapshot | null {
  if (!objective) return null;
  return {
    ...objective,
    destination: { ...objective.destination },
    route: [...objective.route],
    routeLaneIds: [...objective.routeLaneIds],
  };
}

function positiveOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
