/**
 * sim.ts — the deterministic race physics. This is the new core; the decision is
 * the game and this file is the world the decision plays out in.
 *
 * A lap time is:
 *
 *   BASE + fuel(fuelFrac) + grip(compound, age, wetness) + trackEvo(lap)
 *
 * where grip folds together a compound's fresh pace, its DEGRADATION (rising with
 * age, then a quadratic CLIFF past its life), and its match to the CONDITIONS (a
 * slick is catastrophic in the wet; an inter overheats in the dry; a full wet is
 * slow until it floods). Fuel burns down so cars get faster late; the track rubbers
 * in the same way for everyone, so it never biases a strategy.
 *
 * DETERMINISM. Everything the seed fixes — the weather timeline, the calibrated
 * forecast, the safety car, and each car's per-SET tyre-life jitter — is drawn up
 * front, independent of any choice. The state then follows from the calls. Two
 * peers on the same seed face an identical race; identical calls give an identical
 * result, different calls each live with their own. Nothing about one car's run
 * touches another's, which is what makes the versus race structurally desync-proof
 * (see race.ts). Per-set jitter is keyed by (seed, carSlot, fitOrder), so the
 * PLAYER slot is identical across peers and each AI car is independent.
 *
 * The forecast is a CALIBRATED BERNOULLI: a probability p is drawn and shown, and
 * whether it actually rains is sampled ~ Bernoulli(p) from the seed — so a "40%"
 * forecast rains ~40% of the time (mechanism.test.ts pins it), and reading the
 * firming forecast is a real bet, not flavour over a solved race.
 *
 * The tuning constants below are refereed by balance.test.ts (the dominant-strategy
 * gate) and audited by mechanism.test.ts from INDEPENDENT constants — never import
 * this file's numbers into the audit, or it checks the game's arithmetic against
 * itself (a tautology that stays green on a mutated formula).
 */

import { makeRng, hashSeed, type Rng } from '@ben-gy/game-engine/rng';
import type { Mode } from './modes';

export type Compound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet';
export const COMPOUNDS: readonly Compound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];
export const SLICKS: readonly Compound[] = ['soft', 'medium', 'hard'];
export const WETS: readonly Compound[] = ['inter', 'wet'];

export const COMPOUND_LETTER: Record<Compound, string> = {
  soft: 'S',
  medium: 'M',
  hard: 'H',
  inter: 'I',
  wet: 'W',
};
export const COMPOUND_NAME: Record<Compound, string> = {
  soft: 'Soft',
  medium: 'Medium',
  hard: 'Hard',
  inter: 'Inter',
  wet: 'Wet',
};

// ── tuning (balance.test.ts referees these) ─────────────────────────────────

export const BASE = 90;
/** Full tank costs this many s/lap over empty; scales linearly with fuel. */
export const FUEL_MAX = 2.4;
/** The track rubbers in over the race, up to this many s faster by the flag. */
export const TRACK_EVO = 1.0;
/** A normal pit stop + out-lap penalty, in seconds. */
export const PIT_LOSS = 21;
/** A pit stop taken under the safety car, when the field is slow. */
export const PIT_LOSS_SC = 9;
/** Extra s at the flag for never making a mandatory stop in a dry race. */
export const NO_STOP_PENALTY = 30;

interface Spec {
  /** Dry fresh pace delta (s/lap); lower is faster. */
  pace: number;
  /** Degradation accumulation (s/lap of age), before the cliff. */
  wear: number;
  /** Nominal set life in laps; past it a quadratic cliff opens. */
  cliffAge: number;
  /** The track temperature (°C) the compound is happiest at. */
  tempOpt: number;
  /** Half-width of the temperature window before penalties bite. */
  tempTol: number;
  wet: boolean;
}

