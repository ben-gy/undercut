/**
 * mechanism.test.ts — principle #21 for a solo-vs-system game. A balance sim
 * measures OUTCOMES, and a broken physics just shifts the outcome curve, so the
 * curve cannot tell you the mechanism works. This audits the mechanisms directly.
 *
 * Crucially it asserts PROPERTIES the model must have — monotonicities, orderings,
 * calibration — derived from INDEPENDENT physical reasoning ("an older tyre is
 * slower", "the wrong tyre for the conditions is worse", "a hotter track overheats
 * a compound", "a 40% forecast rains 40% of the time"). It does NOT re-implement
 * the game's arithmetic and compare it to itself — that memory-hole tautology
 * stays green on a mutated formula. Each block names what mutation turns it red.
 */

import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import {
  RaceEnv,
  lapTime,
  tempEffect,
  conditionPenalty,
  COMPOUNDS,
  SLICKS,
  type Compound,
  type LapInput,
} from '../src/sim';

const neutral = (over: Partial<LapInput>): LapInput => ({
  compound: 'medium',
  age: 3,
  wetness: 0,
  fuelFrac: 0.5,
  lap: 10,
  laps: 40,
  lifeMult: 1,
  wearMult: 1,
  tempPace: 0,
  ...over,
});

describe('the forecast is a calibrated bet (the signature mechanism)', () => {
  // Independent of the lap-time model entirely: bucket seeds by the DISPLAYED
  // forecast probability and check the realised rain frequency matches it. A
  // "40%" forecast that rains 90% of the time would make the whole game a lie.
  // Mutation: decoupling `rains` from `forecastP` (e.g. `rng() < 0.5`) turns red.
  for (const mode of MODES.filter((m) => m.rainCapable)) {
    it(`${mode.name}: realised rain frequency tracks the forecast probability`, () => {
      const buckets = new Map<number, { rain: number; total: number }>();
      for (let i = 0; i < 4000; i++) {
        const env = new RaceEnv((3 + i * 2654435761) >>> 0, mode);
        const b = Math.floor(env.weather.forecastP * 5) / 5; // 0.2-wide buckets
        const rec = buckets.get(b) ?? { rain: 0, total: 0 };
        rec.total++;
        if (env.weather.rains) rec.rain++;
        buckets.set(b, rec);
      }
      for (const [b, rec] of buckets) {
        if (rec.total < 100) continue;
        const observed = rec.rain / rec.total;
        // The bucket centre is b+0.1; allow a generous band for sampling noise.
        expect(Math.abs(observed - (b + 0.1))).toBeLessThan(0.12);
      }
    });
  }
});

describe('degradation: an older tyre is always slower, and there is a cliff', () => {
  // Mutation: flipping the sign of `wear`, or dropping the cliff term, turns red.
  it('lap time is strictly increasing in tyre age for every compound', () => {
    for (const c of COMPOUNDS) {
      for (let age = 0; age < 25; age++) {
        const now = lapTime(neutral({ compound: c, age }));
        const older = lapTime(neutral({ compound: c, age: age + 1 }));
        expect(older, `${c} did not get slower from age ${age} to ${age + 1}`).toBeGreaterThan(now);
      }
    }
  });

  it('degradation accelerates — the late laps of a long stint cost more than the early ones', () => {
    for (const c of SLICKS) {
      const d = (age: number): number => lapTime(neutral({ compound: c, age: age + 1 })) - lapTime(neutral({ compound: c, age }));
      // The per-lap loss deep into a long run (past every slick's nominal life)
      // exceeds the per-lap loss at the start.
      expect(d(40), `${c} has no cliff — deg is linear`).toBeGreaterThan(d(2) + 0.001);
    }
  });
});

describe('conditions: the right tyre for the track is always the fastest', () => {
  // Mutation: zeroing conditionPenalty, or swapping the wet/dry curves, turns red.
  const grip = (c: Compound, w: number): number => lapTime(neutral({ compound: c, wetness: w, age: 0 }));

  it('in the dry, a slick beats any wet tyre', () => {
    for (const slick of SLICKS) {
      expect(grip(slick, 0)).toBeLessThan(grip('inter', 0));
      expect(grip(slick, 0)).toBeLessThan(grip('wet', 0));
    }
  });

  it('in a flooded track, the full wet beats every slick and the inter', () => {
    for (const slick of SLICKS) expect(grip('wet', 0.85)).toBeLessThan(grip(slick, 0.85));
    expect(grip('wet', 0.85)).toBeLessThan(grip('inter', 0.85));
  });

  it('in a damp crossover, the inter beats both the slicks and the full wet', () => {
    for (const slick of SLICKS) expect(grip('inter', 0.4)).toBeLessThan(grip(slick, 0.4));
    expect(grip('inter', 0.4)).toBeLessThan(grip('wet', 0.4));
  });

  it('a slick has zero condition penalty when dry and a large one when wet', () => {
    expect(conditionPenalty('soft', 0)).toBe(0);
    expect(conditionPenalty('soft', 0.8)).toBeGreaterThan(20);
  });
});

describe('fuel: a heavier car is always slower', () => {
  // Mutation: flipping the fuel term sign turns red.
  it('lap time rises with fuel load', () => {
    let prev = -Infinity;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const t = lapTime(neutral({ fuelFrac: f }));
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });
});

describe('temperature: a track outside the window punishes the compound', () => {
  // Mutation: dropping OVERHEAT_WEAR_K or COLD_PACE_K turns the relevant line red.
  it('a hotter track raises a soft tyre’s wear (it overheats)', () => {
    expect(tempEffect('soft', 44).wearMult).toBeGreaterThan(tempEffect('soft', 20).wearMult);
  });

  it('a colder track than a hard tyre likes costs it pace (it never switches on)', () => {
    expect(tempEffect('hard', 15).pace).toBeGreaterThan(0);
    expect(tempEffect('hard', 41).pace).toBeCloseTo(0, 5);
  });

  it('overheating shortens set life', () => {
    expect(tempEffect('soft', 44).lifeMult).toBeLessThan(tempEffect('soft', 24).lifeMult);
  });
});

describe('every race terminates with a full, finite lap log', () => {
  it('no NaN/Infinity lap times, and exactly `laps` rows for a plausible plan', () => {
    for (const mode of MODES) {
      for (let i = 0; i < 40; i++) {
        const env = new RaceEnv((99 + i) >>> 0, mode);
        // A safe plan: start medium, one stop at half distance.
        const half = Math.round(mode.laps / 2);
        const rows = simulateOne(env, half);
        expect(rows.length).toBe(mode.laps);
        for (const t of rows) expect(Number.isFinite(t)).toBe(true);
      }
    }
  });
});

function simulateOne(env: RaceEnv, pitLap: number): number[] {
  // A minimal script sim reusing the model, kept local to avoid asserting the
  // game's own simulate against itself.
  const rows: number[] = [];
  let compound: Compound = 'medium';
  let age = 0;
  let fit = 0;
  let eff = env.effFor(compound, 0, fit);
  for (let lap = 1; lap <= env.laps; lap++) {
    if (lap === pitLap) {
      compound = 'soft';
      age = 0;
      fit++;
      eff = env.effFor(compound, 0, fit);
    }
    const t = lapTime({
      compound,
      age,
      wetness: env.wetnessAt(lap),
      fuelFrac: (env.laps - (lap - 1)) / env.laps,
      lap,
      laps: env.laps,
      lifeMult: eff.lifeMult,
      wearMult: eff.wearMult,
      tempPace: eff.tempPace,
    });
    rows.push(t);
    age++;
  }
  return rows;
}
