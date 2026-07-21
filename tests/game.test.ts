/**
 * game.test.ts — the live race controller. It runs the player's car incrementally
 * while the AI field is precomputed, so the calls can be made lap by lap.
 */

import { describe, expect, it } from 'vitest';
import { modeOf } from '../src/modes';
import { Game } from '../src/game';

const gp = modeOf('gp');
const sprint = modeOf('sprint');

function playTo(g: Game): void {
  while (!g.over) g.step();
}

describe('a solo run plays start to finish', () => {
  it('advances exactly `laps` laps then is over', () => {
    const g = new Game({ seed: 100, mode: gp, start: 'medium' });
    let steps = 0;
    while (!g.over) {
      g.step();
      steps++;
      expect(steps).toBeLessThanOrEqual(gp.laps + 1);
    }
    expect(g.lapsDone).toBe(gp.laps);
  });

  it('a queued box takes fresh tyres — even onto the same compound', () => {
    const g = new Game({ seed: 100, mode: gp, start: 'medium' });
    g.step();
    g.step();
    const ageBefore = g.currentAge;
    expect(ageBefore).toBeGreaterThan(0);
    g.box('medium'); // fresh mediums
    g.step();
    // The out-lap ran at age 0 (a fresh set), and it counted as a real stop.
    const pitRow = g.laps()[2];
    expect(pitRow.pitted).toBe(true);
    expect(pitRow.age, 'the out-lap runs on a fresh set at age 0').toBe(0);
    expect(g.currentAge, 'age resets on the fresh set, so it is now below where it was').toBeLessThan(ageBefore);
    expect(g.stopsMade()).toBe(1);
  });

  it('a two-peer pair making identical calls finishes on identical totals', () => {
    const calls = [
      { at: 12, c: 'soft' as const },
      { at: 28, c: 'medium' as const },
    ];
    const run = (): number => {
      const g = new Game({ seed: 55, mode: gp, start: 'medium' });
      while (!g.over) {
        const next = g.lapsDone + 1;
        const call = calls.find((c) => c.at === next);
        if (call) g.box(call.c);
        g.step();
      }
      return g.summary().total;
    };
    expect(run()).toBe(run());
  });
});

describe('the summary', () => {
  it('reports a finishing position within the grid and a valid optimal', () => {
    const g = new Game({ seed: 200, mode: gp, start: 'medium' });
    g.box('soft');
    // pit once early then run out
    let did = false;
    while (!g.over) {
      if (!did && g.lapsDone === 20) {
        g.box('medium');
        did = true;
      }
      g.step();
    }
    const s = g.summary();
    expect(s.position).toBeGreaterThanOrEqual(1);
    expect(s.position).toBeLessThanOrEqual(gp.grid);
    expect(s.finish.length).toBe(gp.grid);
    expect(s.finish.filter((e) => e.isSelf)).toHaveLength(1);
    expect(s.total).toBeGreaterThan(0);
    // The hindsight-optimal is never slower than what you actually did.
    expect(s.optimal.total).toBeLessThanOrEqual(s.total + 0.001);
    expect(s.lost).toBeGreaterThanOrEqual(0);
  });

  it('the finish order is sorted by total and positions are 1..grid', () => {
    const g = new Game({ seed: 201, mode: sprint, start: 'soft' });
    g.box('soft');
    playTo(g);
    const s = g.summary();
    const totals = s.finish.map((e) => e.total);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
    expect(s.finish.map((e) => e.position)).toEqual(s.finish.map((_, i) => i + 1));
  });
});

describe('standings and gaps are live and coherent', () => {
  it('standings always include the player and sum to the grid size', () => {
    const g = new Game({ seed: 5, mode: gp, start: 'medium' });
    for (let i = 0; i < 10; i++) g.step();
    const s = g.standings();
    expect(s.length).toBe(gp.grid);
    expect(s.filter((r) => r.isSelf)).toHaveLength(1);
    expect(s.map((r) => r.position)).toEqual(s.map((_, i) => i + 1));
  });

  it('wrongTyre flags a slick once it is genuinely wet', () => {
    // Find a rain seed and run to the wet, on slicks, without reacting.
    let flagged = false;
    for (let seed = 1; seed < 60 && !flagged; seed++) {
      const g = new Game({ seed, mode: modeOf('deluge'), start: 'medium' });
      while (!g.over) {
        if (g.wetnessNow() > 0.5 && g.wrongTyre()) {
          flagged = true;
          break;
        }
        g.step();
      }
    }
    expect(flagged, 'a slick in heavy rain must read as the wrong tyre').toBe(true);
  });
});
