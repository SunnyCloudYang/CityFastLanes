import {
  add,
  angleOf,
  convexHull,
  cross,
  distance,
  dot,
  normalize,
  rightOf,
  scale,
  sub,
  wrapAngle,
  type Vec2,
} from '../core/math';
import { INTERSECTION_RADIUS, LANE_WIDTH, laneCenterOffset, roadHalfWidth } from './constants';
import { Lane, type TurnType } from './Lane';
import { SignalController, type SignalPhase } from './Signals';
import type { MapDef, MapRoad } from './types';

export interface NetNode {
  id: number;
  pos: Vec2;
  /** Outward unit directions of every road touching this node. */
  dirs: Vec2[];
  incoming: Lane[];
  outgoing: Lane[];
  connectors: Lane[];
  /** Asphalt footprint of the intersection. */
  polygon: Vec2[];
  signal: SignalController | null;
  signalPhases?: SignalPhase[];
  halfWidth: number;
}

const LATERAL_ACCEL = 2.5;
const CONFLICT_DISTANCE = 3.2;
const CURVE_LOOKUP_STEPS = 128;
const MIN_CURVE_SEGMENTS = 16;

interface RoadGeometry {
  points: Vec2[];
  tangents: Vec2[];
}

interface LaneTangents {
  start: Vec2;
  end: Vec2;
}

export class RoadNetwork {
  readonly nodes = new Map<number, NetNode>();
  readonly lanes: Lane[] = [];
  readonly roadLanes: Lane[] = [];
  readonly connectors: Lane[] = [];
  readonly signals: SignalController[] = [];
  private readonly roadTangents = new Map<Lane, LaneTangents>();
  private nextId = 0;

  constructor(readonly def: MapDef) {
    for (const n of def.nodes) {
      this.nodes.set(n.id, {
        id: n.id,
        pos: { x: n.x, y: n.y },
        dirs: [],
        incoming: [],
        outgoing: [],
        connectors: [],
        polygon: [],
        signal: null,
        signalPhases: n.signalPhases,
        halfWidth: LANE_WIDTH,
      });
    }
    for (const road of def.roads) this.addRoad(road);
    for (const node of this.nodes.values()) {
      if (node.dirs.length === 0) continue;
      this.buildConnectors(node);
      computeConflicts(node.connectors);
      node.polygon = nodePolygon(node);
      if (node.dirs.length >= 3 && node.incoming.length > 0) this.addSignal(node);
    }
  }

  private makeLane(kind: 'road' | 'connector', points: Vec2[], speedLimit: number): Lane {
    const lane = new Lane(this.nextId++, kind, points, speedLimit);
    this.lanes.push(lane);
    (kind === 'road' ? this.roadLanes : this.connectors).push(lane);
    return lane;
  }

  private addRoad(road: MapRoad): void {
    const a = this.nodes.get(road.from);
    const b = this.nodes.get(road.to);
    if (!a || !b) return;
    const geometry = roadGeometry(a.pos, b.pos, road.control);
    if (!geometry) return;
    const count = Math.max(1, Math.floor(road.lanes ?? 1));
    const forward: Lane[] = [];
    const backward: Lane[] = [];
    const last = geometry.points.length - 1;
    for (let i = 0; i < count; i++) {
      const h = laneCenterOffset(road, i);
      const f = this.makeLane('road', offsetPoints(geometry, h), road.speedLimit);
      this.setRoadMetadata(f, road, i, count, b.id);
      this.roadTangents.set(f, { start: geometry.tangents[0], end: geometry.tangents[last] });
      forward.push(f);
      a.outgoing.push(f);
      b.incoming.push(f);

      if (!road.oneWay) {
        const back = this.makeLane('road', offsetPoints(geometry, -h).reverse(), road.speedLimit);
        this.setRoadMetadata(back, road, i, count, a.id);
        this.roadTangents.set(back, {
          start: scale(geometry.tangents[last], -1),
          end: scale(geometry.tangents[0], -1),
        });
        backward.push(back);
        b.outgoing.push(back);
        a.incoming.push(back);
      }
    }
    linkSiblings(forward);
    linkSiblings(backward);
    a.dirs.push(geometry.tangents[0]);
    b.dirs.push(scale(geometry.tangents[last], -1));
    a.halfWidth = b.halfWidth = Math.max(a.halfWidth, roadHalfWidth(road));
  }

