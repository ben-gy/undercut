/**
 * strat.ts — the balance-sim harness. Runs each strategy ARCHETYPE as the player
 * (slot 0) over a seed and reports totals, so balance.test.ts can referee the
 * dominant-strategy gate (principle #18 + the idea's own balance requirement).
 *
 * The archetypes are exactly the AI policies, driven from a CENTERED rng (0.5) so
 * each is its canonical version (central pit laps), not one jittered instance.
 */

import {
  RaceEnv,
  simulatePolicy,
  simulateField,
  makeDriver,
  positionOf,
  POLICY_KINDS,
  type PolicyKind,
} from '../../src/sim';
import type { Mode } from '../../src/modes';

/** A deterministic "central" rng so an archetype uses its middle pit laps. */
const centered = () => 0.5;

export interface StratRun {
  kind: PolicyKind;
  total: number;
  position: number;
}

export function runStrategies(seed: number, mode: Mode): StratRun[] {
  const env = new RaceEnv(seed, mode);
  const field = simulateField(env);
  return POLICY_KINDS.map((kind) => {
    const driver = makeDriver(kind, centered, mode);
    const res = simulatePolicy(env, driver, 0);
    return { kind, total: res.total, position: positionOf(res.total, field) };
  });
}

export interface Dist {
  wins: Record<PolicyKind, number>;
  seeds: number;
  rainSeeds: number;
  /** Per-partition winner counts (rained vs dry), for the "forecast matters" gate. */
  winsWhenRain: Record<PolicyKind, number>;
  winsWhenDry: Record<PolicyKind, number>;
}

export function distribution(mode: Mode, seeds: number, base = 1000): Dist {
  const wins = zero();
  const winsWhenRain = zero();
  const winsWhenDry = zero();
  let rainSeeds = 0;
  for (let i = 0; i < seeds; i++) {
    const seed = (base + i * 2654435761) >>> 0;
    const env = new RaceEnv(seed, mode);
    const runs = runStrategies(seed, mode);
    const best = runs.reduce((a, b) => (b.total < a.total ? b : a));
    wins[best.kind]++;
    if (env.weather.rains) {
      rainSeeds++;
      winsWhenRain[best.kind]++;
    } else {
      winsWhenDry[best.kind]++;
    }
  }
  return { wins, seeds, rainSeeds, winsWhenRain, winsWhenDry };
}

function zero(): Record<PolicyKind, number> {
  const o = {} as Record<PolicyKind, number>;
  for (const k of POLICY_KINDS) o[k] = 0;
  return o;
}

export function topShare(counts: Record<PolicyKind, number>): { kind: PolicyKind; share: number } {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  let best: PolicyKind = POLICY_KINDS[0];
  for (const k of POLICY_KINDS) if (counts[k] > counts[best]) best = k;
  return { kind: best, share: counts[best] / total };
}

export function sharesWith(counts: Record<PolicyKind, number>, minShare: number): number {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return POLICY_KINDS.filter((k) => counts[k] / total >= minShare).length;
}