export const SPEC: Record<Compound, Spec> = {
  // Softer compounds want a cooler track (they overheat and grain in the heat);
  // harder compounds need heat to switch on (they grain and slide when cold).
  soft: { pace: -0.65, wear: 0.1, cliffAge: 13, tempOpt: 24, tempTol: 9, wet: false },
  medium: { pace: 0.0, wear: 0.06, cliffAge: 21, tempOpt: 32, tempTol: 11, wet: false },
  hard: { pace: 0.38, wear: 0.028, cliffAge: 33, tempOpt: 41, tempTol: 13, wet: false },
  inter: { pace: 2.2, wear: 0.055, cliffAge: 24, tempOpt: 18, tempTol: 18, wet: true },
  wet: { pace: 3.4, wear: 0.045, cliffAge: 30, tempOpt: 13, tempTol: 20, wet: true },
};

/** How steep the cliff is once a set is past its life. */
export const CLIFF_K = 0.055;

// Track-temperature effects (a seeded constant per race).
/** Overheating (track hotter than the window) raises wear and shortens life. */
const OVERHEAT_WEAR_K = 0.9;
const OVERHEAT_LIFE_K = 0.5;
/** A track colder than the window costs pace (the tyre never switches on). */
const COLD_PACE_K = 0.16;
/** Being off-window at all adds a little wear (both directions). */
const OFF_WEAR_K = 0.25;

// Slick performance falls off fast once the track is wet.
const DRY_EDGE = 0.05;
const SLICK_WET_K = 60;
const SLICK_WET_EXP = 1.6;

// Inter is happiest in a damp band; it overheats when dry and aquaplanes flooded.
const INTER_LOW = 0.2;
const INTER_HIGH = 0.62;
const INTER_DRY_K = 20;
const INTER_FLOOD_K = 24;

// Full wet wants standing water; it is slow until the track floods.
const WET_MIN = 0.55;
const WET_DRY_K = 17;

/** How many laps ahead the forecast begins to firm toward the truth. */
export const FIRM_WINDOW = 12;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── the lap-time model ──────────────────────────────────────────────────────

/** Degradation (s) for a set at `age` laps, with per-set jitter applied. */
export function degradation(c: Compound, age: number, lifeMult: number, wearMult: number): number {
  const s = SPEC[c];
  const linear = s.wear * wearMult * age;
  const cliffAt = s.cliffAge * lifeMult;
  const over = age - cliffAt;
  const extra = over > 0 ? CLIFF_K * over * over : 0;
  return linear + extra;
}

/** The condition penalty (s) for running `c` at wetness `w`. */
export function conditionPenalty(c: Compound, w: number): number {
  if (!SPEC[c].wet) {
    // A slick: fine dry, catastrophic wet.
    return w <= DRY_EDGE ? 0 : SLICK_WET_K * Math.pow(w - DRY_EDGE, SLICK_WET_EXP);
  }
  if (c === 'inter') {
    if (w < INTER_LOW) return (INTER_LOW - w) * INTER_DRY_K;
    if (w > INTER_HIGH) return (w - INTER_HIGH) * INTER_FLOOD_K;
    return 0;
  }
  // Full wet.
  return w < WET_MIN ? (WET_MIN - w) * WET_DRY_K : 0;
}

/** The best compound for a given wetness, ignoring wear (for AI + hints). */
export function bestForConditions(w: number): Compound {
  let best: Compound = 'medium';
  let bestVal = Infinity;
  for (const c of COMPOUNDS) {
    const v = SPEC[c].pace + conditionPenalty(c, w);
    if (v < bestVal) {
      bestVal = v;
      best = c;
    }
  }
  return best;
}

export function fuelPenalty(fuelFrac: number): number {
  return FUEL_MAX * clamp01(fuelFrac);
}

export interface TempEffect {
  /** Multiplier on set life (overheating shortens it). */
  lifeMult: number;
  /** Multiplier on wear (off-window, especially hot, wears faster). */
  wearMult: number;
  /** Pace penalty added when the track is below the compound's window. */
  pace: number;
}

