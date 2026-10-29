import * as THREE from 'three';
import { Input } from './control/Input';
import { TouchControls } from './control/TouchControls';
import { loadSettings, saveSettings, type Settings } from './core/Settings';
import { MAPS } from './map/maps';
import { parseMap, serializeMap } from './map/MapJson';
import type { MapDef } from './map/types';
import { CameraRig, VIEW_NAMES, type ViewMode } from './render/CameraRig';
import { OverlayRenderer } from './render/OverlayRenderer';
import { PedestrianRenderer } from './render/PedestrianRenderer';
import { buildScene, type BuiltScene } from './render/SceneBuilder';
import { SketchRenderer } from './render/sketch/SketchRenderer';
import { interpolatedPose, VehicleRenderer } from './render/VehicleRenderer';
import { Pedestrian } from './sim/Pedestrian';
import { Objectives, type ObjectiveMode } from './sim/Objectives';
import { PEDESTRIAN_SNAPSHOT_STRIDE, SNAPSHOT_STRIDE, type SimulationCommand, type SimulationSnapshot } from './sim/protocol';
import { Replay, type ReplayData, type ReplayInput } from './sim/Replay';
import { TrafficScore } from './sim/TrafficScore';
import { Vehicle, VEHICLE_KINDS } from './sim/Vehicle';
import { World } from './sim/World';
import { Hud } from './ui/Hud';
import { MapEditor } from './ui/MapEditor';
import './style.css';

const DT = 1 / 60;
const MAX_STEPS = 12;
const KIND_NAMES = { car: '轿车', van: '厢式车', bus: '公交', taxi: '出租车', motorcycle: '摩托', bike: '自行车' };
const VIEW_ORDER: ViewMode[] = ['top', 'chase', 'fp'];
const OBJECTIVE_NAMES = { delivery: '送货', pickup: '接人', timed: '限时到达' };

