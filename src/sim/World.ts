import { Random } from '../core/Random';
import {
  add,
  angleOf,
  centroid,
  clamp,
  distance,
  fromAngle,
  normalize,
  rightOf,
  scale,
  wrapAngle,
  type Vec2,
} from '../core/math';
import type { Lane } from '../map/Lane';
import { findRoute } from '../map/Pathfinding';
import { RoadNetwork } from '../map/RoadNetwork';
import type { MapDef } from '../map/types';
import { idm, type IdmParams } from './ai/IDM';
import { satMTV } from './Collision';
import { SPECS, Vehicle, type VehicleKind } from './Vehicle';

const MOTOR_COLORS = [0xd9534f, 0x3b7dd8, 0xe0a030, 0x4caf7a, 0x8e6cc0, 0xe7e3da, 0x5a5a5a, 0xd96f9e];
const BIKE_COLORS = [0xe0433a, 0x2f8fd0, 0xf0b429, 0x3fae6a, 0xff7a3d];
const IDM_MOTOR = { b: 2.2, T: 1.3, s0: 2 };
const IDM_BIKE = { b: 2, T: 1, s0: 1 };
/** Vehicles idle longer than this are recycled to break rare gridlocks. */
const STUCK_LIMIT = 45;
const LOOKAHEAD_LIMIT = 70;
/** How far into a sibling connector a vehicle still blocks the shared mouth. */
const SIBLING_WINDOW = 10;

export interface Building {
  poly: Vec2[];
  c: Vec2;
  r: number;
}

export class World {
  readonly net: RoadNetwork;
  readonly vehicles: Vehicle[] = [];
  readonly buildings: Building[];
  /** Vehicles the UI is looking at; never recycled or despawned. */
  readonly protectedIds = new Set<number>();
  time = 0;
  private readonly rng: Random;

  constructor(
    readonly def: MapDef,
    public targetMotor: number,
    public targetBikes: number,
    seed = def.seed,
  ) {
    this.net = new RoadNetwork(def);
    this.rng = new Random(seed * 9973 + 1);
    this.buildings = def.decor
      .filter((d) => d.type === 'building')
      .map((d) => {
        const c = centroid(d.polygon);
        return { poly: d.polygon, c, r: Math.max(...d.polygon.map((p) => distance(p, c))) };
      });
    this.fill();
  }

  get players(): Vehicle[] {
    return this.vehicles.filter((v) => v.controller === 'player');
  }

  count(bikes: boolean): number {
    let n = 0;
    for (const v of this.vehicles) if (v.isBike === bikes) n++;
    return n;
  }

  step(dt: number): void {
    this.time += dt;
    for (const v of this.vehicles) {
      v.prevPos.x = v.pos.x;
      v.prevPos.y = v.pos.y;
      v.prevHeading = v.heading;
    }
    for (const s of this.net.signals) s.update(dt);
    this.rebuildOccupancy();
    const players = this.players;
    for (const v of this.vehicles) {
      if (v.controller === 'ai') this.driveAI(v, dt, players);
      else this.drivePlayer(v, dt);
    }
    for (const v of this.vehicles) if (v.controller === 'ai') this.advance(v);
    for (const p of players) this.collide(p);
    this.recycle(players);
    this.spawnTick(players);
  }

  takeControl(v: Vehicle): void {
    if (v.controller === 'player') return;
    for (const p of this.players) this.releaseControl(p);
    this.detach(v);
    v.controller = 'player';
    v.input = { throttle: 0, steer: 0, handbrake: false };
  }

  releaseControl(v: Vehicle): void {
    if (v.controller !== 'player') return;
    v.controller = 'ai';
    v.speed = Math.max(0, v.speed);
    v.stuckTime = 0;
    const snap = this.nearestLane(v);
    v.lane = snap.lane;
    v.s = snap.s;
    v.route = [];
    this.ensureRoute(v);
  }

  // ---------------------------------------------------------------- AI