/** The effect of a track temperature on a compound (dry compounds only care). */
export function tempEffect(c: Compound, trackTemp: number): TempEffect {
  const s = SPEC[c];
  const over = Math.max(0, trackTemp - s.tempOpt) / s.tempTol;
  const cold = Math.max(0, s.tempOpt - trackTemp) / s.tempTol;
  const off = Math.abs(trackTemp - s.tempOpt) / s.tempTol;
  return {
    lifeMult: 1 / (1 + OVERHEAT_LIFE_K * over),
    wearMult: 1 + OVERHEAT_WEAR_K * over + OFF_WEAR_K * off,
    pace: COLD_PACE_K * Math.max(0, cold - 1) * s.tempTol,
  };
}

export interface LapInput {
  compound: Compound;
  age: number;
  wetness: number;
  /** Fraction of the tank remaining, 1 at the start → ~0 at the flag. */
  fuelFrac: number;
  lap: number;
  laps: number;
  /** Effective set life multiplier (per-set jitter × temperature). */
  lifeMult: number;
  /** Effective wear multiplier (per-set jitter × temperature × mode wearScale). */
  wearMult: number;
  /** Pace penalty from a cold track for this compound. */
  tempPace?: number;
}

export function lapTime(x: LapInput): number {
  const s = SPEC[x.compound];
  const grip =
    s.pace +
    (x.tempPace ?? 0) +
    degradation(x.compound, x.age, x.lifeMult, x.wearMult) +
    conditionPenalty(x.compound, x.wetness);
  const evo = -TRACK_EVO * ((x.lap - 1) / Math.max(1, x.laps - 1));
  return BASE + fuelPenalty(x.fuelFrac) + grip + evo;
}

// ── the seed-drawn environment ──────────────────────────────────────────────

export interface Forecast {
  /** The displayed chance of rain in the coming window, 0..1 (firms over time). */
  p: number;
  /** The lap the rain window is expected around, or null once it has resolved dry. */
  lap: number | null;
  /** The rain has already begun. */
  active: boolean;
}

export interface Weather {
  rains: boolean;
  /** The pre-race forecast probability (the honest generative parameter). */
  forecastP: number;
  /** The lap the rain window opens (drawn whether or not it rains). */
  windowLap: number;
  peak: number;
  peakLap: number;
  /** Deluge only: the lap it starts drying back toward slicks (or null). */
  dryLap: number | null;
}

export class RaceEnv {
  readonly seed: number;
  readonly mode: Mode;
  readonly laps: number;
  readonly weather: Weather;
  /** Track temperature (°C) for the whole race — shifts the fastest compound. */
  readonly trackTemp: number;
  private wet: number[] = [];
  private sc: boolean[] = [];

  constructor(seed: number, mode: Mode) {
    this.seed = seed >>> 0;
    this.mode = mode;
    this.laps = mode.laps;
    const rng = makeRng(this.seed);
    this.trackTemp = Math.round(mode.tempLo + rng() * mode.tempSpan);
    this.weather = drawWeather(rng, mode);
    this.buildTimeline(rng);
  }

  /** The combined per-set effect (jitter × temperature × mode wearScale). */
  effFor(compound: Compound, carSlot: number, fitOrder: number): { lifeMult: number; wearMult: number; tempPace: number } {
    const jit = this.setJitter(carSlot, fitOrder);
    const te = tempEffect(compound, this.trackTemp);
    return {
      lifeMult: jit.lifeMult * te.lifeMult,
      wearMult: jit.wearMult * te.wearMult * this.mode.wearScale,
      tempPace: te.pace,
    };
  }

