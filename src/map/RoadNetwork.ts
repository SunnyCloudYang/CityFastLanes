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
import { INTERSECTION_RADIUS, LANE_WIDTH, ROAD_HALF_WIDTH } from './constants';
import { Lane, type TurnType } from './Lane';
import { SignalController } from './Signals';
import type { MapDef } from './types';

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
}

const LATERAL_ACCEL = 2.5;
const CONFLICT_DISTANCE = 2.4;

export class RoadNetwork {
  readonly nodes = new Map<number, NetNode>();
  readonly lanes: Lane[] = [];
  readonly roadLanes: Lane[] = [];
  readonly connectors: Lane[] = [];
  readonly signals: SignalController[] = [];
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
      });
    }
    for (const road of def.roads) this.addRoad(road.id, road.from, road.to, road.speedLimit);
    for (const node of this.nodes.values()) {
      if (node.dirs.length === 0) continue;
      this.buildConnectors(node);
      computeConflicts(node.connectors);
      node.polygon = nodePolygon(node);
      if (node.dirs.length >= 3) this.addSignal(node);
    }
  }

  private makeLane(kind: 'road' | 'connector', points: Vec2[], speedLimit: number): Lane {
    const lane = new Lane(this.nextId++, kind, points, speedLimit);
    this.lanes.push(lane);
    (kind === 'road' ? this.roadLanes : this.connectors).push(lane);
    return lane;
  }

  private addRoad(roadId: number, fromId: number, toId: number, speedLimit: number): void {
    const a = this.nodes.get(fromId);
    const b = this.nodes.get(toId);
    if (!a || !b) return;
    const d = normalize(sub(b.pos, a.pos));
    const n = rightOf(d);
    const h = LANE_WIDTH / 2;
    const r = INTERSECTION_RADIUS;
    const forward = this.makeLane(
      'road',
      [add(add(a.pos, scale(d, r)), scale(n, h)), add(sub(b.pos, scale(d, r)), scale(n, h))],
      speedLimit,
    );
    const backward = this.makeLane(
      'road',
      [sub(sub(b.pos, scale(d, r)), scale(n, h)), sub(add(a.pos, scale(d, r)), scale(n, h))],
      speedLimit,
    );
    forward.roadId = backward.roadId = roadId;
    forward.nodeId = b.id;
    backward.nodeId = a.id;
    a.outgoing.push(forward);
    b.incoming.push(forward);
    b.outgoing.push(backward);
    a.incoming.push(backward);
    a.dirs.push(d);
    b.dirs.push(scale(d, -1));
  }

  private buildConnectors(node: NetNode): void {
    for (const lin of node.incoming) {
      for (const lout of node.outgoing) {
        const uturn = lout.roadId === lin.roadId;
        if (uturn && node.dirs.length > 1) continue;
        const p0 = lin.end;
        const p3 = lout.start;
        const dIn = lin.pointAt(lin.length).t;
        const dOut = lout.pointAt(0).t;
        const chord = distance(p0, p3);
        const k = Math.max(chord * 0.42, uturn ? 6 : 0);
        const p1 = add(p0, scale(dIn, k));
        const p2 = sub(p3, scale(dOut, k));
        const steps = Math.max(6, Math.ceil(chord));
        const pts: Vec2[] = [];
        for (let i = 0; i <= steps; i++) pts.push(bezier(p0, p1, p2, p3, i / steps));

        const turn: TurnType = uturn
          ? 'uturn'
          : dot(dIn, dOut) > 0.7
            ? 'straight'
            : cross(dIn, dOut) > 0
              ? 'right'
              : 'left';
        const base = Math.min(lin.speedLimit, lout.speedLimit);
        const limit = turn === 'straight' ? base : Math.min(base, Math.sqrt(LATERAL_ACCEL * minRadius(pts)));
        const c = this.makeLane('connector', pts, limit);
        c.turn = turn;
        c.nodeId = node.id;
        lin.next.push(c);
        c.prev.push(lin);
        c.next.push(lout);
        lout.prev.push(c);
        node.connectors.push(c);
      }
    }
  }

  private addSignal(node: NetNode): void {
    const ctrl = new SignalController(node.id, (node.id * 7.3) % 37);
    node.signal = ctrl;
    this.signals.push(ctrl);
    const ref = angleOf(node.incoming[0].pointAt(node.incoming[0].length).t);
    for (const lane of node.incoming) {
      let diff = Math.abs(wrapAngle(angleOf(lane.pointAt(lane.length).t) - ref));
      if (diff > Math.PI / 2) diff = Math.PI - diff;
      lane.signal = { ctrl, group: diff < Math.PI / 4 ? 0 : 1 };
    }
  }
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
      if (a.prev[0] === b.prev[0]) continue;
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
    pts.push(add(c, scale(n, ROAD_HALF_WIDTH)), sub(c, scale(n, ROAD_HALF_WIDTH)));
  }
  return convexHull(pts);
}
