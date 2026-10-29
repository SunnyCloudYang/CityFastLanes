import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { distance, dot, scale, sub, type Vec2 } from '../src/core/math';
import { LANE_WIDTH } from '../src/map/constants';
import type { Lane } from '../src/map/Lane';
import { parseMap, serializeMap } from '../src/map/MapJson';
import { MAPS } from '../src/map/maps';
import { findRoute } from '../src/map/Pathfinding';
import { RoadNetwork } from '../src/map/RoadNetwork';
import { buildScene } from '../src/render/SceneBuilder';
import { generateOrganic } from '../src/map/generators/organic';
import { generateRadial } from '../src/map/generators/radial';
import { generateRing } from '../src/map/generators/ring';
import type { MapDef } from '../src/map/types';

function twoNodeMap(control?: Vec2, oneWay = false): MapDef {
  return {
    version: 1,
    id: 'curve-test',
    name: 'Curve test',
    seed: 1,
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 100, y: 0 },
    ],
    roads: [{ id: 4, from: 0, to: 1, speedLimit: 14, lanes: 2, control, oneWay }],
    decor: [],
    bounds: { minX: -20, minY: -20, maxX: 120, maxY: 60 },
  };
}

function reachableRoadLaneCount(start: Lane, total: number): number {
  const seen = new Set<Lane>([start]);
  const stack = [start];
  while (stack.length) {
    const lane = stack.pop()!;
    const edges = [...lane.next];
    if (lane.kind === 'road') {
      if (lane.left) edges.push(lane.left);
      if (lane.right) edges.push(lane.right);
    }
    for (const next of edges) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  let count = 0;
  for (const lane of seen) if (lane.kind === 'road') count++;
  expect(count).toBeLessThanOrEqual(total);
  return count;
}

describe('M3 curved road network', () => {
  it('samples trimmed quadratic curves and offsets both directions by whole lane widths', () => {
    const net = new RoadNetwork(twoNodeMap({ x: 50, y: 40 }));
    expect(net.roadLanes).toHaveLength(4);
    const forward = net.roadLanes.filter((lane) => lane.start.x < lane.end.x).sort((a, b) => a.laneIndex - b.laneIndex);
    const backward = net.roadLanes.filter((lane) => lane.start.x > lane.end.x).sort((a, b) => a.laneIndex - b.laneIndex);
    expect(forward).toHaveLength(2);
    expect(backward).toHaveLength(2);
    for (const lane of net.roadLanes) {
      expect(lane.points.length).toBeGreaterThanOrEqual(17);
      expect(lane.length).toBeGreaterThan(0);
      expect(Number.isFinite(lane.length)).toBe(true);
      expect(lane.next.length).toBeGreaterThan(0);
    }
    for (let i = 0; i < 2; i++) {
      const mirrored = [...backward[i].points].reverse();
      for (let p = 0; p < forward[i].points.length; p++) {
        expect(distance(forward[i].points[p], mirrored[p])).toBeCloseTo((i * 2 + 1) * LANE_WIDTH, 8);
        expect(distance(forward[0].points[p], forward[1].points[p])).toBeCloseTo(LANE_WIDTH, 8);
      }
    }
    expect(dot(net.nodes.get(0)!.dirs[0], forward[0].pointAt(0).t)).toBeGreaterThan(0.99);
    expect(dot(net.nodes.get(1)!.dirs[0], scale(forward[0].pointAt(forward[0].length).t, -1))).toBeGreaterThan(0.99);
    for (const node of net.nodes.values()) expect(Math.hypot(node.dirs[0].x, node.dirs[0].y)).toBeCloseTo(1, 8);
  });

  it('generates only from-to lanes for a one-way road', () => {
    const net = new RoadNetwork(twoNodeMap({ x: 50, y: 20 }, true));
    expect(net.roadLanes).toHaveLength(2);
    for (const lane of net.roadLanes) expect(lane.start.x).toBeLessThan(lane.end.x);
    const straight = new RoadNetwork(twoNodeMap(undefined, true));
    expect(straight.roadLanes.map((lane) => lane.start.y)).toEqual([-LANE_WIDTH / 2, LANE_WIDTH / 2]);
    expect(net.nodes.get(0)!.incoming).toHaveLength(0);
    expect(net.nodes.get(1)!.outgoing).toHaveLength(0);
    expect(net.nodes.get(0)!.outgoing).toHaveLength(2);
    expect(net.nodes.get(1)!.incoming).toHaveLength(2);
  });

  it.each([undefined, { x: 5, y: 3 }])('keeps short road lanes positive (control=%o)', (control) => {
    const def = twoNodeMap(control);
    def.nodes[1].x = 10;
    const net = new RoadNetwork(def);
    for (const lane of net.roadLanes) {
      expect(lane.length).toBeGreaterThan(0);
      expect(lane.start.x).not.toBe(lane.end.x);
      if (control) expect(lane.points.length).toBeGreaterThanOrEqual(17);
    }
  });
});

const generatorCases = [
  ['radial', () => generateRadial({ id: 'radial', name: 'Radial', seed: 23, singleWay: true }), 33],
  ['ring', () => generateRing({ id: 'ring', name: 'Ring', seed: 29 }), 36],
  ['organic', () => generateOrganic({ id: 'organic', name: 'Organic', seed: 31 }), 42],
] as const;

describe.each(generatorCases)('M3 %s generator', (id, build, nodeCount) => {
  it('is reproducible, reasonably sized, decorated and lane-connected', () => {
    const def = build();
    expect(def).toEqual(build());
    expect(def.nodes).toHaveLength(nodeCount);
    expect(def.decor.length).toBeGreaterThan(0);
    expect(def.bounds.maxX - def.bounds.minX).toBeLessThan(700);
    expect(def.bounds.maxY - def.bounds.minY).toBeLessThan(700);
    const net = new RoadNetwork(def);
    for (let i = 0; i < 50; i++) {
      const a = net.roadLanes[(i * 7) % net.roadLanes.length];
      const b = net.roadLanes[(i * 13 + 5) % net.roadLanes.length];
      if (a !== b) expect(findRoute(a, b), `${id}: ${a.id} -> ${b.id}`).not.toBeNull();
    }
    for (const node of net.nodes.values()) {
      for (const lane of node.outgoing) {
        expect(Math.max(...node.dirs.map((dir) => dot(dir, lane.pointAt(0).t)))).toBeGreaterThan(0.98);
      }
      for (const lane of node.incoming) {
        const end = scale(lane.pointAt(lane.length).t, -1);
        expect(Math.max(...node.dirs.map((dir) => dot(dir, end)))).toBeGreaterThan(0.98);
      }
    }
  });
});

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

describe.each(MAPS)('map $id road clearance', (entry) => {
  it('keeps road lane centrelines off raised sidewalk blocks', () => {
    const def = entry.build();
    const net = new RoadNetwork(def);
    const blocks = def.decor.filter((item) => item.type === 'block');
    for (const lane of net.roadLanes) {
      for (let s = 12; s < lane.length - 12; s += 2) {
        const point = lane.pointAt(s).p;
        for (const block of blocks) {
          expect(pointInPolygon(point, block.polygon), `lane ${lane.id} enters a raised block at s=${s}`).toBe(false);
        }
      }
    }
  });
});

describe('M3 map topology', () => {
  it('makes every ring road lane reachable from every other ring road lane', () => {
    const def = generateRing({ id: 'ring', name: 'Ring', seed: 29 });
    expect(def.roads.filter((road) => road.oneWay)).toHaveLength(18);
    const net = new RoadNetwork(def);
    for (const lane of net.roadLanes) expect(reachableRoadLaneCount(lane, net.roadLanes.length)).toBe(net.roadLanes.length);
  });

  it('uses curved organic streets and only a few reversible radial one-way arcs', () => {
    const organic = generateOrganic({ id: 'organic', name: 'Organic', seed: 31 });
    const curvedIds = new Set(organic.roads.filter((road) => road.control).map((road) => road.id));
    expect(curvedIds.size).toBeGreaterThan(0);
    const organicNet = new RoadNetwork(organic);
    for (const lane of organicNet.roadLanes) {
      if (curvedIds.has(lane.roadId)) expect(lane.points.length).toBeGreaterThanOrEqual(17);
    }
    const radial = generateRadial({ id: 'radial', name: 'Radial', seed: 23, singleWay: true });
    const oneWay = radial.roads.filter((road) => road.oneWay);
    expect(oneWay).toHaveLength(2);
    const radialNet = new RoadNetwork(radial);
    for (const road of oneWay) expect(radialNet.roadLanes.filter((lane) => lane.roadId === road.id)).toHaveLength(1);
  });

  it('registers all three new maps', () => {
    expect(MAPS.map((entry) => entry.id)).toEqual(expect.arrayContaining(['radial', 'ring', 'organic']));
  });
});

function baseJsonMap(): MapDef {
  return {
    version: 1,
    id: 'json-test',
    name: 'JSON test',
    seed: 5,
    nodes: [
      { id: 10, x: 0, y: 0, signalPhases: [{ groups: [0], turns: ['straight'], green: 8 }] },
      { id: 20, x: 80, y: 0 },
    ],
    roads: [{ id: 7, from: 10, to: 20, speedLimit: 12, lanes: 2, oneWay: false, control: { x: 40, y: 12 } }],
    decor: [{ type: 'park', polygon: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 1, y: 4 }] }],
    bounds: { minX: -10, minY: -10, maxX: 90, maxY: 30 },
  };
}

