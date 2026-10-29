import { distance } from '../core/math';
import type { Lane, TrafficClass } from './Lane';

class MinHeap<T> {
  private items: T[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): T | undefined {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

/**
 * Lane-level A* by travel time. Returns the lanes to drive after `from`,
 * ending with `to`, or null when unreachable.
 */
export function findRoute(
  from: Lane,
  to: Lane,
  maxSpeed = 14,
  traffic: TrafficClass = 'all',
  allowLaneChanges = true,
): Lane[] | null {
  if (from === to) return null;
  const g = new Map<Lane, number>([[from, 0]]);
  const came = new Map<Lane, Lane>();
  const heap = new MinHeap<Lane>();
  heap.push(from, 0);
  while (heap.size) {
    const cur = heap.pop()!;
    if (cur === to) {
      const path: Lane[] = [];
      let c: Lane = to;
      while (c !== from) {
        path.push(c);
        c = came.get(c)!;
      }
      return path.reverse();
    }
    const gc = g.get(cur)!;
    const edges = [...cur.next];
    if (allowLaneChanges && cur.kind === 'road') {
      if (cur.left) edges.push(cur.left);
      if (cur.right) edges.push(cur.right);
    }
    for (const nx of edges) {
      if (nx.traffic !== 'all' && traffic !== 'all' && nx.traffic !== traffic) continue;
      const ng = gc + nx.length / Math.max(nx.speedLimit, 1);
      if (ng < (g.get(nx) ?? Infinity)) {
        g.set(nx, ng);
        came.set(nx, cur);
        heap.push(nx, ng + distance(nx.end, to.end) / maxSpeed);
      }
    }
  }
  return null;
}
