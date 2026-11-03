import type { Vec2 } from '../core/math';
import type { Lane } from '../map/Lane';

export interface NearestLane {
  lane: Lane;
  s: number;
  distance: number;
}

export function nearestRoadLane(lanes: readonly Lane[], position: Vec2): NearestLane | null {
  let best: NearestLane | null = null;
  let bestDistanceSquared = Infinity;
  for (const lane of lanes) {
    if (lane.length <= 0) continue;
    const s = lane.project(position);
    const point = lane.pointAt(s).p;
    const dx = point.x - position.x;
    const dy = point.y - position.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      best = { lane, s, distance: Math.sqrt(distanceSquared) };
    }
  }
  return best;
}