function editedJson(edit: (value: any) => void): string {
  const value = JSON.parse(serializeMap(baseJsonMap()));
  edit(value);
  return JSON.stringify(value);
}

describe('road approach markings', () => {
  it('places the stop line before the zebra crossing in the direction of travel', () => {
    const def = twoNodeMap();
    def.nodes.push({ id: 2, x: 100, y: 100 }, { id: 3, x: 100, y: -100 });
    def.roads.push(
      { id: 5, from: 1, to: 2, speedLimit: 14 },
      { id: 6, from: 1, to: 3, speedLimit: 14 },
    );
    const net = new RoadNetwork(def);
    const scene = buildScene(net);
    const markings = scene.root.children.find(
      (child) => child instanceof THREE.InstancedMesh && child.geometry instanceof THREE.BoxGeometry,
    ) as THREE.InstancedMesh;
    const stops: Vec2[] = [];
    const crosswalks: Vec2[] = [];
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const size = new THREE.Vector3();
    for (let i = 0; i < markings.count; i++) {
      markings.getMatrixAt(i, matrix);
      matrix.decompose(position, rotation, size);
      if (Math.abs(size.x - 0.45) < 1e-6) stops.push({ x: position.x, y: position.z });
      if (Math.abs(size.x - 1.7) < 1e-6) crosswalks.push({ x: position.x, y: position.z });
    }
    scene.dispose();

    const lane = net.roadLanes.find((candidate) => candidate.roadId === 4 && candidate.nodeId === 1)!;
    const { t } = lane.pointAt(lane.length);
    const stop = stops.reduce((best, point) => (distance(point, lane.end) < distance(best, lane.end) ? point : best));
    const stopDistance = dot(sub(lane.end, stop), t);
    const crossingDistances = crosswalks
      .filter((point) => Math.abs(dot(sub(point, lane.end), { x: -t.y, y: t.x })) < 3.5)
      .map((point) => dot(sub(lane.end, point), t))
      .filter((along) => along > 0 && along < 9);
    expect(crossingDistances.length).toBeGreaterThan(0);
    for (const crossingDistance of crossingDistances) expect(stopDistance).toBeGreaterThan(crossingDistance);
  });

  it('creates one signal head per road approach instead of one per lane', () => {
    const def = twoNodeMap();
    def.nodes.push({ id: 2, x: 100, y: 100 }, { id: 3, x: 100, y: -100 });
    def.roads.push(
      { id: 5, from: 1, to: 2, speedLimit: 14 },
      { id: 6, from: 1, to: 3, speedLimit: 14 },
    );
    const net = new RoadNetwork(def);
    const signalLanes = net.roadLanes.filter((lane) => lane.signal);
    const approaches = new Set(signalLanes.map((lane) => `${lane.nodeId}:${lane.roadId}`));
    expect(signalLanes.length).toBeGreaterThan(approaches.size);

    const scene = buildScene(net);
    expect(scene.lamps).toHaveLength(approaches.size);
    scene.dispose();
  });
});