  private driveAI(v: Vehicle, dt: number, players: Vehicle[]): void {
    const lane = v.lane!;
    const spec = v.spec;
    this.ensureRoute(v);
    const half = spec.length / 2;
    const distToEnd = lane.length - v.s;
    const want = spec.desiredSpeed * v.driverFactor;

    // Slow down ahead of curves: the speed we may carry while braking into the next lanes.
    let v0 = Math.min(lane.speedLimit, want);
    let ahead = distToEnd - half;
    for (let i = 0; i < 2 && i < v.route.length; i++) {
      const lim = Math.min(v.route[i].speedLimit, want);
      v0 = Math.min(v0, Math.sqrt(lim * lim + 2 * 1.4 * Math.max(0, ahead)));
      ahead += v.route[i].length;
    }

    const base = v.isBike ? IDM_BIKE : IDM_MOTOR;
    const params: IdmParams = { ...base, a: spec.idmAccel };
    let { gap, speed: leadSpeed } = this.findLeader(v);

    const next = v.route[0];
    if (lane.kind === 'road' && next?.kind === 'connector' && v.reserved !== next) {
      if (!this.tryReserve(v, lane, next, distToEnd)) {
        const stopGap = distToEnd - half + base.s0 - 0.8;
        if (stopGap < gap) {
          gap = stopGap;
          leadSpeed = 0;
        }
      }
    }
    for (const p of players) {
      const g = coneGap(v, p);
      if (g < gap) {
        gap = g;
        leadSpeed = Math.max(0, p.speed);
      }
    }

    const acc = clamp(idm(v.speed, Math.max(v0, 1), gap, v.speed - leadSpeed, params), -spec.maxBrake * 1.3, spec.idmAccel);

    // Pure pursuit towards a point further along the route.
    const ld = clamp(v.speed * 0.9, 3.5, 12);
    const target = this.pathPoint(v, v.s + ld);
    const dx = target.x - v.pos.x;
    const dy = target.y - v.pos.y;
    const c = Math.cos(v.heading);
    const sn = Math.sin(v.heading);
    const alpha = Math.atan2(-dx * sn + dy * c, dx * c + dy * sn);
    const steer = Math.atan2(2 * spec.wheelbase * Math.sin(alpha), Math.max(Math.hypot(dx, dy), 0.5));

    v.integrate(dt, acc, clamp(steer, -spec.maxSteer, spec.maxSteer), 3, 0);
    v.stuckTime = v.speed < 0.3 ? v.stuckTime + dt : 0;
  }

  /** Nearest vehicle ahead along the lane sequence. Bikes and motor vehicles share connectors only. */
  private findLeader(v: Vehicle): { gap: number; speed: number } {
    const half = v.spec.length / 2;
    let gap = Infinity;
    let speed = 0;
    let base = -v.s;
    const n = Math.min(3, v.route.length);
    for (let i = -1; i < n; i++) {
      const lane = i < 0 ? v.lane! : v.route[i];
      // Connectors leaving the same lane overlap near their mouth, so vehicles
      // taking a different turn still count as leaders there.
      const lanes = lane.kind === 'connector' ? lane.prev[0].next : [lane];
      for (const l of lanes) {
        for (const u of l.occupants) {
          if (u === v) continue;
          if (l !== lane && u.s > SIBLING_WINDOW) continue;
          if (i < 0 && (u.s < v.s || (u.s === v.s && u.id < v.id))) continue;
          if (lane.kind === 'road' && u.isBike !== v.isBike) continue;
          const g = base + u.s - half - u.spec.length / 2;
          if (g < gap) {
            gap = g;
            speed = u.speed;
          }
        }
      }
      if (gap < Infinity) break;
      base += lane.length;
      if (base > LOOKAHEAD_LIMIT) break;
    }
    return { gap, speed };
  }

  /** Asks for exclusive use of an intersection path: signal, crossing traffic, and room on the exit lane. */
  private tryReserve(v: Vehicle, lane: Lane, conn: Lane, distToEnd: number): boolean {
    const front = distToEnd - v.spec.length / 2;
    if (front > Math.max(6, v.speed * 2.5)) return false;
    for (const u of lane.occupants) if (u !== v && u.s > v.s && u.isBike === v.isBike) return false;
    if (lane.signal) {
      const st = lane.signal.ctrl.state(lane.signal.group);
      if (st === 'red') return false;
      if (st === 'yellow' && front > (v.speed * v.speed) / 6 + 0.5) return false;
    }
    for (const k of conn.conflicts) if (k.holders.size > 0) return false;
    if (!this.hasSpace(conn.next[0], v)) return false;
    conn.holders.add(v);
    v.reserved = conn;
    return true;
  }

