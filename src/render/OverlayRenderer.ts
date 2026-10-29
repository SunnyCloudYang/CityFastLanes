import * as THREE from 'three';
import type { Lane } from '../map/Lane';
import type { Vec2 } from '../core/math';
import type { World } from '../sim/World';

/** Hand-drawn route guides and a low-resolution congestion heat map. */
export class OverlayRenderer {
  readonly group = new THREE.Group();
  showHeatmap = false;
  showRoutes = true;
  private readonly routeGroup = new THREE.Group();
  private readonly heat: THREE.InstancedMesh;
  private readonly destinationMarker: THREE.Mesh;
  private destination: Vec2 | null = null;

  constructor() {
    this.group.add(this.routeGroup);
    const geometry = new THREE.CircleGeometry(12, 20).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false });
    this.heat = new THREE.InstancedMesh(geometry, material, 400);
    this.heat.count = 0;
    this.heat.position.y = 0.075;
    this.heat.frustumCulled = false;
    this.group.add(this.heat);
    this.destinationMarker = new THREE.Mesh(
      new THREE.TorusGeometry(4, 0.25, 6, 32).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xe0433a }),
    );
    this.destinationMarker.visible = false;
    this.destinationMarker.position.y = 0.2;
    this.group.add(this.destinationMarker);
  }

  setRoute(lanes: readonly Lane[]): void {
    for (const child of [...this.routeGroup.children]) {
      this.routeGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) child.geometry.dispose();
    }
    if (!this.showRoutes || !lanes.length) return;
    const points: THREE.Vector3[] = [];
    for (const lane of lanes) {
      for (const p of lane.points) {
        const previous = points.at(-1);
        if (!previous || Math.hypot(previous.x - p.x, previous.z - p.y) > 0.05) points.push(new THREE.Vector3(p.x, 0.14, p.y));
      }
    }
    if (points.length < 2) return;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color: 0xe0433a, dashSize: 2, gapSize: 1.2, transparent: true, opacity: 0.85 }),
    );
    line.computeLineDistances();
    this.routeGroup.add(line);
    for (let i = 4; i < points.length - 1; i += 8) {
      const direction = points[i + 1].clone().sub(points[i]).normalize();
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.75, 2.3, 3),
        new THREE.MeshBasicMaterial({ color: 0xe0433a }),
      );
      arrow.position.copy(points[i]);
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      this.routeGroup.add(arrow);
    }
  }

  setDestination(point: Vec2 | null): void {
    this.destination = point;
    this.destinationMarker.visible = !!point;
    if (point) this.destinationMarker.position.set(point.x, 0.2, point.y);
  }

  update(world: World, time: number): void {
    if (this.destination) {
      const pulse = 1 + Math.sin(time * 4) * 0.08;
      this.destinationMarker.scale.setScalar(pulse);
      this.destinationMarker.rotation.y = time * 0.35;
    }
    if (!this.showHeatmap) {
      this.heat.count = 0;
      return;
    }
    const buckets = new Map<string, { x: number; y: number; speed: number; count: number }>();
    for (const v of world.vehicles) {
      const x = Math.floor(v.pos.x / 24) * 24 + 12;
      const y = Math.floor(v.pos.y / 24) * 24 + 12;
      const key = `${x},${y}`;
      const bucket = buckets.get(key) ?? { x, y, speed: 0, count: 0 };
      bucket.speed += Math.abs(v.speed);
      bucket.count++;
      buckets.set(key, bucket);
    }
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let i = 0;
    for (const bucket of buckets.values()) {
      if (i >= 400) break;
      const speed = bucket.speed / bucket.count;
      const congestion = Math.max(0, 1 - speed / 9);
      dummy.position.set(bucket.x, 0, bucket.y);
      dummy.scale.setScalar(0.7 + congestion * 0.3);
      dummy.updateMatrix();
      this.heat.setMatrixAt(i, dummy.matrix);
      this.heat.setColorAt(i, color.setHSL(0.33 * (1 - congestion), 0.85, 0.48));
      i++;
    }
    this.heat.count = i;
    this.heat.instanceMatrix.needsUpdate = true;
    if (this.heat.instanceColor) this.heat.instanceColor.needsUpdate = true;
  }
}