describe('MapJson', () => {
  it.each(MAPS)('round-trips $id without losing map data', (entry) => {
    const def = entry.build();
    const json = serializeMap(def);
    const restored = parseMap(json);
    expect(restored).toEqual(def);
    expect(serializeMap(restored)).toBe(json);
    expect(json).toContain('\n');
  });

  it('accepts a legacy map without a version and preserves optional curve fields', () => {
    const def = baseJsonMap();
    delete def.version;
    const restored = parseMap(serializeMap(def));
    expect(restored.version).toBeUndefined();
    expect(restored.roads[0].control).toEqual({ x: 40, y: 12 });
    expect(restored.nodes[0].signalPhases).toEqual(def.nodes[0].signalPhases);
  });

  it.each([
    ['malformed JSON', '{'],
    ['non-object root', 'null'],
    ['unsupported version', editedJson((value) => (value.version = 2))],
    ['duplicate node id', editedJson((value) => (value.nodes[1].id = 10))],
    ['duplicate road id', editedJson((value) => value.roads.push({ ...value.roads[0] }))],
    ['missing endpoint', editedJson((value) => (value.roads[0].to = 999))],
    ['self road', editedJson((value) => (value.roads[0].to = 10))],
    ['zero lanes', editedJson((value) => (value.roads[0].lanes = 0))],
    ['too many lanes', editedJson((value) => (value.roads[0].lanes = 5))],
    ['fractional lanes', editedJson((value) => (value.roads[0].lanes = 1.5))],
    ['invalid control', editedJson((value) => (value.roads[0].control = null))],
    ['non-finite coordinate', editedJson((value) => (value.nodes[0].x = null))],
    ['invalid decor', editedJson((value) => (value.decor[0].polygon = value.decor[0].polygon.slice(0, 2)))],
    ['invalid bounds', editedJson((value) => (value.bounds.maxX = value.bounds.minX))],
    ['unknown field', editedJson((value) => (value.extra = true))],
  ])('rejects %s', (_label, json) => {
    expect(() => parseMap(json)).toThrow(Error);
  });

  it('rejects non-finite values during export', () => {
    const def = baseJsonMap();
    def.nodes[0].x = Infinity;
    expect(() => serializeMap(def)).toThrow(/finite number/);
  });

  it('does not spread prototype-pollution fields into imported maps', () => {
    const json = editedJson((value) => {
      Object.defineProperty(value, '__proto__', { value: { polluted: true }, enumerable: true });
    });
    expect(() => parseMap(json)).toThrow(/unsupported field/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
