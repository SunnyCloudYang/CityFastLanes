export type LightState = 'green' | 'yellow' | 'red';

/** Two-group fixed-time signal: group 0 and group 1 alternate, with an all-red gap. */
export class SignalController {
  static GREEN = 14;
  static YELLOW = 3;
  static ALL_RED = 1.5;

  private t: number;

  constructor(
    readonly nodeId: number,
    offset: number,
  ) {
    this.t = ((offset % this.cycle) + this.cycle) % this.cycle;
  }

  get half(): number {
    return SignalController.GREEN + SignalController.YELLOW + SignalController.ALL_RED;
  }

  get cycle(): number {
    return this.half * 2;
  }

  update(dt: number): void {
    this.t = (this.t + dt) % this.cycle;
  }

  state(group: number): LightState {
    const local = (this.t - group * this.half + this.cycle) % this.cycle;
    if (local < SignalController.GREEN) return 'green';
    if (local < SignalController.GREEN + SignalController.YELLOW) return 'yellow';
    return 'red';
  }
}
