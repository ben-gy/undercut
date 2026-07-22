// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — three races with genuine spread (principle #14). A mode changes how
 * the race PLAYS, not a single number:
 *
 *   - Sprint      24 laps, DRY and stable. No weather to read — the whole game is
 *                 the undercut vs the overcut on a degrading slick. The on-ramp.
 *   - Grand Prix  40 laps with a real RAIN FORECAST that is a genuine coin-flip in
 *                 the middle of the race. Two-stop dry territory that the rain can
 *                 rewrite. The flagship: reading the firming forecast is the game.
 *   - Deluge      52 laps, VOLATILE — the rain is likelier, can arrive early, can
 *                 dry back out (a crossover back to slicks), and a spin under the
 *                 downpour brings a safety car that makes a stop cheap. Flexibility
 *                 and reacting well is everything.
 *
 * The mode is the HOST's pick and travels frozen inside the round start
 * (main.ts's roundOpts), because it changes the race's length and its whole
 * weather character — two peers reading their own picker would be racing
 * different Grands Prix on one ladder. An id off the wire is always validated
 * through `modeOf`, never trusted raw.
 */

export interface Mode {
  id: string;
  name: string;
  blurb: string;
  /** Race distance in laps. */
  laps: number;
  /** Cars on the grid (you + the field). */
  grid: number;
  /** Does the mode ever rain? Sprint does not. */
  rainCapable: boolean;
  /** Lowest / highest the pre-race rain forecast probability can be drawn. */
  forecastLo: number;
  forecastHi: number;
  /** The rain window opens between these fractions of race distance. */
  rainStartLo: number;
  rainStartSpan: number;
  /** Peak wetness range if it rains. */
  rainPeakLo: number;
  rainPeakSpan: number;
  /** Deluge: the rain can dry back out before the flag. */
  canDryBack: boolean;
  /** Chance of a safety-car window when the rain arrives (cheaper stop). */
  safetyCar: number;
  /** Multiplier on tyre wear (a longer, harder-on-tyres race wears faster). */
  wearScale: number;
  /** Track temperature (°C) is drawn in [tempLo, tempLo+tempSpan] per race. It
   *  shifts which compound is fastest, so the optimal plan varies by seed. */
  tempLo: number;
  tempSpan: number;
}

export const MODES: readonly Mode[] = [
  {
    id: 'sprint',
    name: 'Sprint',
    blurb: '24 laps · dry · pure undercut vs overcut',
    laps: 24,
    grid: 10,
    rainCapable: false,
    forecastLo: 0,
    forecastHi: 0,
    rainStartLo: 0,
    rainStartSpan: 0,
    rainPeakLo: 0,
    rainPeakSpan: 0,
    canDryBack: false,
    safetyCar: 0,
    wearScale: 1.0,
    tempLo: 19,
    tempSpan: 30,
  },
  {
    id: 'gp',
    name: 'Grand Prix',
    blurb: '40 laps · a coin-flip rain forecast rewrites the race',
    laps: 40,
    grid: 12,
    rainCapable: true,
    forecastLo: 0.28,
    forecastHi: 0.72,
    rainStartLo: 0.38,
    rainStartSpan: 0.24,
    rainPeakLo: 0.55,
    rainPeakSpan: 0.35,
    canDryBack: false,
    safetyCar: 0.35,
    wearScale: 1.05,
    tempLo: 18,
    tempSpan: 22,
  },
  {
    id: 'deluge',
    name: 'Deluge',
    blurb: '52 laps · volatile weather · a spin brings the safety car',
    laps: 52,
    grid: 12,
    rainCapable: true,
    forecastLo: 0.4,
    forecastHi: 0.85,
    rainStartLo: 0.25,
    rainStartSpan: 0.3,
    rainPeakLo: 0.6,
    rainPeakSpan: 0.35,
    canDryBack: true,
    safetyCar: 0.6,
    wearScale: 1.12,
    tempLo: 14,
    tempSpan: 22,
  },
];

export const DEFAULT_MODE: Mode = MODES[0];

/** Validate an id off the wire or storage; unknown falls back, never undefined. */
export function modeOf(id: string | null | undefined): Mode {
  return MODES.find((m) => m.id === id) ?? DEFAULT_MODE;
}
