import { distance, type Vec2 } from '../core/math';
import type { MapDef } from '../map/types';

/** Minimal node-and-road editor. Each accepted edit returns a fresh MapDef. */
export class MapEditor {
  private pendingNode: number | null = null;

  constructor(private readonly source: MapDef) {}

  get waitingForRoadEnd(): boolean {
    return this.pendingNode !== null;
  }

  cancel(): void {
    this.pendingNode = null;
  }

  click(point: Vec2): { def: MapDef; message: string } | null {
    const def = structuredClone(this.source);
    const near = def.nodes
      .map((node) => ({ node, distance: distance(node, point) }))
      .filter((item) => item.distance < 8)
      .sort((a, b) => a.distance - b.distance)[0]?.node;
    if (!near) {
      if (this.pendingNode !== null) return null;
      const id = Math.max(-1, ...def.nodes.map((node) => node.id)) + 1;
      def.nodes.push({ id, x: Math.round(point.x), y: Math.round(point.y) });
      def.decor = [];
      this.expandBounds(def, point);
      this.pendingNode = id;
      return { def, message: `已放置节点 ${id}；点击另一节点或空白处连路` };
    }
    if (this.pendingNode === null) {
      this.pendingNode = near.id;
      return { def, message: `起点 ${near.id}；点击终点连接道路` };
    }
    if (this.pendingNode === near.id) {
      this.pendingNode = null;
      return null;
    }
    if (def.roads.some((r) => (r.from === this.pendingNode && r.to === near.id) || (r.to === this.pendingNode && r.from === near.id))) {
      this.pendingNode = null;
      return null;
    }
    def.roads.push({
      id: Math.max(-1, ...def.roads.map((road) => road.id)) + 1,
      from: this.pendingNode,
      to: near.id,
      speedLimit: 13.9,
      lanes: 1,
    });
    def.decor = [];
    this.pendingNode = null;
    return { def, message: `已连接 ${def.roads.at(-1)!.from} → ${near.id}` };
  }

  private expandBounds(def: MapDef, p: Vec2): void {
    def.bounds.minX = Math.min(def.bounds.minX, p.x - 30);
    def.bounds.minY = Math.min(def.bounds.minY, p.y - 30);
    def.bounds.maxX = Math.max(def.bounds.maxX, p.x + 30);
    def.bounds.maxY = Math.max(def.bounds.maxY, p.y + 30);
  }
}
