/**
 * balance.test.ts — the DOMINANT-STRATEGY gate (principle #18 + the idea's own
 * balance requirement). A race-strategy game dies the instant one plan wins
 * regardless of the weather: there is no decision left, only a script to memorise.
 *
 * So this simulates the strategy ARCHETYPES against each other across hundreds of
 * fixed weather/temperature seeds and asserts the SHAPE of the outcome, not vibes:
 *
 *   1. No single fixed strategy wins more than ~40% of seeds in any mode.
 *   2. At least three genuinely distinct strategies each take a meaningful share.
 *   3. THE FORECAST CHANGES THE OPTIMAL CALL: in the rain-capable modes the best
 *      strategy over seeds that RAINED differs from the best over seeds that
 *      stayed DRY — if the same plan won both, the weather is flavour text over a
 *      solved race (the exact failure the idea calls out).
 *   4. Reading the weather beats ignoring it: on rain seeds the hindsight-optimal
 *      line (which can pre-empt onto wets) is materially faster than the best
 *      dry-only script — so the rain is a real, winnable bet, not just a hazard.
 *
 * The baseline was built FIRST and let the numbers referee: the initial model had
 * Sprint at 100% one-plan and the forecast was pure flavour (reacting always beat
 * pre-empting). Track temperature — which shifts the fastest compound per seed —
 * and a one-lap reaction lag (a reactor drives a lap in real water before it can
 * box, so a confident forecast is worth pre-empting) are what earned these numbers.
 */

import { describe, expect, it } from 'vitest';
import { MODES, modeOf } from '../src/modes';
import { RaceEnv, simulateScript, POLICY_KINDS, type Compound, type Script } from '../src/sim';
import { distribution, topShare, sharesWith } from './helpers/strat';

const N = 500;

describe('no dominant strategy in any mode', () => {
  for (const mode of MODES) {
    it(`${mode.name}: top strategy wins ≤45% and ≥3 strategies take ≥10%`, () => {
      const d = distribution(mode, N, 11);
      const top = topShare(d.wins);
      const three = sharesWith(d.wins, 0.1);
      const pretty = POLICY_KINDS.map((k) => `${k} ${((d.wins[k] / N) * 100).toFixed(1)}%`).join(', ');
      expect(
        top.share,
        `${mode.name} is a solved race — "${top.kind}" wins ${(top.share * 100).toFixed(1)}%. ${pretty}`,
      ).toBeLessThanOrEqual(0.45);
      expect(
        three,
        `${mode.name} offers fewer than three viable plans: ${pretty}`,
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('the forecast changes the optimal call', () => {
  for (const mode of MODES.filter((m) => m.rainCapable)) {
    it(`${mode.name}: the best plan when it rains ≠ the best plan when it stays dry`, () => {
      const d = distribution(mode, N, 11);
      expect(d.rainSeeds, 'need a mix of rain and dry seeds to compare').toBeGreaterThan(N * 0.15);
      expect(N - d.rainSeeds, 'need a mix of rain and dry seeds to compare').toBeGreaterThan(N * 0.15);
      const rainTop = topShare(d.winsWhenRain).kind;
      const dryTop = topShare(d.winsWhenDry).kind;
      expect(
        rainTop,
        `the same strategy (${rainTop}) is best whether it rains or not — the ` +
          `forecast is flavour over a solved race`,
      ).not.toBe(dryTop);
    });
  }
});

describe('reading the weather is a real, winnable bet', () => {
  it('on rain seeds the hindsight-optimal (which can pre-empt onto wets) beats the best dry-only line', () => {
    const mode = modeOf('gp');
    let rainSeeds = 0;
    let sumOptimal = 0;
    let sumDryOnly = 0;
    for (let i = 0; i < 160; i++) {
      const seed = (11 + i * 2654435761) >>> 0;
      const env = new RaceEnv(seed, mode);
      if (!env.weather.rains) continue;
      rainSeeds++;
      sumOptimal += bestScript(env, false);
      sumDryOnly += bestScript(env, true);
    }
    expect(rainSeeds).toBeGreaterThan(20);
    const gain = (sumDryOnly - sumOptimal) / rainSeeds;
    expect(
      gain,
      'ignoring the forecast (dry tyres only) costs barely anything on rain seeds — ' +
        'the rain is not a real decision',
    ).toBeGreaterThan(15); // seconds per race, on average
  });
});

/** The best one/two-stop total over a coarse grid; `dryOnly` bans wet compounds. */
function bestScript(env: RaceEnv, dryOnly: boolean): number {
  const L = env.laps;
  const all: Compound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];
  const compounds = dryOnly ? (['soft', 'medium', 'hard'] as Compound[]) : all;
  const starts = dryOnly ? (['soft', 'medium', 'hard'] as Compound[]) : all;
  const stopLaps: number[] = [];
  for (let lap = 4; lap < L; lap += 4) stopLaps.push(lap);
  let best = Infinity;
  const consider = (s: Script): void => {
    const r = simulateScript(env, s, 0);
    if (r.total < best) best = r.total;
  };
  for (const start of starts) {
    for (const l1 of stopLaps) for (const c1 of compounds) consider({ start, stops: [{ lap: l1, compound: c1 }] });
    for (let i = 0; i < stopLaps.length; i++)
      for (let j = i + 1; j < stopLaps.length; j++)
        for (const c1 of compounds) for (const c2 of compounds) consider({ start, stops: [{ lap: stopLaps[i], compound: c1 }, { lap: stopLaps[j], compound: c2 }] });
  }
  return best;
}
