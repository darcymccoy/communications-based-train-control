/** Shared value types for the simulation layer. */

export type TrainMode = 'cruising' | 'braking' | 'station' | 'failsafe' | 'stopped';

/** A position report sent from a train to the wayside controller. */
export interface PositionReport {
  trainId: number;
  /** Arc-length of the train's front along the track, in metres. */
  front: number;
  /** Arc-length of the train's rear (front - trainLength). */
  rear: number;
  speed: number;
  /** Simulation time (seconds) the report was received. */
  at: number;
}

/** Everything a train needs to know to pick its speed this tick. */
export interface MovementAuthority {
  /**
   * Distance (m) of clear track ahead of this train's front, measured to the
   * limit of authority — normally the rear of the train ahead, less a margin.
   */
  clearDistance: number;
  /** Speed the train is permitted to run at, given `clearDistance`. */
  permittedSpeed: number;
  /** Set when the wayside could not issue an authority (comms lost). */
  failsafe: boolean;
  /** Id of the train that limits us, if any (for the UI). */
  limitedBy: number | null;
}

export interface SimParams {
  /** Service deceleration rate (m/s²) used for the braking curve. */
  decel: number;
  /** Emergency deceleration used when a train fails safe (m/s²). */
  emergencyDecel: number;
  /** Acceleration rate (m/s²). */
  accel: number;
  /** Fixed standoff (m) kept beyond the calculated braking distance. */
  safetyMargin: number;
  /** How often trains report to the wayside (s). */
  commsInterval: number;
  /**
   * Age (s) beyond which a position report is considered stale. If the wayside
   * has not heard from a train within this window it stops trusting the data.
   */
  commsTimeout: number;
  /** Length of each train (m). */
  trainLength: number;
  /** Seconds a train dwells at a station platform before departing. */
  stationDwell: number;
}
