import { generateGrid } from './generators/grid';
import { generateOrganic } from './generators/organic';
import { generateRadial } from './generators/radial';
import { generateRing } from './generators/ring';
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
      generateGrid({
        id: 'downtown',
        name: '方格市中心',
        seed: 11,
        cols: 7,
        rows: 7,
        spacing: 72,
        parkChance: 0.12,
        lanes: 2,
        protectedLeft: true,
      }),
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
  {
    id: 'radial',
    name: '放射新城',
    build: () => generateRadial({ id: 'radial', name: '放射新城', seed: 23, singleWay: true }),
  },
  {
    id: 'ring',
    name: '单向环岛',
    build: () => generateRing({ id: 'ring', name: '单向环岛', seed: 29 }),
  },
  {
    id: 'organic',
    name: '有机街区',
    build: () => generateOrganic({ id: 'organic', name: '有机街区', seed: 31 }),
  },
];
