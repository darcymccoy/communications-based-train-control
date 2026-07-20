import type { MovementAuthority, PositionReport, SimParams } from './types';
import type { Track } from './track';
import type { Train } from './train';

/**
 * The wayside controller: the ground-based half of CBTC.
 *
 * It never observes the trains directly. It knows only what the trains have
 * radioed in — a table of position reports, each with an age. Every control
 * cycle it uses that table to grant each train a *movement authority*: how far
 * it may proceed, and how fast. This is the whole architecture of CBTC in
 * miniature: continuous two-way radio, and a train that moves only on
 * permission it has been granted.
 */
export class Wayside {
  /** Last report received from each train, keyed by train id. */
  readonly reports = new Map<number, PositionReport>();

  /** Set of ids the wayside currently considers out of contact. */
  readonly lostContact = new Set<number>();

  constructor(
    private readonly track: Track,
    private readonly params: () => SimParams,
  ) {}

  /** Called every comms interval: trains with a working radio report in. */
  receiveReports(trains: Train[], now: number): void {
    const p = this.params();
    for (const t of trains) {
      if (t.radioDown) continue; // Radio dropout: this report never arrives.
      this.reports.set(t.id, {
        trainId: t.id,
        front: t.front,
        rear: t.rear(p, this.track),
        speed: t.speed,
        at: now,
      });
    }
  }

  /**
   * Grant (or withhold) a movement authority for every train, then hand it to
   * the train. Trains act only on what they are given here.
   */
  issueAuthorities(trains: Train[], now: number): void {
    const p = this.params();
    this.lostContact.clear();

    for (const t of trains) {
      const own = this.reports.get(t.id);
      const stale = !own || now - own.at > p.commsTimeout;

      if (stale) {
        this.lostContact.add(t.id);
      }

      if (t.radioDown || stale) {
        // Two ways to end up here, both fail safe:
        //   - the train's radio is down, so it hears no authority at all;
        //   - the wayside has not had a report inside the timeout, so it does
        //     not know where the train is and will not vouch for the track.
        // Either way the train gets no permission to move, and stops.
        t.authority = { clearDistance: 0, permittedSpeed: 0, failsafe: true, limitedBy: null };
        continue;
      }

      t.authority = this.authorityFor(t, trains);
    }
  }

  private authorityFor(t: Train, trains: Train[]): MovementAuthority {
    const p = this.params();
    const front = t.front;

    // Find the nearest limit of authority ahead: the rear of the closest train
    // in front of us, as last reported.
    //
    // Note the reports we consult may be STALE — that is deliberate and it is
    // safe. Trains only move forward, so a stale rear position is always
    // *behind* where that train really is now. Acting on old data about the
    // train ahead makes us stop short, never late. (Stale data about our OWN
    // position is the dangerous case, and that is exactly what the failsafe
    // above refuses to run on.)
    let clearDistance = this.track.length - p.trainLength;
    let limitedBy: number | null = null;

    for (const other of trains) {
      if (other.id === t.id) continue;
      const r = this.reports.get(other.id);
      if (!r) continue;

      const toRear = this.track.forwardGap(front, r.rear);
      const toFront = this.track.forwardGap(front, r.front);

      // If the gap to their rear wraps past the gap to their front, we are
      // inside their body — i.e. we have collided. Clamp to zero.
      const gap = toRear > toFront ? 0 : toRear;

      if (gap < clearDistance) {
        clearDistance = gap;
        limitedBy = other.id;
      }
    }

    // THE BRAKING CURVE — the inverse of the moving-block calculation.
    //
    // Train.protectedEnvelope() asks "at speed v, how much track do I need?".
    // Here we ask the reverse: "given this much clear track, how fast may I
    // run and still stop in time?" Rearranging d = v²/(2a) + margin gives
    //
    //     v_permitted = sqrt( 2 · a · (d - margin) )
    //
    // The train chases this speed continuously, so as the gap ahead opens up
    // it accelerates, and as the gap closes it brakes — smoothly, and always
    // holding a stopping distance in hand. There is no fixed block anywhere in
    // this calculation; the block *is* the braking curve.
    const usable = Math.max(0, clearDistance - p.safetyMargin);
    const permittedSpeed = Math.sqrt(2 * p.decel * usable);

    return { clearDistance, permittedSpeed, failsafe: false, limitedBy };
  }

  /** Last-known position of a train the wayside has lost contact with. */
  lastKnown(id: number): PositionReport | undefined {
    return this.reports.get(id);
  }
}
