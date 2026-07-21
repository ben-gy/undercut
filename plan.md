# Game Plan: Undercut

## Overview
- **Name:** Undercut
- **Repo name:** undercut
- **Tagline:** Race strategy with no driving — call the pit windows, read the weather, beat the field on a decision.
- **Genre (directory category):** strategy

## Core Loop
The race runs itself forward at a watchable pace; you never drive. You start on a
compound you chose, then watch your tyre-life bar bleed, your gap to the cars
around you swing, and a **weather forecast that is a probability, not a fact**.
Your only verb is the pit call: **box now**, and onto **which** compound. Every
place you gain or lose is attributable to a call you made. The central decision is
the **undercut vs the overcut** — pit early into clean air and leapfrog a rival
while they're stuck on old rubber, or stay out on dying tyres and hope the rain
comes so you pit once for wets instead of twice for slicks. Fresh tyres are fast
but a stop costs ~21s; a tyre past its cliff falls off a shelf; the wrong tyre for
the conditions is a disaster. **Win:** finish ahead of the AI field (P1 is the
dream). **Lose:** nothing catastrophic — you just finish where your calls put you.

## Controls
- **Desktop:** number keys 1–5 pick a compound when the pit menu is open; `P`
  opens/closes the pit menu; `Space` pauses; `+`/`-` change sim speed (solo only).
- **Mobile:** big tap buttons only — **BOX** opens a compound picker (5 large
  tiles, letter-labelled S/M/H/I/W), a pause button, and a 1×/2×/4× speed toggle
  (solo). No D-pad, no joystick, nothing to reach across — a strategy game whose
  input is a tap on a decision (principle #19: a pad here would be wrong).

## Multiplayer
- **Mode:** live P2P **and** async-seed (both — the idea asks for both).
- **If live P2P — shape:** **versus.** Why versus, not co-op/shared-world: a
  pit-strategy race is a duel of *judgment* on an identical race — the whole
  payoff is "my call beat yours on the same weather." Co-op has no shared fate
  (each peer runs their own car and the difficulty is a fixed field, not a threat
  the party faces together); shared-world doesn't apply. Versus is the honest
  shape, and it's the desync-proof one below.
- **If live P2P:** players 2–6; topology **parallel same-seed race** (NOT a
  snapshot star). Every peer runs its **own** deterministic race over the seed +
  mode the host froze into the round start; no peer ever touches another peer's
  car, so there is **no shared mutable state and structurally nothing to desync**
  (exactly boxbox/lastlight/sporeline). What crosses the wire: a compact **status
  ping** (`st` — lap, position-in-field, current compound, running time) so rivals
  render live, a **pit event** (`pit` — "boxed for Inters, lap 19") so you watch
  each other's calls land in real time, and a **final result** (`fin`) plus the
  host's **ladder** (`lad`). All ≤12-byte channel names. Ranking is by **lowest
  total race time** (the clean cross-peer yardstick), tie-broken by finishing
  position then id.
  - **Room entry:** all three ways in — scan the QR, open the invite link, type
    the code (stock lobby gives all three; QR appears in the lobby).
  - **Late joiner:** `RoundInfo.seated=false` → spectator ("round in progress,
    you're in the next one"); seated next round.
  - **Host leaves:** results are BROADCAST, so a promoted survivor already holds
    every result and just publishes the ladder — host transfer is a display
    concern. Wired via `onHostChange → race.setHost`. The live race itself needs
    no host (each peer sims its own), so a mid-race host-leave never freezes a car.
  - **Fixed race rate in MP** (no fast-forward) so live races stay watchable
    together; solo keeps the speed toggle.
- **End of round → rematch (MANDATORY):** `@ben-gy/game-engine/rematch`
  (`createRounds`), never touching the room. "Play again" = a vote + a new round
  number; the host broadcasts the new seed + frozen roster. Waiting peers see a
  ready list + a **visible countdown** (quorum-start, host force-start), never
  unanimity-forever. A decliner/closed tab: the round starts without them (no
  deadlock). Host leaves on results: the promoted peer runs the rematch inheriting
  no tally. Persists across rounds: a **running match win tally**. "Back to lobby"
  ≠ leave the room.

## Juice Plan
- Procedural SFX: `blip` each lap tick past half-distance / on overtakes, `select`
  on a pit call, `powerup` when a call gains you a place, `win`/`lose` at the flag,
  `hit` on a cliff/wrong-tyre disaster. Mute persisted.
- The timing tower **animates position swaps** (rows tween up/down) — that motion
  IS the drama; an overtake flashes the row.
- Tyre-life bar is a green→amber→red **luminance** ramp (never colour-only) with a
  pulse when it hits the cliff; rain sweeps in as an animated forecast strip.
- 3-2-1-GO countdown (`countdown.ts`) with audio before lights-out.
- Screen-shake-lite: a brief flash on a disaster; all motion respects
  `prefers-reduced-motion`.

## Style Direction
**Vibe:** clean-minimal broadcast pit-wall — a timing screen, not a cockpit.
**Palette:** dark tarmac ground, steel panels, an ice-blue accent for the clock;
the five compounds are a **shape+letter+luminance** set (S red / M amber / H
white / I green / W blue) chosen to be colour-blind-safe AND ≥3:1 on the panel,
never distinguished by hue alone (always the letter).
**Theme:** dark.
**Reference feel:** a live motorsport timing tower + a strategy dashboard (feel
only, no series/team/driver/sponsor/circuit names — all original).

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** **DOM/CSS** — a dashboard (timing tower, tyre bar, forecast strip,
  pit controls). Crisp text, trivial responsive, accessible, and contrast is a
  computed-style property (no canvas probe needed).
- **Engine modules (imported, never copied):** net, rematch, turn, lobby, rng,
  sound, storage, mobile, qr (via lobby), feedback.
- **Persistence:** localStorage — mute, chosen mode, best finishing position +
  best time per mode.

## The sim (the new core — `src/sim.ts`, pure & deterministic)
Lap time = BASE + fuelPenalty(fuelFrac) + grip(compound, tyreAge, wetness) +
seededMicroNoise. Compounds: soft/medium/hard slicks (fresh-fast→slow, low→high
durability, a quadratic **cliff** past a per-set life) + inter + wet (grip curves
over wetness so the right tyre for the conditions changes as it rains). Fuel burns
down → cars get faster late. **Weather is a calibrated Bernoulli forecast:** draw
a forecast probability `p`, sample rain ~ `Bernoulli(p)` from the seed, and firm
the *displayed* p toward the truth as the event approaches — so reading the
firming forecast beats pre-committing, and a `p=40%` forecast rains ~40% of the
time (a mechanism invariant). Per-set tyre-life/wear **jitter** drawn from the
seed keeps even the dry race from being solved. `simulate(seed, mode, plan)` plays
a full race for a fixed plan (used by the balance sim + the retrospective optimal);
the live `Game` runs the same model incrementally as the player inserts stops.

## Non-Goals
- No season/championship meta this run (the idea floats it; it's the natural first
  EXPANSION_IDEAS entry). One excellent single race across 3 modes ships first.
- No live wheel-to-wheel position coupling between humans (that would need lockstep
  of pit calls and is desync-prone) — humans race the shared field independently
  and are ranked by time; live "watching" is the ping + pit-event stream.

## How To Play (player-facing copy)
You don't drive — you make the calls. Watch your tyre life fall and the weather
forecast firm, then **BOX** onto the right compound at the right lap. Pit too early
and you waste tyres; too late and they fall off a cliff. Bet on the rain and win
big, or lose it all. Lowest race time wins.
