import * as THREE from 'three';
import { clamp, lerp, lerpAngle } from '../core/math';
import { SPECS, VEHICLE_KINDS, type Vehicle, type VehicleKind } from '../sim/Vehicle';
import type { World } from '../sim/World';

const TYRE = 0x333338;
const GLASS = 0xd3dae0;
const CAPACITY = 600;

interface PartDef {
  geometry: THREE.BufferGeometry;
  local: THREE.Matrix4;
  color: number | null;
  nightOnly?: boolean;
}

interface PartBatch {
  mesh: THREE.InstancedMesh;
  ids: number[];
  color: number | null;
  nightOnly: boolean;
}

function part(
  geometry: THREE.BufferGeometry,
  color: number | null,
  x: number,
  y: number,
  z = 0,
  nightOnly = false,
): PartDef {
  return { geometry, color, local: new THREE.Matrix4().makeTranslation(x, y, z), nightOnly };
}

function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function wheel(r: number, w: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, w, 12).rotateX(Math.PI / 2);
}

function partsFor(kind: VehicleKind): PartDef[] {
  const { length: l, width: w } = SPECS[kind];
  if (kind === 'bike' || kind === 'motorcycle') {
    const scale = kind === 'motorcycle' ? 1.15 : 1;
    return [
      part(box(1.5 * scale, 0.09, 0.09), 0x444448, 0, 0.62),
      part(wheel(0.34 * scale, 0.08), TYRE, 0.55 * scale, 0.34),
      part(wheel(0.34 * scale, 0.08), TYRE, -0.55 * scale, 0.34),
      part(box(0.08, 0.08, 0.6), 0x444448, 0.48, 1.02),
      part(box(0.38, 0.62, 0.38), null, -0.12, 1.2),
      part(new THREE.SphereGeometry(0.15, 10, 8), 0xf0d9c0, -0.05, 1.68),
      part(new THREE.SphereGeometry(0.11, 8, 6), 0xffedb0, 0.75 * scale, 0.85, 0, true),
    ];
  }
  const parts: PartDef[] =
    kind === 'bus'
      ? [
          part(box(l, 2.35, w), null, 0, 1.45),
          part(box(l * 0.82, 0.75, w * 1.01), GLASS, 0.3, 1.9),
        ]
      : kind === 'van'
        ? [
            part(box(l, 1.55, w), null, 0, 1.05),
            part(box(0.9, 0.6, w * 0.92), GLASS, l / 2 - 0.5, 1.5),
          ]
        : [
            part(box(l, 0.62, w), null, 0, 0.58),
            part(box(l * 0.5, 0.55, w * 0.86), GLASS, -l * 0.06, 1.16),
          ];
  if (kind === 'taxi') parts.push(part(box(0.55, 0.2, 0.3), 0xf0b429, 0, 1.55));
  for (const sx of [0.32, -0.32]) {
    for (const sz of [0.5, -0.5]) parts.push(part(wheel(0.33, 0.25), TYRE, l * sx, 0.33, w * sz));
  }
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.SphereGeometry(0.12, 8, 6), 0xffedb0, l / 2 + 0.03, 0.7, side * w * 0.3, true));
  }
  return parts;
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

/** One instanced draw call per vehicle part, with body colour stored per instance. */
export class VehicleRenderer {
  readonly group = new THREE.Group();
  private readonly batches = new Map<VehicleKind, PartBatch[]>();
  private readonly ring: THREE.Mesh;
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xe0433a });
  private readonly material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly headlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private night = 0;

  constructor() {
    for (const kind of VEHICLE_KINDS) {
      const batches: PartBatch[] = [];
      for (const def of partsFor(kind)) {
        // Bake the part transform into shared geometry; per-vehicle transforms remain instanced.
        const geometry = def.geometry.clone().applyMatrix4(def.local);
        def.geometry.dispose();
        const mesh = new THREE.InstancedMesh(geometry, def.nightOnly ? this.headlightMaterial : this.material, CAPACITY);
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        mesh.userData.vehicleKind = kind;
        this.group.add(mesh);
        batches.push({ mesh, ids: [], color: def.color, nightOnly: !!def.nightOnly });
      }
      this.batches.set(kind, batches);
    }
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.9, 40).rotateX(-Math.PI / 2), this.ringMat);
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  setNight(amount: number): void {
    this.night = amount;
  }

  clear(): void {
    for (const batches of this.batches.values()) {
      for (const batch of batches) {
        batch.mesh.count = 0;
        batch.ids.length = 0;
      }
    }
    this.ring.visible = false;
  }

  sync(world: World, alpha: number, selectedId: number | null, controlling: boolean, showRing: boolean): void {
    const vehicles = new Map<VehicleKind, Vehicle[]>(VEHICLE_KINDS.map((kind) => [kind, []]));
    for (const v of world.vehicles) vehicles.get(v.kind)!.push(v);
    const base = new THREE.Matrix4();
    const roll = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const color = new THREE.Color();
    for (const kind of VEHICLE_KINDS) {
      const list = vehicles.get(kind)!;
      const batches = this.batches.get(kind)!;
      for (const batch of batches) batch.ids.length = 0;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const pose = interpolatedPose(v, alpha);
        position.set(pose.x, 0.2, pose.y);
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -pose.heading);
        base.compose(position, quaternion, scale);
        if (kind === 'bike') {
          roll.makeRotationX(clamp(v.steer * v.speed * 0.25, -0.4, 0.4));
          base.multiply(roll);
        }
        for (let p = 0; p < batches.length; p++) {
          const batch = batches[p];
          batch.mesh.setMatrixAt(i, matrix.copy(base));
          batch.mesh.setColorAt(i, color.setHex(batch.color ?? v.color));
          batch.ids.push(v.id);
        }
        if (v.id === selectedId) {
          this.ring.visible = true;
          this.ring.position.set(pose.x, 0.25, pose.y);
          this.ring.scale.setScalar(v.isBike ? 0.55 : v.spec.length / 4.3);
          this.ringMat.color.setHex(controlling ? 0x2f6fd0 : 0xe0433a);
        }
      }
      for (const batch of batches) {
        batch.mesh.count = list.length;
        batch.mesh.visible = !batch.nightOnly || this.night > 0.1;
        batch.mesh.instanceMatrix.needsUpdate = true;
        if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      }
    }
    if (!showRing || selectedId === null || !world.vehicles.some((v) => v.id === selectedId)) this.ring.visible = false;
  }

  pick(ray: THREE.Raycaster, world: World, slop: number): number | null {
    for (const hit of ray.intersectObjects(this.group.children, false)) {
      const kind = hit.object.userData.vehicleKind as VehicleKind | undefined;
      if (kind && hit.instanceId !== undefined) {
        const id = this.batches.get(kind)![0].ids[hit.instanceId];
        if (id !== undefined) return id;
      }
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
