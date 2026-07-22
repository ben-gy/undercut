// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * play.ts — the live broadcast dashboard. You never drive; you read and you call.
 *
 * The race advances one lap at a time on a setInterval clock (never rAF — a
 * backgrounded tab freezes rAF and a race that stops when you switch tabs is a
 * dead room). Solo may fast-forward; multiplayer runs at a fixed rate so live
 * races stay watchable together (each peer's sim is deterministic, so a little
 * wall-clock skew changes nothing about the result).
 *
 * The timing tower shows YOUR race against the AI field (identical for every peer
 * on the seed). A separate rivals strip shows the other humans' live pings and a
 * ticker of their pit calls landing — "watch each other's calls in real time",
 * which is the whole social hook of the live mode.
 */

import type { Sfx } from '@ben-gy/game-engine/sound';
import { el } from './dom';
import { startCountdown, type Countdown } from './countdown';
import { Game, type Summary } from './game';
import { COMPOUNDS, COMPOUND_LETTER, COMPOUND_NAME, type Compound } from './sim';
import type { Mode } from './modes';
import type { PitEvent, Standing } from './race';

const LAP_MS = 900;
const SPEEDS = [1, 2, 4];

export interface PlayConfig {
  game: Game;
  mode: Mode;
  multiplayer: boolean;
  sfx: Sfx;
  onProgress: (lap: number, laps: number, pos: number, compound: Compound, total: number) => void;
  onPit: (lap: number, compound: Compound) => void;
  onFinish: (summary: Summary) => void;
  onMenu: () => void;
}

export interface PlayView {
  root: HTMLElement;
  setRivals(rivals: Standing[]): void;
  addPitEvent(ev: PitEvent): void;
  destroy(): void;
}

