export interface HudCallbacks {
  onMap(id: string): void;
  onCounts(cars: number, bikes: number): void;
  onSpeed(scale: number): void;
  onPause(): void;
  onSketch(enabled: boolean): void;
}

export interface HudInit {
  maps: { id: string; name: string }[];
  mapId: string;
  cars: number;
  bikes: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private readonly status = $('status');
  private readonly pauseBtn = $<HTMLButtonElement>('pause-btn');
  private readonly speedBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')];
  private readonly sketch = $<HTMLInputElement>('sketch-toggle');

  constructor(init: HudInit, cb: HudCallbacks) {
    const select = $<HTMLSelectElement>('map-select');
    for (const m of init.maps) select.add(new Option(m.name, m.id, false, m.id === init.mapId));
    select.addEventListener('change', () => {
      cb.onMap(select.value);
      select.blur();
    });

    const cars = $<HTMLInputElement>('car-count');
    const bikes = $<HTMLInputElement>('bike-count');
    const carsVal = $('car-count-val');
    const bikesVal = $('bike-count-val');
    cars.value = String(init.cars);
    bikes.value = String(init.bikes);
    const sync = () => {
      carsVal.textContent = cars.value;
      bikesVal.textContent = bikes.value;
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
    this.sketch.addEventListener('change', () => {
      cb.onSketch(this.sketch.checked);
      this.sketch.blur();
    });
  }

  setStatus(html: string): void {
    this.status.innerHTML = html;
  }

  setSpeed(scale: number): void {
    for (const b of this.speedBtns) b.classList.toggle('active', Number(b.dataset.speed) === scale);
  }

  setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '继续' : '暂停';
    this.pauseBtn.classList.toggle('active', paused);
  }

  setSketch(enabled: boolean): void {
    this.sketch.checked = enabled;
  }
}
