/**
 * countdown.ts — 3, 2, 1, GO.
 *
 * A round never begins the instant the map appears (principle #15). Without
 * this, whoever happened to be looking at their screen when the host's start
 * arrived gets a free head start, and the board reads as a jump-cut.
 *
 * The AUDIO is what actually carries it — players watch the map, not the
 * overlay — so each tick plays even though the number is what you notice.
 *
 * Each peer counts locally from the moment the start message arrived, so the
 * peers are in step to within one network hop. That is fine here and would be
 * fine even if it were not: Lastlight is a parallel same-seed race with no
 * shared clock, so a few hundred milliseconds of skew changes nothing about
 * fairness — every settlement gets the same number of DAYS, not the same
 * number of seconds.
 *
 * setInterval, never rAF: a backgrounded tab freezes rAF, and a countdown that
 * silently stops when you switch tabs is a round that never starts.
 */

import type { Sfx } from '@ben-gy/game-engine/sound';

export interface Countdown {
  cancel(): void;
}

export interface CountdownConfig {
  container: HTMLElement;
  sfx?: Sfx | null;
  /** Ticks to show before GO. Default 3. */
  from?: number;
  /** Ms per tick. Default 700. */
  stepMs?: number;
  onDone: () => void;
}

export function startCountdown(cfg: CountdownConfig): Countdown {
  const from = cfg.from ?? 3;
  const stepMs = cfg.stepMs ?? 700;

  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  const num = document.createElement('div');
  num.className = 'countdown-num';
  el.appendChild(num);
  cfg.container.appendChild(el);

  let n = from;
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function paint(): void {
    num.textContent = n > 0 ? String(n) : 'GO';
    // Retrigger the pop animation by reflowing the class off and on.
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
    if (n > 0) cfg.sfx?.play('blip');
    else cfg.sfx?.play('select');
  }

  function finish(): void {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    el.remove();
    cfg.onDone();
  }

  paint();
  timer = setInterval(() => {
    n--;
    if (n < 0) return finish();
    paint();
  }, stepMs);

  return {
    cancel(): void {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      el.remove();
    },
  };
}