  private hasSpace(out: Lane, v: Vehicle): boolean {
    let free = out.length;
    for (const u of out.occupants) if (u.isBike === v.isBike) free = Math.min(free, u.s - u.spec.length / 2);
    let need = v.spec.length + 2.5;
    for (const c of out.prev) {
      for (const h of c.holders) if (h !== v && h.isBike === v.isBike) need += h.spec.length + 2.5;
    }
    return free >= need;
  }

  private pathPoint(v: Vehicle, s: number): Vec2 {
    let lane = v.lane!;
    let rem = s;
    let i = 0;
    while (rem > lane.length && i < v.route.length) {
      rem -= lane.length;
      lane = v.route[i++];
    }
    const { p, t } = lane.pointAt(rem);
    return add(p, scale(rightOf(t), v.spec.laneOffset));
  }

  /** Re-projects onto the lane after integrating and hands over to the next lane at the end. */
  private advance(v: Vehicle): void {
    let lane = v.lane!;
    let s = lane.project(v.pos, v.s);
    let guard = 0;
    while (s >= lane.length - 0.02 && v.route.length && guard++ < 3) {
      const nl = v.route.shift()!;
      if (lane.kind === 'connector') {
        lane.holders.delete(v);
        if (v.reserved === lane) v.reserved = null;
      }
      if (nl.kind === 'connector') nl.holders.add(v);
      lane = nl;
      s = lane.project(v.pos, 0);
    }
    v.lane = lane;
    v.s = s;
  }

  private ensureRoute(v: Vehicle): void {
    let guard = 0;
    while (v.route.length < 4 && guard++ < 4) {
      const from = v.route.length ? v.route[v.route.length - 1] : v.lane!;
      const path = findRoute(from, this.rng.pick(this.net.roadLanes));
      if (path?.length) v.route.push(...path);
      else if (from.next.length) v.route.push(this.rng.pick(from.next));
      else break;
    }
  }

  private rebuildOccupancy(): void {
    for (const lane of this.net.lanes) lane.occupants.length = 0;
    for (const v of this.vehicles) if (v.controller === 'ai' && v.lane) v.lane.occupants.push(v);
  }

  // ---------------------------------------------------------------- player

  private drivePlayer(v: Vehicle, dt: number): void {
    const spec = v.spec;
    const { throttle, steer, handbrake } = v.input;
    const coast = () => -Math.sign(v.speed) * Math.min(Math.abs(v.speed) / dt, 0.5 + 0.015 * v.speed * v.speed);
    let acc: number;
    if (throttle > 0) acc = v.speed < -0.2 ? spec.maxBrake : spec.maxAccel * throttle;
    else if (throttle < 0) acc = v.speed > 0.2 ? -spec.maxBrake : -spec.maxAccel * 0.6;
    else acc = coast();
    if (handbrake) acc = -Math.sign(v.speed) * Math.min(Math.abs(v.speed) / dt, 9);
    const steerTarget = (steer * spec.maxSteer) / (1 + Math.abs(v.speed) / 10);
    v.integrate(dt, acc, steerTarget, 2.2, -spec.maxSpeed * 0.3);
  }

  private collide(p: Vehicle): void {
    for (const u of this.vehicles) {
      if (u === p || Math.abs(u.pos.x - p.pos.x) > 8 || Math.abs(u.pos.y - p.pos.y) > 8) continue;
      const mtv = satMTV(p.corners(), u.corners());
      if (mtv) bump(p, mtv);
    }
    for (const b of this.buildings) {
      if (distance(b.c, p.pos) > b.r + p.spec.length) continue;
      const mtv = satMTV(p.corners(), b.poly);
      if (mtv) bump(p, mtv);
    }
    const bd = this.def.bounds;
    p.pos.x = clamp(p.pos.x, bd.minX - 30, bd.maxX + 30);
    p.pos.y = clamp(p.pos.y, bd.minY - 30, bd.maxY + 30);
  }

