/**
 * The track is a closed loop (a "stadium" oval: two straights joined by two
 * semicircles). Everything in the simulation addresses the track by a single
 * scalar `s` — distance in metres from an arbitrary origin, wrapping at
 * `length`. Screen geometry is derived from `s` only at render time, which is
 * what keeps the physics and the drawing code independent of each other.
 */

export interface Point {
  x: number;
  y: number;
}

export class Track {
  readonly straight: number;
  readonly radius: number;
  readonly length: number;

  constructor(straight: number, radius: number) {
    this.straight = straight;
    this.radius = radius;
    this.length = 2 * straight + 2 * Math.PI * radius;
  }

  /** Normalise any distance into [0, length). */
  wrap(s: number): number {
    const m = s % this.length;
    return m < 0 ? m + this.length : m;
  }

  /**
   * Forward distance from `from` to `to` along the direction of travel.
   * On a loop this is always non-negative: a train 10 m "behind" you is really
   * (length - 10) m ahead, and that is the distance that matters for safety.
   */
  forwardGap(from: number, to: number): number {
    return this.wrap(to - from);
  }

  /** World-space (metres) point at arc-length `s`. Origin is the oval centre. */
  pointAt(s: number): Point {
    const t = this.wrap(s);
    const { straight: L, radius: R } = this;
    const arc = Math.PI * R;

    // Bottom straight, travelling +x (screen y grows downward).
    if (t < L) {
      return { x: -L / 2 + t, y: R };
    }
    // Right semicircle, bottom -> right -> top.
    if (t < L + arc) {
      const phi = (t - L) / R;
      return { x: L / 2 + R * Math.sin(phi), y: R * Math.cos(phi) };
    }
    // Top straight, travelling -x.
    if (t < 2 * L + arc) {
      return { x: L / 2 - (t - L - arc), y: -R };
    }
    // Left semicircle, top -> left -> bottom.
    const psi = (t - 2 * L - arc) / R;
    return { x: -L / 2 - R * Math.sin(psi), y: -R * Math.cos(psi) };
  }

  /** Unit tangent (direction of travel) at arc-length `s`. */
  tangentAt(s: number): Point {
    const ahead = this.pointAt(s + 0.5);
    const behind = this.pointAt(s - 0.5);
    const dx = ahead.x - behind.x;
    const dy = ahead.y - behind.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
}
