import * as THREE from 'three';
import { Input } from './control/Input';
import { MAPS } from './map/maps';
import { CameraRig, VIEW_NAMES, type ViewMode } from './render/CameraRig';
import { buildScene, type BuiltScene } from './render/SceneBuilder';
import { SketchRenderer } from './render/sketch/SketchRenderer';
import { interpolatedPose, VehicleRenderer } from './render/VehicleRenderer';
import type { Vehicle } from './sim/Vehicle';
import { World } from './sim/World';
import { Hud } from './ui/Hud';
import './style.css';

const DT = 1 / 60;
const MAX_STEPS = 12;
const KIND_NAMES = { car: '轿车', van: '厢式车', bike: '自行车' };
const VIEW_ORDER: ViewMode[] = ['top', 'chase', 'fp'];

class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.4);
  private readonly vehicles = new VehicleRenderer();
  private readonly rig = new CameraRig();
  private readonly sketch: SketchRenderer;
  private readonly input: Input;
  private readonly hud: Hud;
  private world!: World;
  private built: BuiltScene | null = null;

  private mapId = MAPS[0].id;
  private cars = 70;
  private bikes = 20;
  private selectedId: number | null = null;
  private controlling = false;
  private paused = false;
  private timeScale = 1;
  private acc = 0;
  private last = performance.now();
  private clock = 0;
  private statusTimer = 0;

  private drag = { active: false, moved: false, x: 0, y: 0 };

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target, this.vehicles.group);

    this.sketch = new SketchRenderer(this.renderer);
    this.input = new Input((code) => this.onKey(code));
    this.hud = new Hud(
      { maps: MAPS, mapId: this.mapId, cars: this.cars, bikes: this.bikes },
      {
        onMap: (id) => this.loadMap(id),
        onCounts: (cars, bikes) => {
          this.cars = cars;
          this.bikes = bikes;
          this.world.targetMotor = cars;
          this.world.targetBikes = bikes;
        },
        onSpeed: (s) => this.setSpeed(s),
        onPause: () => this.togglePause(),
        onSketch: (on) => (this.sketch.enabled = on),
      },
    );

    this.bindPointer(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.loadMap(this.mapId);
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- setup

  private loadMap(id: string): void {
    const entry = MAPS.find((m) => m.id === id) ?? MAPS[0];
    this.mapId = entry.id;
    if (this.built) {
      this.scene.remove(this.built.root);
      this.built.dispose();
    }
    this.vehicles.clear();
    this.world = new World(entry.build(), this.cars, this.bikes);
    this.built = buildScene(this.world.net);
    this.scene.add(this.built.root);
    this.selectedId = null;
    this.controlling = false;
    this.rig.setMode('top');

    const b = this.world.def.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minY + b.maxY) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    this.rig.target.set(cx, 0, cz);
    this.rig.viewHeight = span * 0.32;
    this.sun.position.set(cx - span * 0.35, span * 0.8, cz - span * 0.25);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -span * 0.75;
    cam.right = cam.top = span * 0.75;
    cam.near = 1;
    cam.far = span * 3;
    cam.updateProjectionMatrix();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.sketch.setSize(w, h, this.renderer.getPixelRatio());
    this.rig.resize(w, h);
  }

  // ---------------------------------------------------------------- selection & control

  private get selected(): Vehicle | null {
    if (this.selectedId === null) return null;
    return this.world.vehicles.find((v) => v.id === this.selectedId) ?? null;
  }

  private select(id: number | null): void {
    if (this.controlling && id !== this.selectedId) this.release();
    this.selectedId = id;
    this.world.protectedIds.clear();
    if (id !== null) this.world.protectedIds.add(id);
    else this.rig.setMode('top');
  }

  private takeControl(): void {
    let v = this.selected;
    if (!v) {
      const t = this.rig.target;
      v = this.world.vehicles.reduce<Vehicle | null>(
        (best, u) =>
          !best || Math.hypot(u.pos.x - t.x, u.pos.y - t.z) < Math.hypot(best.pos.x - t.x, best.pos.y - t.z) ? u : best,
        null,
      );
      if (!v) return;
      this.select(v.id);
    }
    this.world.takeControl(v);
    this.controlling = true;
    if (this.rig.mode === 'top') this.rig.setMode('chase');
  }

  private release(): void {
    const v = this.selected;
    if (v) this.world.releaseControl(v);
    this.controlling = false;
  }

  private cycleSelection(): void {
    if (this.controlling) return;
    const list = this.world.vehicles;
    if (!list.length) return;
    const i = list.findIndex((v) => v.id === this.selectedId);
    this.select(list[(i + 1) % list.length].id);
  }

  private cycleView(): void {
    if (!this.selected) {
      this.rig.setMode('top');
      return;
    }
    this.rig.setMode(VIEW_ORDER[(VIEW_ORDER.indexOf(this.rig.mode) + 1) % VIEW_ORDER.length]);
  }

  private setSpeed(s: number): void {
    this.timeScale = s;
    this.hud.setSpeed(s);
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
  }

  private onKey(code: string): void {
    switch (code) {
      case 'Tab':
        this.cycleSelection();
        break;
      case 'Enter':
      case 'KeyF':
        if (this.controlling) this.release();
        else this.takeControl();
        break;
      case 'Escape':
        if (this.controlling) this.release();
        else this.select(null);
        break;
      case 'KeyV':
        this.cycleView();
        break;
      case 'KeyQ':
        this.rig.rotate(-1);
        break;
      case 'KeyE':
        this.rig.rotate(1);
        break;
      case 'KeyP':
        this.togglePause();
        break;
      case 'Digit1':
        this.setSpeed(0.5);
        break;
      case 'Digit2':
        this.setSpeed(1);
        break;
      case 'Digit3':
        this.setSpeed(3);
        break;
      case 'KeyK':
        this.sketch.enabled = !this.sketch.enabled;
        this.hud.setSketch(this.sketch.enabled);
        break;
    }
  }

  private bindPointer(el: HTMLCanvasElement): void {
    el.addEventListener('pointerdown', (e) => {
      this.drag = { active: true, moved: false, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag.active) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!this.drag.moved && !this.controlling) this.select(null);
      this.drag.moved = true;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.rig.mode === 'top' && !this.controlling) this.rig.pan(dx, dy, el.clientHeight);
    });
    el.addEventListener('pointerup', (e) => {
      const wasClick = this.drag.active && !this.drag.moved;
      this.drag.active = false;
      if (!wasClick) return;
      const id = this.pickAt(e.clientX, e.clientY);
      if (id !== null) this.select(id);
      else if (!this.controlling) this.select(null);
    });
    el.addEventListener('dblclick', (e) => {
      const id = this.pickAt(e.clientX, e.clientY);
      if (id === null) return;
      this.select(id);
      this.takeControl();
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.rig.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false },
    );
  }

  private pickAt(clientX: number, clientY: number): number | null {
    const el = this.renderer.domElement;
    const ndc = new THREE.Vector2((clientX / el.clientWidth) * 2 - 1, -(clientY / el.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.rig.camera);
    const slop = this.rig.mode === 'top' ? Math.max(3, this.rig.viewHeight / 60) : 3;
    return this.vehicles.pick(ray, this.world, slop);
  }

  // ---------------------------------------------------------------- loop

  private applyInput(realDt: number): void {
    const v = this.selected;
    if (this.controlling && v) {
      v.input.throttle = this.input.throttle;
      v.input.steer = this.input.steer;
      v.input.handbrake = this.input.handbrake;
      return;
    }
    const t = this.input.throttle;
    const s = this.input.steer;
    if (t || s) {
      if (this.selectedId !== null) this.select(null);
      const px = this.rig.viewHeight * 0.8 * realDt;
      const h = this.renderer.domElement.clientHeight;
      const wpp = this.rig.viewHeight / h;
      this.rig.pan((-s * px) / wpp, (t * px * Math.sin(this.rig.elevation)) / wpp, h);
    }
  }

  private frame = (now: number): void => {
    const real = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += real;

    if (this.controlling && !this.selected) this.controlling = false;
    if (this.selectedId !== null && !this.selected) this.select(null);

    this.applyInput(real);
    if (!this.paused) {
      this.acc += real * this.timeScale;
      let n = 0;
      while (this.acc >= DT && n < MAX_STEPS) {
        this.world.step(DT);
        this.acc -= DT;
        n++;
      }
      if (n >= MAX_STEPS) this.acc = 0;
    }
    const alpha = this.acc / DT;

    this.vehicles.sync(this.world, alpha, this.selectedId, this.controlling, this.rig.mode === 'top');
    if (this.built) {
      for (const l of this.built.lamps) l.mesh.material = this.built.lampMaterials[l.ctrl.state(l.group)];
    }
    const v = this.selected;
    this.rig.update(real, v ? { v, pose: interpolatedPose(v, alpha) } : null);
    this.sketch.render(this.scene, this.rig.camera, this.clock);

    this.statusTimer -= real;
    if (this.statusTimer <= 0) {
      this.statusTimer = 0.15;
      this.updateStatus(v);
    }
    requestAnimationFrame(this.frame);
  };

  private updateStatus(v: Vehicle | null): void {
    const mode = this.controlling ? '驾驶中' : v ? '跟随' : '观察';
    const lines = [
      `<div class="mode">${mode} · ${VIEW_NAMES[this.rig.mode]}</div>`,
      `<div>车辆 ${this.world.count(false)} · 自行车 ${this.world.count(true)}</div>`,
    ];
    if (v) {
      lines.push(
        `<div class="accent">${KIND_NAMES[v.kind]} #${v.id}</div>`,
        `<div class="speed">${Math.round(Math.abs(v.speed) * 3.6)} <small>km/h</small></div>`,
      );
    }
    if (this.paused) lines.push('<div class="accent">已暂停</div>');
    this.hud.setStatus(lines.join(''));
  }
}

new Game(document.getElementById('app')!);
