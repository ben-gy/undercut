/**
 * contrast.test.ts — principle #22. Undercut is a DOM broadcast-timing dashboard,
 * not a canvas, but the trap is identical: a tyre-life bar or a compound dot drawn
 * in a hue the same luminance as the steel panel behind it is THERE and INVISIBLE,
 * and on a moody dark pit-wall palette that reads as atmosphere.
 *
 * So every colour that carries meaning on the play surface must clear WCAG's 3:1
 * floor for a non-text graphic (§1.4.11) against every surface it can sit on. The
 * five compounds must ALSO be mutually distinguishable — but colour is never the
 * only cue anyway (each compound always paints its letter S/M/H/I/W and the
 * tyre-life ladder is a fill height + a text state), so this is the belt to that
 * braces. Moving the literals into palette.ts is what lets them be pinned here.
 */

import { describe, expect, it } from 'vitest';
import { ALL_MARKS, ALL_SURFACES, COMPOUND_MARKS, PALETTE, contrast } from '../src/palette';

const FLOOR = 3;

describe('every meaningful mark reads on every surface it can sit on', () => {
  for (const [name, hex] of ALL_MARKS) {
    it(`${name} clears ${FLOOR}:1 on all panels`, () => {
      for (const surface of ALL_SURFACES) {
        const ratio = contrast(hex, surface);
        expect(
          ratio,
          `${name} (${hex}) is ${ratio.toFixed(2)}:1 on ${surface} — below the ${FLOOR}:1 floor, ` +
            `so it is drawn but invisible on that panel`,
        ).toBeGreaterThanOrEqual(FLOOR);
      }
    });
  }
});

describe('body text clears the stronger text floor', () => {
  it('text is ≥4.5:1 on the ground and panels', () => {
    for (const surface of [PALETTE.ground, PALETTE.panel, PALETTE.panelHi]) {
      expect(contrast(PALETTE.text, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the five compounds are mutually distinguishable', () => {
  it('no two compounds are within a hair of the same luminance', () => {
    for (let i = 0; i < COMPOUND_MARKS.length; i++) {
      for (let j = i + 1; j < COMPOUND_MARKS.length; j++) {
        const [an, ah] = COMPOUND_MARKS[i];
        const [bn, bh] = COMPOUND_MARKS[j];
        const ratio = contrast(ah, bh);
        expect(
          ratio,
          `${an} and ${bn} are only ${ratio.toFixed(2)}:1 apart — a colour-blind or ` +
            `greyscale viewer cannot tell them apart (they still carry letters, but ` +
            `the swatch should help, not hinder)`,
        ).toBeGreaterThan(1.12);
      }
    }
  });
});