  private setRoadMetadata(lane: Lane, road: MapRoad, index: number, count: number, nodeId: number): void {
    lane.roadId = road.id;
    lane.laneIndex = index;
    lane.laneCount = count;
    lane.nodeId = nodeId;
  }

  private startTangent(lane: Lane): Vec2 {
    return this.roadTangents.get(lane)?.start ?? lane.pointAt(0).t;
  }

  private endTangent(lane: Lane): Vec2 {
    return this.roadTangents.get(lane)?.end ?? lane.pointAt(lane.length).t;
  }

  private buildConnectors(node: NetNode, fallbackFor: Lane | null = null): void {
    for (const lin of node.incoming) {
      if (fallbackFor && lin !== fallbackFor) continue;
      for (const lout of node.outgoing) {
        const uturn = lout.roadId === lin.roadId;
        if (uturn && node.dirs.length > 1) continue;
        const p0 = lin.end;
        const p3 = lout.start;
        const dIn = this.endTangent(lin);
        const dOut = this.startTangent(lout);
        const turn: TurnType = uturn
          ? 'uturn'
          : dot(dIn, dOut) > 0.7
            ? 'straight'
            : cross(dIn, dOut) > 0
              ? 'right'
              : 'left';
        if (!laneServesTurn(lin, lout, turn, fallbackFor !== null)) continue;
        const chord = distance(p0, p3);
        const k = Math.max(chord * 0.42, uturn ? 6 : 0);
        const p1 = add(p0, scale(dIn, k));
        const p2 = sub(p3, scale(dOut, k));
        const steps = Math.max(6, Math.ceil(chord));
        const pts: Vec2[] = [];
        for (let i = 0; i <= steps; i++) pts.push(bezier(p0, p1, p2, p3, i / steps));

        const base = Math.min(lin.speedLimit, lout.speedLimit);
        const limit = turn === 'straight' ? base : Math.min(base, Math.sqrt(LATERAL_ACCEL * minRadius(pts)));
        for (const traffic of ['motor', 'bike'] as const) {
          const c = this.makeLane('connector', pts.map((p) => ({ ...p })), limit);
          c.turn = turn;
          c.traffic = traffic;
          c.bikeOffset = traffic === 'bike' ? 0.55 : 0;
          c.nodeId = node.id;
          lin.next.push(c);
          c.prev.push(lin);
          c.next.push(lout);
          lout.prev.push(c);
          node.connectors.push(c);
        }
      }
    }
    if (!fallbackFor) {
      for (const lane of node.incoming) if (lane.next.length === 0) this.buildConnectors(node, lane);
    }
  }

  private addSignal(node: NetNode): void {
    const ctrl = new SignalController(node.id, (node.id * 7.3) % 37, node.signalPhases);
    node.signal = ctrl;
    this.signals.push(ctrl);
    const ref = angleOf(this.endTangent(node.incoming[0]));
    for (const lane of node.incoming) {
      let diff = Math.abs(wrapAngle(angleOf(this.endTangent(lane)) - ref));
      if (diff > Math.PI / 2) diff = Math.PI - diff;
      lane.signal = { ctrl, group: diff < Math.PI / 4 ? 0 : 1 };
    }
  }
}