  private nearestLane(v: Vehicle): { lane: Lane; s: number } {
    let best = { lane: this.net.roadLanes[0], s: 0 };
    let bestScore = Infinity;
    for (const lane of this.net.roadLanes) {
      const s = lane.project(v.pos);
      const { p, t } = lane.pointAt(s);
      const ang = Math.abs(wrapAngle(angleOf(t) - v.heading));
      const score = distance(p, v.pos) + ang * 6 + (ang > 1.9 ? 1000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { lane, s };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- population

  private fill(): void {
    for (let tries = 0; tries < 600; tries++) {
      const needBikes = this.count(true) < this.targetBikes;
      const needMotor = this.count(false) < this.targetMotor;
      if (!needBikes && !needMotor) break;
      const bike = needBikes && (!needMotor || this.rng.chance(0.3));
      this.trySpawn(bike ? 'bike' : this.randomMotorKind(), []);
    }
  }

  private randomMotorKind(): VehicleKind {
    return this.rng.chance(0.15) ? 'van' : 'car';
  }

  private spawnTick(players: Vehicle[]): void {
    for (const bikes of [false, true]) {
      const target = bikes ? this.targetBikes : this.targetMotor;
      const n = this.count(bikes);
      if (n < target) this.trySpawn(bikes ? 'bike' : this.randomMotorKind(), players);
      else if (n > target) {
        const victim = this.vehicles.find(
          (v) => v.isBike === bikes && v.controller === 'ai' && !this.protectedIds.has(v.id),
        );
        if (victim) this.remove(victim);
      }
    }
  }

  private trySpawn(kind: VehicleKind, players: Vehicle[]): boolean {
    const lane = this.rng.pick(this.net.roadLanes);
    if (!lane || lane.length < 14) return false;
    const s = this.rng.range(6, lane.length - 6);
    for (const u of lane.occupants) if (Math.abs(u.s - s) < 12) return false;
    const spec = SPECS[kind];
    const { p, t } = lane.pointAt(s);
    const pos = add(p, scale(rightOf(t), spec.laneOffset));
    for (const q of players) if (distance(q.pos, pos) < 25) return false;
    const colors = kind === 'bike' ? BIKE_COLORS : MOTOR_COLORS;
    const v = new Vehicle(kind, pos, angleOf(t), this.rng.pick(colors), this.rng.range(0.85, 1.1));
    v.lane = lane;
    v.s = s;
    lane.occupants.push(v);
    this.ensureRoute(v);
    this.vehicles.push(v);
    return true;
  }

  private recycle(players: Vehicle[]): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (v.controller !== 'ai' || v.stuckTime < STUCK_LIMIT || this.protectedIds.has(v.id)) continue;
      if (players.some((p) => distance(p.pos, v.pos) < 40)) continue;
      this.remove(v);
    }
  }

  private remove(v: Vehicle): void {
    this.detach(v);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  private detach(v: Vehicle): void {
    v.reserved?.holders.delete(v);
    if (v.lane?.kind === 'connector') v.lane.holders.delete(v);
    v.reserved = null;
    v.lane = null;
    v.route = [];
  }
}

/** Gap to a player-driven vehicle if it sits in this vehicle's forward corridor. */
function coneGap(v: Vehicle, p: Vehicle): number {
  const dx = p.pos.x - v.pos.x;
  const dy = p.pos.y - v.pos.y;
  const c = Math.cos(v.heading);
  const s = Math.sin(v.heading);
  const fwd = dx * c + dy * s;
  if (fwd <= 0 || fwd > 35) return Infinity;
  const lat = -dx * s + dy * c;
  const rel = p.heading - v.heading;
  const extFwd = Math.abs(Math.cos(rel)) * (p.spec.length / 2) + Math.abs(Math.sin(rel)) * (p.spec.width / 2);
  const extLat = Math.abs(Math.sin(rel)) * (p.spec.length / 2) + Math.abs(Math.cos(rel)) * (p.spec.width / 2);
  if (Math.abs(lat) > v.spec.width / 2 + extLat + 0.3) return Infinity;
  return fwd - v.spec.length / 2 - extFwd;
}

function bump(p: Vehicle, mtv: Vec2): void {
  p.pos.x += mtv.x;
  p.pos.y += mtv.y;
  const n = normalize(mtv);
  const vel = scale(fromAngle(p.heading), p.speed);
  if (vel.x * n.x + vel.y * n.y < 0) p.speed *= -0.15;
}
