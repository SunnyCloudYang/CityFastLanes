import { describe, expect, it } from 'vitest';
import { MapEditor } from '../src/ui/MapEditor';
import { makeMap } from './helpers';

function baseMap() {
  return makeMap({
    id: 'editor-test',
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 100, y: 0 },
    ],
    roads: [],
    bounds: { minX: -10, minY: -10, maxX: 110, maxY: 10 },
  });
}

describe('MapEditor', () => {
  it('connects two existing nodes when both are clicked in turn', () => {
    const editor = new MapEditor(baseMap());
    expect(editor.click({ x: 0, y: 0 })?.message).toMatch(/起点 0/);
    const connected = editor.click({ x: 100, y: 0 });
    expect(connected?.message).toMatch(/已连接 0 → 1/);
    expect(connected!.def.roads).toHaveLength(1);
  });

  it('places a new node and connects it when empty ground is clicked next', () => {
    const placed = new MapEditor(baseMap()).click({ x: 60, y: 60 });
    expect(placed?.message).toMatch(/已放置节点 2/);
    expect(placed!.def.nodes).toHaveLength(3);
    // main.ts resumes from the last accepted def, restoring the pending start.
    const editor = new MapEditor(placed!.def);
    editor.click({ x: 60, y: 60 });
    const connected = editor.click({ x: 60, y: 100 });
    expect(connected?.message).toMatch(/已连接 2 → 3/);
    expect(connected!.def.nodes).toHaveLength(4);
    expect(connected!.def.roads).toHaveLength(1);
    expect(editor.waitingForRoadEnd).toBe(false);
  });
});
