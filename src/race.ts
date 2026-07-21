/**
 * race.ts — the netcode, which is deliberately almost nothing.
 *
 * Undercut multiplayer is a PARALLEL SAME-SEED RACE. Every peer runs its own
 * `Game` over its own pit calls, from a seed + mode the host froze into the round
 * start. No peer ever touches another peer's car, so there is no shared mutable
 * state and structurally nothing to desync. What crosses the wire is a live
 * status ping (which lap you are on, your position, your tyre, your running time),
 * a pit EVENT so rivals watch your calls land in real time, and a final result —
 * display data, all of it.
 *
 * Ranking is by LOWEST total race time, so the leader is whoever raced quickest.
 * Results are BROADCAST, not unicast to the host, so a promoted peer already holds
 * every result it needs to publish the ladder — which is the whole of host
 * transfer here (takeover.test.ts).
 *
 * The one thing that can genuinely go wrong is a room that waits forever on
 * somebody who closed their tab, so the ladder publishes on a visible countdown
 * from the first finisher (principle #12), and a peer that leaves is dropped from
 * the expected set. Timers are setInterval, never rAF: a backgrounded tab freezes
 * rAF, and a countdown that stops when you switch tabs is a room that hangs.
 */

import type { Compound } from './sim';

export interface RaceNet {
  readonly selfId: string;
  channel<T>(
    name: string,
    onReceive: (data: T, from: string) => void,
  ): ((data: T, toPeers?: string | string[]) => void) & { off: () => void };
}

/** How long the room holds the ladder open for stragglers after the first finish. */
export const LADDER_GRACE_MS = 25_000;
const TICK_MS = 250;

export interface RaceSeat {
  id: string;
  name: string;
}

/** The compact result that crosses the wire and drives the ladder. */
export interface RaceResult {
  total: number;
  position: number;
  optimal: number;
  lost: number;
  stops: number;
  startCompound: Compound;
  /** The compounds this car used, in order fitted (for a real breakdown). */
  compounds: Compound[];
  /** The laps this car pitted on (for a real breakdown). */
  pitLaps: number[];
}

export interface Standing {
  id: string;
  name: string;
  isSelf: boolean;
  /** 1-based lap they are on (or completed). */
  lap: number;
  laps: number;
  /** Live position in the field. */
  pos: number;
  compound: Compound;
  /** Running total in seconds. */
  total: number;
  done: boolean;
  result: RaceResult | null;
  gone: boolean;
}

/** A pit call landing live, surfaced to the UI ticker. */
export interface PitEvent {
  id: string;
  name: string;
  lap: number;
  compound: Compound;
}

interface StatusMsg {
  r: number;
  lap: number;
  laps: number;
  pos: number;
  compound: Compound;
  total: number;
}

interface PitMsg {
  r: number;
  lap: number;
  compound: Compound;
}

interface FinMsg extends RaceResult {
  r: number;
}

interface LadderMsg {
  r: number;
  order: string[];
}

export interface RaceConfig {
  net?: RaceNet | null;
  round: number;
  seats: RaceSeat[];
  selfId: string;
  isHost: boolean;
  graceMs?: number;
  onChange?: () => void;
  onLadder?: () => void;
  onPit?: (ev: PitEvent) => void;
}

export interface Race {
  standings(): Standing[];
  ping(lap: number, laps: number, pos: number, compound: Compound, total: number): void;
  pit(lap: number, compound: Compound): void;
  finish(result: RaceResult): void;
  settled(): boolean;
  closesInMs(): number | null;
  setHost(isHost: boolean): void;
  isHost(): boolean;
  peerLeft(id: string): void;
  closeNow(): void;
  destroy(): void;
}

