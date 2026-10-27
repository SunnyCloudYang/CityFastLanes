export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const fromAngle = (a: number): Vec2 => ({ x: Math.cos(a), y: Math.sin(a) });
export const angleOf = (d: Vec2): number => Math.atan2(d.y, d.x);

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
}

/**
 * Right-hand normal of a direction. The sim plane maps (x, y) to three.js (x, z),
 * so with Y up this is the driver's right-hand side.
 */
export const rightOf = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

export function polygonArea(p: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function centroid(p: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q.x;
    y += q.y;
  }
  return { x: x / p.length, y: y / p.length };
}

function intersectLines(p: Vec2, r: Vec2, q: Vec2, s: Vec2): Vec2 | null {
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-9) return null;
  const t = cross(sub(q, p), s) / rxs;
  return add(p, scale(r, t));
}

/** Shrinks a convex polygon by moving every edge inward by `d`. */
export function insetPolygon(poly: Vec2[], d: number): Vec2[] {
  const n = poly.length;
  const ccw = polygonArea(poly) > 0;
  const lines = poly.map((p, i) => {
    const e = normalize(sub(poly[(i + 1) % n], p));
    const inward = ccw ? { x: -e.y, y: e.x } : { x: e.y, y: -e.x };
    return { p: add(p, scale(inward, d)), e };
  });
  return lines.map((l, i) => {
    const prev = lines[(i - 1 + n) % n];
    return intersectLines(prev.p, prev.e, l.p, l.e) ?? l.p;
  });
}

export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const turn = (o: Vec2, a: Vec2, b: Vec2) => cross(sub(a, o), sub(b, o));
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
