/**
 * takeover.test.ts — the host can leave and the room still reaches a result.
 * Multiplayer contract gate #2.
 *
 * Undercut's netcode is a parallel same-seed race: no peer has authority over
 * anyone's car, so "the host left" cannot freeze a run. What it CAN do is strand
 * the room on the results screen, because the host is the peer that publishes the
 * ladder. So after promotion the survivor must be able to close the ladder, and it
 * must already hold the results — which is why final results are BROADCAST, not
 * unicast to the host. `setHost()` takes no wire, so the whole gate is testable
 * without a mesh, a relay or a browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRace, LADDER_GRACE_MS, type Race, type RaceNet, type RaceResult } from '../src/race';

function pair(): { a: RaceNet; b: RaceNet; flush: () => void } {
  type Handler = { peer: 'a' | 'b'; name: string; fn: (data: unknown, from: string) => void };
  const handlers: Handler[] = [];
  const queue: Array<() => void> = [];

  const make = (self: 'a' | 'b'): RaceNet => ({
    selfId: self,
    channel<T>(name: string, onReceive: (data: T, from: string) => void) {
      const entry: Handler = { peer: self, name, fn: onReceive as Handler['fn'] };
      handlers.push(entry);
      const send = (data: T): void => {
        queue.push(() => {
          for (const h of handlers) {
            if (h.name !== name || h.peer === self) continue;
            h.fn(data, self);
          }
        });
      };
      send.off = (): void => {
        const i = handlers.indexOf(entry);
        if (i >= 0) handlers.splice(i, 1);
      };
      return send as ReturnType<RaceNet['channel']>;
    },
  });

  return {
    a: make('a'),
    b: make('b'),
    flush(): void {
      for (let i = 0; i < 20 && queue.length; i++) {
        const batch = queue.splice(0, queue.length);
        for (const fn of batch) fn();
      }
    },
  };
}

const result = (total: number, position = 1): RaceResult => ({
  total,
  position,
  optimal: total - 8,
  lost: 8,
  stops: 2,
  startCompound: 'medium',
  compounds: ['medium', 'soft', 'medium'],
  pitLaps: [14, 30],
});

const SEATS = [
  { id: 'a', name: 'Ana' },
  { id: 'b', name: 'Bo' },
];

describe('a promoted peer can close the ladder', () => {
  let bus: ReturnType<typeof pair>;
  let guestRace: Race;
  let guestLadder = 0;
  let hostReports: (total: number) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    guestLadder = 0;
    bus = pair();

    // The other seat is a RAW SENDER, not a second Race — the host reported and
    // then vanished, and nobody is closing.
    const sendFin = bus.a.channel<Record<string, unknown>>('fin', () => {});
    hostReports = (total: number): void => {
      sendFin({ r: 1, ...result(total) });
    };

    guestRace = createRace({
      net: bus.b,
      round: 1,
      seats: SEATS,
      selfId: 'b',
      isHost: false,
      onLadder: () => guestLadder++,
    });
  });

  afterEach(() => {
    guestRace.destroy();
    vi.useRealTimers();
  });

  it('a guest does NOT publish the ladder, even holding every result', () => {
    guestRace.finish(result(30));
    hostReports(40);
    bus.flush();
    expect(guestRace.settled()).toBe(false);
    expect(guestLadder).toBe(0);
  });

  it('once promoted, it closes immediately on the results it already held', () => {
    guestRace.finish(result(30));
    hostReports(40);
    bus.flush();
    expect(guestRace.settled()).toBe(false);

    guestRace.setHost(true);

    expect(guestRace.isHost()).toBe(true);
    expect(guestRace.settled()).toBe(true);
    expect(guestLadder).toBe(1);
  });

  it('the ladder is ranked by LOWEST time and includes the departed host', () => {
    hostReports(40);
    guestRace.finish(result(30));
    bus.flush();
    guestRace.setHost(true);

    const order = guestRace.standings();
    expect(order.map((s) => s.id), 'the faster total leads').toEqual(['b', 'a']);
    expect(order[0].result?.total).toBe(30);
    // Principle #9: everyone's result with a real breakdown.
    expect(order[1].result).toMatchObject({ total: 40, compounds: ['medium', 'soft', 'medium'], pitLaps: [14, 30] });
  });

  it('promoted mid-countdown, it takes over the clock and closes on expiry', () => {
    guestRace.finish(result(30));
    bus.flush();
    expect(guestRace.closesInMs()).toBeGreaterThan(0);

    guestRace.setHost(true);
    vi.advanceTimersByTime(LADDER_GRACE_MS + 500);

    expect(guestRace.settled()).toBe(true);
    expect(guestLadder).toBe(1);
    const other = guestRace.standings().find((s) => s.id === 'a');
    expect(other?.result).toBeNull();
  });

  it('a promoted peer that has heard nothing yet does not invent a ladder', () => {
    guestRace.setHost(true);
    expect(guestRace.settled()).toBe(false);
    expect(guestRace.closesInMs()).toBeNull();
  });
});

describe('the room never hangs on somebody who is gone', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a peer leaving lets the host close with the rest', () => {
    const bus = pair();
    let ladders = 0;
    const host = createRace({
      net: bus.a,
      round: 1,
      seats: SEATS,
      selfId: 'a',
      isHost: true,
      onLadder: () => ladders++,
    });

    host.finish(result(35));
    bus.flush();
    expect(host.settled()).toBe(false);

    host.peerLeft('b');

    expect(host.settled()).toBe(true);
    expect(ladders).toBe(1);
    expect(host.standings().find((s) => s.id === 'b')?.gone).toBe(true);
    host.destroy();
  });

  it('the wait always has a stated horizon', () => {
    const bus = pair();
    const host = createRace({ net: bus.a, round: 1, seats: SEATS, selfId: 'a', isHost: true });
    expect(host.closesInMs()).toBeNull();
    host.finish(result(35));
    expect(host.closesInMs()).toBeGreaterThan(0);
    expect(host.closesInMs()).toBeLessThanOrEqual(LADDER_GRACE_MS);
    host.destroy();
  });

  it('a stale round is ignored entirely', () => {
    const bus = pair();
    const host = createRace({ net: bus.a, round: 2, seats: SEATS, selfId: 'a', isHost: true });
    const stale = createRace({ net: bus.b, round: 1, seats: SEATS, selfId: 'b', isHost: false });
    stale.finish(result(9));
    bus.flush();

    expect(host.standings().find((s) => s.id === 'b')?.result).toBeNull();
    host.destroy();
    stale.destroy();
  });
});

describe('a pit event crosses the wire for the rivals ticker', () => {
  it('a peer boxing surfaces onPit to the others, tagged with the round', () => {
    const bus = pair();
    const seen: Array<{ id: string; lap: number }> = [];
    const host = createRace({ net: bus.a, round: 1, seats: SEATS, selfId: 'a', isHost: true });
    const guest = createRace({
      net: bus.b,
      round: 1,
      seats: SEATS,
      selfId: 'b',
      isHost: false,
      onPit: (ev) => seen.push({ id: ev.id, lap: ev.lap }),
    });
    host.pit(18, 'inter');
    bus.flush();
    expect(seen).toEqual([{ id: 'a', lap: 18 }]);
    host.destroy();
    guest.destroy();
  });
});

describe('a solo run needs no room at all', () => {
  it('settles the moment it finishes', () => {
    const solo = createRace({
      net: null,
      round: 0,
      seats: [{ id: 'me', name: 'You' }],
      selfId: 'me',
      isHost: true,
    });
    solo.finish(result(28));
    expect(solo.settled()).toBe(true);
    expect(solo.standings()[0].result?.total).toBe(28);
    solo.destroy();
  });
});
