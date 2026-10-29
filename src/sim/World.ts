import { Random } from '../core/Random';
import { SpatialHash } from '../core/SpatialHash';
import {
  add,
  angleOf,
  centroid,
  clamp,
  distance,
  dot,
  fromAngle,
  lerp,
  normalize,
  rightOf,
  scale,
  sub,
  wrapAngle,
  type Vec2,
} from '../core/math';
import { LANE_WIDTH, laneCenterOffset } from '../map/constants';
import type { Lane } from '../map/Lane';
import { findRoute } from '../map/Pathfinding';
import { RoadNetwork } from '../map/RoadNetwork';
import type { MapDef } from '../map/types';
import { idm, type IdmParams } from './ai/IDM';
import { satMTV } from './Collision';
import { Pedestrian } from './Pedestrian';
import { SPECS, Vehicle, type VehicleKind } from './Vehicle';

const MOTOR_COLORS = [0xd9534f, 0x3b7dd8, 0xe0a030, 0x4caf7a, 0x8e6cc0, 0xe7e3da, 0x5a5a5a, 0xd96f9e];
const BIKE_COLORS = [0xe0433a, 0x2f8fd0, 0xf0b429, 0x3fae6a, 0xff7a3d];
const IDM_MOTOR = { b: 2.2, T: 1.3, s0: 2 };
const IDM_BIKE = { b: 2, T: 1, s0: 1 };
const STUCK_LIMIT = 45;
const STOP_LINE_BUFFER = 2.8;
const LOOKAHEAD_LIMIT = 70;
/** How far into a sibling connector a vehicle still blocks the shared mouth. */
const SIBLING_WINDOW = 10;
const PEDESTRIAN_YIELD_DISTANCE = 30;
const PEDESTRIAN_STOP_BUFFER = STOP_LINE_BUFFER;

interface SidewalkCorner {
  id: number;
  nodeId: number;
  roadId: number;
  pos: Vec2;
  edges: SidewalkEdge[];
}

interface SidewalkEdge {
  a: SidewalkCorner;
  b: SidewalkCorner;
  points: Vec2[];
  roadId: number;
  crossingNodeId: number | null;
}

export interface Building {
  poly: Vec2[];
  c: Vec2;
  r: number;
}

export class World {
  readonly net: RoadNetwork;
  readonly vehicles: Vehicle[] = [];
  readonly pedestrians: Pedestrian[] = [];
  readonly buildings: Building[];
  /** Vehicles the UI is looking at; never recycled or despawned. */
  readonly protectedIds = new Set<number>();
  time = 0;
  collisionCount = 0;
  private signalScale = 1;
  private readonly rng: Random;
  private readonly pedestrianRng: Random;
  private readonly pedestrianCorners: SidewalkCorner[] = [];
  private readonly pedestrianEdges: SidewalkEdge[] = [];
  private readonly activeCrossings: Pedestrian[] = [];
  private readonly laneIndex = new SpatialHash<Lane>(32);
  private readonly buildingIndex = new SpatialHash<Building>(32);
  private readonly vehicleIndex = new SpatialHash<Vehicle>(16);

  constructor(
    readonly def: MapDef,
    public targetMotor: number,
    public targetBikes: number,
    seed = def.seed,
  ) {
    this.net = new RoadNetwork(def);
    this.rng = new Random(seed * 9973 + 1);
    this.pedestrianRng = new Random(seed * 6151 + 17);
    this.buildings = def.decor
      .filter((d) => d.type === 'building')
      .map((d) => {
        const c = centroid(d.polygon);
        return { poly: d.polygon, c, r: Math.max(...d.polygon.map((p) => distance(p, c))) };
      });
    for (const building of this.buildings) this.buildingIndex.insert(building, building.c.x, building.c.y, building.r);
    for (const lane of this.net.roadLanes) {
      const xs = lane.points.map((p) => p.x);
      const ys = lane.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      this.laneIndex.insert(lane, (minX + maxX) / 2, (minY + maxY) / 2, Math.hypot(maxX - minX, maxY - minY) / 2);
    }
    this.fill();
    this.buildPedestrianNetwork();
    this.fillPedestrians();
  }

  get players(): Vehicle[] {
    return this.vehicles.filter((v) => v.controller === 'player');
  }