export function createPlay(cfg: PlayConfig): PlayView {
  const { game, mode, sfx } = cfg;

  let speedIdx = 0;
  let clock: ReturnType<typeof setInterval> | undefined;
  let countdown: Countdown | undefined;
  let paused = false;
  let destroyed = false;
  let finished = false;
  let trayOpen = false;
  const tickerLines: string[] = [];

  // ── DOM skeleton ────────────────────────────────────────────────────────────
  const root = el('div', { class: 'play' });

  const hud = el('div', { class: 'hud' });
  const lapEl = el('div', { class: 'hud-stat' }, [el('span', { class: 'hud-k', text: 'LAP' }), el('span', { class: 'hud-v', text: '0' })]);
  const posEl = el('div', { class: 'hud-stat' }, [el('span', { class: 'hud-k', text: 'POS' }), el('span', { class: 'hud-v', text: '—' })]);
  const tempEl = el('div', { class: 'hud-stat' }, [el('span', { class: 'hud-k', text: 'TRACK' }), el('span', { class: 'hud-v', text: `${game.env.trackTemp}°C` })]);
  hud.append(lapEl, posEl, tempEl);

  const forecast = el('div', { class: 'forecast' });

  const tower = el('div', { class: 'tower', role: 'list', 'aria-label': 'Timing tower' });

  const rivals = el('div', { class: 'rivals', hidden: !cfg.multiplayer });
  const rivalList = el('div', { class: 'rival-list' });
  const ticker = el('div', { class: 'ticker', 'aria-live': 'polite' });
  rivals.append(el('div', { class: 'rivals-h', text: 'Your rivals' }), rivalList, ticker);

  // your car panel
  const car = el('div', { class: 'car' });
  const carTop = el('div', { class: 'car-top' });
  const compChip = el('div', { class: 'chip chip-lg' });
  const carMeta = el('div', { class: 'car-meta' });
  const ageEl = el('div', { class: 'car-line', text: '' });
  const gapEl = el('div', { class: 'car-line', text: '' });
  carMeta.append(ageEl, gapEl);
  carTop.append(compChip, carMeta);
  const lifeWrap = el('div', { class: 'life' });
  const lifeBar = el('div', { class: 'life-fill' });
  const lifeLabel = el('div', { class: 'life-label', text: 'TYRE' });
  lifeWrap.append(lifeBar, lifeLabel);
  car.append(carTop, lifeWrap);

  // controls
  const controls = el('div', { class: 'controls' });
  const boxBtn = el('button', { class: 'btn btn-box', type: 'button' }, ['BOX']);
  const pauseBtn = el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Pause' }, ['❚❚']);
  const speedBtn = el('button', { class: 'btn btn-ghost', type: 'button', hidden: cfg.multiplayer }, ['1×']);
  controls.append(boxBtn, pauseBtn, speedBtn);

  // pit tray (compound picker)
  const tray = el('div', { class: 'tray', hidden: true, role: 'dialog', 'aria-label': 'Choose a tyre compound' });
  const trayGrid = el('div', { class: 'tray-grid' });
  for (const c of COMPOUNDS) {
    const b = el('button', { class: `tyre tyre-${c}`, type: 'button', 'data-c': c }, [
      el('span', { class: 'tyre-letter', text: COMPOUND_LETTER[c] }),
      el('span', { class: 'tyre-name', text: COMPOUND_NAME[c] }),
    ]);
    b.addEventListener('click', () => chooseCompound(c));
    trayGrid.append(b);
  }
  const trayCancel = el('button', { class: 'btn btn-ghost tray-cancel', type: 'button' }, ['Stay out']);
  trayCancel.addEventListener('click', () => closeTray());
  tray.append(el('div', { class: 'tray-h', text: 'Fit which tyre?' }), trayGrid, trayCancel);

  const pauseOverlay = el('div', { class: 'overlay', hidden: true });
  const pausePanel = el('div', { class: 'panel' }, [el('h2', { text: 'Paused' })]);
  const resumeBtn = el('button', { class: 'btn', type: 'button' }, ['Resume']);
  const quitBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, ['Back to menu']);
  resumeBtn.addEventListener('click', () => setPaused(false));
  quitBtn.addEventListener('click', () => {
    teardown();
    cfg.onMenu();
  });
  pausePanel.append(resumeBtn, quitBtn);
  pauseOverlay.append(pausePanel);

  root.append(hud, forecast, tower, rivals, car, controls, tray, pauseOverlay);

  // ── behaviour ─────────────────────────────────────────────────────────────
  function chooseCompound(c: Compound): void {
    game.box(c);
    sfx.play('select');
    closeTray();
    renderCar();
  }
  function openTray(): void {
    if (finished || paused) return;
    trayOpen = true;
    tray.hidden = false;
  }
  function closeTray(): void {
    trayOpen = false;
    tray.hidden = true;
  }
  boxBtn.addEventListener('click', () => (trayOpen ? closeTray() : openTray()));
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
    if (clock) restartClock();
  });

  function setPaused(p: boolean): void {
    if (finished) return;
    paused = p;
    pauseOverlay.hidden = !p;
    if (p) closeTray();
  }

  const onKey = (e: KeyboardEvent): void => {
    if (finished) return;
    if (e.key === 'p' || e.key === 'P') return void openTray();
    if (e.key === ' ') {
      e.preventDefault();
      return void setPaused(!paused);
    }
    if (e.key === 'Escape') return void (trayOpen ? closeTray() : setPaused(true));
    if (trayOpen) {
      const n = Number(e.key);
      if (n >= 1 && n <= COMPOUNDS.length) chooseCompound(COMPOUNDS[n - 1]);
    }
    if (!cfg.multiplayer && (e.key === '+' || e.key === '=')) {
      speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1);
      speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
      if (clock) restartClock();
    }
    if (!cfg.multiplayer && e.key === '-') {
      speedIdx = Math.max(0, speedIdx - 1);
      speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
      if (clock) restartClock();
    }
  };
  window.addEventListener('keydown', onKey);

  // ── the race clock ────────────────────────────────────────────────────────
  function restartClock(): void {
    if (clock) clearInterval(clock);
    clock = setInterval(onTick, LAP_MS / SPEEDS[speedIdx]);
  }

  function onTick(): void {
    if (destroyed || paused || finished) return;
    const before = game.currentCompound;
    const res = game.step();
    if (res.pitted) {
      sfx.play('powerup');
      cfg.onPit(res.lap, res.compound);
      pushTicker(`You boxed → ${COMPOUND_NAME[res.compound]} (L${res.lap})`);
    } else if (res.delta > 0) {
      sfx.play('blip');
    }
    void before;
    cfg.onProgress(res.lap, game.L, res.position, res.compound, game.liveTotal());
    render();
    if (game.over) finish();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    if (clock) clearInterval(clock);
    clock = undefined;
    closeTray();
    boxBtn.disabled = true;
    cfg.onFinish(game.summary());
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function render(): void {
    (lapEl.querySelector('.hud-v') as HTMLElement).textContent = `${Math.min(game.lapsDone + (game.over ? 0 : 1), game.L)}/${game.L}`;
    (posEl.querySelector('.hud-v') as HTMLElement).textContent = `P${game.position()}`;
    renderForecast();
    renderTower();
    renderCar();
  }

  function renderForecast(): void {
    const f = game.forecast();
    forecast.className = 'forecast';
    if (!mode.rainCapable) {
      forecast.classList.add('dry');
      forecast.innerHTML = '';
      forecast.append(el('span', { class: 'fc-k', text: 'DRY' }), el('span', { class: 'fc-v', text: 'Stable, no rain' }));
      return;
    }
    if (f.active) {
      forecast.classList.add('raining');
      const w = Math.round(game.wetnessNow() * 100);
      forecast.innerHTML = '';
      forecast.append(
        el('span', { class: 'fc-k', text: game.safetyCarNow() ? 'SAFETY CAR' : 'RAINING' }),
        el('span', { class: 'fc-v', text: `Track ${w}% wet` }),
      );
      return;
    }
    const pct = Math.round(f.p * 100);
    forecast.classList.add(pct >= 55 ? 'likely' : pct >= 25 ? 'chance' : 'dry');
    const when = f.lap !== null ? ` · ~lap ${f.lap}` : '';
    forecast.innerHTML = '';
    const meter = el('div', { class: 'fc-meter' }, [el('div', { class: 'fc-meter-fill' })]);
    (meter.firstChild as HTMLElement).style.width = `${pct}%`;
    forecast.append(
      el('span', { class: 'fc-k', text: 'RAIN' }),
      el('span', { class: 'fc-v', text: `${pct}%${when}` }),
      meter,
    );
  }

  function renderTower(): void {
    const list = game.standings();
    tower.innerHTML = '';
    for (const s of list) {
      const leader = list[0];
      const gap = s.position === 1 ? 'LEADER' : `+${(s.cum - leader.cum).toFixed(1)}s`;
      const row = el('div', { class: `trow${s.isSelf ? ' me' : ''}`, role: 'listitem' }, [
        el('span', { class: 'tpos', text: `${s.position}` }),
        el('span', { class: `chip chip-${s.compound}`, text: COMPOUND_LETTER[s.compound] }),
        el('span', { class: 'tname', text: s.isSelf ? 'You' : s.name }),
        el('span', { class: 'tgap', text: gap }),
      ]);
      tower.append(row);
    }
  }

  function renderCar(): void {
    const c = game.currentCompound;
    const pending = game.pendingBox();
    compChip.className = `chip chip-lg chip-${c}`;
    compChip.textContent = COMPOUND_LETTER[c];
    const life = game.tyreLife();
    lifeBar.style.width = `${Math.round(life * 100)}%`;
    lifeBar.className = 'life-fill ' + (life > 0.5 ? 'ok' : life > 0.22 ? 'warn' : 'danger');
    lifeLabel.textContent = life > 0.5 ? 'TYRE OK' : life > 0.22 ? 'WORN' : 'ON THE CLIFF';
    ageEl.textContent = `${COMPOUND_NAME[c]} · ${game.currentAge} laps`;
    const gaps = game.gaps();
    const parts: string[] = [];
    if (gaps.ahead !== null) parts.push(`▲ ${gaps.ahead.toFixed(1)}s`);
    if (gaps.behind !== null) parts.push(`▼ ${gaps.behind.toFixed(1)}s`);
    gapEl.textContent = parts.join('   ') || '—';
    boxBtn.textContent = pending ? `BOXING → ${COMPOUND_LETTER[pending]}` : 'BOX';
    boxBtn.classList.toggle('armed', !!pending);
    car.classList.toggle('alert', game.wrongTyre());
  }

  function pushTicker(line: string): void {
    tickerLines.unshift(line);
    if (tickerLines.length > 4) tickerLines.pop();
    ticker.innerHTML = '';
    for (const l of tickerLines) ticker.append(el('div', { class: 'tick', text: l }));
  }

  // ── public ──────────────────────────────────────────────────────────────────
  function setRivals(list: Standing[]): void {
    if (!cfg.multiplayer) return;
    rivalList.innerHTML = '';
    for (const s of list) {
      if (s.isSelf) continue;
      const st = s.gone ? 'left' : s.done ? 'done' : `L${s.lap}`;
      rivalList.append(
        el('div', { class: `rrow${s.gone ? ' gone' : ''}` }, [
          el('span', { class: `chip chip-${s.compound}`, text: COMPOUND_LETTER[s.compound] }),
          el('span', { class: 'rname', text: s.name }),
          el('span', { class: 'rst', text: st }),
        ]),
      );
    }
  }

  function addPitEvent(ev: PitEvent): void {
    pushTicker(`${ev.name} boxed → ${COMPOUND_NAME[ev.compound]} (L${ev.lap})`);
    sfx.play('blip');
  }

  function teardown(): void {
    destroyed = true;
    if (clock) clearInterval(clock);
    clock = undefined;
    countdown?.cancel();
    window.removeEventListener('keydown', onKey);
  }

  // ── boot: count in, then start the clock ─────────────────────────────────────
  render();
  countdown = startCountdown({
    container: root,
    sfx,
    onDone: () => {
      countdown = undefined;
      if (destroyed) return;
      restartClock();
    },
  });

  return {
    root,
    setRivals,
    addPitEvent,
    destroy: teardown,
  };
}
