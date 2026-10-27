import { clamp, wrapAngle, type Vec2 } from '../core/math';
import type { Lane } from '../map/Lane';

export type VehicleKind = 'car' | 'van' | 'bike';

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
    laneOffset: 1.2,
    eyeHeight: 1.65,
    eyeForward: 0.05,
  },
};

let nextId = 1;

export class Vehicle {
  readonly id = nextId++;
  readonly spec: VehicleSpec;
  readonly prevPos: Vec2;
  prevHeading: number;
  speed = 0;
  steer = 0;
  controller: 'ai' | 'player' = 'ai';

  lane: Lane | null = null;
  /** Arc length along `lane`. */
  s = 0;
  /** Lanes to drive after `lane`. */
  route: Lane[] = [];
  /** Connector this vehicle has been granted. */
  reserved: Lane | null = null;
  stuckTime = 0;

  input = { throttle: 0, steer: 0, handbrake: false };

  constructor(
    readonly kind: VehicleKind,
    readonly pos: Vec2,
    public heading: number,
    readonly color: number,
    readonly driverFactor: number,
  ) {
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