  setSignalScale(scale: number): void {
    const next = Math.max(0.5, Math.min(2, scale));
    for (const signal of this.net.signals) signal.scaleGreen(next / this.signalScale);
    this.signalScale = next;
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
    this.updatePedestrians(dt);
    const players = this.players;
    for (const v of this.vehicles) {
      if (v.controller === 'ai') this.driveAI(v, dt, players);
      else this.drivePlayer(v, dt);
    }
    for (const v of this.vehicles) if (v.controller === 'ai') this.advance(v);
    this.vehicleIndex.clear();
    for (const v of this.vehicles) this.vehicleIndex.insert(v, v.pos.x, v.pos.y, v.spec.length / 2);
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
    v.laneChangeCooldown = Math.max(0, v.laneChangeCooldown - dt);
    if (v.laneChange) {
      v.laneChange.progress = Math.min(1, v.laneChange.progress + dt / v.laneChange.duration);
      if (v.laneChange.progress >= 1) {
        v.laneChange = null;
        v.laneChangeCooldown = 2.5;
      }
    }
    const lane = v.lane!;
    const spec = v.spec;
    this.ensureRoute(v);
    const half = spec.length / 2;
    const distToEnd = lane.length - v.s;
    // A reservation is only useful while its holder can actually enter. A newly
    // spawned leader or a red signal may leave it queued well before the stop line;
    // holding the junction in that state blocks every conflicting movement forever.
    if (v.reserved && lane.kind === 'road' && v.speed < 0.25 && v.stuckTime > 2 && distToEnd - half > 1.5) {
      v.reserved.holders.delete(v);
      v.reserved = null;
    }
    const want = spec.desiredSpeed * v.driverFactor;

    // Slow down ahead of curves: the speed we may carry while braking into the next lanes.
    let v0 = Math.min(lane.speedLimit, want);
    let ahead = distToEnd - half;
    for (let i = 0; i < 2 && i < v.route.length; i++) {
      const lim = Math.min(v.route[i].speedLimit, want);
      v0 = Math.min(v0, Math.sqrt(lim * lim + 2 * 1.4 * Math.max(0, ahead)));
      ahead += v.route[i].length;
    }

    if (v.kind === 'bus') {
      if (lane.kind === 'connector') v0 = Math.min(v0, 4.5);
      if (v.stopTimer > 0) {
        v.stopTimer = Math.max(0, v.stopTimer - dt);
        v0 = 0;
      } else if (lane.kind === 'road' && lane.roadId % 7 === 0 && v.lastStopLane !== lane.id && Math.abs(v.s - lane.length * 0.55) < 3) {
        v.stopTimer = 3;
        v.lastStopLane = lane.id;
        v0 = 0;
      }
    }

    const base = v.isBike ? IDM_BIKE : IDM_MOTOR;
    const params: IdmParams = { ...base, a: spec.idmAccel };
    let { gap, speed: leadSpeed } = this.findLeader(v);

    const next = v.route[0];
    if (lane.kind === 'road' && next?.kind === 'connector' && v.reserved !== next) {
      if (!this.tryReserve(v, lane, next, distToEnd)) {
        const stopGap = distToEnd - half + base.s0 - STOP_LINE_BUFFER;
        if (stopGap < gap) {
          gap = stopGap;
          leadSpeed = 0;
        }
      }
    }
    const pedestrianGap = this.pedestrianGap(v, lane, distToEnd, base.s0);
    if (pedestrianGap < gap) {
      gap = pedestrianGap;
      leadSpeed = 0;
    }
    for (const p of players) {
      const g = coneGap(v, p);
      if (g < gap) {
        gap = g;
        leadSpeed = Math.max(0, p.speed);
      }
    }
    if (v.stuckTime < 8) {
      for (const u of this.vehicles) {
        if (u === v || (v.kind !== 'bus' && u.kind !== 'bus')) continue;
        const g = coneGap(v, u);
        if (g < gap) {
          gap = g;
          leadSpeed = Math.max(0, u.speed);
        }
      }
    }

    const acc =
      v.kind === 'bus' && v.stopTimer > 0 && v.speed < 0.15
        ? -spec.maxBrake
        : clamp(idm(v.speed, Math.max(v0, 0.05), gap, v.speed - leadSpeed, params), -spec.maxBrake * 1.3, spec.idmAccel);

    // Pure pursuit towards a point further along the route.
    const ld = v.kind === 'bus' && lane.kind === 'connector' ? 3.5 : clamp(v.speed * 0.9, 3.5, 12);
    const target = this.pathPoint(v, v.s + ld);
    const dx = target.x - v.pos.x;
    const dy = target.y - v.pos.y;
    const c = Math.cos(v.heading);
    const sn = Math.sin(v.heading);
    const alpha = Math.atan2(-dx * sn + dy * c, dx * c + dy * sn);
    const steer = Math.atan2(2 * spec.wheelbase * Math.sin(alpha), Math.max(Math.hypot(dx, dy), 0.5));

    v.integrate(dt, acc, clamp(steer, -spec.maxSteer, spec.maxSteer), 3, 0);
    this.considerLaneChange(v, params, v0);
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
          const us = occupancyS(u, l);
          if (l !== lane && us > SIBLING_WINDOW) continue;
          if (i < 0 && (us < v.s || (us === v.s && u.id < v.id))) continue;
          if (lane.kind === 'road' && u.isBike !== v.isBike) continue;
          const g = base + us - half - u.spec.length / 2;
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
    if (this.activeCrossings.some((p) => this.connectorConflictsWithCrossing(conn, p, v.spec.width / 2 + 0.6))) {
      return false;
    }
    for (const u of lane.occupants) if (u !== v && occupancyS(u, lane) > v.s && u.isBike === v.isBike) return false;
    if (lane.signal) {
      const st = lane.signal.ctrl.state(lane.signal.group, conn.turn);
      if (st === 'red') return false;
      if (st === 'yellow' && front > (v.speed * v.speed) / 6 + 0.5) return false;
    }
    for (const k of conn.conflicts) if (k.holders.size > 0) return false;
    if (this.connectorBlockedByVehicle(conn, v, lane)) return false;
    if (conn.turn === 'left' && this.mustYieldToThroughTraffic(v, conn, front)) return false;
    if (!this.hasSpace(conn.next[0], v) || this.wouldCreateWaitCycle(v, conn.next[0])) return false;
    conn.holders.add(v);
    v.reserved = conn;
    return true;
  }

