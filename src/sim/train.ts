import type { MovementAuthority, SimParams, TrainMode } from './types';
import type { Track } from './track';
import type { Station } from './simulation';

export class Train {
  readonly id: number;
  readonly color: string;

  /** Arc-length of the train's front along the track (m). */
  front: number;
  speed = 0;
  maxSpeed: number;

  /** Operator-toggled: when true this train's radio is down. */
  radioDown = false;

  // --- Reporting/UI state, refreshed each control tick ---
  mode: TrainMode = 'stopped';
  authority: MovementAuthority | null = null;

  // --- Onboard station stopping (ATO) ---
  /** Seconds still to wait at the platform; 0 when not dwelling. */
  dwell = 0;
  /** Index of the station we are stopped at / pulling away from, so we don't
   * immediately try to stop at it again. Cleared once we've cleared its
   * platform. */
  private servingStation: number | null = null;
  /** Index of the station we are currently braking toward, once it is within
   * braking range, so `step` can berth us exactly at the platform. */
  private approachStop: number | null = null;

  constructor(id: number, color: string, front: number, maxSpeed: number) {
    this.id = id;
    this.color = color;
    this.front = front;
    this.maxSpeed = maxSpeed;
  }

  rear(p: SimParams, track: Track): number {
    return track.wrap(this.front - p.trainLength);
  }

  /** Clear any in-progress or pending station stop (used on reset). */
  clearStops(): void {
    this.dwell = 0;
    this.servingStation = null;
    this.approachStop = null;
  }

  /**
   * THE MOVING-BLOCK CALCULATION.
   *
   * The "block" a train occupies is not a fixed section of track — it is the
   * distance the train would need to come to a complete stop from its current
   * speed, and so it grows and shrinks continuously as the train speeds up and
   * slows down. Two contributions:
   *
   *   1. Braking distance. From v = 0 = u² - 2·a·d we get d = v² / (2a):
   *      the distance covered while decelerating at `decel` from speed `v`.
   *      Note this is quadratic — doubling speed *quadruples* the block.
   *
   *   2. Safety margin. A fixed standoff absorbing the things the ideal
   *      equation ignores: comms latency, the delay between the brake command
   *      and the brakes biting, odometry error, and plain engineering caution.
   *
   * A train may never let this envelope overlap the rear of the train ahead.
   * That rule alone produces the whole following behaviour.
   */
  static protectedEnvelope(speed: number, p: SimParams): number {
    return (speed * speed) / (2 * p.decel) + p.safetyMargin;
  }

  /** The envelope this train is currently claiming (m of track ahead of it). */
  envelope(p: SimParams): number {
    return Train.protectedEnvelope(this.speed, p);
  }

