// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * ui.ts — the non-game screens: shell, menu, how-to-play, about, results.
 *
 * The results screen carries two things the idea demands: EVERY player's outcome
 * with a real per-driver breakdown (principle #9 — compounds used, stops, gap to
 * the winner), and the RETROSPECTIVELY OPTIMAL line on your exact seed, so you
 * always learn what you left on the table.
 */

import { el } from './dom';
import { COMPOUND_LETTER, COMPOUND_NAME, type Compound, type Script } from './sim';
import { MODES, type Mode } from './modes';

export interface Shell {
  root: HTMLElement;
  view: HTMLElement;
  footer: HTMLElement;
}

export function mountShell(root: HTMLElement): Shell {
  root.innerHTML = '';
  const view = el('div', { class: 'main-content' });
  const footer = el('footer', { class: 'site-footer' });
  footer.innerHTML =
    'Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · ' +
    '<a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>';
  root.append(view, footer);
  return { root, view, footer };
}

function tyreChip(c: Compound, lg = false): HTMLElement {
  return el('span', { class: `chip chip-${c}${lg ? ' chip-lg' : ''}`, text: COMPOUND_LETTER[c] });
}

// ── menu ──────────────────────────────────────────────────────────────────────

export interface MenuOpts {
  mode: Mode;
  best: { pos: number; time: number } | null;
  muted: boolean;
  onMode: (m: Mode) => void;
  onSolo: () => void;
  onDaily: () => void;
  onFriends: () => void;
  onHelp: () => void;
  onAbout: () => void;
  onMute: (m: boolean) => void;
}

export function renderMenu(view: HTMLElement, o: MenuOpts): void {
  view.innerHTML = '';
  const wrap = el('div', { class: 'menu' });
  wrap.append(
    el('h1', { class: 'title', text: 'Undercut' }),
    el('p', { class: 'tagline', text: 'No driving. Just the calls that win the race.' }),
  );

  const modes = el('div', { class: 'mode-pick', role: 'group', 'aria-label': 'Race format' });
  for (const m of MODES) {
    const b = el('button', {
      class: `mode-btn${m.id === o.mode.id ? ' on' : ''}`,
      type: 'button',
      'aria-pressed': m.id === o.mode.id,
    }, [el('span', { class: 'mode-name', text: m.name }), el('span', { class: 'mode-blurb', text: m.blurb })]);
    b.addEventListener('click', () => o.onMode(m));
    modes.append(b);
  }
  wrap.append(modes);

  if (o.best) {
    wrap.append(el('div', { class: 'best', text: `Best in ${o.mode.name}: P${o.best.pos} · ${fmt(o.best.time)}` }));
  }

  const play = el('div', { class: 'menu-actions' });
  const solo = el('button', { class: 'btn btn-primary', type: 'button' }, ['Race solo']);
  const daily = el('button', { class: 'btn', type: 'button' }, ['Today’s race']);
  const friends = el('button', { class: 'btn', type: 'button' }, ['Race friends']);
  solo.addEventListener('click', o.onSolo);
  daily.addEventListener('click', o.onDaily);
  friends.addEventListener('click', o.onFriends);
  play.append(solo, daily, friends);
  wrap.append(play);

  const small = el('div', { class: 'menu-small' });
  const help = el('button', { class: 'link', type: 'button' }, ['How to play']);
  const about = el('button', { class: 'link', type: 'button' }, ['About']);
  const mute = el('button', { class: 'link', type: 'button' }, [o.muted ? 'Sound: off' : 'Sound: on']);
  help.addEventListener('click', o.onHelp);
  about.addEventListener('click', o.onAbout);
  mute.addEventListener('click', () => o.onMute(!o.muted));
  small.append(help, about, mute);
  wrap.append(small);

  view.append(wrap);
}

// ── how to play ─────────────────────────────────────────────────────────────

export function renderHelp(view: HTMLElement, back: () => void): void {
  view.innerHTML = '';
  const wrap = el('div', { class: 'sheet' });
  wrap.append(el('h2', { text: 'How to play' }));
  const p = (t: string): HTMLElement => el('p', { text: t });
  wrap.append(
    p('You don’t drive — you make the calls. The race runs itself; you decide WHEN to box and onto WHICH tyre.'),
    p('Fresh tyres are fast but a stop costs ~21s. Push a set past its cliff and it falls off a shelf — watch the tyre-life bar and your lap times.'),
    p('The track temperature (top-right) decides which compound is happiest: softs love a cool track, hards need heat. Pick your opening tyre to suit it.'),
    p('In Grand Prix and Deluge, read the RAIN forecast — it’s a probability that firms as the window nears. Slicks are hopeless in the wet, wets are slow in the dry. Bet early and win big, or react and pay for it.'),
    p('The undercut: box a lap before a rival and your fresh tyres leapfrog them. The overcut: stay out and hope they hit traffic — or that the rain comes. Lowest total race time wins.'),
  );
  const legend = el('div', { class: 'legend' });
  for (const c of ['soft', 'medium', 'hard', 'inter', 'wet'] as Compound[]) {
    legend.append(el('span', { class: 'legend-item' }, [tyreChip(c), el('span', { text: COMPOUND_NAME[c] })]));
  }
  wrap.append(el('h3', { text: 'Tyres' }), legend);
  const b = el('button', { class: 'btn', type: 'button' }, ['Back']);
  b.addEventListener('click', back);
  wrap.append(b);
  view.append(wrap);
}

// ── about ──────────────────────────────────────────────────────────────────────