  private hasSpace(out: Lane, v: Vehicle): boolean {
    let free = out.length;
    for (const u of out.occupants) {
      if (u.isBike === v.isBike) free = Math.min(free, occupancyS(u, out) - u.spec.length / 2);
    }
    let need = v.spec.length + 2.5;
    for (const c of out.prev) {
      for (const h of c.holders) if (h !== v && h.isBike === v.isBike) need += h.spec.length + 2.5;
    }
    return free >= need;
  }

  /** Centreline conflict tests miss long bodies waiting at or just beyond a stop line. */
  private connectorBlockedByVehicle(conn: Lane, v: Vehicle, incoming: Lane): boolean {
    const clearance = v.spec.width / 2 + 0.35;
    for (const u of this.vehicles) {
      if (u === v || (u.lane === incoming && occupancyS(u, incoming) <= v.s)) continue;
      const c = Math.cos(u.heading);
      const s = Math.sin(u.heading);
      for (const point of conn.points) {
        const dx = point.x - u.pos.x;
        const dy = point.y - u.pos.y;
        const longitudinal = Math.abs(dx * c + dy * s) - u.spec.length / 2;
        const lateral = Math.abs(-dx * s + dy * c) - u.spec.width / 2;
        if (Math.hypot(Math.max(0, longitudinal), Math.max(0, lateral)) < clearance) return true;
      }
    }
    return false;
  }

