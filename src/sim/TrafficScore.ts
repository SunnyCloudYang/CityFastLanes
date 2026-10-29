import { clamp, cross, dot, type Vec2 } from '../core/math';
import type { Lane } from '../map/Lane';
import type { Vehicle } from './Vehicle';
import type { World } from './World';

export type TrafficViolation = 'redLight' | 'wrongWay' | 'collision';

export interface TrafficEvent {
  type: TrafficViolation;
  penalty: number;
  score: number;
  /** Seconds accumulated by this score instance. */
  time: number;
}

export interface TrafficScoreSnapshot {
  score: number;
  /** Total step time without an observed violation; violations do not subtract previous time. */
  safeDrivingTime: number;
  /** Current uninterrupted safe-driving time. */
  safeStreak: number;
  events: TrafficEvent[];
}

export interface TrafficScoreOptions {
  penalties?: Partial<Record<TrafficViolation, number>>;
  cooldowns?: Partial<Record<TrafficViolation, number>>;
  maxEvents?: number;
  /** Minimum signed speed against a lane before wrong-way driving is reported. */
  wrongWaySpeed?: number;
  /** Maximum lateral distance from a road lane used by wrong-way detection. */
  roadTolerance?: number;
  /** Maximum lateral distance from the stop line used by red-light detection. */
  stopLineTolerance?: number;
}

const DEFAULT_PENALTIES: Record<TrafficViolation, number> = {
  redLight: 15,
  wrongWay: 10,
  collision: 20,
};
const DEFAULT_COOLDOWNS: Record<TrafficViolation, number> = {
  redLight: 3,
  wrongWay: 2,
  collision: 1,
};
const VIOLATIONS: readonly TrafficViolation[] = ['redLight', 'wrongWay', 'collision'];

/** Pure traffic-rule scoring for one vehicle. A new vehicle starts a fresh score. */
export class TrafficScore {
  private readonly penalties: Record<TrafficViolation, number>;
  private readonly cooldownDuration: Record<TrafficViolation, number>;
  private readonly cooldown: Record<TrafficViolation, number> = {
    redLight: 0,
    wrongWay: 0,
    collision: 0,
  };
  private readonly maxEvents: number;
  private readonly wrongWaySpeed: number;
  private readonly roadTolerance: number;
  private readonly stopLineTolerance: number;
  private vehicle: Vehicle | null = null;
  private previous: Vec2 | null = null;
  private eventList: TrafficEvent[] = [];
  private currentScore = 100;
  private safeTime = 0;
  private streak = 0;
  private elapsed = 0;
  private collisionNotified = false;

  constructor(options: TrafficScoreOptions = {}) {
    this.penalties = {
      redLight: validOption(options.penalties?.redLight, DEFAULT_PENALTIES.redLight),
      wrongWay: validOption(options.penalties?.wrongWay, DEFAULT_PENALTIES.wrongWay),
      collision: validOption(options.penalties?.collision, DEFAULT_PENALTIES.collision),
    };
    this.cooldownDuration = {
      redLight: validOption(options.cooldowns?.redLight, DEFAULT_COOLDOWNS.redLight),
      wrongWay: validOption(options.cooldowns?.wrongWay, DEFAULT_COOLDOWNS.wrongWay),
      collision: validOption(options.cooldowns?.collision, DEFAULT_COOLDOWNS.collision),
    };
    this.maxEvents = Math.max(1, Math.floor(validOption(options.maxEvents, 12)));
    this.wrongWaySpeed = validOption(options.wrongWaySpeed, 1);
    this.roadTolerance = validOption(options.roadTolerance, 4.5);
    this.stopLineTolerance = validOption(options.stopLineTolerance, 4.5);
  }

  get score(): number {
    return this.currentScore;
  }

  get safeDrivingTime(): number {
    return this.safeTime;
  }

  get safeStreak(): number {
    return this.streak;
  }

  get events(): TrafficEvent[] {
    return this.eventList.map((event) => ({ ...event }));
  }

