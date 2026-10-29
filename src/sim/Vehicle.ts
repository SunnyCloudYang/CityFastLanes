import { clamp, wrapAngle, type Vec2 } from '../core/math';
import type { Lane } from '../map/Lane';

export const VEHICLE_KINDS = ['car', 'van', 'bus', 'taxi', 'motorcycle', 'bike'] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

export interface VehicleSpec {
  length: number;
  width: number;
  wheelbase: number;
  maxSteer: number;
  maxAccel: number;
  maxBrake: number;
  maxSpeed: number;
  /** Comfortable acceleration used by the AI. */
  idmAccel: number;
  desiredSpeed: number;
  /** Lateral offset from the lane centreline (bikes keep right). */
  laneOffset: number;
  eyeHeight: number;
  eyeForward: number;
}

export const SPECS: Record<VehicleKind, VehicleSpec> = {
  car: {
    length: 4.3,
    width: 1.8,
    wheelbase: 2.6,
    maxSteer: 0.6,
    maxAccel: 3.2,
    maxBrake: 7,
    maxSpeed: 22,
    idmAccel: 1.6,
    desiredSpeed: 15,
    laneOffset: 0,
    eyeHeight: 1.3,
    eyeForward: 0.6,
  },
  van: {
    length: 6,
    width: 2.1,
    wheelbase: 3.6,
    maxSteer: 0.55,
    maxAccel: 2,
    maxBrake: 5.5,
    maxSpeed: 17,
    idmAccel: 1.1,
    desiredSpeed: 12.5,
    laneOffset: 0,
    eyeHeight: 1.85,
    eyeForward: 1.9,
  },
  bus: {
    length: 10.5,
    width: 2.5,
    wheelbase: 5.6,
    maxSteer: 0.45,
    maxAccel: 1.5,
    maxBrake: 5,
    maxSpeed: 16,
    idmAccel: 0.85,
    desiredSpeed: 11,
    laneOffset: 0,
    eyeHeight: 2.2,
    eyeForward: 3.4,
  },
  taxi: {
    length: 4.4,
    width: 1.8,
    wheelbase: 2.6,
    maxSteer: 0.6,
    maxAccel: 3.1,
    maxBrake: 7,
    maxSpeed: 22,
    idmAccel: 1.55,
    desiredSpeed: 14.5,
    laneOffset: 0,
    eyeHeight: 1.3,
    eyeForward: 0.6,
  },
  motorcycle: {
    length: 2.2,
    width: 0.7,
    wheelbase: 1.45,
    maxSteer: 0.65,
    maxAccel: 3.8,
    maxBrake: 6,
    maxSpeed: 20,
    idmAccel: 1.8,
    desiredSpeed: 13,
    laneOffset: 0,
    eyeHeight: 1.55,
    eyeForward: 0.25,
  },
  bike: {
    length: 1.8,
    width: 0.6,
    wheelbase: 1.1,
    maxSteer: 0.7,
    maxAccel: 1.6,
    maxBrake: 4,
    maxSpeed: 9,
    idmAccel: 1,
    desiredSpeed: 5,
    laneOffset: 1.35,
    eyeHeight: 1.65,
    eyeForward: 0.05,
  },
};

let nextId = 1;

export class Vehicle {
  readonly id: number;
  readonly spec: VehicleSpec;
  readonly prevPos: Vec2;
  prevHeading: number;
  speed = 0;
  steer = 0;
  controller: 'ai' | 'player' = 'ai';

  lane: Lane | null = null;
  /** Previous lane still occupied by the rear of a long vehicle. */
  trailLane: Lane | null = null;
  /** Arc length along `lane`. */
  s = 0;
  /** Lanes to drive after `lane`. */
  route: Lane[] = [];
  /** Connector this vehicle has been granted. */
  reserved: Lane | null = null;
  /** A smooth lateral transition between parallel road lanes. */
  laneChange: { from: Lane; offset: number; progress: number; duration: number } | null = null;
  laneChangeCooldown = 0;
  laneChanges = 0;
  stopTimer = 0;
  lastStopLane = -1;
  stuckTime = 0;

  input = { throttle: 0, steer: 0, handbrake: false };

  constructor(
    readonly kind: VehicleKind,
    readonly pos: Vec2,
    public heading: number,
    readonly color: number,
    readonly driverFactor: number,
    id?: number,
  ) {
    this.id = id ?? nextId++;
    if (id !== undefined) nextId = Math.max(nextId, id + 1);
    this.spec = SPECS[kind];
    this.prevPos = { ...pos };
    this.prevHeading = heading;
  }

  get isBike(): boolean {
    return this.kind === 'bike';
  }

  /** Kinematic bicycle model step. Positive steer turns right. */
  integrate(dt: number, accel: number, steerTarget: number, steerRate: number, minSpeed: number): void {
    const maxD = steerRate * dt;
    this.steer += clamp(steerTarget - this.steer, -maxD, maxD);
    this.speed = clamp(this.speed + accel * dt, minSpeed, this.spec.maxSpeed);
    this.heading = wrapAngle(this.heading + (this.speed / this.spec.wheelbase) * Math.tan(this.steer) * dt);
    this.pos.x += Math.cos(this.heading) * this.speed * dt;
    this.pos.y += Math.sin(this.heading) * this.speed * dt;
  }

  corners(): Vec2[] {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    const hl = this.spec.length / 2;
    const hw = this.spec.width / 2;
    const { x, y } = this.pos;
    const fx = c * hl;
    const fy = s * hl;
    const rx = -s * hw;
    const ry = c * hw;
    return [
      { x: x + fx + rx, y: y + fy + ry },
      { x: x + fx - rx, y: y + fy - ry },
      { x: x - fx - rx, y: y - fy - ry },
      { x: x - fx + rx, y: y - fy + ry },
    ];
  }
}
