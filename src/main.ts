// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — boot and the screen machine. Owns no game rules.
 *
 * The structural rule this file enforces is ONE ROOM PER SESSION: a `Net` is
 * created when the player enters a room and lives until they walk back to the
 * menu; every rematch happens INSIDE it via rematch.ts. Leaving and re-joining a
 * room to "reset" hands back a Trystero room mid-teardown, the mesh never forms,
 * and both players sit alone in the correct room code forever (net.ts throws on it).
 *
 * A round has a pre-race GRID step where you choose your starting tyre for free —
 * the one free tyre choice in the race. In multiplayer that choice is per-peer
 * (each car is independent) and auto-picks after a timeout so a dawdler still
 * reaches the race and, therefore, the results screen (principle #12).
 */

import '@ben-gy/game-engine/mobile.css';
import './styles/main.css';

import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createSfx } from '@ben-gy/game-engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import { clearRoomInUrl, createLobby, createRoomEntry, normalizeRoomCode, setRoomInUrl } from '@ben-gy/game-engine/lobby';
import { newSeed } from '@ben-gy/game-engine/rng';

import { Game, dailySeed, type Summary } from './game';
import { DEFAULT_MODE, MODES, modeOf, type Mode } from './modes';
import { RaceEnv, COMPOUNDS, COMPOUND_LETTER, COMPOUND_NAME, type Compound } from './sim';
import { createRace, resultOf, type Race, type Standing } from './race';
import { createPlay, type PlayView } from './play';
import { el } from './dom';
import { mountFeedback, openFeedback } from './feedback';
import { mountShell, renderAbout, renderHelp, renderMenu, renderResults, type ResultEntry } from './ui';

const SLUG = 'undercut';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const GRID_AUTOPICK_MS = 18_000;

const store = createStore(SLUG);
const sfx = createSfx(store.get('muted', false));

const root = document.getElementById('app');
if (!root) throw new Error('missing #app');
const shell = mountShell(root);

let mode: Mode = modeOf(store.get<string>('mode', DEFAULT_MODE.id));

// ── live session state ────────────────────────────────────────────────────────
let game: Game | null = null;
let play: PlayView | null = null;
let race: Race | null = null;
let resultsTimer: ReturnType<typeof setInterval> | undefined;
let gridTimer: ReturnType<typeof setTimeout> | undefined;

let net: Net | null = null;
let rounds: Rounds | null = null;
let roomCode = '';
let lastSummary: Summary | null = null;
let curRound = 0;

const wins = new Map<string, number>();
const nameById = new Map<string, string>();
const tallied = new Set<number>();

interface Best {
  pos: number;
  time: number;
}
const bestKey = (m: Mode): string => `best:${m.id}`;

function setPlaying(on: boolean): void {
  document.body.classList.toggle('playing', on);
}

function teardownRound(): void {
  play?.destroy();
  play = null;
  race?.destroy();
  race = null;
  game = null;
  if (resultsTimer) clearInterval(resultsTimer);
  resultsTimer = undefined;
  if (gridTimer) clearTimeout(gridTimer);
  gridTimer = undefined;
}

async function leaveRoom(): Promise<void> {
  rounds?.destroy();
  rounds = null;
  const n = net;
  net = null;
  roomCode = '';
  wins.clear();
  nameById.clear();
  tallied.clear();
  clearRoomInUrl();
  if (n) await n.leave();
}

// ── screens ─────────────────────────────────────────────────────────────────
function showMenu(): void {
  teardownRound();
  setPlaying(false);
  lastSummary = null;
  void leaveRoom();
  renderMenu(shell.view, {
    mode,
    best: store.get<Best | null>(bestKey(mode), null),
    muted: sfx.muted(),
    onMode: (m) => {
      mode = m;
      store.set('mode', m.id);
      showMenu();
    },
    onSolo: () => showGrid(newSeed(), mode, false),
    onDaily: () => showGrid(dailySeed(), mode, false),
    onFriends: () => showRoomEntry(),
    onHelp: () => renderHelp(shell.view, showMenu),
    onAbout: () => renderAbout(shell.view, showMenu),
    onMute: (m) => {
      sfx.setMuted(m);
      store.set('muted', m);
      showMenu();
    },
  });
}