  private buildTimeline(rng: Rng): void {
    const L = this.laps;
    const w = new Array(L + 2).fill(0);
    const sc = new Array(L + 2).fill(false);
    const wx = this.weather;
    if (wx.rains) {
      // A fast onset (1–3 laps, faster in a volatile mode) is what makes reading
      // the forecast pay: a reactor drives a lap in real water before it can box,
      // so a confident forecast is worth pre-empting.
      const ramp = (this.mode.canDryBack ? 1 : 2) + Math.floor(rng() * 2);
      const dry = wx.dryLap;
      for (let lap = 1; lap <= L; lap++) {
        let val: number;
        if (lap < wx.windowLap) val = 0;
        else if (lap < wx.windowLap + ramp) val = wx.peak * ((lap - wx.windowLap + 1) / ramp);
        else if (dry !== null && lap >= dry) {
          const dRamp = 4;
          val = wx.peak * Math.max(0, 1 - (lap - dry + 1) / dRamp);
        } else val = wx.peak;
        w[lap] = clamp01(val);
      }
      // A safety-car window a couple of laps after the rain arrives.
      if (rng() < this.mode.safetyCar) {
        const start = wx.windowLap + 1;
        const len = 2 + Math.floor(rng() * 3);
        for (let lap = start; lap < start + len && lap <= L; lap++) sc[lap] = true;
      }
    }
    this.wet = w;
    this.sc = sc;
  }

  wetnessAt(lap: number): number {
    return this.wet[Math.max(0, Math.min(this.wet.length - 1, lap))] ?? 0;
  }

  safetyCarAt(lap: number): boolean {
    return this.sc[Math.max(0, Math.min(this.sc.length - 1, lap))] ?? false;
  }

  /**
   * The forecast as it reads on `lap`. Early it shows the drawn probability; it
   * firms toward the truth (rain or no rain) as the window approaches, resolving
   * at the window lap. Not rain-capable modes always read 0.
   */
  forecastAt(lap: number): Forecast {
    const w = this.weather;
    if (!this.mode.rainCapable) return { p: 0, lap: null, active: false };
    const active = w.rains && lap >= w.windowLap && this.wetnessAt(lap) > DRY_EDGE;
    if (active) return { p: 1, lap: w.windowLap, active: true };
    const lead = w.windowLap - lap;
    if (lead <= 0) {
      // The window has passed with no rain (or the shower is over).
      return { p: w.rains ? 1 : 0, lap: w.rains ? w.windowLap : null, active: false };
    }
    const firm = clamp01(1 - lead / FIRM_WINDOW);
    const truth = w.rains ? 1 : 0;
    const p = w.forecastP * (1 - firm) + truth * firm;
    return { p: clamp01(p), lap: w.windowLap, active: false };
  }

  /** Per-set tyre jitter, deterministic in (seed, carSlot, fitOrder). */
  setJitter(carSlot: number, fitOrder: number): { lifeMult: number; wearMult: number } {
    const r = makeRng(hashSeed(`${this.seed}:${carSlot}:${fitOrder}`));
    // Life varies ±18%, wear inversely-ish so a long-life set also wears slower.
    const lifeMult = 0.82 + r() * 0.36;
    const wearMult = 0.86 + r() * 0.3;
    return { lifeMult, wearMult };
  }
}

function drawWeather(rng: Rng, mode: Mode): Weather {
  if (!mode.rainCapable) {
    return { rains: false, forecastP: 0, windowLap: 0, peak: 0, peakLap: 0, dryLap: null };
  }
  const forecastP = mode.forecastLo + rng() * (mode.forecastHi - mode.forecastLo);
  const windowLap = Math.max(2, Math.round(mode.laps * (mode.rainStartLo + rng() * mode.rainStartSpan)));
  const rains = rng() < forecastP; // calibrated Bernoulli — the whole game's bet
  const peak = clamp01(mode.rainPeakLo + rng() * mode.rainPeakSpan);
  const peakLap = Math.min(mode.laps, windowLap + 4);
  let dryLap: number | null = null;
  if (mode.canDryBack && rains && rng() < 0.5) {
    dryLap = Math.min(mode.laps - 1, windowLap + 8 + Math.floor(rng() * 10));
  }
  return { rains, forecastP, windowLap, peak, peakLap, dryLap };
}

// ── a driver: either an explicit script or a live/AI policy ──────────────────

export interface PitCall {
  /** The lap to box on (1-indexed). Boxing on lap N runs N on fresh tyres. */
  lap: number;
  compound: Compound;
}

export interface Script {
  start: Compound;
  stops: PitCall[];
}

export interface LapRow {
  lap: number;
  compound: Compound;
  age: number;
  wetness: number;
  lapTime: number;
  pitted: boolean;
  cumTime: number;
}

