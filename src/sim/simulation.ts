import { Track } from './track';
import { Train } from './train';
import { Wayside } from './wayside';
import type { SimParams } from './types';

export const TRAIN_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24'];

/**
 * Default max speeds (m/s), deliberately unequal. If every train ran at the
 * same speed they would hold their initial spacing forever and the moving
 * block would never be tested. Mismatched speeds make the fleet bunch up, so a
 * faster train closes on a slower one and you can watch its block compress and
 * force it to brake — which is the entire point of the demo.
 */
export const DEFAULT_MAX_SPEEDS = [22, 14, 19, 11];

/** A passenger station: a platform running alongside the track. */
export interface Station {
  name: string;
  /** Arc-length (m) of the platform centre along the loop. */
  at: number;
  /** Platform length (m). */
  length: number;
  /**
   * Optional nudge (screen px) for the name plate. Stations on a curve have
   * their label pushed outward horizontally, so a wide name can overlap the
   * vertically-running platform; a small upward nudge lifts it clear.
   */
  labelDy?: number;
}

/**
 * Three stations spread around the ~2 km loop: one on each straight and one at
 * the far curve, so the platforms don't bunch up on one side. Positions are in
 * arc-length metres, the same coordinate everything else in the sim uses.
 */
export const STATIONS: Station[] = [
  { name: 'Central', at: 186, length: 90 },
  { name: 'Berri-UQAM', at: 686, length: 90, labelDy: -80 },
  { name: 'Beaudry', at: 1186, length: 90 },
];

export const DEFAULT_PARAMS: SimParams = {
  accel: 0.9,
  decel: 1.1,
  emergencyDecel: 1.6,
  safetyMargin: 40,
  commsInterval: 0.15,
  commsTimeout: 0.6,
  trainLength: 60,
  stationDwell: 5,
};

/** Fixed physics step. Decoupled from the frame rate so behaviour is stable. */
const DT = 1 / 120;

export class Simulation {
  readonly track = new Track(372, 200); // ~2 km loop
  readonly params: SimParams = { ...DEFAULT_PARAMS };
  readonly stations: Station[] = STATIONS;
  readonly wayside: Wayside;

  trains: Train[] = [];
  time = 0;
  running = true;
  /** 1x / 2x / 4x — multiplies simulated time per real second. */
  rate = 1;

  private accumulator = 0;
  private nextCommsAt = 0;

  constructor(trainCount = 2) {
    this.wayside = new Wayside(this.track, () => this.params);
    this.setTrainCount(trainCount);
  }

  /**
   * Grow or shrink the fleet without disturbing the trains already running.
   * A new train is dropped into the middle of the largest gap on the loop —
   * placing it at a fixed offset instead could land it on top of, or right on
   * the tail of, a train that is already there.
   */
  setTrainCount(n: number): void {
    while (this.trains.length > n) {
      const removed = this.trains.pop();
      if (removed) this.wayside.reports.delete(removed.id);
    }
    while (this.trains.length < n) {
      const id = this.trains.length;
      this.trains.push(
        new Train(
          id,
          TRAIN_COLORS[id % TRAIN_COLORS.length],
          this.trains.length === 0 ? 0 : this.midOfLargestGap(),
          DEFAULT_MAX_SPEEDS[id % DEFAULT_MAX_SPEEDS.length],
        ),
      );
    }
  }

  /** Arc-length halfway along the biggest stretch of empty track. */
  private midOfLargestGap(): number {
    const fronts = this.trains.map((t) => t.front).sort((a, b) => a - b);
    let bestAt = 0;
    let bestGap = -1;

    for (let i = 0; i < fronts.length; i++) {
      const here = fronts[i];
      const next = fronts[(i + 1) % fronts.length];
      const gap = i === fronts.length - 1 ? this.track.length - here + next : next - here;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = here + gap / 2;
      }
    }
    return this.track.wrap(bestAt);
  }

  /** Advance by `realSeconds` of wall-clock time, scaled by the sim rate. */
  advance(realSeconds: number): void {
    if (!this.running) return;

    // Clamp: after a tab-switch we don't want to simulate a huge lurch.
    this.accumulator += Math.min(realSeconds, 0.25) * this.rate;

    while (this.accumulator >= DT) {
      this.tick(DT);
      this.accumulator -= DT;
    }
  }

  private tick(dt: number): void {
    this.time += dt;

    // The comms cycle runs at its own (much slower) cadence than the physics —
    // this is what makes the radio link visible as a discrete thing that can be
    // interrupted, rather than an assumption baked into every step.
    if (this.time >= this.nextCommsAt) {
      this.wayside.receiveReports(this.trains, this.time);
      this.wayside.issueAuthorities(this.trains, this.time);
      this.nextCommsAt = this.time + this.params.commsInterval;
    }

    for (const t of this.trains) {
      t.step(dt, this.params, this.track, this.stations);
    }
  }

  reset(): void {
    const n = this.trains.length;
    const spacing = this.track.length / n;
    this.trains.forEach((t, i) => {
      t.front = spacing * i;
      t.speed = 0;
      t.radioDown = false;
      t.authority = null;
      t.mode = 'stopped';
      t.clearStops();
    });
    this.wayside.reports.clear();
    this.time = 0;
    this.nextCommsAt = 0;
    this.accumulator = 0;
  }
}