function roadGeometry(a: Vec2, b: Vec2, control?: Vec2): RoadGeometry | null {
  if (!control) {
    const delta = sub(b, a);
    const total = Math.hypot(delta.x, delta.y);
    if (total < 1e-6) return null;
    const tangent = scale(delta, 1 / total);
    // Leave a short positive centre section even when the nodes are closer than two radii.
    const trim = Math.min(INTERSECTION_RADIUS, total * 0.45);
    return {
      points: [add(a, scale(tangent, trim)), sub(b, scale(tangent, trim))],
      tangents: [tangent, tangent],
    };
  }

  const lookup: Vec2[] = [];
  const cumulative: number[] = [0];
  for (let i = 0; i <= CURVE_LOOKUP_STEPS; i++) {
    const point = quadratic(a, control, b, i / CURVE_LOOKUP_STEPS);
    lookup.push(point);
    if (i > 0) cumulative.push(cumulative[i - 1] + distance(lookup[i - 1], point));
  }
  const total = cumulative[CURVE_LOOKUP_STEPS];
  if (total < 1e-6) return null;
  const trim = Math.min(INTERSECTION_RADIUS, total * 0.45);
  const startT = parameterAtLength(lookup, cumulative, trim);
  const endT = parameterAtLength(lookup, cumulative, total - trim);
  const steps = Math.max(MIN_CURVE_SEGMENTS, Math.ceil((total - trim * 2) / 3));
  const points: Vec2[] = [];
  const tangents: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = startT + ((endT - startT) * i) / steps;
    points.push(quadratic(a, control, b, t));
    tangents.push(quadraticTangent(a, control, b, t));
  }
  return { points, tangents };
}

function offsetPoints(geometry: RoadGeometry, offset: number): Vec2[] {
  return geometry.points.map((point, i) => add(point, scale(rightOf(geometry.tangents[i]), offset)));
}

function quadratic(a: Vec2, control: Vec2, b: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
  };
}

function quadraticTangent(a: Vec2, control: Vec2, b: Vec2, t: number): Vec2 {
  const d = {
    x: 2 * ((1 - t) * (control.x - a.x) + t * (b.x - control.x)),
    y: 2 * ((1 - t) * (control.y - a.y) + t * (b.y - control.y)),
  };
  return Math.hypot(d.x, d.y) > 1e-9 ? normalize(d) : normalize(sub(b, a));
}

function parameterAtLength(points: Vec2[], cumulative: number[], target: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= target) lo = mid;
    else hi = mid;
  }
  const segment = cumulative[hi] - cumulative[lo];
  const t = segment > 1e-9 ? (target - cumulative[lo]) / segment : 0;
  return (lo + Math.max(0, Math.min(1, t))) / (points.length - 1);
}

function linkSiblings(lanes: Lane[]): void {
  for (let i = 0; i < lanes.length; i++) {
    lanes[i].left = i > 0 ? lanes[i - 1] : null;
    lanes[i].right = i < lanes.length - 1 ? lanes[i + 1] : null;
  }
}

function laneServesTurn(lin: Lane, lout: Lane, turn: TurnType, relaxed: boolean): boolean {
  if (turn === 'straight' || turn === 'uturn') return lout.laneIndex === Math.min(lin.laneIndex, lout.laneCount - 1);
  if (turn === 'left') return (relaxed || lin.laneIndex === 0) && lout.laneIndex === 0;
  return (relaxed || lin.laneIndex === lin.laneCount - 1) && lout.laneIndex === lout.laneCount - 1;
}

function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function minRadius(pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const area2 = Math.abs(cross(sub(b, a), sub(c, a)));
    if (area2 < 1e-9) continue;
    best = Math.min(best, (distance(a, b) * distance(b, c) * distance(c, a)) / (2 * area2));
  }
  return best;
}

function computeConflicts(connectors: Lane[]): void {
  for (let i = 0; i < connectors.length; i++) {
    for (let j = i + 1; j < connectors.length; j++) {
      const a = connectors[i];
      const b = connectors[j];
      if (a.prev[0] === b.prev[0] && a.traffic === b.traffic) continue;
      if (a.next[0] === b.next[0] || pathsClose(a.points, b.points, CONFLICT_DISTANCE)) {
        a.conflicts.push(b);
        b.conflicts.push(a);
      }
    }
  }
}

function pathsClose(a: Vec2[], b: Vec2[], d: number): boolean {
  const d2 = d * d;
  for (const p of a) {
    for (const q of b) {
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      if (dx * dx + dy * dy < d2) return true;
    }
  }
  return false;
}

function nodePolygon(node: NetNode): Vec2[] {
  const pts: Vec2[] = [];
  for (const d of node.dirs) {
    const n = rightOf(d);
    const c = add(node.pos, scale(d, INTERSECTION_RADIUS + 0.5));
    pts.push(add(c, scale(n, node.halfWidth)), sub(c, scale(n, node.halfWidth)));
  }
  return convexHull(pts);
}