class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.4);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1.4);
  private readonly vehicles = new VehicleRenderer();
  private readonly pedestrians = new PedestrianRenderer();
  private readonly overlay = new OverlayRenderer();
  private readonly rig = new CameraRig();
  private readonly sketch: SketchRenderer;
  private readonly input: Input;
  private readonly hud: Hud;
  private world!: World;
  private built: BuiltScene | null = null;
  private readonly customMaps = new Map<string, MapDef>();
  private settings: Settings = loadSettings();
  private mapId = MAPS[0].id;
  private cars = this.settings.cars;
  private bikes = this.settings.bikes;
  private selectedId: number | null = null;
  private controlling = false;
  private paused = false;
  private timeScale = 1;
  private acc = 0;
  private last = performance.now();
  private clock = 0;
  private statusTimer = 0;
  private simWorker: Worker | null = null;
  private lastStepSent = 0;
  private frameMs = 16.7;
  private simMs = 0;
  private readonly score = new TrafficScore();
  private readonly objectives = new Objectives({ seed: 19 });
  private objectiveMode: ObjectiveMode | null = null;
  private objectiveRouteId = -1;
  private replay: Replay | null = null;
  private replaying = false;
  private lastScoreTime = 0;
  private lastCollisionCount = 0;
  private lastRouteKey = '';
  private editor: MapEditor | null = null;
  private editing = false;
  private drag = { active: false, moved: false, x: 0, y: 0 };
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.scene.add(this.ambient, this.sun, this.sun.target, this.vehicles.group, this.pedestrians.group, this.overlay.group);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sketch = new SketchRenderer(this.renderer);
    this.sketch.enabled = this.settings.sketch;
    this.sketch.setStyle(this.settings.style);
    this.input = new Input((code) => this.onKey(code));
    this.hud = new Hud({ maps: MAPS, ...this.settings }, {
      onMap: (id) => this.loadMap(id),
      onCounts: (cars, bikes) => {
        this.cars = cars;
        this.bikes = bikes;
        this.world.targetMotor = cars;
        this.world.targetBikes = bikes;
        this.send({ type: 'counts', cars, bikes });
        this.persist();
      },
      onSpeed: (s) => this.setSpeed(s),
      onPause: () => this.togglePause(),
      onSketch: (on) => { this.sketch.enabled = on; this.persist(); },
      onStyle: (style) => { this.sketch.setStyle(style); this.settings.style = style; this.persist(); },
      onNight: (amount) => { this.setNight(amount); this.settings.night = amount; this.persist(); },
      onObjective: (mode) => this.setObjective(mode),
      onRoutes: (enabled) => { this.overlay.showRoutes = enabled; this.refreshRoute(true); },
      onHeatmap: (enabled) => { this.overlay.showHeatmap = enabled; },
      onSignals: (scale) => { this.world.setSignalScale(scale); this.send({ type: 'signals', scale }); },
      onMapExport: () => this.download(`${this.world.def.id}.json`, serializeMap(this.world.def)),
      onMapImport: (file) => this.importMap(file),
      onEdit: () => this.toggleEditor(),
      onShare: () => this.shareMap(),
      onReplayRecord: () => this.toggleRecording(),
      onReplayPlay: (file) => this.importReplay(file),
      onReplayExport: () => this.exportReplay(),
    });
    new TouchControls(this.input, () => this.takeControl(), () => this.cycleView());
    this.setNight(this.settings.night);
    this.bindPointer(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    const initial = MAPS.some((m) => m.id === this.settings.mapId) ? this.settings.mapId : MAPS[0].id;
    this.loadMap(initial);
    requestAnimationFrame(this.frame);
  }

  private persist(): void {
    this.settings.mapId = this.mapId;
    this.settings.cars = this.cars;
    this.settings.bikes = this.bikes;
    this.settings.sketch = this.sketch.enabled;
    saveSettings(this.settings);
  }

  private loadMap(id: string, supplied?: MapDef): void {
    const entry = MAPS.find((m) => m.id === id);
    const def = supplied ?? entry?.build() ?? this.customMaps.get(id) ?? MAPS[0].build();
    this.mapId = def.id;
    if (this.built) {
      this.scene.remove(this.built.root);
      this.built.dispose();
    }
    this.vehicles.clear();
    this.world = new World(def, this.cars, this.bikes);
    this.startWorker();
    this.built = buildScene(this.world.net);
    this.scene.add(this.built.root);
    this.selectedId = null;
    this.controlling = false;
    this.score.reset();
    this.objectives.clear();
    this.objectiveRouteId = -1;
    this.lastRouteKey = '';
    this.lastScoreTime = 0;
    this.lastCollisionCount = 0;
    this.overlay.setDestination(null);
    this.overlay.setRoute([]);
    this.editor = null;
    this.editing = false;
    this.rig.setMode('top');
    const b = def.bounds;
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
    this.persist();
  }

  private startWorker(): void {
    this.simWorker?.terminate();
    this.simWorker = null;
    if (typeof Worker === 'undefined') return;
    const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    this.simWorker = worker;
    worker.onmessage = (event: MessageEvent<SimulationSnapshot>) => {
      this.applySnapshot(event.data);
      if (this.lastStepSent) this.simMs = this.simMs * 0.85 + (performance.now() - this.lastStepSent) * 0.15;
    };
    worker.onerror = () => {
      if (this.simWorker !== worker) return;
      worker.terminate();
      this.simWorker = null;
      this.hud.toast('Worker 不可用，已切换主线程模拟');
    };
    worker.postMessage({ type: 'init', def: this.world.def, cars: this.cars, bikes: this.bikes } satisfies SimulationCommand);
  }

  private send(command: SimulationCommand): void { this.simWorker?.postMessage(command); }

  private applySnapshot(snapshot: SimulationSnapshot): void {
    const data = new Float32Array(snapshot.data);
    const existing = new Map(this.world.vehicles.map((v) => [v.id, v]));
    const seen = new Set<number>();
    for (let o = 0; o < data.length; o += SNAPSHOT_STRIDE) {
      const id = data[o];
      seen.add(id);
      let v = existing.get(id);
      if (!v) {
        v = new Vehicle(VEHICLE_KINDS[data[o + 1]], { x: data[o + 4], y: data[o + 5] }, data[o + 6], data[o + 2], data[o + 3], id);
        this.world.vehicles.push(v);
      }
      v.pos.x = data[o + 4]; v.pos.y = data[o + 5]; v.heading = data[o + 6];
      v.prevPos.x = data[o + 7]; v.prevPos.y = data[o + 8]; v.prevHeading = data[o + 9];
      v.speed = data[o + 10]; v.steer = data[o + 11]; v.controller = data[o + 12] ? 'player' : 'ai';
      const route = snapshot.routes[id] ?? [];
      v.lane = route[0] >= 0 ? this.world.net.lanes[route[0]] ?? null : null;
      v.route = route.slice(1).map((laneId) => this.world.net.lanes[laneId]).filter(Boolean);
    }
    for (let i = this.world.vehicles.length - 1; i >= 0; i--) if (!seen.has(this.world.vehicles[i].id)) this.world.vehicles.splice(i, 1);
    const pedestrianData = new Float32Array(snapshot.pedestrianData);
    const pedestrians = new Map(this.world.pedestrians.map((p) => [p.id, p]));
    const pedestrianSeen = new Set<number>();
    for (let o = 0; o < pedestrianData.length; o += PEDESTRIAN_SNAPSHOT_STRIDE) {
      const id = pedestrianData[o];
      pedestrianSeen.add(id);
      let p = pedestrians.get(id);
      if (!p) {
        p = new Pedestrian(id, [{ x: pedestrianData[o + 1], y: pedestrianData[o + 2] }], 1.3, 0);
        this.world.pedestrians.push(p);
      }
      p.pos.x = pedestrianData[o + 1]; p.pos.y = pedestrianData[o + 2];
      p.prevPos.x = pedestrianData[o + 3]; p.prevPos.y = pedestrianData[o + 4];
      const dx = p.pos.x - p.prevPos.x; const dy = p.pos.y - p.prevPos.y;
      if (Math.hypot(dx, dy) > 0.0001) p.heading = Math.atan2(dy, dx);
    }
    for (let i = this.world.pedestrians.length - 1; i >= 0; i--) if (!pedestrianSeen.has(this.world.pedestrians[i].id)) this.world.pedestrians.splice(i, 1);
    const dt = this.lastScoreTime ? Math.max(0, snapshot.time - this.lastScoreTime) : 0;
    for (const signal of this.world.net.signals) signal.update(dt);
    this.world.time = snapshot.time;
    this.lastScoreTime = snapshot.time;
    if (snapshot.collisions > this.lastCollisionCount && this.controlling) this.score.penalizeCollision();
    this.lastCollisionCount = snapshot.collisions;
    this.updateGameplay(dt);
  }

  private updateGameplay(dt: number): void {
    const player = this.controlling ? this.selected : null;
    if (player && dt > 0) {
      this.score.step(this.world, player, dt);
      const objective = this.objectives.step(this.world, player, dt);
      if (objective && objective.id !== this.objectiveRouteId) {
        this.objectiveRouteId = objective.id;
        this.overlay.setDestination(objective.destination);
        this.overlay.setRoute(objective.route);
        this.lastRouteKey = `objective-${objective.id}`;
      }
      if (objective?.status === 'completed') {
        this.hud.toast(`目标完成！已完成 ${this.objectives.completedCount} 个`);
        this.objectives.next(this.world, player);
      } else if (objective?.status === 'expired') {
        this.hud.toast('时间到，已生成下一个目的地');
        this.objectives.next(this.world, player);
      }
    }
  }

  private resize(): void {
    const w = window.innerWidth; const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.sketch.setSize(w, h, this.renderer.getPixelRatio());
    this.rig.resize(w, h);
  }

  private get selected(): Vehicle | null {
    return this.selectedId === null ? null : this.world.vehicles.find((v) => v.id === this.selectedId) ?? null;
  }

  private select(id: number | null): void {
    if (this.controlling && id !== this.selectedId) this.release();
    this.selectedId = id;
    this.world.protectedIds.clear();
    if (id !== null) this.world.protectedIds.add(id); else this.rig.setMode('top');
    this.send({ type: 'protect', id: id ?? 0 });
    this.refreshRoute(true);
  }

  private takeControl(): void {
    if (this.replaying) return;
    let v = this.selected;
    if (!v) {
      const t = this.rig.target;
      v = this.world.vehicles.reduce<Vehicle | null>((best, u) => !best || Math.hypot(u.pos.x - t.x, u.pos.y - t.z) < Math.hypot(best.pos.x - t.x, best.pos.y - t.z) ? u : best, null);
      if (!v) return;
      this.select(v.id);
    }
    this.world.takeControl(v);
    this.send({ type: 'take', id: v.id });
    this.controlling = true;
    this.score.reset();
    if (this.objectiveMode) {
      this.objectives.start(this.world, v, this.objectiveMode);
      this.objectiveRouteId = -1;
    }
    if (this.rig.mode === 'top') this.rig.setMode('chase');
  }

  private release(): void {
    const v = this.selected;
    if (v) { this.world.releaseControl(v); this.send({ type: 'release', id: v.id }); }
    this.controlling = false;
    this.objectives.clear();
    this.objectiveRouteId = -1;
    this.overlay.setDestination(null);
    this.refreshRoute(true);
  }

  private cycleSelection(): void {
    if (this.controlling || !this.world.vehicles.length) return;
    const i = this.world.vehicles.findIndex((v) => v.id === this.selectedId);
    this.select(this.world.vehicles[(i + 1) % this.world.vehicles.length].id);
  }

  private cycleView(): void {
    if (!this.selected) { this.rig.setMode('top'); return; }
    this.rig.setMode(VIEW_ORDER[(VIEW_ORDER.indexOf(this.rig.mode) + 1) % VIEW_ORDER.length]);
  }

  private refreshRoute(force = false): void {
    if (this.controlling && this.objectives.current) return;
    const route = this.selected ? [this.selected.lane, ...this.selected.route].filter((lane) => lane !== null) : [];
    const key = `${this.selectedId}:${route.map((lane) => lane!.id).join(',')}`;
    if (force || key !== this.lastRouteKey) {
      this.lastRouteKey = key;
      this.overlay.setRoute(route as NonNullable<Vehicle['lane']>[]);
    }
  }

  private setNight(amount: number): void {
    this.sketch.setNight(amount); this.vehicles.setNight(amount);
    this.ambient.intensity = 1.4 - amount * 0.9;
    this.sun.intensity = 2.4 - amount * 2.1;
  }

  private setSpeed(s: number): void { this.timeScale = s; this.hud.setSpeed(s); }
  private togglePause(): void { this.paused = !this.paused; this.hud.setPaused(this.paused); }

  private setObjective(mode: ObjectiveMode | null): void {
    this.objectiveMode = mode;
    this.objectives.clear();
    this.objectiveRouteId = -1;
    this.overlay.setDestination(null);
    if (!this.controlling && mode) this.takeControl();
    else if (this.controlling && mode && this.selected) this.objectives.start(this.world, this.selected, mode);
    else this.refreshRoute(true);
  }

  private onKey(code: string): void {
    switch (code) {
      case 'Tab': this.cycleSelection(); break;
      case 'Enter': case 'KeyF': if (this.controlling) this.release(); else this.takeControl(); break;
      case 'Escape': if (this.editing) this.toggleEditor(); else if (this.controlling) this.release(); else this.select(null); break;
      case 'KeyV': this.cycleView(); break;
      case 'KeyQ': this.rig.rotate(-1); break;
      case 'KeyE': this.rig.rotate(1); break;
      case 'KeyP': this.togglePause(); break;
      case 'Digit1': this.setSpeed(0.5); break;
      case 'Digit2': this.setSpeed(1); break;
      case 'Digit3': this.setSpeed(3); break;
      case 'KeyK': this.sketch.enabled = !this.sketch.enabled; this.hud.setSketch(this.sketch.enabled); this.persist(); break;
    }
  }

  private bindPointer(el: HTMLCanvasElement): void {
    el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.drag = { active: true, moved: false, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDistance > 0) this.rig.zoom(this.pinchDistance / Math.max(distance, 1));
        this.pinchDistance = distance;
        this.drag.moved = true;
        return;
      }
      if (!this.drag.active) return;
      const dx = e.clientX - this.drag.x; const dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!this.drag.moved && !this.controlling) this.select(null);
      this.drag.moved = true;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      if (this.rig.mode === 'top' && !this.controlling && !this.editing) this.rig.pan(dx, dy, el.clientHeight);
    });
    el.addEventListener('pointerup', (e) => {
      this.pointers.delete(e.pointerId);
      this.pinchDistance = 0;
      const wasClick = this.drag.active && !this.drag.moved;
      this.drag.active = false;
      if (!wasClick) return;
      if (this.editing) { this.editAt(e.clientX, e.clientY); return; }
      const id = this.pickAt(e.clientX, e.clientY);
      if (id !== null) this.select(id); else if (!this.controlling) this.select(null);
    });
    el.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.drag.active = false; });
    el.addEventListener('dblclick', (e) => {
      if (this.editing) return;
      const id = this.pickAt(e.clientX, e.clientY);
      if (id === null) return;
      this.select(id); this.takeControl();
    });
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.rig.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1); }, { passive: false });
  }

  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const el = this.renderer.domElement;
    const ndc = new THREE.Vector2((clientX / el.clientWidth) * 2 - 1, -(clientY / el.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.rig.camera);
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  }

  private pickAt(clientX: number, clientY: number): number | null {
    const el = this.renderer.domElement;
    const ndc = new THREE.Vector2((clientX / el.clientWidth) * 2 - 1, -(clientY / el.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.rig.camera);
    const slop = this.rig.mode === 'top' ? Math.max(3, this.rig.viewHeight / 60) : 3;
    return this.vehicles.pick(ray, this.world, slop);
  }

  private applyInput(realDt: number): void {
    const v = this.selected;
    if (this.controlling && v) {
      if (!this.replaying) {
        v.input.throttle = this.input.throttle;
        v.input.steer = this.input.steer;
        v.input.handbrake = this.input.handbrake;
      }
      return;
    }
    const t = this.input.throttle; const s = this.input.steer;
    if (t || s) {
      if (this.selectedId !== null) this.select(null);
      const px = this.rig.viewHeight * 0.8 * realDt;
      const h = this.renderer.domElement.clientHeight;
      const wpp = this.rig.viewHeight / h;
      this.rig.pan((-s * px) / wpp, (t * px * Math.sin(this.rig.elevation)) / wpp, h);
    }
  }

  private frame = (now: number): void => {
    const raw = now - this.last;
    const real = Math.min(0.1, raw / 1000);
    this.frameMs = this.frameMs * 0.9 + raw * 0.1;
    this.last = now; this.clock += real;
    if (this.controlling && !this.selected) this.controlling = false;
    if (this.selectedId !== null && !this.selected) this.select(null);
    this.applyInput(real);
    if (!this.paused) {
      this.acc += real * this.timeScale;
      let n = 0;
      const simStart = performance.now();
      while (this.acc >= DT && n < MAX_STEPS) {
        const recorded = this.controlling && this.selected ? { ...this.selected.input } : { throttle: 0, steer: 0, handbrake: false };
        if (this.replay?.isRecording) this.replay.record(recorded);
        let input: (ReplayInput & { id: number }) | undefined;
        if (this.replaying) {
          const playback = this.replay?.nextInput();
          if (playback && this.selected) input = { ...playback, id: this.selected.id };
          else { this.replaying = false; this.hud.toast('回放结束'); }
        } else if (this.controlling && this.selected) input = { ...this.selected.input, id: this.selected.id };
        if (input && this.selected) Object.assign(this.selected.input, input);
        if (this.simWorker) {
          this.send({ type: 'step', dt: DT, input });
          this.lastStepSent = performance.now();
        } else {
          this.world.step(DT);
          this.lastScoreTime = this.world.time;
          this.updateGameplay(DT);
        }
        this.acc -= DT; n++;
      }
      if (!this.simWorker && n) this.simMs = this.simMs * 0.85 + (performance.now() - simStart) * 0.15;
      if (n >= MAX_STEPS) this.acc = 0;
    }
    const alpha = this.acc / DT;
    this.vehicles.sync(this.world, alpha, this.selectedId, this.controlling, this.rig.mode === 'top');
    this.pedestrians.sync(this.world, alpha);
    this.overlay.update(this.world, this.clock);
    if (this.built) for (const l of this.built.lamps) l.mesh.material = this.built.lampMaterials[l.ctrl.state(l.group)];
    const v = this.selected;
    this.rig.update(real, v ? { v, pose: interpolatedPose(v, alpha) } : null);
    this.renderer.info.reset();
    this.sketch.render(this.scene, this.rig.camera, this.clock, this.rig.mode === 'fp' && v ? Math.abs(v.speed) : 0);
    this.statusTimer -= real;
    if (this.statusTimer <= 0) { this.statusTimer = 0.15; this.refreshRoute(); this.updateStatus(v); }
    requestAnimationFrame(this.frame);
  };

  private updateStatus(v: Vehicle | null): void {
    const mode = this.replaying ? '回放' : this.controlling ? '驾驶中' : v ? '跟随' : this.editing ? '编辑地图' : '观察';
    const lines = [`<div class="mode">${mode} · ${VIEW_NAMES[this.rig.mode]}</div>`, `<div>车辆 ${this.world.count(false)} · 自行车 ${this.world.count(true)} · 行人 ${this.world.pedestrians.length}</div>`];
    if (v) lines.push(`<div class="accent">${KIND_NAMES[v.kind]} #${v.id}</div>`, `<div class="speed">${Math.round(Math.abs(v.speed) * 3.6)} <small>km/h</small></div>`);
    if (this.controlling) lines.push(`<div>交规评分 <b>${this.score.score}</b> · 安全 ${Math.floor(this.score.safeStreak)}s</div>`);
    const objective = this.objectives.current;
    if (objective) lines.push(`<div class="accent">${OBJECTIVE_NAMES[objective.mode]} #${objective.id}${objective.remainingTime !== null ? ` · ${Math.ceil(objective.remainingTime)}s` : ''}</div>`);
    if (this.replay?.isRecording) lines.push(`<div class="accent">记录中 · ${this.replay.frameCount} 帧</div>`);
    if (this.replaying) lines.push(`<div class="accent">回放 ${this.replay?.playbackIndex}/${this.replay?.frameCount}</div>`);
    const event = this.score.events.at(-1);
    if (event && event.time > this.world.time - 3) lines.push(`<div class="accent">${{ redLight: '闯红灯', wrongWay: '逆行', collision: '碰撞' }[event.type]} −${event.penalty}</div>`);
    lines.push(`<div class="perf">${this.frameMs.toFixed(1)} ms · 模拟 ${this.simMs.toFixed(1)} ms</div>`, `<div class="perf">${this.renderer.info.render.calls} 次绘制 · ${this.simWorker ? 'Worker' : '主线程'}</div>`);
    if (this.paused) lines.push('<div class="accent">已暂停</div>');
    this.hud.setStatus(lines.join(''));
  }

  private toggleEditor(): void {
    this.editing = !this.editing;
    this.editor = this.editing ? new MapEditor(this.world.def) : null;
    if (this.editing) {
      this.release(); this.select(null); this.rig.setMode('top');
      this.hud.toast('编辑：空白处放节点，依次点击两个节点连路；Esc 退出');
    } else this.hud.toast('已退出地图编辑');
  }

  private editAt(x: number, y: number): void {
    const ground = this.groundAt(x, y);
    if (!ground || !this.editor) return;
    const result = this.editor.click({ x: ground.x, y: ground.z });
    if (!result) { this.hud.toast('请先选择道路起点，或避免重复连接'); return; }
    const continueFrom = this.editor.waitingForRoadEnd;
    const id = `edited-${Date.now().toString(36)}`;
    result.def.id = id;
    this.customMaps.set(id, result.def);
    this.hud.addMap(id, result.def.name);
    this.loadMap(id);
    this.editing = true;
    this.editor = new MapEditor(result.def);
    if (continueFrom) this.editor.click({ x: ground.x, y: ground.z });
    this.hud.toast(result.message);
  }

  private async importMap(file: File): Promise<void> {
    try {
      const def = parseMap(await file.text());
      def.id = `imported-${Date.now().toString(36)}`;
      this.customMaps.set(def.id, def);
      this.hud.addMap(def.id, def.name);
      this.loadMap(def.id);
      this.hud.toast(`已导入「${def.name}」：${def.nodes.length} 节点 / ${def.roads.length} 道路`);
    } catch (error) { this.hud.toast(`地图导入失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  private async shareMap(): Promise<void> {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('map', this.mapId);
    try { await navigator.clipboard.writeText(url.toString()); this.hud.toast('分享链接已复制（导入地图请同时分享 JSON）'); }
    catch { this.hud.toast(url.toString()); }
  }

  private toggleRecording(): void {
    if (this.replay?.isRecording) {
      this.replay.finish();
      this.hud.setRecording(false);
      this.hud.toast(`已记录 ${this.replay.frameCount} 帧，可导出回放`);
      return;
    }
    this.replaying = false;
    this.replay = new Replay(this.replayConfig());
    this.replay.startRecording();
    this.hud.setRecording(true);
    this.hud.toast('开始记录固定步长驾驶输入');
  }

  private replayConfig() {
    return { seed: this.world.def.seed, mapId: this.world.def.id, initialVehicles: { motor: this.cars, bikes: this.bikes }, dt: DT };
  }

  private exportReplay(): void {
    if (!this.replay || !this.replay.frameCount) { this.hud.toast('还没有可导出的回放'); return; }
    if (this.replay.isRecording) { this.replay.finish(); this.hud.setRecording(false); }
    this.download(`${this.mapId}-replay.json`, this.replay.exportJSON());
  }

  private async importReplay(file: File): Promise<void> {
    try {
      const data: ReplayData = Replay.importJSON(await file.text()).toData();
      if (data.dt !== DT) throw new Error(`仅支持 1/60 秒固定步长回放（文件为 ${data.dt}）`);
      const entry = MAPS.find((m) => m.id === data.mapId);
      const def = entry?.build() ?? this.customMaps.get(data.mapId);
      if (!def || def.seed !== data.seed) throw new Error('找不到回放对应的地图与种子；导入地图的临时 ID 不可跨会话回放');
      this.cars = data.initialVehicles.motor; this.bikes = data.initialVehicles.bikes;
      this.loadMap(data.mapId);
      const first = this.world.vehicles[0];
      if (!first) throw new Error('回放需要至少一辆车');
      this.select(first.id); this.takeControl();
      this.replay = new Replay({ seed: data.seed, mapId: data.mapId, initialVehicles: data.initialVehicles, dt: data.dt });
      this.replay.startPlayback(data);
      this.replaying = true;
      this.hud.setRecording(false);
      this.hud.toast(`开始回放 ${data.frames.length} 帧`);
    } catch (error) { this.hud.toast(`回放导入失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  private download(name: string, content: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

new Game(document.getElementById('app')!);
