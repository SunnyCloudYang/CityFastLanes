import * as THREE from 'three';
import { clamp, lerp } from '../core/math';
import type { World } from '../sim/World';

const CAPACITY = 60;
const BODY_COLORS = [0x3b7dd8, 0xd9534f, 0xe0a030, 0x4caf7a, 0x8e6cc0, 0x5a5a5a];
const UP = new THREE.Vector3(0, 1, 0);

/** Two instanced draws for all pedestrians: a low-poly body and a head. */
export class PedestrianRenderer {
  readonly group = new THREE.Group();
  private readonly body: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly material = new THREE.MeshLambertMaterial({ color: 0xffffff });

  constructor() {
    const bodyGeometry = new THREE.CylinderGeometry(0.2, 0.27, 0.85, 6).translate(0, 0.92, 0);
    const headGeometry = new THREE.IcosahedronGeometry(0.19, 0).translate(0, 1.54, 0);
    this.body = new THREE.InstancedMesh(bodyGeometry, this.material, CAPACITY);
    this.head = new THREE.InstancedMesh(headGeometry, this.material, CAPACITY);
    for (const mesh of [this.body, this.head]) {
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  sync(world: World, alpha: number): void {
    const blend = clamp(alpha, 0, 1);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const base = new THREE.Matrix4();
    const sway = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const count = Math.min(world.pedestrians.length, CAPACITY);

    for (let i = 0; i < count; i++) {
      const pedestrian = world.pedestrians[i];
      const x = lerp(pedestrian.prevPos.x, pedestrian.pos.x, blend);
      const y = lerp(pedestrian.prevPos.y, pedestrian.pos.y, blend);
      const walking = pedestrian.state !== 'waiting';
      const phase = world.time * 8 + pedestrian.id * 1.7;
      const bob = walking ? Math.abs(Math.sin(phase)) * 0.045 : 0;
      position.set(x, 0.16 + bob, y);
      quaternion.setFromAxisAngle(UP, -pedestrian.heading);
      base.compose(position, quaternion, scale);
      sway.makeRotationX(walking ? Math.sin(phase) * 0.045 : 0);
      matrix.copy(base).multiply(sway);
      this.body.setMatrixAt(i, matrix);
      this.head.setMatrixAt(i, matrix);
      this.body.setColorAt(i, color.setHex(BODY_COLORS[pedestrian.id % BODY_COLORS.length]));
      this.head.setColorAt(i, color.setHex(0xf0d9c0));
    }

    for (const mesh of [this.body, this.head]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
