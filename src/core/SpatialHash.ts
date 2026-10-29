/** Uniform-grid broad phase. Items may occupy multiple cells; query results are deduplicated. */
export class SpatialHash<T> {
  private readonly cells = new Map<string, Set<T>>();

  constructor(readonly cellSize = 24) {}

  clear(): void {
    this.cells.clear();
  }

  insert(item: T, x: number, y: number, radius = 0): void {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const key = `${cx},${cy}`;
        let cell = this.cells.get(key);
        if (!cell) this.cells.set(key, (cell = new Set()));
        cell.add(item);
      }
    }
  }

  query(x: number, y: number, radius: number): T[] {
    const result = new Set<T>();
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (cell) for (const item of cell) result.add(item);
      }
    }
    return [...result];
  }
}
