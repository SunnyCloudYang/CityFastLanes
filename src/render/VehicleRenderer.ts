import * as THREE from 'three';
import { clamp, lerp, lerpAngle } from '../core/math';
import type { Vehicle } from '../sim/Vehicle';
import type { World } from '../sim/World';

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<number, THREE.MeshLambertMaterial>();

function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `b${w},${h},${d}`;
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
}

function wheel(r: number, w: number): THREE.BufferGeometry {
  const key = `w${r},${w}`;
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = new THREE.CylinderGeometry(r, r, w, 12).rotateX(Math.PI / 2)));
  return g;
}

function sphere(r: number): THREE.BufferGeometry {
  const key = `s${r}`;
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = new THREE.SphereGeometry(r, 10, 8)));
  return g;
}

function mat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) matCache.set(color, (m = new THREE.MeshLambertMaterial({ color })));
  return m;
}

function part(geo: THREE.BufferGeometry, color: number, x: number, y: number, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

const TYRE = 0x333338;
const GLASS = 0xd3dae0;

/** Local frame: +X forward, +Y up, +Z right. */
function buildBody(v: Vehicle): THREE.Group {
  const g = new THREE.Group();
  const { length: l, width: w } = v.spec;
  if (v.kind === 'bike') {
    g.add(
      part(box(1.5, 0.07, 0.07), 0x444448, 0, 0.62),
      part(wheel(0.34, 0.05), TYRE, 0.55, 0.34),
      part(wheel(0.34, 0.05), TYRE, -0.55, 0.34),
      part(box(0.06, 0.06, 0.6), 0x444448, 0.48, 1.02),
      part(box(0.32, 0.62, 0.38), v.color, -0.12, 1.2),
      part(sphere(0.15), 0xf0d9c0, -0.05, 1.68),
    );
    return g;
  }
  if (v.kind === 'van') {
    g.add(
      part(box(l, 1.55, w), v.color, 0, 1.05),
      part(box(0.9, 0.6, w * 0.92), GLASS, l / 2 - 0.5, 1.5),
    );
  } else {
    g.add(part(box(l, 0.62, w), v.color, 0, 0.58), part(box(l * 0.5, 0.55, w * 0.86), GLASS, -l * 0.06, 1.16));
  }
  for (const sx of [0.32, -0.32]) {
    for (const sz of [0.5, -0.5]) g.add(part(wheel(0.33, 0.25), TYRE, l * sx, 0.33, w * sz));
  }
  return g;
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

export function interpolatedPose(v: Vehicle, alpha: number): Pose {
  return {
    x: lerp(v.prevPos.x, v.pos.x, alpha),
    y: lerp(v.prevPos.y, v.pos.y, alpha),
    heading: lerpAngle(v.prevHeading, v.heading, alpha),
  };
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<number, { outer: THREE.Group; body: THREE.Group }>();
  private readonly ring: THREE.Mesh;
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xe0433a });

  constructor() {
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.9, 40).rotateX(-Math.PI / 2), this.ringMat);
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  clear(): void {
    for (const { outer } of this.meshes.values()) this.group.remove(outer);
    this.meshes.clear();
    this.ring.visible = false;
  }

  sync(world: World, alpha: number, selectedId: number | null, controlling: boolean, showRing: boolean): void {
    const seen = new Set<number>();
    for (const v of world.vehicles) {
      seen.add(v.id);
      let entry = this.meshes.get(v.id);
      if (!entry) {
        const outer = new THREE.Group();
        outer.userData.vehicleId = v.id;
        const body = buildBody(v);
        outer.add(body);
        this.group.add(outer);
        entry = { outer, body };
        this.meshes.set(v.id, entry);
      }
      const pose = interpolatedPose(v, alpha);
      entry.outer.position.set(pose.x, 0.2, pose.y);
      entry.outer.rotation.y = -pose.heading;
      if (v.isBike) entry.body.rotation.x = clamp(v.steer * v.speed * 0.25, -0.4, 0.4);
      if (v.id === selectedId) {
        this.ring.visible = true;
        this.ring.position.set(pose.x, 0.25, pose.y);
        this.ring.scale.setScalar(v.isBike ? 0.55 : v.spec.length / 4.3);
        this.ringMat.color.setHex(controlling ? 0x2f6fd0 : 0xe0433a);
      }
    }
    for (const [id, { outer }] of this.meshes) {
      if (!seen.has(id)) {
        this.group.remove(outer);
        this.meshes.delete(id);
      }
    }
    if (!showRing || selectedId === null || !seen.has(selectedId)) this.ring.visible = false;
  }

  /** Vehicle under the ray, falling back to the nearest one around the ground hit point. */
  pick(ray: THREE.Raycaster, world: World, slop: number): number | null {
    for (const hit of ray.intersectObjects(this.group.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.vehicleId === undefined) o = o.parent;
      if (o) return o.userData.vehicleId as number;
    }
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
    let best: number | null = null;
    let bestD = slop;
    for (const v of world.vehicles) {
      const d = Math.hypot(v.pos.x - p.x, v.pos.y - p.z);
      if (d < bestD) {
        bestD = d;
        best = v.id;
      }
    }
    return best;
  }
}