  /** MOBIL: change only when the benefit is worth the disturbance and both new gaps are safe. */
  private considerLaneChange(v: Vehicle, params: IdmParams, v0: number): void {
    const lane = v.lane!;
    if (
      v.isBike ||
      v.kind === 'bus' ||
      v.laneChange ||
      v.laneChangeCooldown > 0 ||
      lane.kind !== 'road' ||
      lane.points.length > 2 ||
      lane.laneCount < 2 ||
      v.speed < 2 ||
      lane.length - v.s < 18
    )
      return;
    const current = this.findLeader(v);
    const currentAcc = idm(v.speed, v0, current.gap, v.speed - current.speed, params);
    let best: { lane: Lane; score: number } | null = null;
    for (const target of [lane.left, lane.right]) {
      if (!target) continue;
      let ahead: { gap: number; speed: number } = { gap: Infinity, speed: 0 };
      let behind: { gap: number; vehicle: Vehicle } | null = null;
      for (const u of target.occupants) {
        if (u === v || u.isBike) continue;
        const ds = occupancyS(u, target) - v.s;
        const gap = Math.abs(ds) - (v.spec.length + u.spec.length) / 2;
        if (ds >= 0 && gap < ahead.gap) ahead = { gap, speed: u.speed };
        if (ds < 0 && (!behind || gap < behind.gap)) behind = { gap, vehicle: u };
      }
      if (ahead.gap < Math.max(3, v.speed * 0.45)) continue;
      if (behind && behind.gap < Math.max(4, behind.vehicle.speed * 0.65)) continue;
      const targetAcc = idm(
        v.speed,
        Math.min(v0, target.speedLimit),
        ahead.gap,
        v.speed - ahead.speed,
        params,
      );
      let cooperation = 0;
      if (behind) {
        const follower = behind.vehicle;
        const followerParams: IdmParams = {
          b: 2.2,
          T: 1.3,
          s0: 2,
          a: follower.spec.idmAccel,
        };
        const beforeGap = ahead.gap === Infinity ? Infinity : behind.gap + v.spec.length + ahead.gap;
        const before = idm(
          follower.speed,
          Math.min(target.speedLimit, follower.spec.desiredSpeed * follower.driverFactor),
          beforeGap,
          follower.speed - ahead.speed,
          followerParams,
        );
        const after = idm(
          follower.speed,
          Math.min(target.speedLimit, follower.spec.desiredSpeed * follower.driverFactor),
          behind.gap,
          follower.speed - v.speed,
          followerParams,
        );
        if (after < -2.5) continue;
        cooperation = after - before;
      }
      const score = targetAcc - currentAcc + 0.35 * cooperation;
      if (score > 0.3 && (!best || score > best.score)) best = { lane: target, score };
    }
    if (!best) return;
    const sourcePoint = lane.pointAt(v.s);
    const targetPoint = best.lane.pointAt(v.s);
    const offset = dot({ x: sourcePoint.p.x - targetPoint.p.x, y: sourcePoint.p.y - targetPoint.p.y }, rightOf(targetPoint.t));
    v.laneChange = { from: lane, offset, progress: 0, duration: 1.4 };
    v.lane = best.lane;
    v.route = [];
    v.laneChanges++;
    v.laneChangeCooldown = 4;
    this.ensureRoute(v);
  }

  /** Left turns yield to approaching conflicting through/right movements with an earlier ETA. */
  private mustYieldToThroughTraffic(v: Vehicle, conn: Lane, front: number): boolean {
    const ownEta = front / Math.max(v.speed, 1.5);
    for (const other of conn.conflicts) {
      if (other.turn !== 'straight' && other.turn !== 'right') continue;
      const incoming = other.prev[0];
      if (!incoming) continue;
      for (const u of incoming.occupants) {
        if (u === v || (u.route[0] !== other && u.reserved !== other)) continue;
        if (incoming.signal && incoming.signal.ctrl.state(incoming.signal.group, other.turn) === 'red') continue;
        const otherFront = incoming.length - u.s - u.spec.length / 2;
        if (otherFront < -1) continue;
        // A motionless queue at the stop line is not approaching through traffic;
        // yielding to it forever can create a left-turn/through wait cycle.
        if (u.speed < 0.5 && u.stuckTime > 4 && otherFront < 12) continue;
        const eta = otherFront / Math.max(u.speed, 1.5);
        const threshold = v.stuckTime > 15 ? 0.9 : Math.min(5, ownEta + 1.8);
        if (eta < threshold) return true;
      }
    }
    return false;
  }

  /** Reject reservations that would close a ring of vehicles waiting for occupied exits. */
  private wouldCreateWaitCycle(v: Vehicle, out: Lane): boolean {
    const seen = new Set<Vehicle>();
    const visit = (lane: Lane, depth: number): boolean => {
      if (depth > 20) return false;
      const blockers = lane.occupants
        .filter((u) => u.isBike === v.isBike)
        .sort((a, b) => occupancyS(a, lane) - occupancyS(b, lane));
      for (const blocker of blockers) {
        if (blocker === v) return true;
        if (seen.has(blocker)) continue;
        seen.add(blocker);
        const next = blocker.reserved?.next[0] ??
          (blocker.lane?.kind === 'connector' || blocker.speed < 0.5 ? blocker.route[0]?.next[0] : undefined);
        if (next && visit(next, depth + 1)) return true;
      }
      return false;
    };
    return visit(out, 0);
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
    let offset = v.spec.laneOffset + (v.isBike ? lane.bikeOffset : 0);
    if (v.laneChange && lane === v.lane) {
      const tChange = v.laneChange.progress;
      const smooth = tChange * tChange * (3 - 2 * tChange);
      offset += v.laneChange.offset * (1 - smooth);
    }
    return add(p, scale(rightOf(t), offset));
  }