function showRoomEntry(): void {
  teardownRound();
  setPlaying(false);
  shell.view.innerHTML = '';
  createRoomEntry({
    container: shell.view,
    title: 'Race friends',
    subtitle: 'Everyone races the identical seed. Start a room, or type a friend’s code.',
    onSubmit: (code, created) => void enterRoom(code, created),
    onCancel: showMenu,
  });
}

// ── the grid: choose your starting tyre (free) ───────────────────────────────
function suggestStart(env: RaceEnv): Compound {
  const t = env.trackTemp;
  return t <= 26 ? 'soft' : t >= 39 ? 'hard' : 'medium';
}

function showGrid(seed: number, roundMode: Mode, multiplayer: boolean, info?: RoundInfo): void {
  teardownRound();
  setPlaying(false);
  sfx.unlock();
  const env = new RaceEnv(seed, roundMode);
  const suggested = suggestStart(env);

  shell.view.innerHTML = '';
  const wrap = el('div', { class: 'grid-screen' });
  wrap.append(el('h2', { class: 'grid-h', text: 'On the grid' }));
  wrap.append(
    el('div', { class: 'grid-cond' }, [
      el('span', { class: 'gc', text: `${roundMode.name} · ${roundMode.laps} laps` }),
      el('span', { class: 'gc', text: `Track ${env.trackTemp}°C` }),
      el('span', { class: 'gc', text: roundMode.rainCapable ? forecastLabel(env) : 'Dry, stable' }),
    ]),
  );
  wrap.append(el('p', { class: 'grid-sub', text: 'Choose your starting tyre — the one free choice of the race.' }));

  const grid = el('div', { class: 'tray-grid grid-tyres' });
  for (const c of COMPOUNDS) {
    const b = el('button', {
      class: `tyre tyre-${c}${c === suggested ? ' suggested' : ''}`,
      type: 'button',
    }, [
      el('span', { class: 'tyre-letter', text: COMPOUND_LETTER[c] }),
      el('span', { class: 'tyre-name', text: COMPOUND_NAME[c] }),
      c === suggested ? el('span', { class: 'tyre-tip', text: 'suits the track' }) : el('span', {}),
    ]);
    b.addEventListener('click', () => beginRound(seed, roundMode, multiplayer, info?.round ?? 0, c, info));
    grid.append(b);
  }
  wrap.append(grid);

  if (multiplayer) {
    const note = el('div', { class: 'grid-note muted', text: 'Auto-starts soon so the race stays in sync.' });
    wrap.append(note);
    gridTimer = setTimeout(() => beginRound(seed, roundMode, multiplayer, info?.round ?? 0, suggested, info), GRID_AUTOPICK_MS);
  } else {
    const back = el('button', { class: 'btn btn-ghost', type: 'button' }, ['Back']);
    back.addEventListener('click', showMenu);
    wrap.append(back);
  }
  shell.view.append(wrap);
}

function forecastLabel(env: RaceEnv): string {
  const f = env.forecastAt(1);
  const pct = Math.round(f.p * 100);
  if (pct < 15) return 'Rain unlikely';
  return `Rain ${pct}% ${f.lap ? `~lap ${f.lap}` : ''}`.trim();
}

// ── multiplayer ─────────────────────────────────────────────────────────────
async function enterRoom(code: string, created: boolean): Promise<void> {
  teardownRound();
  sfx.unlock();
  await leaveRoom();

  roomCode = normalizeRoomCode(code);
  setRoomInUrl(roomCode);

  net = createNet(
    { appId: roomAppId(SLUG), roomId: roomCode, claimHost: created },
    {
      onHostChange: (_id, isSelf) => {
        race?.setHost(isSelf);
        repaintLobbyish();
      },
      onPeerLeave: (id) => {
        race?.peerLeft(id);
        repaintLobbyish();
      },
      onPeers: () => repaintLobbyish(),
    },
  );

  rounds = createRounds({
    net,
    playerName: myName(),
    minPlayers: MIN_PLAYERS,
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => onRoundStart(info),
    onChange: () => repaintLobbyish(),
  });

  showLobby();
}

