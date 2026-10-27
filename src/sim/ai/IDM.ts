export interface IdmParams {
  /** Max acceleration. */
  a: number;
  /** Comfortable deceleration. */
  b: number;
  /** Desired time headway. */
  T: number;
  /** Minimum standstill gap. */
  s0: number;
}

/**
 * Intelligent Driver Model.
 * @param v own speed
 * @param v0 desired speed
 * @param gap bumper-to-bumper distance to the obstacle ahead (Infinity when free)
 * @param dv approach rate, own speed minus leader speed
 */
export function idm(v: number, v0: number, gap: number, dv: number, p: IdmParams): number {
  const free = 1 - Math.pow(v / v0, 4);
  if (!Number.isFinite(gap)) return p.a * free;
  if (gap <= 0.05) return -9;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  return p.a * (free - (sStar / gap) ** 2);
}