  /** Re-projects onto the lane after integrating and hands over to the next lane at the end. */
  private advance(v: Vehicle): void {
    let lane = v.lane!;
    let s = lane.project(v.pos, v.s);
    let guard = 0;
    while (s >= lane.length - 0.02 && v.route.length && guard++ < 3) {
      const nl = v.route.shift()!;
      v.trailLane = lane;
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
    if (s > v.spec.length * 1.2) v.trailLane = null;
  }

  private ensureRoute(v: Vehicle): void {
    let guard = 0;
    while (v.route.length < 4 && guard++ < 4) {
      const from = v.route.length ? v.route[v.route.length - 1] : v.lane!;
      const path = findRoute(from, this.rng.pick(this.net.roadLanes), 14, v.isBike ? 'bike' : 'motor', false);
      if (path?.length) v.route.push(...path);
      else {
        const choices = from.next.filter((l) => l.traffic === 'all' || l.traffic === (v.isBike ? 'bike' : 'motor'));
        if (choices.length) v.route.push(this.rng.pick(choices));
        else break;
      }
    }
  }

  private rebuildOccupancy(): void {
    for (const lane of this.net.lanes) lane.occupants.length = 0;
    for (const v of this.vehicles) {
      if (v.controller !== 'ai' || !v.lane) continue;
      v.lane.occupants.push(v);
      if (v.laneChange && !v.laneChange.from.occupants.includes(v)) v.laneChange.from.occupants.push(v);
      if (v.trailLane && !v.trailLane.occupants.includes(v)) v.trailLane.occupants.push(v);
    }
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
    for (const u of this.vehicleIndex.query(p.pos.x, p.pos.y, 8 + p.spec.length / 2)) {
      if (u === p || Math.abs(u.pos.x - p.pos.x) > 8 || Math.abs(u.pos.y - p.pos.y) > 8) continue;
      const mtv = satMTV(p.corners(), u.corners());
      if (mtv) {
        this.collisionCount++;
        bump(p, mtv);
      }
    }
    for (const b of this.buildingIndex.query(p.pos.x, p.pos.y, p.spec.length)) {
      if (distance(b.c, p.pos) > b.r + p.spec.length) continue;
      const mtv = satMTV(p.corners(), b.poly);
      if (mtv) {
        this.collisionCount++;
        bump(p, mtv);
      }
    }
    const bd = this.def.bounds;
    p.pos.x = clamp(p.pos.x, bd.minX - 30, bd.maxX + 30);
    p.pos.y = clamp(p.pos.y, bd.minY - 30, bd.maxY + 30);
  }

  private nearestLane(v: Vehicle): { lane: Lane; s: number } {
    let best = { lane: this.net.roadLanes[0], s: 0 };
    let bestScore = Infinity;
    let radius = 32;
    let candidates = this.laneIndex.query(v.pos.x, v.pos.y, radius);
    while (!candidates.length && radius < 2048) {
      radius *= 2;
      candidates = this.laneIndex.query(v.pos.x, v.pos.y, radius);
    }
    for (const lane of candidates) {
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

  // ---------------------------------------------------------------- pedestrians

  /** Builds two sidewalk polylines per road and a corner/crosswalk graph at every node. */
  private buildPedestrianNetwork(): void {
    const cornersByNode = new Map<number, SidewalkCorner[]>();
    const addCorner = (nodeId: number, roadId: number, pos: Vec2): SidewalkCorner => {
      const corner: SidewalkCorner = { id: this.pedestrianCorners.length, nodeId, roadId, pos: { ...pos }, edges: [] };
      this.pedestrianCorners.push(corner);
      const list = cornersByNode.get(nodeId) ?? [];
      list.push(corner);
      cornersByNode.set(nodeId, list);
      return corner;
    };

    for (const road of this.def.roads) {
      const from = this.net.nodes.get(road.from);
      const to = this.net.nodes.get(road.to);
      const lane = this.net.roadLanes.find(
        (candidate) => candidate.roadId === road.id && candidate.nodeId === road.to && candidate.laneIndex === 0,
      );
      if (!from || !to || !lane) continue;
      const centreline = offsetPolyline(lane.points, -laneCenterOffset(road, lane.laneIndex));
      const sidewalkOffset = Math.max(from.halfWidth, to.halfWidth) + 2;
      for (const side of [-1, 1] as const) {
        const points = offsetPolyline(centreline, side * sidewalkOffset);
        const a = addCorner(road.from, road.id, points[0]);
        const b = addCorner(road.to, road.id, points[points.length - 1]);
        this.addPedestrianEdge(a, b, points, null, road.id);
      }
    }

    for (const [nodeId, corners] of cornersByNode) {
      const node = this.net.nodes.get(nodeId)!;
      corners.sort(
        (a, b) =>
          Math.atan2(a.pos.y - node.pos.y, a.pos.x - node.pos.x) -
          Math.atan2(b.pos.y - node.pos.y, b.pos.x - node.pos.x),
      );
      // Two corners have only one unique connection; larger rings include the closing edge.
      const count = corners.length === 2 ? 1 : corners.length;
      for (let i = 0; i < count; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        if (a.roadId === b.roadId) {
          // Opposite corners of one road form a zebra crossing at the stop-line plane.
          this.addPedestrianEdge(a, b, [a.pos, b.pos], nodeId, a.roadId);
        } else {
          // Adjacent road corners follow the outside of the intersection, not its asphalt.
          this.addPedestrianEdge(a, b, sidewalkArc(node.pos, a.pos, b.pos));
        }
      }
    }
  }

  private addPedestrianEdge(
    a: SidewalkCorner,
    b: SidewalkCorner,
    points: Vec2[],
    crossingNodeId: number | null = null,
    roadId = -1,
  ): void {
    const edge: SidewalkEdge = { a, b, points: points.map((p) => ({ ...p })), crossingNodeId, roadId };
    this.pedestrianEdges.push(edge);
    a.edges.push(edge);
    b.edges.push(edge);
  }

  private fillPedestrians(): void {
    const edges = this.pedestrianEdges.filter(
      (edge) => edge.crossingNodeId === null && polylineLength(edge.points) > 0.5,
    );
    if (!edges.length) return;
    const count = Math.min(60, this.net.nodes.size * 2);
    for (let i = 0; i < count; i++) {
      const edge = this.pedestrianRng.pick(edges);
      const forward = this.pedestrianRng.chance(0.5);
      const from = forward ? edge.a : edge.b;
      const to = forward ? edge.b : edge.a;
      const points = forward ? edge.points : [...edge.points].reverse();
      const sample = samplePolyline(points, this.pedestrianRng.range(0, polylineLength(points)));
      const path = [sample.point, ...points.slice(sample.nextIndex)];
      this.pedestrians.push(new Pedestrian(i + 1, path, this.pedestrianRng.range(1.2, 1.6), to.id, from.id));
    }
  }

  private updatePedestrians(dt: number): void {
    for (const pedestrian of this.pedestrians) {
      pedestrian.prevPos.x = pedestrian.pos.x;
      pedestrian.prevPos.y = pedestrian.pos.y;
      if (pedestrian.state === 'waiting') {
        if (pedestrian.crossingNodeId === null || !this.canStartCrossing(pedestrian)) continue;
        pedestrian.state = 'crossing';
      }

      let remaining = pedestrian.speed * dt;
      let guard = 0;
      while (remaining > 1e-8 && guard++ < 12) {
        const target = pedestrian.path[pedestrian.pathIndex];
        if (!target) {
          this.startNextPedestrianEdge(pedestrian);
          if ((pedestrian.state as Pedestrian['state']) === 'waiting') {
            if (pedestrian.crossingNodeId === null || !this.canStartCrossing(pedestrian)) break;
            pedestrian.state = 'crossing';
          }
          continue;
        }
        const dx = target.x - pedestrian.pos.x;
        const dy = target.y - pedestrian.pos.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-8) {
          pedestrian.pathIndex++;
          continue;
        }
        const amount = Math.min(remaining, d);
        pedestrian.pos.x += (dx / d) * amount;
        pedestrian.pos.y += (dy / d) * amount;
        pedestrian.heading = Math.atan2(dy, dx);
        if (pedestrian.state === 'crossing') {
          const length = Math.max(0.001, distance(pedestrian.path[0], pedestrian.path[pedestrian.path.length - 1]));
          pedestrian.crossingProgress = clamp(pedestrian.crossingProgress + amount / length, 0, 1);
        }
        remaining -= amount;
        if (amount >= d - 1e-8) {
          pedestrian.pos.x = target.x;
          pedestrian.pos.y = target.y;
          pedestrian.pathIndex++;
        }
      }
    }
    this.activeCrossings.length = 0;
    for (const pedestrian of this.pedestrians) {
      if (pedestrian.state === 'crossing') this.activeCrossings.push(pedestrian);
    }
  }

  private startNextPedestrianEdge(pedestrian: Pedestrian): void {
    const corner = this.pedestrianCorners[pedestrian.targetCornerId];
    if (!corner || !corner.edges.length) {
      pedestrian.state = 'waiting';
      pedestrian.crossingNodeId = null;
      pedestrian.crossingRoadId = null;
      pedestrian.path = [{ ...pedestrian.pos }];
      pedestrian.pathIndex = 1;
      return;
    }
    const withoutBacktrack = corner.edges.filter((edge) => {
      const other = edge.a === corner ? edge.b : edge.a;
      return other.id !== pedestrian.previousCornerId;
    });
    const edge = this.pedestrianRng.pick(withoutBacktrack.length ? withoutBacktrack : corner.edges);
    const forward = edge.a === corner;
    const next = forward ? edge.b : edge.a;
    const points = forward ? edge.points : [...edge.points].reverse();
    pedestrian.previousCornerId = corner.id;
    pedestrian.targetCornerId = next.id;
    pedestrian.path = points.map((p) => ({ ...p }));
    pedestrian.pathIndex = 1;
    pedestrian.pos.x = pedestrian.path[0].x;
    pedestrian.pos.y = pedestrian.path[0].y;
    pedestrian.crossingNodeId = edge.crossingNodeId;
    pedestrian.crossingRoadId = edge.crossingNodeId === null ? null : edge.roadId;
    pedestrian.crossingProgress = 0;
    pedestrian.state = edge.crossingNodeId === null ? 'walking' : 'waiting';
    const target = pedestrian.path[1];
    if (target) pedestrian.heading = Math.atan2(target.y - pedestrian.pos.y, target.x - pedestrian.pos.x);
  }

  /** A pedestrian commits only when nearby traffic can stop or has already cleared the node. */
  private canStartCrossing(pedestrian: Pedestrian): boolean {
    const nodeId = pedestrian.crossingNodeId;
    const node = nodeId === null ? undefined : this.net.nodes.get(nodeId);
    if (!node) return false;
    for (const vehicle of this.vehicles) {
      if (vehicle.reserved?.nodeId === nodeId) return false;
      if (vehicle.lane?.kind === 'connector' && vehicle.lane.nodeId === nodeId) return false;
      if (vehicle.trailLane?.kind === 'connector' && vehicle.trailLane.nodeId === nodeId) return false;
      if (vehicle.lane?.kind === 'road' && vehicle.lane.nodeId === nodeId) {
        const front = vehicle.lane.length - vehicle.s - vehicle.spec.length / 2;
        const speed = Math.max(0, vehicle.speed);
        const brakingDistance = (speed * speed) / (2 * vehicle.spec.maxBrake);
        if (front < Math.max(7, brakingDistance + 3)) return false;
      }
      if (vehicle.controller === 'player') {
        if (distance(vehicle.pos, node.pos) < 32 + vehicle.spec.length / 2) return false;
        const a = pedestrian.path[0];
        const b = pedestrian.path[1];
        if (a && b && distanceToSegment(vehicle.pos, a, b) < vehicle.spec.length / 2 + 1) return false;
      }
    }
    return true;
  }

  /** Virtual IDM obstacle at an occupied crosswalk, both on approach and inside a connector. */
  private pedestrianGap(vehicle: Vehicle, lane: Lane, distToEnd: number, standstillGap: number): number {
    let gap = Infinity;
    const front = distToEnd - vehicle.spec.length / 2;
    if (lane.kind === 'road' && front <= PEDESTRIAN_YIELD_DISTANCE) {
      for (const pedestrian of this.activeCrossings) {
        if (pedestrian.crossingNodeId !== lane.nodeId) continue;
        const next = vehicle.route[0];
        const conflicts =
          lane.roadId === pedestrian.crossingRoadId ||
          (next?.kind === 'connector' &&
            this.connectorConflictsWithCrossing(next, pedestrian, vehicle.spec.width / 2 + 0.6));
        if (!conflicts) continue;
        gap = Math.min(gap, front + standstillGap - PEDESTRIAN_STOP_BUFFER);
      }
    } else if (lane.kind === 'connector') {
      const node = this.net.nodes.get(lane.nodeId);
      const tangent = lane.pointAt(vehicle.s).t;
      for (const pedestrian of this.activeCrossings) {
        if (pedestrian.crossingNodeId !== lane.nodeId) continue;
        if (!this.connectorConflictsWithCrossing(lane, pedestrian, vehicle.spec.width / 2 + 0.6)) continue;
        const delta = sub(pedestrian.pos, vehicle.pos);
        const forward = dot(delta, tangent);
        const lateral = dot(delta, rightOf(tangent));
        if (forward <= 0 || forward > PEDESTRIAN_YIELD_DISTANCE) continue;
        if (Math.abs(lateral) > (node?.halfWidth ?? LANE_WIDTH) + 2) continue;
        gap = Math.min(gap, Math.max(0.01, forward - vehicle.spec.length / 2 - 0.6));
      }
    }
    return gap;
  }

  private connectorConflictsWithCrossing(connector: Lane, pedestrian: Pedestrian, clearance: number): boolean {
    if (connector.kind !== 'connector' || connector.nodeId !== pedestrian.crossingNodeId) return false;
    const a = pedestrian.path[0];
    const b = pedestrian.path[pedestrian.path.length - 1];
    if (!a || !b) return false;
    for (const point of connector.points) {
      if (distanceToSegment(point, a, b) <= clearance) return true;
    }
    return false;
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
    const r = this.rng.next();
    if (r < 0.06) return 'bus';
    if (r < 0.16) return 'van';
    if (r < 0.28) return 'taxi';
    if (r < 0.36) return 'motorcycle';
    return 'car';
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
    for (const u of lane.occupants) if (Math.abs(occupancyS(u, lane) - s) < 12) return false;
    const spec = SPECS[kind];
    const { p, t } = lane.pointAt(s);
    const pos = add(p, scale(rightOf(t), spec.laneOffset));
    for (const q of players) if (distance(q.pos, pos) < 25) return false;
    const colors = kind === 'bike' ? BIKE_COLORS : MOTOR_COLORS;
    const color = kind === 'taxi' ? 0xf0b429 : this.rng.pick(colors);
    const v = new Vehicle(kind, pos, angleOf(t), color, this.rng.range(0.85, 1.1));
    // Lane spacing alone misses crossing lanes and reserved approaches at junctions.
    if (lane.next.some((connector) => connector.holders.size > 0)) return false;
    for (const u of this.vehicles) {
      if (distance(u.pos, pos) > (u.spec.length + spec.length) / 2 + 1) continue;
      if (satMTV(v.corners(), u.corners())) return false;
    }
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
    v.laneChange = null;
    v.trailLane = null;
    v.lane = null;
    v.route = [];
  }
}

function occupancyS(v: Vehicle, lane: Lane): number {
  return v.lane === lane || v.laneChange?.from === lane ? v.s : lane.length + Math.max(0, v.s - v.spec.length);
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

function offsetPolyline(points: Vec2[], offset: number): Vec2[] {
  return points.map((point, i) => {
    const before = points[Math.max(0, i - 1)];
    const after = points[Math.min(points.length - 1, i + 1)];
    const tangent = normalize(sub(after, before));
    return add(point, scale(rightOf(tangent), offset));
  });
}

/** Arc outside a node between two adjacent sidewalk corners. */
function sidewalkArc(centre: Vec2, a: Vec2, b: Vec2): Vec2[] {
  const start = Math.atan2(a.y - centre.y, a.x - centre.x);
  const end = Math.atan2(b.y - centre.y, b.x - centre.x);
  let sweep = end - start;
  if (Math.abs(sweep) < 1e-8) return [{ ...a }, { ...b }];
  while (sweep < 0) sweep += Math.PI * 2;
  const radiusA = distance(centre, a);
  const radiusB = distance(centre, b);
  const steps = Math.max(1, Math.ceil((sweep * Math.max(radiusA, radiusB)) / 3));
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const direction = fromAngle(start + sweep * t);
    points.push(add(centre, scale(direction, lerp(radiusA, radiusB, t))));
  }
  points[0] = { ...a };
  points[points.length - 1] = { ...b };
  return points;
}

function polylineLength(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length;
}

function samplePolyline(points: Vec2[], s: number): { point: Vec2; nextIndex: number } {
  let remaining = clamp(s, 0, polylineLength(points));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = distance(a, b);
    if (remaining <= length || i === points.length - 1) {
      const t = length > 1e-9 ? clamp(remaining / length, 0, 1) : 0;
      return { point: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }, nextIndex: i };
    }
    remaining -= length;
  }
  return { point: { ...points[0] }, nextIndex: 1 };
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  const t = lengthSquared > 1e-9 ? clamp(dot(sub(p, a), ab) / lengthSquared, 0, 1) : 0;
  return distance(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
