/**
 * game.ts — the live race, advanced one lap at a time.
 *
 * This wraps the pure sim (sim.ts): the AI field is simulated in full up front
 * (deterministic from the seed), and the PLAYER's car is run incrementally so the
 * calls can be made live. `step()` runs the next lap; `box()` queues a stop for
 * the upcoming lap. Standings are read off cumulative time at the current lap, so
 * the timing tower is a true "everyone on the same lap" order.
 *
 * The retrospective optimal — the perfect line on this exact seed — is a bounded
 * search over one- and two-stop scripts with full weather hindsight, shown on the
 * results screen so you always learn what you left on the table (the idea asks for
 * this explicitly).
 */

import type { Mode } from './modes';
import {
  RaceEnv,
  SPEC,
  PIT_LOSS,
  PIT_LOSS_SC,
  NO_STOP_PENALTY,
  lapTime,
  tempEffect,
  simulateField,
  simulateScript,
  positionOf,
  COMPOUNDS,
  type Compound,
  type FieldCar,
  type Forecast,
  type LapRow,
  type PitCall,
  type Script,
} from './sim';

export interface StepResult {
  lap: number;
  pitted: boolean;
  compound: Compound;
  position: number;
  /** Positive if you gained places this lap, negative if you lost them. */
  delta: number;
}

export interface StandRow {
  slot: number;
  name: string;
  isSelf: boolean;
  cum: number;
  compound: Compound;
  position: number;
}

export interface FinishEntry {
  slot: number;
  name: string;
  isSelf: boolean;
  total: number;
  position: number;
  compoundsUsed: Compound[];
  stops: number;
}

export interface OptimalLine {
  total: number;
  position: number;
  script: Script;
}

export interface Summary {
  mode: Mode;
  seed: number;
  total: number;
  position: number;
  grid: number;
  startCompound: Compound;
  calls: PitCall[];
  laps: LapRow[];
  optimal: OptimalLine;
  /** total − optimal.total: seconds left on the table. */
  lost: number;
  finish: FinishEntry[];
}

export interface GameOpts {
  seed: number;
  mode: Mode;
  start: Compound;
}

const SELF_NAME = 'You';

export class Game {
  readonly seed: number;
  readonly mode: Mode;
  readonly env: RaceEnv;
  readonly field: FieldCar[];
  readonly startCompound: Compound;

  private lap = 0; // laps completed
  private compound: Compound;
  private age = 0;
  private fitOrder = 0;
  private eff: { lifeMult: number; wearMult: number; tempPace: number };
  private cum = 0;
  private rows: LapRow[] = [];
  private calls: PitCall[] = [];
  private pending: Compound | null = null;
  private prevPosition = 0;

  constructor(opts: GameOpts) {
    this.seed = opts.seed >>> 0;
    this.mode = opts.mode;
    this.startCompound = opts.start;
    this.compound = opts.start;
    this.env = new RaceEnv(this.seed, opts.mode);
    this.field = simulateField(this.env);
    this.eff = this.env.effFor(this.compound, 0, 0);
    this.prevPosition = Math.ceil(this.mode.grid / 2);
  }

  get L(): number {
    return this.mode.laps;
  }
  get lapsDone(): number {
    return this.lap;
  }
  get over(): boolean {
    return this.lap >= this.L;
  }
  get currentCompound(): Compound {
    return this.compound;
  }
  get currentAge(): number {
    return this.age;
  }
  liveTotal(): number {
    return this.cum;
  }
  stopsMade(): number {
    return this.calls.length;
  }

  /** The forecast as it reads going into the next lap. */
  forecast(): Forecast {
    return this.env.forecastAt(this.lap + 1);
  }
  wetnessNow(): number {
    return this.env.wetnessAt(Math.min(this.L, this.lap + 1));
  }
  safetyCarNow(): boolean {
    return this.env.safetyCarAt(Math.min(this.L, this.lap + 1));
  }