  /**
   * Integrate one physics step. The train chases `permittedSpeed` — the speed
   * the wayside says is safe — accelerating or braking toward it.
   */
  step(dt: number, p: SimParams, track: Track, stations: Station[]): void {
    const auth = this.authority;
    const failsafe = !auth || auth.failsafe;

    // The speed the wayside safety authority allows (0 when failing safe).
    let waysideTarget: number;
    let decel = p.decel;

    if (failsafe) {
      // FAIL SAFE. CBTC is a "permissive" system: a train moves only while it
      // holds a valid movement authority. No authority — because its radio is
      // down, or the wayside has gone quiet — is not "carry on as before", it
      // is "stop". Absence of permission is never treated as permission.
      waysideTarget = 0;
      decel = p.emergencyDecel;
    } else {
      waysideTarget = Math.min(auth!.permittedSpeed, this.maxSpeed);
    }

    // ONBOARD STATION STOPPING (an ATO layer, distinct from the CBTC safety
    // authority above). It only ever *lowers* the target speed, so a train can
    // dwell at a platform without ever exceeding the movement authority the
    // wayside granted it. The stop uses the same braking curve as the moving
    // block: v = sqrt(2·a·d) brings the train to rest exactly at the platform.
    const stationCap = this.stationTarget(dt, p, track, stations);
    const target = failsafe ? 0 : Math.min(waysideTarget, stationCap);

    if (this.speed < target) {
      this.speed = Math.min(target, this.speed + p.accel * dt);
    } else if (this.speed > target) {
      this.speed = Math.max(target, this.speed - decel * dt);
    }
    this.speed = Math.max(0, this.speed);

    // Move — but if we're braking into a station and this step would carry us
    // to (or past) the platform, berth exactly there instead. The braking curve
    // gets the train slow, and this clamp guarantees the stop lands on the
    // platform rather than overshooting it: the curve is critically tuned, so
    // discrete steps would otherwise creep past and the train would never halt.
    const move = this.speed * dt;
    if (!failsafe && this.approachStop !== null) {
      const stopAt = track.wrap(stations[this.approachStop].at + p.trainLength / 2);
      if (move >= track.forwardGap(this.front, stopAt)) {
        this.front = stopAt;
        this.speed = 0;
        this.dwell = p.stationDwell;
        this.servingStation = this.approachStop;
        this.approachStop = null;
      } else {
        this.front = track.wrap(this.front + move);
      }
    } else {
      this.front = track.wrap(this.front + move);
    }

    // Classify for the UI. The order matters: we want the *tightest* live
    // constraint to name the mode, so a station stop is only reported when the
    // station is actually holding us back harder than the train ahead is.
    //
    // "At the cap" needs a tolerance rather than an exact comparison. The
    // wayside refreshes an authority only once per comms interval, so the
    // permitted speed arrives as a staircase: each update nudges the cap and
    // the train spends the next few physics steps accelerating onto it. Judged
    // exactly, a train following another at a settled distance would fall out
    // of `held` for two or three steps after every single update, and the
    // reported mode would flicker between braking and cruising at the comms
    // rate. So the tolerance is one comms cycle of acceleration — the most a
    // train can legitimately trail a freshly-raised cap by — and it widens once
    // we have already called the train held, so the label doesn't chatter while
    // the deviation sits on the boundary.
    const catchUp = p.accel * p.commsInterval;
    const wasHeld = this.mode === 'braking' || this.mode === 'station';
    const held = this.speed > target - (wasHeld ? 2 * catchUp : catchUp);
    // Which constraint is tighter gets the same treatment, and for the same
    // reason: as a train brakes into a platform behind another train the two
    // caps cross, and comparing a staircase against a smooth curve makes the
    // label swap back and forth across the handover. Claiming the station only
    // once it is clearly the tighter cap, and holding that claim until the
    // train ahead is clearly tighter, makes the handover happen once.
    const stationTighter =
      this.mode === 'station'
        ? stationCap < waysideTarget + catchUp
        : stationCap < waysideTarget - catchUp;
    const stationLimiting =
      !failsafe && held && stationTighter && stationCap < this.maxSpeed - 0.01;

    if (failsafe) {
      this.mode = this.speed > 0.05 ? 'failsafe' : 'stopped';
    } else if (this.dwell > 0 || (this.speed <= 0.05 && target <= 0.05)) {
      // Stationary — whether dwelling at a platform or simply held at a stop.
      this.mode = 'stopped';
    } else if (stationLimiting) {
      this.mode = 'station';
    } else if (waysideTarget < this.maxSpeed - 0.01 && held) {
      // Being held below our own max speed by the train ahead.
      this.mode = 'braking';
    } else {
      this.mode = 'cruising';
    }
  }

  /**
   * The speed cap imposed by the next station stop, and the little state machine
   * that runs a berth: brake to a stop at the platform, hold for `stationDwell`
   * seconds, then release and pull away. Returns `Infinity` when no station is
   * constraining us (so the caller's `Math.min` is a no-op).
   *
   * Called once per physics step and advances the dwell timer, so it has side
   * effects despite the name — keeping the berth logic in one place is worth it.
   */
  private stationTarget(dt: number, p: SimParams, track: Track, stations: Station[]): number {
    this.approachStop = null;
    if (stations.length === 0) return Infinity;

    // Holding at the platform: count the timer down, stay stopped.
    if (this.dwell > 0) {
      this.dwell = Math.max(0, this.dwell - dt);
      return 0;
    }

    // We stop with the train *centred* on the platform, so the point the front
    // must reach is half a train-length beyond the platform centre.
    const stopOf = (i: number) => stations[i].at + p.trainLength / 2;

    // Once we've pulled clear of the platform we just served, it becomes a
    // candidate again (a full lap later). Until then we exclude it so we don't
    // simply re-stop at the platform we're departing.
    if (this.servingStation !== null) {
      const g = track.forwardGap(this.front, stopOf(this.servingStation));
      if (g > p.trainLength) this.servingStation = null;
    }

    // Nearest station ahead, ignoring the one we're leaving.
    let idx = -1;
    let gap = Infinity;
    for (let i = 0; i < stations.length; i++) {
      if (i === this.servingStation) continue;
      const g = track.forwardGap(this.front, stopOf(i));
      if (g < gap) {
        gap = g;
        idx = i;
      }
    }
    if (idx < 0) return Infinity;

    // Braking curve to a dead stop at the platform — the same v = √(2·a·d) the
    // moving block uses, but aimed at the station instead of the train ahead.
    const cap = Math.sqrt(2 * p.decel * gap);

    // Once the station is within braking range it becomes the active stop, and
    // `step` will berth us exactly on it. (Left unset when it's still far off,
    // so a distant platform never triggers the arrival clamp.)
    if (cap < this.maxSpeed) {
      this.approachStop = idx;
    }
    return cap;
  }
}
