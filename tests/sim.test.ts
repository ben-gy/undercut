/**
 * sim.test.ts — the pure model, and the P2P-sync determinism invariant.
 *
 * Two peers on the same seed MUST face a byte-identical race — same weather, same
 * track temperature, same field, same per-set jitter — or the ladder that ranks
 * them by time is comparing runs on different worlds. This is the determinism that
 * makes the parallel same-seed race desync-proof (race.ts).
 */

import { describe, expect, it } from 'vitest';
import { MODES, modeOf } from '../src/modes';
import {
  RaceEnv,
  simulateField,
  simulateScript,
  positionOf,
  NO_STOP_PENALTY,
  COMPOUNDS,
  type Script,
} from '../src/sim';

const gp = modeOf('gp');

describe('determinism (the P2P-sync invariant)', () => {
  it('same seed → identical environment', () => {
    for (const mode of MODES) {
      const a = new RaceEnv(4242, mode);
      const b = new RaceEnv(4242, mode);
      expect(a.trackTemp).toBe(b.trackTemp);
      expect(a.weather).toEqual(b.weather);
      for (let l = 1; l <= mode.laps; l++) {
        expect(a.wetnessAt(l)).toBe(b.wetnessAt(l));
        expect(a.safetyCarAt(l)).toBe(b.safetyCarAt(l));
      }
    }
  });

  it('same seed → identical AI field, lap for lap', () => {
    const a = simulateField(new RaceEnv(777, gp));
    const b = simulateField(new RaceEnv(777, gp));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].kind).toBe(b[i].kind);
      expect(a[i].result.total).toBe(b[i].result.total);
      expect(a[i].result.laps.map((r) => r.cumTime)).toEqual(b[i].result.laps.map((r) => r.cumTime));
    }
  });

  it('same seed + same script → identical total (both peers agree)', () => {
    const script: Script = { start: 'medium', stops: [{ lap: 14, compound: 'soft' }] };
    const a = simulateScript(new RaceEnv(9001, gp), script, 0);
    const b = simulateScript(new RaceEnv(9001, gp), script, 0);
    expect(a.total).toBe(b.total);
    expect(a.laps.map((r) => r.lapTime)).toEqual(b.laps.map((r) => r.lapTime));
  });

  it('different seeds → different races (the seed actually does something)', () => {
    const script: Script = { start: 'medium', stops: [{ lap: 14, compound: 'soft' }] };
    const a = simulateScript(new RaceEnv(1, gp), script, 0);
    const b = simulateScript(new RaceEnv(2, gp), script, 0);
    expect(a.total).not.toBe(b.total);
  });
});

describe('the pit-stop model', () => {
  it('a pit onto the SAME compound still counts as a stop (a fresh set)', () => {
    const env = new RaceEnv(5, MODES[0]);
    const r = simulateScript(env, { start: 'soft', stops: [{ lap: 10, compound: 'soft' }] }, 0);
    expect(r.stops, 'a fresh set of the same tyre is a real pit stop').toBe(1);
  });

  it('never pitting in a dry race takes the mandatory-stop penalty', () => {
    const env = new RaceEnv(5, MODES[0]); // Sprint, dry
    const noStop = simulateScript(env, { start: 'medium', stops: [] }, 0);
    const oneStop = simulateScript(env, { start: 'medium', stops: [{ lap: 12, compound: 'medium' }] }, 0);
    expect(noStop.stops).toBe(0);
    // The penalty is baked into the total, so the no-stop run is worse by ≥ its size.
    expect(noStop.total - (oneStop.total - 21)).toBeGreaterThanOrEqual(NO_STOP_PENALTY - 1);
  });

  it('every script produces exactly `laps` rows', () => {
    const env = new RaceEnv(5, gp);
    for (const start of COMPOUNDS) {
      const r = simulateScript(env, { start, stops: [{ lap: 20, compound: 'medium' }] }, 0);
      expect(r.laps.length).toBe(gp.laps);
    }
  });
});

describe('finishing position', () => {
  it('a very fast total finishes ahead of the whole field', () => {
    const env = new RaceEnv(321, gp);
    const field = simulateField(env);
    expect(positionOf(0, field)).toBe(1);
    expect(positionOf(Infinity, field)).toBe(field.length + 1);
  });
});

describe('modeOf validates ids off the wire', () => {
  it('unknown ids fall back to the default, never undefined', () => {
    expect(modeOf('nope')).toBe(MODES[0]);
    expect(modeOf(undefined)).toBe(MODES[0]);
    expect(modeOf('gp').id).toBe('gp');
    // A prototype key must not slip through as a Mode of undefined fields.
    expect(modeOf('constructor')).toBe(MODES[0]);
  });
});