export function createRace(cfg: RaceConfig): Race {
  const net = cfg.net ?? null;
  const round = cfg.round;
  const graceMs = cfg.graceMs ?? LADDER_GRACE_MS;

  let host = cfg.isHost;
  let published = false;
  let destroyed = false;
  let deadline: number | null = null;
  let elapsed = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let order: string[] | null = null;

  const seats = new Map<string, Standing>();
  for (const s of cfg.seats) {
    seats.set(s.id, {
      id: s.id,
      name: s.name,
      isSelf: s.id === cfg.selfId,
      lap: 0,
      laps: 0,
      pos: 0,
      compound: 'medium',
      total: 0,
      done: false,
      result: null,
      gone: false,
    });
  }

  const changed = (): void => cfg.onChange?.();

  const sendSt = net?.channel<StatusMsg>('st', (msg, from) => {
    if (destroyed || msg.r !== round) return;
    const s = seats.get(from);
    if (!s || s.done) return;
    s.lap = msg.lap;
    s.laps = msg.laps;
    s.pos = msg.pos;
    s.compound = msg.compound;
    s.total = msg.total;
    changed();
  });

  const sendPit = net?.channel<PitMsg>('pit', (msg, from) => {
    if (destroyed || msg.r !== round) return;
    const s = seats.get(from);
    if (!s) return;
    cfg.onPit?.({ id: from, name: s.name, lap: msg.lap, compound: msg.compound });
  });

  const sendFin = net?.channel<FinMsg>('fin', (msg, from) => {
    if (destroyed || msg.r !== round) return;
    record(from, msg);
  });

  const sendLad = net?.channel<LadderMsg>('lad', (msg) => {
    if (destroyed || msg.r !== round || published) return;
    order = msg.order;
    publishLocally();
  });

  function record(id: string, msg: FinMsg): void {
    const s = seats.get(id);
    if (!s || s.result) return;
    s.done = true;
    s.total = msg.total;
    s.result = {
      total: msg.total,
      position: msg.position,
      optimal: msg.optimal,
      lost: msg.lost,
      stops: msg.stops,
      startCompound: msg.startCompound,
      compounds: msg.compounds ?? [],
      pitLaps: msg.pitLaps ?? [],
    };
    changed();
    openWindow();
    considerClosing();
  }

  function expected(): Standing[] {
    return [...seats.values()].filter((s) => !s.gone);
  }

  function allIn(): boolean {
    const exp = expected();
    return exp.length > 0 && exp.every((s) => s.result !== null);
  }

  function openWindow(): void {
    if (published || deadline !== null) return;
    if (![...seats.values()].some((s) => s.result)) return;
    deadline = graceMs;
    elapsed = 0;
    ensureTimer();
    changed();
  }

  function ensureTimer(): void {
    if (timer || destroyed || published) return;
    timer = setInterval(tick, TICK_MS);
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function tick(): void {
    if (destroyed || published || deadline === null) return;
    elapsed += TICK_MS;
    if (elapsed >= deadline) {
      if (host) closeNow();
      else changed();
      return;
    }
    changed();
  }

  function considerClosing(): void {
    if (published || !host) return;
    if (allIn()) closeNow();
  }

  function rank(): string[] {
    // Finished cars first, by LOWEST total; a tie goes to the better position,
    // then a stable id so every peer sorts identically.
    return [...seats.values()]
      .sort((a, b) => {
        const ar = a.result;
        const br = b.result;
        if (!!ar !== !!br) return ar ? -1 : 1;
        if (ar && br) {
          if (ar.total !== br.total) return ar.total - br.total;
          if (ar.position !== br.position) return ar.position - br.position;
        }
        return a.id < b.id ? -1 : 1;
      })
      .map((s) => s.id);
  }

  function publishLocally(): void {
    if (published) return;
    published = true;
    stopTimer();
    deadline = null;
    changed();
    cfg.onLadder?.();
  }

  function closeNow(): void {
    if (published || destroyed) return;
    order = rank();
    sendLad?.({ r: round, order });
    publishLocally();
  }

  return {
    standings(): Standing[] {
      const list = [...seats.values()];
      if (order) {
        const at = new Map(order.map((id, i) => [id, i]));
        list.sort((a, b) => (at.get(a.id) ?? 99) - (at.get(b.id) ?? 99));
      } else {
        // Live: whoever has done the most laps leads, ties broken by less time.
        list.sort((a, b) => b.lap - a.lap || a.total - b.total || (a.id < b.id ? -1 : 1));
      }
      return list;
    },

    ping(lap, laps, pos, compound, total): void {
      if (destroyed) return;
      const me = seats.get(cfg.selfId);
      if (me && !me.done) {
        me.lap = lap;
        me.laps = laps;
        me.pos = pos;
        me.compound = compound;
        me.total = total;
        changed();
      }
      sendSt?.({ r: round, lap, laps, pos, compound, total });
    },

    pit(lap, compound): void {
      if (destroyed) return;
      sendPit?.({ r: round, lap, compound });
    },

    finish(result): void {
      if (destroyed) return;
      const msg: FinMsg = { r: round, ...result };
      record(cfg.selfId, msg);
      sendFin?.(msg);
      if (!net) publishLocally();
    },

    settled: () => published,
    closesInMs: () => (deadline === null || published ? null : Math.max(0, deadline - elapsed)),

    setHost(isHost: boolean): void {
      host = isHost;
      if (!host) return;
      if (!published) {
        if (allIn()) return closeNow();
        if (deadline !== null) ensureTimer();
        else openWindow();
      }
      changed();
    },

    isHost: () => host,

    peerLeft(id: string): void {
      const s = seats.get(id);
      if (!s || s.gone) return;
      s.gone = true;
      changed();
      considerClosing();
    },

    closeNow,

    destroy(): void {
      destroyed = true;
      stopTimer();
      sendSt?.off();
      sendPit?.off();
      sendFin?.off();
      sendLad?.off();
    },
  };
}

/** Build the wire result from a finished game's summary. */
export function resultOf(s: {
  total: number;
  position: number;
  optimal: { total: number };
  lost: number;
  startCompound: Compound;
  calls: { lap: number; compound: Compound }[];
}): RaceResult {
  const compounds = [s.startCompound, ...s.calls.map((c) => c.compound)];
  return {
    total: s.total,
    position: s.position,
    optimal: s.optimal.total,
    lost: s.lost,
    stops: s.calls.length,
    startCompound: s.startCompound,
    compounds,
    pitLaps: s.calls.map((c) => c.lap),
  };
}
