import type { MapRoad } from './types';

export const LANE_WIDTH = 3.5;
export const ROAD_HALF_WIDTH = LANE_WIDTH;
/** Road lanes stop this far from the node centre; connectors fill the gap. */
export const INTERSECTION_RADIUS = 9;
export const SIDEWALK_WIDTH = 3.5;
/** Distances measured back from the end of an incoming road lane. */
export const CROSSWALK_DISTANCE = 2.2;
export const STOP_LINE_DISTANCE = 3.4;

export function roadHalfWidth(road: Pick<MapRoad, 'lanes' | 'oneWay'>): number {
  return ((road.lanes ?? 1) * LANE_WIDTH * (road.oneWay ? 1 : 2)) / 2;
}

/** Signed right-hand offset of a lane centre from its road centreline. */
export function laneCenterOffset(road: Pick<MapRoad, 'lanes' | 'oneWay'>, laneIndex: number): number {
  const count = road.lanes ?? 1;
  return road.oneWay ? (laneIndex - (count - 1) / 2) * LANE_WIDTH : (laneIndex + 0.5) * LANE_WIDTH;
}
