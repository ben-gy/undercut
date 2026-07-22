// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * palette.ts — every colour that carries meaning, in one place, so the contrast
 * test (principle #22) can hold each one to a floor.
 *
 * Undercut is a DOM broadcast-timing dashboard, not a canvas, but the trap is the
 * same: a tyre-life bar or a compound dot drawn in a hue the same luminance as the
 * steel panel behind it is *there* and *invisible*, and on a moody dark pit-wall
 * palette that reads as atmosphere. So nothing here is distinguished by hue alone:
 *
 *   - the five COMPOUNDS are a letter (S/M/H/I/W) + a luminance + a hue, so they
 *     survive colour blindness and greyscale (the letter is always painted);
 *   - the tyre-life ladder green→amber→red is a LUMINANCE ramp paired with a
 *     fill height and a text state.
 *
 * The literals live here (not inline in the renderer) precisely so they can be
 * pinned by contrast.test.ts.
 */

export const PALETTE = {
  /** The page — dark tarmac. */
  ground: '#0d1014',
  /** A panel/card sitting on the ground. */
  panel: '#191f26',
  /** A raised panel (a timing row, the pit tray). */
  panelHi: '#232b34',
  /** The dark track a bar's fill is painted on. */
  barTrack: '#0c0f13',
  /** A hairline between panels. */
  edge: '#39424d',

  text: '#eef2f6',
  textDim: '#9fabb8',

  // ── the tyre-life ladder (fresh → worn → cliff), a luminance ramp ──────────
  good: '#3ad07e', // fresh / plenty of life
  warn: '#f6b62e', // worn — a judgement call
  danger: '#ff6a5c', // over the cliff — box now or bleed time

  /** Ice-blue accent for the clock, the pit window and interactive affordances. */
  accent: '#4bc6e8',
  /** The "you" row highlight tint text. */
  self: '#ffd24a',

  // ── the five compounds — hue AND luminance apart, always with a letter ─────
  soft: '#ff5d5d', // S — fastest, shortest life
  medium: '#f4c53a', // M — the balanced default
  hard: '#e6ecf2', // H — slowest, longest life
  inter: '#42d67a', // I — the crossover tyre
  wet: '#4aa6ff', // W — full wet
} as const;

/** Colours that carry meaning and must read on the panels they sit on. */
export const ALL_MARKS: ReadonlyArray<readonly [string, string]> = [
  ['good/fresh', PALETTE.good],
  ['warn/worn', PALETTE.warn],
  ['danger/cliff', PALETTE.danger],
  ['accent', PALETTE.accent],
  ['self', PALETTE.self],
  ['soft', PALETTE.soft],
  ['medium', PALETTE.medium],
  ['hard', PALETTE.hard],
  ['inter', PALETTE.inter],
  ['wet', PALETTE.wet],
  ['text', PALETTE.text],
  ['textDim', PALETTE.textDim],
];

/** Every background a mark can be painted on. */
export const ALL_SURFACES: ReadonlyArray<string> = [
  PALETTE.ground,
  PALETTE.panel,
  PALETTE.panelHi,
  PALETTE.barTrack,
];

/** The tyre-life ladder — every state a set can read as, in ramp order. */
export const TYRE_LADDER: ReadonlyArray<readonly [string, string]> = [
  ['fresh', PALETTE.good],
  ['worn', PALETTE.warn],
  ['cliff', PALETTE.danger],
];

/** The compound swatches, which must also be mutually distinguishable. */
export const COMPOUND_MARKS: ReadonlyArray<readonly [string, string]> = [
  ['soft', PALETTE.soft],
  ['medium', PALETTE.medium],
  ['hard', PALETTE.hard],
  ['inter', PALETTE.inter],
  ['wet', PALETTE.wet],
];

// ── WCAG maths ────────────────────────────────────────────────────────────────

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