function myName(): string {
  const existing = store.get<string>('name', '');
  if (existing) return existing;
  const name = `Driver ${1 + Math.floor(Math.random() * 99)}`;
  store.set('name', name);
  return name;
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  teardownRound();
  setPlaying(false);
  shell.view.innerHTML = '';
  createLobby({
    container: shell.view,
    net,
    rounds,
    roomCode,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    onCancel: showMenu,
  });
}

function repaintLobbyish(): void {
  if (!rounds) return;
  const state = rounds.state();
  if (state.phase === 'playing' && (play || (game && !game.over))) return;
  if (lastSummary) return showResults();
  if (!play) showLobby();
}

function onRoundStart(info: RoundInfo): void {
  lastSummary = null;
  if (!info.seated) {
    showLobby();
    return;
  }
  const opts = (info.opts ?? {}) as { mode?: string };
  const roundMode = modeOf(opts.mode);
  for (const p of info.players) nameById.set(p.id, p.name);
  showGrid(info.seed, roundMode, true, info);
}

// ── a round ─────────────────────────────────────────────────────────────────
function beginRound(seed: number, roundMode: Mode, multiplayer: boolean, round: number, start: Compound, info?: RoundInfo): void {
  teardownRound();
  curRound = round;

  const g = new Game({ seed, mode: roundMode, start });
  game = g;

  if (multiplayer && net && info) {
    race = createRace({
      net,
      round,
      seats: info.players.map((p) => ({ id: p.id, name: p.name })),
      selfId: net.selfId,
      isHost: net.isHost(),
      onChange: () => {
        play?.setRivals(race?.standings() ?? []);
        if (lastSummary) showResults();
      },
      onLadder: () => showResults(),
      onPit: (ev) => play?.addPitEvent(ev),
    });
  }

  const view = createPlay({
    game: g,
    mode: roundMode,
    multiplayer,
    sfx,
    onProgress: (lap, laps, pos, compound, total) => race?.ping(lap, laps, pos, compound, total),
    onPit: (lap, compound) => race?.pit(lap, compound),
    onFinish: (summary) => finishRun(summary),
    onMenu: showMenu,
  });
  play = view;

  shell.view.innerHTML = '';
  shell.view.appendChild(view.root);
  view.setRivals(race?.standings() ?? []);
  setPlaying(true);
}

function finishRun(summary: Summary): void {
  lastSummary = summary;
  sfx.play(summary.position === 1 ? 'win' : summary.position <= 3 ? 'coin' : 'lose');

  const key = bestKey(game!.mode);
  const prev = store.get<Best | null>(key, null);
  if (!prev || summary.position < prev.pos || (summary.position === prev.pos && summary.total < prev.time)) {
    store.set(key, { pos: summary.position, time: summary.total });
  }

  if (race) {
    race.finish(resultOf(summary));
    showResults();
    return;
  }
  showResults();
}

// ── results ─────────────────────────────────────────────────────────────────
function soloEntries(summary: Summary): ResultEntry[] {
  return summary.finish.map((e) => ({
    name: e.name,
    isSelf: e.isSelf,
    total: e.total,
    position: e.position,
    compounds: e.compoundsUsed,
    stops: e.stops,
    done: true,
    gone: false,
  }));
}

function raceEntries(list: Standing[]): ResultEntry[] {
  return list.map((s, i) => ({
    name: s.name,
    isSelf: s.isSelf,
    total: s.result?.total ?? s.total,
    position: i + 1,
    compounds: s.result?.compounds ?? [s.compound],
    stops: s.result?.stops ?? 0,
    done: s.done,
    gone: s.gone,
  }));
}