  /** Call once after each world.step(). dt must use the same fixed step as the world. */
  step(world: World, vehicle: Vehicle, dt: number): TrafficScoreSnapshot {
    if (this.vehicle !== vehicle) {
      // Preserve notifications made before the first step; only an actual
      // vehicle switch after binding starts a fresh score.
      if (this.vehicle !== null) this.reset();
      this.vehicle = vehicle;
      // World updates prevPos before moving a vehicle, so the first call can
      // still detect a stop-line crossing that happened in that world step.
      this.previous = { ...vehicle.prevPos };
    }
    if (!Number.isFinite(dt) || dt <= 0) return this.snapshot();

    this.elapsed += dt;
    for (const type of VIOLATIONS) this.cooldown[type] = Math.max(0, this.cooldown[type] - dt);

    const previous = this.previous ?? { ...vehicle.prevPos };
    let violating = false;
    if (this.crossedRedLight(world, vehicle, previous)) {
      violating = true;
      this.penalize('redLight');
    }
    if (this.isWrongWay(world, vehicle)) {
      violating = true;
      this.penalize('wrongWay');
    }
    if (this.collisionNotified) violating = true;

    if (violating) {
      this.streak = 0;
    } else {
      this.safeTime += dt;
      this.streak += dt;
    }
    this.collisionNotified = false;
    this.previous = { ...vehicle.pos };
    return this.snapshot();
  }

  /**
   * Reports a collision from World/main integration. Returns false while the
   * collision cooldown is active. Call before score.step() to exclude that
   * step from safe-driving time.
   */
  penalizeCollision(): boolean {
    this.collisionNotified = true;
    return this.penalize('collision');
  }

  snapshot(): TrafficScoreSnapshot {
    return {
      score: this.currentScore,
      safeDrivingTime: this.safeTime,
      safeStreak: this.streak,
      events: this.events,
    };
  }

  reset(): void {
    this.vehicle = null;
    this.previous = null;
    this.eventList = [];
    this.currentScore = 100;
    this.safeTime = 0;
    this.streak = 0;
    this.elapsed = 0;
    this.collisionNotified = false;
    for (const type of VIOLATIONS) this.cooldown[type] = 0;
  }

  private penalize(type: TrafficViolation): boolean {
    if (this.cooldown[type] > 0) return false;
    this.cooldown[type] = this.cooldownDuration[type];
    this.currentScore = clamp(this.currentScore - this.penalties[type], 0, 100);
    this.streak = 0;
    this.eventList.push({
      type,
      penalty: this.penalties[type],
      score: this.currentScore,
      time: this.elapsed,
    });
    if (this.eventList.length > this.maxEvents) this.eventList.splice(0, this.eventList.length - this.maxEvents);
    return true;
  }

  private crossedRedLight(world: World, vehicle: Vehicle, previous: Vec2): boolean {
    for (const lane of world.net.roadLanes) {
      if (!lane.signal) continue;
      const tangent = lane.pointAt(lane.length).t;
      const before = signedDistance(previous, lane.end, tangent);
      const after = signedDistance(vehicle.pos, lane.end, tangent);
      if (before >= 0 || after < 0 || after <= before) continue;

      const fraction = -before / (after - before);
      const crossing = {
        x: previous.x + (vehicle.pos.x - previous.x) * fraction,
        y: previous.y + (vehicle.pos.y - previous.y) * fraction,
      };
      const lateral = Math.abs(cross(tangent, { x: crossing.x - lane.end.x, y: crossing.y - lane.end.y }));
      if (lateral > this.stopLineTolerance) continue;

      const connector = vehicle.reserved?.prev.includes(lane)
        ? vehicle.reserved
        : vehicle.route.find((candidate) => candidate.kind === 'connector' && candidate.prev.includes(lane));
      if (lane.signal.ctrl.state(lane.signal.group, connector?.turn) === 'red') return true;
    }
    return false;
  }

  private isWrongWay(world: World, vehicle: Vehicle): boolean {
    const nearest = nearestRoadLane(world.net.roadLanes, vehicle.pos);
    if (!nearest || nearest.distance > this.roadTolerance) return false;
    const heading = { x: Math.cos(vehicle.heading), y: Math.sin(vehicle.heading) };
    const forwardSpeed = vehicle.speed * dot(heading, nearest.lane.pointAt(nearest.s).t);
    return forwardSpeed < -this.wrongWaySpeed;
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

function signedDistance(point: Vec2, origin: Vec2, direction: Vec2): number {
  return dot({ x: point.x - origin.x, y: point.y - origin.y }, direction);
}

function validOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
