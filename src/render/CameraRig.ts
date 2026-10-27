import * as THREE from 'three';
import { clamp } from '../core/math';
import type { Vehicle } from '../sim/Vehicle';
import type { Pose } from './VehicleRenderer';

export type ViewMode = 'top' | 'chase' | 'fp';

export const VIEW_NAMES: Record<ViewMode, string> = { top: '俯瞰', chase: '追尾', fp: '第一人称' };

const ORTHO_DISTANCE = 800;

export class CameraRig {
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2400);
  readonly persp = new THREE.PerspectiveCamera(65, 1, 0.1, 1800);
  mode: ViewMode = 'top';
  readonly target = new THREE.Vector3();
  viewHeight = 200;
  azimuth = 0;
  readonly elevation = THREE.MathUtils.degToRad(60);
  chaseDistance = 9;
  private aspect = 1;
  private readonly chasePos = new THREE.Vector3();
  private chaseReady = false;
  private clock = 0;

  get camera(): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    return this.mode === 'top' ? this.ortho : this.persp;
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(h, 1);
    this.persp.aspect = this.aspect;
    this.persp.updateProjectionMatrix();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.chaseReady = false;
  }

  /** Drag the ground under the cursor by a pixel delta. */
  pan(dx: number, dy: number, screenH: number): void {
    const wpp = this.viewHeight / screenH;
    const right = new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth));
    const fwd = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
    this.target.addScaledVector(right, -dx * wpp);
    this.target.addScaledVector(fwd, (dy * wpp) / Math.sin(this.elevation));
  }

  zoom(factor: number): void {
    if (this.mode === 'top') this.viewHeight = clamp(this.viewHeight * factor, 30, 800);
    else if (this.mode === 'chase') this.chaseDistance = clamp(this.chaseDistance * factor, 4, 30);
  }

  rotate(step: number): void {
    this.azimuth += (step * Math.PI) / 4;
  }

  update(dt: number, subject: { v: Vehicle; pose: Pose } | null): void {
    this.clock += dt;
    if (this.mode === 'top' || !subject) {
      this.updateTop(dt, subject?.pose ?? null);
      return;
    }
    const { v, pose } = subject;
    const fwd = new THREE.Vector3(Math.cos(pose.heading), 0, Math.sin(pose.heading));
    const base = new THREE.Vector3(pose.x, 0, pose.y);
    const cam = this.persp;
    if (this.mode === 'chase') {
      const desired = base
        .clone()
        .addScaledVector(fwd, -this.chaseDistance)
        .add(new THREE.Vector3(0, this.chaseDistance * 0.38 + 1, 0));
      if (!this.chaseReady) {
        this.chasePos.copy(desired);
        this.chaseReady = true;
      }
      this.chasePos.lerp(desired, 1 - Math.exp(-dt * 5));
      cam.fov = 62;
      cam.position.copy(this.chasePos);
      cam.up.set(0, 1, 0);
      cam.lookAt(base.clone().addScaledVector(fwd, 3).add(new THREE.Vector3(0, 1.2, 0)));
    } else {
      const spec = v.spec;
      const eye = base.clone().addScaledVector(fwd, spec.eyeForward);
      eye.y = 0.2 + spec.eyeHeight;
      if (v.isBike) eye.y += Math.sin(this.clock * Math.max(v.speed, 0) * 1.6) * 0.015 * Math.min(v.speed, 1);
      const yaw = pose.heading + v.steer * 0.25;
      const look = eye.clone().add(new THREE.Vector3(Math.cos(yaw) * 10, -0.35, Math.sin(yaw) * 10));
      cam.fov = 75;
      cam.position.copy(eye);
      cam.up.set(0, 1, 0);
      cam.lookAt(look);
      if (v.isBike) cam.rotateZ(-clamp(v.steer * v.speed * 0.2, -0.3, 0.3));
    }
    cam.updateProjectionMatrix();
  }

  private updateTop(dt: number, pose: Pose | null): void {
    if (pose) this.target.lerp(new THREE.Vector3(pose.x, 0, pose.y), 1 - Math.exp(-dt * 8));
    const half = this.viewHeight / 2;
    const cam = this.ortho;
    cam.left = -half * this.aspect;
    cam.right = half * this.aspect;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    const ce = Math.cos(this.elevation);
    cam.position.set(
      this.target.x + Math.sin(this.azimuth) * ce * ORTHO_DISTANCE,
      this.target.y + Math.sin(this.elevation) * ORTHO_DISTANCE,
      this.target.z + Math.cos(this.azimuth) * ce * ORTHO_DISTANCE,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
  }
}
