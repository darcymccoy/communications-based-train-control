import { Train } from '../sim/train';
import type { Simulation } from '../sim/simulation';

/**
 * The control panel and live telemetry readout.
 *
 * Like the renderer, this reads simulation state to display it, and writes to
 * the simulation only through explicit user actions (a slider moved, a button
 * pressed). It holds no state of its own about the trains.
 */

const MODE_LABEL: Record<string, string> = {
  cruising: 'CRUISING',
  braking: 'BRAKING — train ahead',
  station: 'BRAKING — station ahead',
  failsafe: 'FAILSAFE — comms lost',
  stopped: 'STOPPED',
};

export class ControlPanel {
  private trainList: HTMLElement;
  private cards: TrainCard[] = [];
  private playBtn!: HTMLButtonElement;
  private rateBtns: HTMLButtonElement[] = [];
  private countBtns: HTMLButtonElement[] = [];

  constructor(
    root: HTMLElement,
    private sim: Simulation,
  ) {
    root.innerHTML = '';
    root.append(this.buildHeader(), this.buildPlayback(), this.buildGlobals());

    this.trainList = el('div', 'train-list');
    root.append(sectionTitle('Trains'), this.trainList);
    root.append(this.buildLegend());

    this.rebuildTrainCards();
    this.syncButtons();
  }

  private buildHeader(): HTMLElement {
    const h = el('header', 'panel-header');
    h.append(
      el('h1', '', 'CBTC Moving Block'),
      el(
        'p',
        'subtitle',
        'Every train radios its position to the wayside controller, which grants ' +
          'it permission to move. Each train reserves exactly the track it needs ' +
          'to stop.',
      ),
    );
    return h;
  }

  private buildPlayback(): HTMLElement {
    const wrap = el('div', 'section');
    const row = el('div', 'row');

    this.playBtn = el('button', 'btn primary') as HTMLButtonElement;
    this.playBtn.onclick = () => {
      this.sim.running = !this.sim.running;
      this.syncButtons();
    };

    const rates = el('div', 'segmented');
    for (const r of [1, 2, 4]) {
      const b = el('button', 'btn seg', `${r}x`) as HTMLButtonElement;
      b.onclick = () => {
        this.sim.rate = r;
        this.syncButtons();
      };
      this.rateBtns.push(b);
      rates.append(b);
    }

    const reset = el('button', 'btn', 'Reset') as HTMLButtonElement;
    reset.onclick = () => {
      this.sim.reset();
      this.rebuildTrainCards();
    };

    row.append(this.playBtn, rates, reset);
    wrap.append(row);
    return wrap;
  }

  private buildGlobals(): HTMLElement {
    const wrap = el('div', 'section');
    wrap.append(sectionTitle('Fleet & braking'));

    // Train count.
    const countRow = el('div', 'field');
    countRow.append(el('label', '', 'Number of trains'));
    const seg = el('div', 'segmented');
    for (const n of [2, 3, 4]) {
      const b = el('button', 'btn seg', `${n}`) as HTMLButtonElement;
      b.onclick = () => {
        this.sim.setTrainCount(n);
        this.rebuildTrainCards();
        this.syncButtons();
      };
      this.countBtns.push(b);
      seg.append(b);
    }
    countRow.append(seg);
    wrap.append(countRow);

    // Global service deceleration. This is the `a` in d = v²/(2a): weaker
    // brakes mean a longer block for the same speed, which is the single most
    // instructive slider here.
    wrap.append(
      slider({
        label: 'Deceleration rate',
        min: 0.4,
        max: 2.0,
        step: 0.05,
        value: this.sim.params.decel,
        format: (v) => `${v.toFixed(2)} m/s²`,
        onInput: (v) => {
          this.sim.params.decel = v;
          // Emergency braking is always at least as hard as service braking.
          this.sim.params.emergencyDecel = Math.max(v * 1.45, v);
        },
      }),
    );

    wrap.append(
      slider({
        label: 'Safety margin',
        min: 0,
        max: 150,
        step: 5,
        value: this.sim.params.safetyMargin,
        format: (v) => `${v.toFixed(0)} m`,
        onInput: (v) => {
          this.sim.params.safetyMargin = v;
        },
      }),
    );

    return wrap;
  }

  private buildLegend(): HTMLElement {
    const wrap = el('div', 'section legend');
    wrap.append(sectionTitle('Reading the display'));
    const items: [string, string][] = [
      ['legend-block', 'Shaded band ahead of a train = its moving block: the distance it needs to stop.'],
      ['legend-brake', 'Flashing red = braking because its block has reached the train ahead.'],
      ['legend-station', 'Steady violet = easing to a stop for a station ahead.'],
      ['legend-platform', 'Grey bar beside the track = a station platform where trains dwell.'],
      ['legend-fail', 'Flashing amber = radio lost. No authority, so the train fails safe and stops.'],
      ['legend-ghost', 'Dashed outline = the last position the wayside heard from a lost train.'],
    ];
    for (const [cls, text] of items) {
      const row = el('div', 'legend-row');
      row.append(el('span', `swatch ${cls}`), el('span', 'legend-text', text));
      wrap.append(row);
    }
    return wrap;
  }

  private rebuildTrainCards(): void {
    this.trainList.innerHTML = '';
    this.cards = this.sim.trains.map((t) => {
      const card = new TrainCard(t, this.sim);
      this.trainList.append(card.root);
      return card;
    });
  }

