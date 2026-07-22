# Undercut

**Race strategy with no driving — call the pit windows, read the weather, beat the field on a decision.**

🎮 Play: https://undercut.benrichardson.dev

## What it is
Undercut is a motorsport strategy game where you never touch the wheel. The race
simulates forward at a watchable pace and your only verb is the **pit call**: box
now, and onto which tyre. Every place you gain or lose is down to a call you made.

The core tension is the **undercut versus the overcut** — pit early onto fresh
rubber and leapfrog a rival stuck on old tyres, or stay out on a dying set and
hope the rain comes so you pit once for wets instead of twice for slicks. Fresh
tyres are fast but a stop costs ~21s; a set pushed past its cliff falls off a
shelf; and the wrong tyre for the conditions is a disaster. Read the **track
temperature** (it decides which compound is fastest — softs love a cool track,
hards need heat) and, in the wet-capable modes, the **rain forecast**, which is a
probability that firms as the window nears, not a fact.

Solo is instant. It’s also a live head-to-head with friends over a room link, and
an async “same seed, beat my call” share.

## How to play
- **Choose your starting tyre** on the grid (the one free choice of the race).
- Watch your tyre-life bar fall, your gaps swing, and the forecast firm.
- **BOX** when the moment’s right and pick a compound. Too early wastes tyres; too
  late and they cliff. Lowest total race time wins.
- **Desktop:** `P` opens the pit menu, `1–5` pick a compound, `Space` pauses,
  `+`/`-` change the sim speed (solo). **Mobile:** big tap buttons only — no D-pad.

## Multiplayer
Live peer-to-peer for 2–6, plus async seed-share. Every peer runs the **identical
seeded race** — same weather, same track temperature, same field — over its own
pit calls, so there is no shared state to desync; you’re ranked by total race
time. You watch each other’s calls land live (a rivals strip + a pit ticker). It’s
peer-to-peer over WebRTC with **no game server** — a public signalling relay only
introduces the browsers to each other. Create a room or join by scanning the QR,
opening the link, or typing the code. If the host leaves, a survivor takes over
and the ladder still publishes.

## Tech
- Vite 6 + vanilla TypeScript
- DOM/CSS rendering (a broadcast-timing dashboard)
- Shared engine (`@ben-gy/game-engine`): P2P netcode, multi-round sessions, lobby,
  deterministic RNG, procedural audio, mobile hardening
- Vitest — 127 tests, including a balance sim (the dominant-strategy gate), a
  mechanism audit, P2P determinism, host election/transfer, rematch and contrast

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
