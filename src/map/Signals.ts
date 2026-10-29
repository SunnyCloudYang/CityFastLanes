import type { TurnType } from './Lane';

export type LightState = 'green' | 'yellow' | 'red';

export interface SignalPhase {
  /** Approach groups served by this phase. */
  groups: number[];
  /** Restrict movements for protected phases; omitted means every movement. */
  turns?: TurnType[];
  green?: number;
  yellow?: number;
  allRed?: number;
}

/** Fixed-time N-phase signal with yellow and all-red clearance intervals. */
export class SignalController {
  static GREEN = 14;
  static YELLOW = 3;
  static ALL_RED = 1.5;
  readonly phases: Required<SignalPhase>[];
  private cycleDuration: number;
  private t: number;

  constructor(
    readonly nodeId: number,
    offset: number,
    phases: SignalPhase[] = [
      { groups: [0] },
      { groups: [1] },
    ],
  ) {
    this.phases = phases.map((p) => ({
      groups: [...p.groups],
      turns: p.turns ? [...p.turns] : ['straight', 'left', 'right', 'uturn'],
      green: p.green ?? SignalController.GREEN,
      yellow: p.yellow ?? SignalController.YELLOW,
      allRed: p.allRed ?? SignalController.ALL_RED,
    }));
    this.cycleDuration = this.phases.reduce((sum, p) => sum + p.green + p.yellow + p.allRed, 0);
    this.t = ((offset % this.cycle) + this.cycle) % this.cycle;
  }

  get cycle(): number {
    return this.cycleDuration;
  }

  /** Observer tool: uniformly retime green phases while preserving clearance intervals. */
  scaleGreen(factor: number): void {
    const safe = Math.max(0.25, Math.min(4, factor));
    for (const phase of this.phases) phase.green *= safe;
    this.cycleDuration = this.phases.reduce((sum, p) => sum + p.green + p.yellow + p.allRed, 0);
    this.t %= this.cycleDuration;
  }

  update(dt: number): void {
    this.t = (this.t + dt) % this.cycle;
  }

  state(group: number, turn?: TurnType): LightState {
    let elapsed = 0;
    for (const phase of this.phases) {
      const duration = phase.green + phase.yellow + phase.allRed;
      if (this.t < elapsed + duration) {
        const local = this.t - elapsed;
        const allowed = phase.groups.includes(group) && (!turn || phase.turns.includes(turn));
        if (!allowed || local >= phase.green + phase.yellow) return 'red';
        return local < phase.green ? 'green' : 'yellow';
      }
      elapsed += duration;
    }
    return 'red';
  }
}

/** Four-phase sequence: through/right traffic and protected lefts for each axis. */
export function protectedLeftPhases(): SignalPhase[] {
  return [
    { groups: [0], turns: ['straight', 'right', 'uturn'], green: 11 },
    { groups: [0], turns: ['left'], green: 6 },
    { groups: [1], turns: ['straight', 'right', 'uturn'], green: 11 },
    { groups: [1], turns: ['left'], green: 6 },
  ];
}