function tallyIfSettled(): void {
  if (!race || !race.settled() || tallied.has(curRound)) return;
  tallied.add(curRound);
  const done = race.standings().filter((s) => s.done && !s.gone && s.result);
  if (done.length === 0) return;
  const winner = done.reduce((a, b) => (b.result!.total < a.result!.total ? b : a));
  wins.set(winner.id, (wins.get(winner.id) ?? 0) + 1);
}

function tallyText(): string {
  if (wins.size === 0) return '';
  const parts = [...wins.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${nameById.get(id) ?? '—'} ${n}`);
  return `Match: ${parts.join(' · ')}`;
}

function showResults(): void {
  const summary = lastSummary;
  const g = game;
  if (!summary || !g) return;

  setPlaying(false);
  tallyIfSettled();

  const multiplayer = !!race;
  const state = rounds?.state();
  const votes = state
    ? state.votes.length
      ? `Ready: ${state.votes.map((v) => v.name).join(', ')} (${state.votes.length}/${state.present.length})`
      : 'Nobody has hit play again yet.'
    : '';

  const entries = multiplayer ? raceEntries(race!.standings()) : soloEntries(summary);
  const yourPos = entries.find((e) => e.isSelf)?.position ?? summary.position;

  renderResults(shell.view, {
    mode: g.mode,
    title: yourPos === 1 ? 'You won.' : summary.position === 1 ? 'You won.' : `P${yourPos}`,
    yourPosition: yourPos,
    grid: g.mode.grid,
    entries,
    optimal: summary.optimal,
    yourTotal: summary.total,
    best: store.get<Best | null>(bestKey(g.mode), null),
    multiplayer,
    closesInMs: race?.closesInMs() ?? null,
    votes,
    startsInMs: state?.startsInMs ?? null,
    canForceStart: !!state?.isHost && !!state?.canStart,
    tally: tallyText(),
    onAgain: () => {
      if (rounds) {
        rounds.finish();
        rounds.vote();
        showResults();
      } else {
        showGrid(newSeed(), g.mode, false);
      }
    },
    onLobby: () => {
      lastSummary = null;
      rounds?.finish();
      showLobby();
    },
    onMenu: showMenu,
    onShare: () => void shareRun(g, summary),
    onForceStart: () => rounds?.go(),
    onFeedback: (from) => openFeedback({ returnFocusTo: from }),
  });

  if (!resultsTimer && multiplayer) {
    resultsTimer = setInterval(() => {
      if (lastSummary) showResults();
      else if (resultsTimer) {
        clearInterval(resultsTimer);
        resultsTimer = undefined;
      }
    }, 500);
  }
}

async function shareRun(g: Game, summary: Summary): Promise<void> {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('seed', String(g.seed));
  url.searchParams.set('mode', g.mode.id);
  const text = `I finished P${summary.position} on this Undercut race (${g.mode.name}). Same seed — beat my call.`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Undercut', text, url: url.toString() });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url.toString()}`);
    window.prompt('Link copied — share it:', `${text} ${url.toString()}`);
  } catch {
    window.prompt('Copy this link:', `${text} ${url.toString()}`);
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  hardenViewport();
  mountFeedback({ build: SLUG });

  try {
    setTurnConfig(await getTurnConfig());
  } catch {
    // Fails open to STUN-only; TURN is an upgrade, never a dependency.
  }

  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const seed = params.get('seed');
  const linkMode = params.get('mode');

  if (room) {
    await enterRoom(room, false);
    return;
  }
  if (seed) {
    const n = Number(seed);
    if (Number.isFinite(n)) {
      mode = modeOf(linkMode);
      showGrid(n >>> 0, mode, false);
      return;
    }
  }
  showMenu();
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

const unlock = (): void => sfx.unlock();
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

void boot();

export { MODES };
export type { Standing };