export interface CarResult {
  total: number;
  laps: LapRow[];
  stops: number;
  /** Compounds used (for the mandatory-two / mandatory-stop rule + display). */
  compoundsUsed: Compound[];
}

/**
 * Run one car over the whole race on a fixed script. `carSlot` selects the
 * per-set jitter stream (slot 0 is the human/player slot, shared across peers).
 */
export function simulateScript(env: RaceEnv, script: Script, carSlot: number): CarResult {
  const L = env.laps;
  const rows: LapRow[] = [];
  let compound = script.start;
  let age = 0;
  let fitOrder = 0;
  let eff = env.effFor(compound, carSlot, fitOrder);
  let cum = 0;
  let stops = 0;
  const used = new Set<Compound>([compound]);
  const byLap = new Map<number, Compound>();
  for (const s of script.stops) byLap.set(s.lap, s.compound);

  for (let lap = 1; lap <= L; lap++) {
    let pitted = false;
    const call = byLap.get(lap);
    if (call && lap > 0) {
      compound = call;
      age = 0;
      fitOrder++;
      eff = env.effFor(compound, carSlot, fitOrder);
      used.add(compound);
      pitted = true;
      stops++;
    }
    const wetness = env.wetnessAt(lap);
    const fuelFrac = (L - (lap - 1)) / L;
    let t = lapTime({ compound, age, wetness, fuelFrac, lap, laps: L, lifeMult: eff.lifeMult, wearMult: eff.wearMult, tempPace: eff.tempPace });
    if (pitted) t += env.safetyCarAt(lap) ? PIT_LOSS_SC : PIT_LOSS;
    cum += t;
    rows.push({ lap, compound, age, wetness, lapTime: t, pitted, cumTime: cum });
    age++;
  }

  // Mandatory stop in a dry race: you must change tyres at least once.
  const wetUsed = [...used].some((c) => SPEC[c].wet);
  if (stops === 0 && !wetUsed) cum += NO_STOP_PENALTY;

  return { total: cum, laps: rows, stops, compoundsUsed: [...used] };
}

// ── policies (the AI field AND the balance-sim strategy archetypes) ──────────

export type PolicyKind =
  | 'oneStopSoft'
  | 'oneStopBalanced'
  | 'oneStopHard'
  | 'twoStop'
  | 'gambleRain'
  | 'reactAdaptive';

export const POLICY_KINDS: readonly PolicyKind[] = [
  'oneStopSoft',
  'oneStopBalanced',
  'oneStopHard',
  'twoStop',
  'gambleRain',
  'reactAdaptive',
];

/** Human-readable strategy names for the results screen + hints. */
export const POLICY_NAME: Record<PolicyKind, string> = {
  oneStopSoft: 'One-stop, soft/soft',
  oneStopBalanced: 'One-stop, medium/soft',
  oneStopHard: 'One-stop, hard/medium',
  twoStop: 'Two-stop',
  gambleRain: 'Gamble on the rain',
  reactAdaptive: 'Adaptive',
};

interface PolicyCtx {
  lap: number;
  laps: number;
  compound: Compound;
  age: number;
  /** The wetness the car EXPERIENCED last lap — what a reactor actually knows. A
   *  sudden downpour is only visible in the forecast until you have driven in it. */
  wetness: number;
  forecast: Forecast;
  stopsMade: number;
  mode: Mode;
}

/** A policy decides, at the start of each lap, whether to box and onto what. */
export type Policy = (ctx: PolicyCtx) => Compound | null;

/** The tyre a policy starts the race on. */
export interface PolicyDriver {
  start: Compound;
  policy: Policy;
}

/**
 * Build a driver for a policy kind. `rng` lets a kind vary its exact pit laps and
 * gamble threshold per car, so the field is not identical clones.
 */