export function renderAbout(view: HTMLElement, back: () => void): void {
  view.innerHTML = '';
  const wrap = el('div', { class: 'sheet' });
  wrap.append(el('h2', { text: 'About' }));
  wrap.append(
    el('p', { text: 'Undercut is a race-strategy game with no driving — every place you gain or lose is down to a call you made. Original mechanics and naming; no real series, teams, drivers, sponsors or circuits.' }),
    el('p', { html: 'Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> — one of a catalogue of small web games, tools and sites.' }),
    el('p', { text: 'Solo needs nothing but your browser. “Race friends” connects players peer-to-peer over WebRTC using a public signalling relay only to introduce browsers to each other — no game server, and no data is stored anywhere. Everyone runs the identical seeded race and you’re ranked by time.' }),
    el('p', { class: 'muted', text: 'No cookies, no tracking. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.' }),
  );
  const b = el('button', { class: 'btn', type: 'button' }, ['Back']);
  b.addEventListener('click', back);
  wrap.append(b);
  view.append(wrap);
}

// ── results ────────────────────────────────────────────────────────────────────

export interface ResultEntry {
  name: string;
  isSelf: boolean;
  total: number;
  position: number;
  compounds: Compound[];
  stops: number;
  done: boolean;
  gone: boolean;
}

export interface ResultsOpts {
  mode: Mode;
  title: string;
  yourPosition: number;
  grid: number;
  entries: ResultEntry[];
  optimal: { total: number; script: Script; position: number };
  yourTotal: number;
  best: { pos: number; time: number } | null;
  multiplayer: boolean;
  closesInMs: number | null;
  votes: string;
  startsInMs: number | null;
  canForceStart: boolean;
  tally: string;
  onAgain: () => void;
  onLobby: () => void;
  onMenu: () => void;
  onShare: () => void;
  onForceStart: () => void;
  onFeedback: (from: HTMLElement) => void;
}

export function renderResults(view: HTMLElement, o: ResultsOpts): void {
  view.innerHTML = '';
  const wrap = el('div', { class: 'results' });

  wrap.append(el('h2', { class: 'res-title', text: o.title }));
  wrap.append(el('div', { class: 'res-sub', text: `${o.mode.name} · you finished P${o.yourPosition} of ${o.grid}` }));

  // The ladder / finishing order — everyone's outcome with a real breakdown.
  const board = el('div', { class: 'res-board' });
  const leader = o.entries[0];
  for (const e of o.entries) {
    const gap = e === leader ? 'WON' : e.gone ? 'left' : !e.done ? '…' : `+${(e.total - leader.total).toFixed(1)}s`;
    const chips = el('span', { class: 'res-chips' });
    for (const c of e.compounds) chips.append(tyreChip(c));
    const row = el('div', { class: `res-row${e.isSelf ? ' me' : ''}` }, [
      el('span', { class: 'res-pos', text: `${e.position}` }),
      el('span', { class: 'res-name', text: e.isSelf ? 'You' : e.name }),
      chips,
      el('span', { class: 'res-stops', text: `${e.stops} stop${e.stops === 1 ? '' : 's'}` }),
      el('span', { class: 'res-gap', text: gap }),
    ]);
    board.append(row);
  }
  wrap.append(board);

  // The retrospective optimal — what you left on the table.
  const opt = el('div', { class: 'res-optimal' });
  const lost = Math.max(0, o.yourTotal - o.optimal.total);
  opt.append(
    el('div', { class: 'opt-h', text: lost < 0.5 ? 'You nailed the perfect line.' : `${fmt(lost)} left on the table` }),
    el('div', { class: 'opt-line' }, [el('span', { text: 'Perfect line on this seed: ' }), scriptChips(o.optimal.script)]),
    el('div', { class: 'opt-sub', text: `would have finished P${o.optimal.position}` }),
  );
  wrap.append(opt);

  if (o.multiplayer) {
    if (o.tally) wrap.append(el('div', { class: 'res-tally', text: o.tally }));
    const waiting = el('div', { class: 'res-waiting' });
    if (o.closesInMs !== null) waiting.append(el('div', { text: `Waiting for finishers… ${Math.ceil(o.closesInMs / 1000)}s` }));
    if (o.startsInMs !== null) waiting.append(el('div', { text: `Next race in ${Math.ceil(o.startsInMs / 1000)}s` }));
    if (o.votes) waiting.append(el('div', { class: 'muted', text: o.votes }));
    wrap.append(waiting);
  }

  const actions = el('div', { class: 'res-actions' });
  const again = el('button', { class: 'btn btn-primary', type: 'button' }, [o.multiplayer ? 'Play again' : 'Race again']);
  again.addEventListener('click', o.onAgain);
  actions.append(again);
  if (o.multiplayer && o.canForceStart) {
    const force = el('button', { class: 'btn', type: 'button' }, ['Start now']);
    force.addEventListener('click', o.onForceStart);
    actions.append(force);
  }
  if (o.multiplayer) {
    const lobby = el('button', { class: 'btn', type: 'button' }, ['Back to lobby']);
    lobby.addEventListener('click', o.onLobby);
    actions.append(lobby);
  }
  const share = el('button', { class: 'btn', type: 'button' }, ['Share']);
  share.addEventListener('click', o.onShare);
  const menu = el('button', { class: 'btn btn-ghost', type: 'button' }, ['Menu']);
  menu.addEventListener('click', o.onMenu);
  actions.append(share, menu);
  wrap.append(actions);

  const fb = el('button', { class: 'link results-feedback', type: 'button' }, ['Something off? Tell me']);
  fb.addEventListener('click', () => o.onFeedback(fb));
  wrap.append(fb);

  view.append(wrap);
}

function scriptChips(s: Script): HTMLElement {
  const wrap = el('span', { class: 'script' });
  wrap.append(tyreChip(s.start));
  for (const st of s.stops) {
    wrap.append(el('span', { class: 'arrow', text: `→ L${st.lap} ` }), tyreChip(st.compound));
  }
  return wrap;
}

function fmt(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