  private syncButtons(): void {
    this.playBtn.textContent = this.sim.running ? '❚❚  Pause' : '▶  Play';
    this.rateBtns.forEach((b, i) => {
      b.classList.toggle('active', this.sim.rate === [1, 2, 4][i]);
    });
    this.countBtns.forEach((b, i) => {
      b.classList.toggle('active', this.sim.trains.length === [2, 3, 4][i]);
    });
  }

  /** Called every frame; refreshes the live numbers. */
  update(): void {
    for (const c of this.cards) c.update();
  }

  togglePlay(): void {
    this.sim.running = !this.sim.running;
    this.syncButtons();
  }
}

/** One train's telemetry block plus its per-train controls. */
class TrainCard {
  readonly root: HTMLElement;
  private speedEl: HTMLElement;
  private modeEl: HTMLElement;
  private posEl: HTMLElement;
  private gapEl: HTMLElement;
  private reqEl: HTMLElement;
  private barFill: HTMLElement;
  private barMark: HTMLElement;
  private radioBtn: HTMLButtonElement;

  constructor(
    private train: Train,
    private sim: Simulation,
  ) {
    const t = train;
    this.root = el('div', 'card');
    this.root.style.setProperty('--train', t.color);

    const head = el('div', 'card-head');
    head.append(el('span', 'dot'), el('span', 'card-title', `Train ${t.id + 1}`));
    this.modeEl = el('span', 'badge');
    head.append(this.modeEl);
    this.root.append(head);

    // Big speed readout.
    this.speedEl = el('div', 'speed', '0');
    const speedRow = el('div', 'speed-row');
    speedRow.append(this.speedEl, el('span', 'unit', 'km/h'));
    this.root.append(speedRow);

    // Following distance vs. required safe distance — the core comparison the
    // whole system turns on, so it gets a bar as well as numbers.
    const stats = el('div', 'stats');
    this.posEl = el('span', 'stat-val');
    this.gapEl = el('span', 'stat-val');
    this.reqEl = el('span', 'stat-val');
    stats.append(
      statRow('Position', this.posEl),
      statRow('Clear track ahead', this.gapEl),
      statRow('Needs to stop', this.reqEl),
    );
    this.root.append(stats);

    const bar = el('div', 'bar');
    this.barFill = el('div', 'bar-fill');
    this.barMark = el('div', 'bar-mark');
    bar.append(this.barFill, this.barMark);
    this.root.append(bar);

    // Per-train max speed.
    this.root.append(
      slider({
        label: 'Max speed',
        min: 5,
        max: 30,
        step: 1,
        value: t.maxSpeed,
        format: (v) => `${(v * 3.6).toFixed(0)} km/h`,
        onInput: (v) => {
          t.maxSpeed = v;
        },
      }),
    );

    // Radio dropout.
    this.radioBtn = el('button', 'btn radio', '') as HTMLButtonElement;
    this.radioBtn.onclick = () => {
      t.radioDown = !t.radioDown;
      this.syncRadio();
    };
    this.root.append(this.radioBtn);
    this.syncRadio();
  }

  private syncRadio(): void {
    const down = this.train.radioDown;
    this.radioBtn.textContent = down ? 'Restore comms' : 'Simulate radio dropout';
    this.radioBtn.classList.toggle('danger', down);
  }

  update(): void {
    const t = this.train;
    const p = this.sim.params;

    this.speedEl.textContent = (t.speed * 3.6).toFixed(1);

    this.modeEl.textContent = MODE_LABEL[t.mode] ?? t.mode;
    this.modeEl.className = `badge ${t.mode}`;

    this.posEl.textContent = `${t.front.toFixed(0)} m`;

    const required = t.envelope(p);
    const clear = t.authority?.failsafe ? null : (t.authority?.clearDistance ?? null);

    this.reqEl.textContent = `${required.toFixed(0)} m`;
    this.gapEl.textContent = clear === null ? '— no authority' : `${clear.toFixed(0)} m`;

    const ratio = clear === null || clear <= 0 ? 1 : Math.min(1, required / clear);
    this.barFill.style.width = `${ratio * 100}%`;
    this.barFill.classList.toggle('tight', ratio > 0.92);
    this.barMark.style.left = '100%';

    this.root.classList.toggle('is-failsafe', t.mode === 'failsafe' || (t.radioDown && t.speed < 0.05));
    this.root.classList.toggle('is-braking', t.mode === 'braking');
    this.root.classList.toggle('is-station', t.mode === 'station');
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  return el('h2', 'section-title', text);
}

function statRow(label: string, valueEl: HTMLElement): HTMLElement {
  const row = el('div', 'stat');
  row.append(el('span', 'stat-label', label), valueEl);
  return row;
}

interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}

function slider(o: SliderOpts): HTMLElement {
  const field = el('div', 'field');
  const head = el('div', 'field-head');
  const value = el('span', 'field-value', o.format(o.value));
  head.append(el('label', '', o.label), value);

  const input = el('input', 'range') as HTMLInputElement;
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.value);
  input.oninput = () => {
    const v = Number(input.value);
    value.textContent = o.format(v);
    o.onInput(v);
  };

  field.append(head, input);
  return field;
}