export function makeDriver(kind: PolicyKind, rng: Rng, mode: Mode): PolicyDriver {
  const L = mode.laps;
  const jitter = (frac: number, span: number): number =>
    Math.max(2, Math.min(L - 1, Math.round(L * (frac + (rng() - 0.5) * span))));

  // Shared reaction: if the current tyre is badly wrong for the track NOW, box
  // for the right one (with a little hysteresis so it does not flap).
  const weatherReact = (ctx: PolicyCtx): Compound | null => {
    if (ctx.lap >= ctx.laps - 1) return null;
    const cur = SPEC[ctx.compound].pace + conditionPenalty(ctx.compound, ctx.wetness);
    const want = bestForConditions(ctx.wetness);
    if (want === ctx.compound) return null;
    const wantVal = SPEC[want].pace + conditionPenalty(want, ctx.wetness);
    // Only switch if the swap clearly pays back the ~PIT_LOSS over the stint.
    if (cur - wantVal > 5.5) return want;
    return null;
  };

  switch (kind) {
    case 'oneStopSoft': {
      // Two soft stints — the cold-track plan: soft is fast and lasts when cool.
      const at = jitter(0.5, 0.08);
      return {
        start: 'soft',
        policy: (ctx) => weatherReact(ctx) ?? (ctx.stopsMade === 0 && ctx.lap === at ? 'soft' : null),
      };
    }
    case 'oneStopBalanced': {
      // Medium then a late switch to fresh softs — the temperate default.
      const at = jitter(0.6, 0.08);
      return {
        start: 'medium',
        policy: (ctx) => weatherReact(ctx) ?? (ctx.stopsMade === 0 && ctx.lap === at ? 'soft' : null),
      };
    }
    case 'oneStopHard': {
      // A long hard opening then medium — the hot-track plan (hard likes heat).
      const at = jitter(0.55, 0.08);
      return {
        start: 'hard',
        policy: (ctx) => weatherReact(ctx) ?? (ctx.stopsMade === 0 && ctx.lap === at ? 'medium' : null),
      };
    }
    case 'twoStop': {
      // Three shorter stints — pays off when deg is high (very hot, or a grainy set).
      const a = jitter(0.34, 0.06);
      const b = jitter(0.66, 0.06);
      return {
        start: 'soft',
        policy: (ctx) => {
          const r = weatherReact(ctx);
          if (r) return r;
          if (ctx.stopsMade === 0 && ctx.lap === a) return 'medium';
          if (ctx.stopsMade === 1 && ctx.lap === b) return 'soft';
          return null;
        },
      };
    }
    case 'gambleRain': {
      const at = jitter(0.5, 0.08);
      const thresh = 0.45 + rng() * 0.15;
      let gambled = false;
      return {
        start: 'medium',
        policy: (ctx) => {
          const r = weatherReact(ctx);
          if (r) {
            gambled = true;
            return r;
          }
          // Pre-empt onto inters if the forecast is firming high and near.
          if (
            !gambled &&
            ctx.mode.rainCapable &&
            !SPEC[ctx.compound].wet &&
            ctx.forecast.lap !== null &&
            ctx.forecast.lap - ctx.lap <= 3 &&
            ctx.forecast.lap - ctx.lap >= 0 &&
            ctx.forecast.p >= thresh
          ) {
            gambled = true;
            return 'inter';
          }
          if (ctx.stopsMade === 0 && ctx.lap === at && !SPEC[ctx.compound].wet) return 'medium';
          return null;
        },
      };
    }
    case 'reactAdaptive': {
      // The good strategist: a solid dry two-stop, but it only pre-empts the rain
      // when the forecast is genuinely firm, and it reacts promptly to real water.
      const a = jitter(0.34, 0.05);
      const b = jitter(0.66, 0.05);
      const thresh = 0.7;
      let gambled = false;
      return {
        start: 'medium',
        policy: (ctx) => {
          const r = weatherReact(ctx);
          if (r) {
            gambled = true;
            return r;
          }
          if (
            !gambled &&
            ctx.mode.rainCapable &&
            !SPEC[ctx.compound].wet &&
            ctx.forecast.lap !== null &&
            ctx.forecast.lap - ctx.lap <= 2 &&
            ctx.forecast.lap - ctx.lap >= 0 &&
            ctx.forecast.p >= thresh
          ) {
            gambled = true;
            return 'inter';
          }
          if (ctx.stopsMade === 0 && ctx.lap === a) return 'soft';
          if (ctx.stopsMade === 1 && ctx.lap === b && !SPEC[ctx.compound].wet) return 'medium';
          return null;
        },
      };
    }
  }
}

