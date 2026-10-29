import type { MapDef } from '../map/types';

export const SNAPSHOT_STRIDE = 13;
export const PEDESTRIAN_SNAPSHOT_STRIDE = 5;

export type SimulationCommand =
  | { type: 'init'; def: MapDef; cars: number; bikes: number }
  | {
      type: 'step';
      dt: number;
      input?: { id: number; throttle: number; steer: number; handbrake: boolean };
    }
  | { type: 'take' | 'release' | 'protect'; id: number }
  | { type: 'counts'; cars: number; bikes: number }
  | { type: 'signals'; scale: number };

export interface SimulationSnapshot {
  type: 'snapshot';
  /** Vehicle data; the original SNAPSHOT_STRIDE layout is unchanged. */
  data: ArrayBuffer;
  /** id, x, y, previous x, previous y for each pedestrian. */
  pedestrianData: ArrayBuffer;
  /** Current lane followed by planned lanes, for observation overlays. */
  routes: Record<number, number[]>;
  collisions: number;
  time: number;
}
