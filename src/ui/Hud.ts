import type { SketchStyle } from '../render/sketch/SketchRenderer';
import type { ObjectiveMode } from '../sim/Objectives';

export interface HudCallbacks {
  onMap(id: string): void;
  onCounts(cars: number, bikes: number): void;
  onSpeed(scale: number): void;
  onPause(): void;
  onSketch(enabled: boolean): void;
  onStyle(style: SketchStyle): void;
  onNight(amount: number): void;
  onObjective(mode: ObjectiveMode | null): void;
  onRoutes(enabled: boolean): void;
  onHeatmap(enabled: boolean): void;
  onSignals(scale: number): void;
  onMapExport(): void;
  onMapImport(file: File): void;
  onEdit(): void;
  onShare(): void;
  onReplayRecord(): void;
  onReplayPlay(file: File): void;
  onReplayExport(): void;
}

export interface HudInit {
  maps: { id: string; name: string }[];
  mapId: string;
  cars: number;
  bikes: number;
  style: SketchStyle;
  night: number;
  sketch: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private readonly status = $('status');
  private readonly pauseBtn = $<HTMLButtonElement>('pause-btn');
  private readonly speedBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')];
  private readonly sketch = $<HTMLInputElement>('sketch-toggle');
  private toastTimer = 0;

  constructor(init: HudInit, cb: HudCallbacks) {
    const select = $<HTMLSelectElement>('map-select');
    for (const m of init.maps) select.add(new Option(m.name, m.id, false, m.id === init.mapId));
    select.addEventListener('change', () => {
      cb.onMap(select.value);
      select.blur();
    });
    const cars = $<HTMLInputElement>('car-count');
    const bikes = $<HTMLInputElement>('bike-count');
    cars.value = String(init.cars);
    bikes.value = String(init.bikes);
    const sync = () => {
      $('car-count-val').textContent = cars.value;
      $('bike-count-val').textContent = bikes.value;
    };
    sync();
    for (const el of [cars, bikes]) {
      el.addEventListener('input', () => {
        sync();
        cb.onCounts(Number(cars.value), Number(bikes.value));
      });
      el.addEventListener('change', () => el.blur());
    }
    for (const b of this.speedBtns) b.addEventListener('click', () => cb.onSpeed(Number(b.dataset.speed)));
    this.pauseBtn.addEventListener('click', () => cb.onPause());
    this.sketch.checked = init.sketch;
    this.sketch.addEventListener('change', () => cb.onSketch(this.sketch.checked));
    const style = $<HTMLSelectElement>('style-select');
    style.value = init.style;
    style.addEventListener('change', () => cb.onStyle(style.value as SketchStyle));
    const night = $<HTMLInputElement>('night-range');
    night.value = String(init.night);
    night.addEventListener('input', () => cb.onNight(Number(night.value)));
    $<HTMLSelectElement>('objective-mode').addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value;
      cb.onObjective(value ? (value as ObjectiveMode) : null);
    });
    $<HTMLInputElement>('route-toggle').addEventListener('change', (event) => cb.onRoutes((event.target as HTMLInputElement).checked));
    $<HTMLInputElement>('heat-toggle').addEventListener('change', (event) => cb.onHeatmap((event.target as HTMLInputElement).checked));
    const signals = $<HTMLInputElement>('signal-scale');
    signals.addEventListener('input', () => {
      $('signal-scale-val').textContent = `${signals.value}×`;
      cb.onSignals(Number(signals.value));
    });
    $('map-export').addEventListener('click', cb.onMapExport);
    $('map-import').addEventListener('click', () => $<HTMLInputElement>('map-file').click());
    $<HTMLInputElement>('map-file').addEventListener('change', async (event) => {
      const input = event.target as HTMLInputElement;
      if (input.files?.[0]) await cb.onMapImport(input.files[0]);
      input.value = '';
    });
    $('map-edit').addEventListener('click', cb.onEdit);
    $('map-share').addEventListener('click', cb.onShare);
    $('replay-record').addEventListener('click', cb.onReplayRecord);
    $('replay-play').addEventListener('click', () => $<HTMLInputElement>('replay-file').click());
    $<HTMLInputElement>('replay-file').addEventListener('change', async (event) => {
      const input = event.target as HTMLInputElement;
      if (input.files?.[0]) await cb.onReplayPlay(input.files[0]);
      input.value = '';
    });
    $('replay-export').addEventListener('click', cb.onReplayExport);
    const panel = $('panel-controls');
    $('panel-toggle').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      $('panel-toggle').textContent = panel.classList.contains('collapsed') ? '+' : '−';
    });
    if (matchMedia('(max-width: 700px), (pointer: coarse)').matches) panel.classList.add('collapsed');
  }

  setStatus(html: string): void { this.status.innerHTML = html; }
  setSpeed(scale: number): void { for (const b of this.speedBtns) b.classList.toggle('active', Number(b.dataset.speed) === scale); }
  setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '继续' : '暂停';
    this.pauseBtn.classList.toggle('active', paused);
  }
  setSketch(enabled: boolean): void { this.sketch.checked = enabled; }
  setRecording(recording: boolean): void { $('replay-record').textContent = recording ? '停止记录' : '开始记录'; }
  addMap(id: string, name: string): void {
    const select = $<HTMLSelectElement>('map-select');
    if (![...select.options].some((o) => o.value === id)) select.add(new Option(name, id));
    select.value = id;
  }
  toast(message: string): void {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('visible'), 3200);
  }
}