  /**
   * Estimated remaining tyre life 0..1. It reflects the compound's nominal cliff
   * adjusted for the (visible) track temperature, but NOT the hidden per-set
   * jitter — so the bar is a good guide the true set can still beat or undercut.
   */
  tyreLife(): number {
    const cliff = SPEC[this.compound].cliffAge * tempEffect(this.compound, this.env.trackTemp).lifeMult;
    return Math.max(0, Math.min(1, 1 - this.age / cliff));
  }

  /** Is the current tyre badly wrong for the track right now? */
  wrongTyre(): boolean {
    const w = this.wetnessNow();
    const wet = SPEC[this.compound].wet;
    if (w > 0.35 && !wet) return true; // slick in the rain
    if (w < 0.1 && wet) return true; // wet tyre on a dry track
    return false;
  }

  pendingBox(): Compound | null {
    return this.pending;
  }
  box(c: Compound): void {
    if (this.over) return;
    this.pending = c;
  }
  cancelBox(): void {
    this.pending = null;
  }

  step(): StepResult {
    if (this.over) {
      return { lap: this.lap, pitted: false, compound: this.compound, position: this.position(), delta: 0 };
    }
    const lap = this.lap + 1;
    let pitted = false;
    // A queued box is always a pit — fresh tyres, even onto the same compound.
    if (this.pending) {
      this.compound = this.pending;
      this.age = 0;
      this.fitOrder++;
      this.eff = this.env.effFor(this.compound, 0, this.fitOrder);
      this.calls.push({ lap, compound: this.compound });
      pitted = true;
    }
    this.pending = null;

    const wetness = this.env.wetnessAt(lap);
    const fuelFrac = (this.L - (lap - 1)) / this.L;
    let t = lapTime({
      compound: this.compound,
      age: this.age,
      wetness,
      fuelFrac,
      lap,
      laps: this.L,
      lifeMult: this.eff.lifeMult,
      wearMult: this.eff.wearMult,
      tempPace: this.eff.tempPace,
    });
    if (pitted) t += this.env.safetyCarAt(lap) ? PIT_LOSS_SC : PIT_LOSS;
    this.cum += t;
    this.rows.push({ lap, compound: this.compound, age: this.age, wetness, lapTime: t, pitted, cumTime: this.cum });
    this.age++;
    this.lap = lap;

    const pos = this.position();
    const delta = this.prevPosition - pos; // + = gained places
    this.prevPosition = pos;
    return { lap, pitted, compound: this.compound, position: pos, delta };
  }

  /** Live position at the current lap — read off the same sort the tower uses, so
   *  the HUD and the timing tower can never disagree. */
  position(): number {
    return this.standings().find((r) => r.isSelf)?.position ?? 1;
  }

  /** The whole field ordered by current cumulative time, for the timing tower.
   *  Before the first lap (the grid, during the countdown) every car reads cum 0
   *  and its STARTING tyre, so the tower shows a level grid rather than a phantom
   *  90-second lead over cars whose first lap is already simulated. */
  standings(): StandRow[] {
    const started = this.lap > 0;
    const rows: StandRow[] = this.field.map((c) => {
      const r = started ? c.result.laps[this.lap - 1] : null;
      return {
        slot: c.slot,
        name: c.name,
        isSelf: false,
        cum: r ? r.cumTime : 0,
        compound: r ? r.compound : c.result.laps[0].compound,
        position: 0,
      };
    });
    rows.push({ slot: 0, name: SELF_NAME, isSelf: true, cum: this.cum, compound: this.compound, position: 0 });
    // A stable slot tiebreak keeps the grid order deterministic while tied at 0.
    rows.sort((a, b) => a.cum - b.cum || a.slot - b.slot);
    rows.forEach((r, i) => (r.position = i + 1));
    return rows;
  }

