import * as THREE from 'three';
import { Random } from '../core/Random';
import { add, angleOf, distance, lerpVec, normalize, polygonArea, rightOf, scale, sub, type Vec2 } from '../core/math';
import { INTERSECTION_RADIUS, LANE_WIDTH, ROAD_HALF_WIDTH } from '../map/constants';
import type { RoadNetwork } from '../map/RoadNetwork';
import type { LightState, SignalController } from '../map/Signals';

export interface SignalLamp {
  mesh: THREE.Mesh;
  ctrl: SignalController;
  group: number;
}

export interface BuiltScene {
  root: THREE.Group;
  lamps: SignalLamp[];
  lampMaterials: Record<LightState, THREE.Material>;
  dispose(): void;
}

const Y = {
  ground: 0,
  water: 0.02,
  road: 0.04,
  junction: 0.045,
  marking: 0.06,
  block: 0.18,
};

/** Shape in the sim plane; after rotateX(-PI/2) shape (x, -y) lands on world (x, 0, y). */
function shapeOf(points: Vec2[]): THREE.Shape {
  return new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.y)));
}

function flatPolygon(points: Vec2[], y: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.ShapeGeometry(shapeOf(points));
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

function prism(points: Vec2[], height: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.ExtrudeGeometry(shapeOf(points), { depth: height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function quadPoint(q: Vec2[], u: number, v: number): Vec2 {
  return lerpVec(lerpVec(q[0], q[1], u), lerpVec(q[3], q[2], u), v);
}

export function buildScene(net: RoadNetwork): BuiltScene {
  const def = net.def;
  const rng = new Random(def.seed + 101);
  const root = new THREE.Group();
  const lambert = (color: number, flat = false) => new THREE.MeshLambertMaterial({ color, flatShading: flat });
  const mats = {
    ground: lambert(0xe9e5db),
    asphalt: lambert(0x9a9a9a),
    marking: lambert(0xffffff),
    block: lambert(0xd9d5cb),
    building: lambert(0xf3f1eb),
    grass: lambert(0xb9d29c),
    water: lambert(0x86b7dc),
    trunk: lambert(0x8a6a4a),
    foliage: lambert(0x7fae6a, true),
    rail: lambert(0xcfcac0),
    pole: lambert(0x55555c),
  };
  const lampMaterials: Record<LightState, THREE.Material> = {
    green: new THREE.MeshBasicMaterial({ color: 0x3fbf5f }),
    yellow: new THREE.MeshBasicMaterial({ color: 0xf2c230 }),
    red: new THREE.MeshBasicMaterial({ color: 0xe0433a }),
  };

  const b = def.bounds;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(b.maxX - b.minX, b.maxY - b.minY).rotateX(-Math.PI / 2), mats.ground);
  ground.position.set((b.minX + b.maxX) / 2, Y.ground, (b.minY + b.maxY) / 2);
  ground.receiveShadow = true;
  root.add(ground);

  for (const d of def.decor) if (d.type === 'water') root.add(flatPolygon(d.polygon, Y.water, mats.water));

  // Roads, centre dashes and bridge railings.
  const unitBox = new THREE.BoxGeometry(1, 0.02, 1);
  const dashMatrices: THREE.Matrix4[] = [];
  const dummy = new THREE.Object3D();
  const placeFlat = (p: Vec2, angle: number, sx: number, sz: number, y: number) => {
    dummy.position.set(p.x, y, p.y);
    dummy.rotation.set(0, -angle, 0);
    dummy.scale.set(sx, 1, sz);
    dummy.updateMatrix();
    return dummy.matrix.clone();
  };
  for (const road of def.roads) {
    const a = net.nodes.get(road.from)!.pos;
    const c = net.nodes.get(road.to)!.pos;
    const len = distance(a, c);
    const ang = angleOf(sub(c, a));
    const mid = lerpVec(a, c, 0.5);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(len, ROAD_HALF_WIDTH * 2).rotateX(-Math.PI / 2), mats.asphalt);
    strip.position.set(mid.x, Y.road, mid.y);
    strip.rotation.y = -ang;
    strip.receiveShadow = true;
    root.add(strip);

    const d = normalize(sub(c, a));
    const inner = len - INTERSECTION_RADIUS * 2;
    for (let s = 1.5; s < inner - 1.5; s += 6) {
      dashMatrices.push(placeFlat(add(a, scale(d, INTERSECTION_RADIUS + s + 1.5)), ang, 3, 0.18, Y.marking));
    }

    if (road.bridge) {
      const n = rightOf(d);
      for (const side of [1, -1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(inner, 0.9, 0.35), mats.rail);
        const p = add(mid, scale(n, side * (ROAD_HALF_WIDTH + 0.3)));
        rail.position.set(p.x, 0.45, p.y);
        rail.rotation.y = -ang;
        rail.castShadow = true;
        root.add(rail);
      }
    }
  }

  // Stop lines at every lane entering an intersection.
  for (const lane of net.roadLanes) {
    const { t } = lane.pointAt(lane.length);
    dashMatrices.push(placeFlat(sub(lane.end, scale(t, 0.4)), angleOf(t), 0.45, LANE_WIDTH - 0.3, Y.marking));
  }
  const dashes = new THREE.InstancedMesh(unitBox, mats.marking, dashMatrices.length);
  dashMatrices.forEach((m, i) => dashes.setMatrixAt(i, m));
  dashes.receiveShadow = true;
  root.add(dashes);

  for (const node of net.nodes.values()) {
    if (node.polygon.length >= 3) root.add(flatPolygon(node.polygon, Y.junction, mats.asphalt));
  }

  // City blocks, buildings, parks.
  const treeSpots: Vec2[] = [];
  for (const d of def.decor) {
    if (d.type === 'block') {
      root.add(prism(d.polygon, Y.block, mats.block));
      const n = d.polygon.length;
      const sign = polygonArea(d.polygon) > 0 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const p = d.polygon[i];
        const q = d.polygon[(i + 1) % n];
        const len = distance(p, q);
        const e = normalize(sub(q, p));
        const into = scale({ x: -e.y, y: e.x }, sign);
        for (let s = 8; s < len - 8; s += rng.range(11, 16)) treeSpots.push(add(add(p, scale(e, s)), scale(into, 1.6)));
      }
    } else if (d.type === 'building') {
      const mesh = prism(d.polygon, d.height ?? 10, mats.building);
      mesh.position.y = Y.block;
      root.add(mesh);
    } else if (d.type === 'park') {
      const lawn = flatPolygon(d.polygon, Y.block + 0.01, mats.grass);
      root.add(lawn);
      const count = rng.int(6, 12);
      for (let i = 0; i < count; i++) treeSpots.push(quadPoint(d.polygon, rng.range(0.1, 0.9), rng.range(0.1, 0.9)));
    }
  }
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2.4, 6);
  const crownGeo = new THREE.IcosahedronGeometry(2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, treeSpots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, mats.foliage, treeSpots.length);
  treeSpots.forEach((p, i) => {
    const k = rng.range(0.75, 1.25);
    dummy.position.set(p.x, Y.block + 1.2 * k, p.y);
    dummy.rotation.set(0, rng.range(0, Math.PI), 0);
    dummy.scale.set(k, k, k);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = Y.block + 3.4 * k;
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
  });
  trunks.castShadow = crowns.castShadow = true;
  root.add(trunks, crowns);

  // Signal heads on the kerb at each stop line.
  const lamps: SignalLamp[] = [];
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 3.6, 6);
  const headGeo = new THREE.BoxGeometry(0.4, 0.9, 0.4);
  const lampGeo = new THREE.SphereGeometry(0.45, 10, 8);
  for (const lane of net.roadLanes) {
    if (!lane.signal) continue;
    const { t } = lane.pointAt(lane.length);
    const p = add(sub(lane.end, scale(t, 0.6)), scale(rightOf(t), LANE_WIDTH / 2 + 1.4));
    const pole = new THREE.Mesh(poleGeo, mats.pole);
    pole.position.set(p.x, 1.8, p.y);
    const head = new THREE.Mesh(headGeo, mats.pole);
    head.position.set(p.x, 3.7, p.y);
    head.rotation.y = -angleOf(t);
    const lamp = new THREE.Mesh(lampGeo, lampMaterials.red);
    lamp.position.set(p.x, 4.4, p.y);
    pole.castShadow = head.castShadow = true;
    root.add(pole, head, lamp);
    lamps.push({ mesh: lamp, ctrl: lane.signal.ctrl, group: lane.signal.group });
  }

  return {
    root,
    lamps,
    lampMaterials,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const m of Object.values(mats)) m.dispose();
      for (const m of Object.values(lampMaterials)) m.dispose();
    },
  };
}