/** Run a car driven by a live policy (AI field + balance sim). */
export function simulatePolicy(env: RaceEnv, driver: PolicyDriver, carSlot: number): CarResult {
  const L = env.laps;
  const rows: LapRow[] = [];
  let compound = driver.start;
  let age = 0;
  let fitOrder = 0;
  let eff = env.effFor(compound, carSlot, fitOrder);
  let cum = 0;
  let stops = 0;
  const used = new Set<Compound>([compound]);

  let prevWetness = 0;
  for (let lap = 1; lap <= L; lap++) {
    const forecast = env.forecastAt(lap);
    const wetness = env.wetnessAt(lap);
    // The policy decides on what it KNOWS: last lap's felt wetness + the forecast.
    const call = driver.policy({ lap, laps: L, compound, age, wetness: prevWetness, forecast, stopsMade: stops, mode: env.mode });
    let pitted = false;
    // A non-null call is always a pit — fresh tyres, even onto the SAME compound
    // (a fresh set of softs is a real plan). Policies return null to stay out.
    if (call) {
      compound = call;
      age = 0;
      fitOrder++;
      eff = env.effFor(compound, carSlot, fitOrder);
      used.add(compound);
      pitted = true;
      stops++;
    }
    const fuelFrac = (L - (lap - 1)) / L;
    let t = lapTime({ compound, age, wetness, fuelFrac, lap, laps: L, lifeMult: eff.lifeMult, wearMult: eff.wearMult, tempPace: eff.tempPace });
    if (pitted) t += env.safetyCarAt(lap) ? PIT_LOSS_SC : PIT_LOSS;
    cum += t;
    rows.push({ lap, compound, age, wetness, lapTime: t, pitted, cumTime: cum });
    age++;
    prevWetness = wetness;
  }

  const wetUsed = [...used].some((c) => SPEC[c].wet);
  if (stops === 0 && !wetUsed) cum += NO_STOP_PENALTY;
  return { total: cum, laps: rows, stops, compoundsUsed: [...used] };
}

// ── the AI field ─────────────────────────────────────────────────────────────

export interface FieldCar {
  slot: number;
  name: string;
  kind: PolicyKind;
  result: CarResult;
}

const FIELD_NAMES = [
  'Vale', 'Renn', 'Costa', 'Aoki', 'Bex', 'Dane', 'Foss', 'Grey', 'Hale', 'Ivo', 'Kwon', 'Larsen',
  'Mira', 'Novak', 'Orr', 'Pace',
];

/**
 * Simulate the AI field (slots 1..grid-1). Each car draws a policy kind from the
 * seed, so the field is varied but deterministic and identical for every peer.
 */
export function simulateField(env: RaceEnv): FieldCar[] {
  const cars: FieldCar[] = [];
  const rng = makeRng(hashSeed(`${env.seed}:field:${env.mode.id}`));
  for (let slot = 1; slot < env.mode.grid; slot++) {
    const kind = POLICY_KINDS[Math.floor(rng() * POLICY_KINDS.length)];
    const carRng = makeRng(hashSeed(`${env.seed}:car:${slot}`));
    const driver = makeDriver(kind, carRng, env.mode);
    const result = simulatePolicy(env, driver, slot);
    cars.push({ slot, name: FIELD_NAMES[(slot - 1) % FIELD_NAMES.length], kind, result });
  }
  return cars;
}

/** Your finishing position (1 = win) given your total and the field's totals. */
export function positionOf(myTotal: number, field: FieldCar[]): number {
  let ahead = 0;
  for (const c of field) if (c.result.total < myTotal) ahead++;
  return ahead + 1;
}
