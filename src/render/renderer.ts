import type { Simulation, Station } from '../sim/simulation';
import type { Track } from '../sim/track';
import { Train } from '../sim/train';

/**
 * Canvas renderer. It reads simulation state and draws it; it never writes to
 * it. Keeping the arrow pointing one way means the simulation can be tested,
 * re-timed or re-skinned without touching this file.
 */

const TRACK_WIDTH = 14;
const TRAIN_WIDTH = 16;
const ENVELOPE_WIDTH = 26;
const PADDING = 56;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sim: Simulation,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  /** Match the backing store to the CSS box (and the display's pixel ratio). */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { straight, radius } = this.sim.track;
    const worldW = straight + 2 * radius + ENVELOPE_WIDTH;
    const worldH = 2 * radius + ENVELOPE_WIDTH;

    this.scale = Math.min(
      (rect.width - PADDING * 2) / worldW,
      (rect.height - PADDING * 2) / worldH,
    );
    this.ox = rect.width / 2;
    this.oy = rect.height / 2;
  }

  private sx(x: number): number {
    return this.ox + x * this.scale;
  }
  private sy(y: number): number {
    return this.oy + y * this.scale;
  }

  /**
   * Stroke a band of track between two arc-lengths. Because both the track and
   * every zone we want to draw are defined purely in arc-length, this one
   * primitive draws the rails, the trains and the moving blocks alike.
   */
  private strokeAlong(
    track: Track,
    from: number,
    length: number,
    width: number,
    style: string,
    cap: CanvasLineCap = 'butt',
  ): void {
    if (length <= 0) return;
    const ctx = this.ctx;
    const stepCount = Math.max(2, Math.ceil(length / 4));
    const step = length / stepCount;

    ctx.beginPath();
    for (let i = 0; i <= stepCount; i++) {
      const p = track.pointAt(from + i * step);
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.lineCap = cap;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  draw(): void {
    const { ctx, sim } = this;
    const { track, params } = sim;
    const rect = this.canvas.getBoundingClientRect();

    ctx.clearRect(0, 0, rect.width, rect.height);

    // --- Track bed ---
    this.strokeAlong(track, 0, track.length, TRACK_WIDTH + 8, '#1e293b');
    this.strokeAlong(track, 0, track.length, TRACK_WIDTH, '#334155');

    // --- Stations (platforms beside the track) ---
    for (const st of sim.stations) {
      this.drawStation(st);
    }

    // --- Moving blocks (drawn under the trains) ---
    for (const t of sim.trains) {
      this.drawEnvelope(t);
    }

    // --- Trains ---
    for (const t of sim.trains) {
      this.drawTrain(t);
    }

    // --- Ghosts: where the wayside last saw a train it has lost ---
    for (const t of sim.trains) {
      if (!t.radioDown) continue;
      const last = sim.wayside.lastKnown(t.id);
      if (!last) continue;
      ctx.save();
      ctx.setLineDash([6, 6]);
      this.strokeAlong(track, last.rear, params.trainLength, TRAIN_WIDTH, 'rgba(248,250,252,0.35)');
      ctx.restore();
      const p = track.pointAt(last.front);
      this.label('last known', this.sx(p.x), this.sy(p.y) - 20, 'rgba(248,250,252,0.5)', 10);
    }
  }

  /**
   * The moving block itself: a band of track reserved ahead of the train,
   * exactly as long as the distance it needs to stop. This is the thing the
   * demo exists to show — watch it stretch as a train accelerates and collapse
   * as it slows.
   */
  private drawEnvelope(t: Train): void {
    const { sim } = this;
    const len = t.envelope(sim.params);

    // rgb triple + a pulsing alpha: amber when unauthorised, red when the train
    // ahead is holding us back, violet when easing into a station, the train's
    // own colour when running free.
    let rgb: string;
    let alpha: number;
    if (t.mode === 'failsafe') {
      rgb = '251, 146, 60';
      alpha = 0.35 + 0.25 * Math.sin(sim.time * 12);
    } else if (t.mode === 'braking') {
      rgb = '248, 113, 113';
      alpha = 0.3 + 0.2 * Math.sin(sim.time * 9);
    } else if (t.mode === 'station') {
      // A scheduled stop, not a safety event — steady, no pulsing.
      rgb = '167, 139, 250';
      alpha = 0.4;
    } else {
      rgb = hexToRgb(t.color);
      alpha = 0.22;
    }

    this.strokeAlong(sim.track, t.front, len, ENVELOPE_WIDTH, `rgba(${rgb}, ${alpha})`);

    // Leading edge — the limit of movement authority.
    this.strokeAlong(sim.track, t.front + len - 2, 2, ENVELOPE_WIDTH, `rgba(${rgb}, 0.85)`);
  }

  private drawTrain(t: Train): void {
    const { sim, ctx } = this;
    const rear = t.front - sim.params.trainLength;

    this.strokeAlong(sim.track, rear, sim.params.trainLength, TRAIN_WIDTH + 4, '#0f172a');
    this.strokeAlong(sim.track, rear, sim.params.trainLength, TRAIN_WIDTH, t.color);

    // Nose marker so direction of travel is unambiguous.
    this.strokeAlong(sim.track, t.front - 6, 6, TRAIN_WIDTH, '#f8fafc');

    // Speed readout, offset outward from the track so it never sits on a rail.
    const mid = sim.track.pointAt(rear + sim.params.trainLength / 2);
    const nx = mid.x === 0 && mid.y === 0 ? 0 : mid.x;
    const ny = mid.y;
    const norm = Math.hypot(nx, ny) || 1;
    const off = 30;
    const lx = this.sx(mid.x) + (nx / norm) * off;
    const ly = this.sy(mid.y) + (ny / norm) * off;

    const kmh = (t.speed * 3.6).toFixed(0);
    ctx.save();
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = t.mode === 'failsafe' ? '#fb923c' : t.color;
    ctx.fillText(`T${t.id + 1} · ${kmh} km/h`, lx, ly);
    ctx.restore();
  }

  /**
   * A station platform: a band running parallel to the track but offset to one
   * side, plus a name label further out. Like everything else it's addressed by
   * arc-length, so it follows the rails around curves as well as straights.
   */
  private drawStation(st: Station): void {
    const { ctx, sim } = this;
    const { track } = sim;

    // Offsets are in screen pixels, not metres, so the platform hugs the rail
    // edge at any zoom. sx()/sy() apply the same positive scale with no
    // rotation, so a world-space normal keeps its direction on screen — we just
    // renormalise it to a pixel length.
    const PLATFORM_WIDTH = 12;
    const gap = (TRACK_WIDTH + 8) / 2 + 2 + PLATFORM_WIDTH / 2; // rail edge + 2px

    // Point `px` pixels outward (away from the oval centre) from arc-length s.
    const outward = (s: number, px: number): { x: number; y: number } => {
      const p = track.pointAt(s);
      const tan = track.tangentAt(s);
      let nx = -tan.y;
      let ny = tan.x;
      const n = Math.hypot(nx, ny) || 1;
      nx /= n;
      ny /= n;
      return { x: this.sx(p.x) + nx * px, y: this.sy(p.y) + ny * px };
    };

    const stepCount = Math.max(2, Math.ceil(st.length / 4));
    const step = st.length / stepCount;
    ctx.beginPath();
    for (let i = 0; i <= stepCount; i++) {
      const q = outward(st.at - st.length / 2 + i * step, gap);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.lineWidth = PLATFORM_WIDTH;
    ctx.strokeStyle = '#94a3b8';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Name plate, sitting just beyond the platform.
    const c = outward(st.at, gap + PLATFORM_WIDTH / 2 + 12);
    this.label(st.name, c.x, c.y + 4 + (st.labelDy ?? 0), '#cbd5e1', 12);
  }

  private label(text: string, x: number, y: number, color: string, size: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
