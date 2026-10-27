import { generateGrid } from './generators/grid';
import type { MapDef } from './types';

export interface MapEntry {
  id: string;
  name: string;
  build: () => MapDef;
}

export const MAPS: MapEntry[] = [
  {
    id: 'downtown',
    name: '方格市中心',
    build: () =>
      generateGrid({ id: 'downtown', name: '方格市中心', seed: 11, cols: 7, rows: 7, spacing: 72, parkChance: 0.12 }),
  },
  {
    id: 'oldtown',
    name: '老城区',
    build: () =>
      generateGrid({
        id: 'oldtown',
        name: '老城区',
        seed: 7,
        cols: 7,
        rows: 6,
        spacing: 62,
        jitter: 8,
        removeRatio: 0.22,
        parkChance: 0.18,
        speedLimit: 11,
      }),
  },
  {
    id: 'riverside',
    name: '河畔双桥',
    build: () =>
      generateGrid({
        id: 'riverside',
        name: '河畔双桥',
        seed: 3,
        cols: 8,
        rows: 6,
        spacing: 68,
        jitter: 4,
        parkChance: 0.15,
        river: { afterCol: 3, width: 46, bridgeRows: [1, 4] },
      }),
  },
];