  /** Gap in seconds to the car ahead / behind on the road, live. */
  gaps(): { ahead: number | null; behind: number | null } {
    const s = this.standings();
    const me = s.findIndex((r) => r.isSelf);
    const ahead = me > 0 ? me : -1;
    const behind = me < s.length - 1 ? me + 1 : -1;
    return {
      ahead: ahead >= 0 ? this.cum - s[ahead].cum : null,
      behind: behind >= 0 ? s[behind].cum - this.cum : null,
    };
  }

  laps(): LapRow[] {
    return this.rows;
  }

  summary(): Summary {
    const total = this.cum + this.noStopPenalty();
    const opt = retrospectiveOptimal(this.env, this.field);
    const finish = this.finishOrder(total);
    const position = finish.find((e) => e.isSelf)!.position;
    return {
      mode: this.mode,
      seed: this.seed,
      total,
      position,
      grid: this.mode.grid,
      startCompound: this.startCompound,
      calls: this.calls,
      laps: this.rows,
      optimal: opt,
      lost: Math.max(0, total - opt.total),
      finish,
    };
  }

  private noStopPenalty(): number {
    if (this.calls.length > 0) return 0;
    const wetUsed = SPEC[this.startCompound].wet;
    return wetUsed ? 0 : NO_STOP_PENALTY;
  }

  private finishOrder(myTotal: number): FinishEntry[] {
    const entries: FinishEntry[] = this.field.map((c) => ({
      slot: c.slot,
      name: c.name,
      isSelf: false,
      total: c.result.total,
      position: 0,
      compoundsUsed: c.result.compoundsUsed,
      stops: c.result.stops,
    }));
    entries.push({
      slot: 0,
      name: SELF_NAME,
      isSelf: true,
      total: myTotal,
      position: 0,
      compoundsUsed: [this.startCompound, ...this.calls.map((c) => c.compound)].filter((v, i, a) => a.indexOf(v) === i),
      stops: this.calls.length,
    });
    entries.sort((a, b) => a.total - b.total);
    entries.forEach((e, i) => (e.position = i + 1));
    return entries;
  }
}

// ── the retrospective optimal (bounded hindsight search) ─────────────────────

/**
 * The best one- or two-stop line on this exact seed with full weather knowledge.
 * Not exhaustive (the space is large), but a coarse lap grid + all compounds is
 * more than enough to show a player the shape of the line they missed.
 */
export function retrospectiveOptimal(env: RaceEnv, field: FieldCar[]): OptimalLine {
  const L = env.laps;
  const starts: Compound[] = env.weather.rains ? ['soft', 'medium', 'hard', 'inter'] : ['soft', 'medium', 'hard'];
  const stopLaps: number[] = [];
  for (let lap = 3; lap < L; lap += Math.max(2, Math.round(L / 16))) stopLaps.push(lap);

  let best: Script | null = null;
  let bestTotal = Infinity;

  const consider = (script: Script): void => {
    const r = simulateScript(env, script, 0);
    if (r.total < bestTotal) {
      bestTotal = r.total;
      best = script;
    }
  };

  for (const start of starts) {
    // one-stop
    for (const l1 of stopLaps) {
      for (const c1 of COMPOUNDS) {
        if (c1 === start) continue;
        consider({ start, stops: [{ lap: l1, compound: c1 }] });
      }
    }
    // two-stop
    for (let i = 0; i < stopLaps.length; i++) {
      for (let j = i + 1; j < stopLaps.length; j++) {
        for (const c1 of COMPOUNDS) {
          for (const c2 of COMPOUNDS) {
            consider({ start, stops: [{ lap: stopLaps[i], compound: c1 }, { lap: stopLaps[j], compound: c2 }] });
          }
        }
      }
    }
  }

  const fallback: Script = { start: 'medium', stops: [{ lap: Math.round(L / 2), compound: 'medium' }] };
  const script: Script = best ?? fallback;
  return { total: bestTotal, position: positionOf(bestTotal, field), script };
}

/** A UTC daily seed, so "today's race" is the same for everyone. */
export function dailySeed(): number {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
