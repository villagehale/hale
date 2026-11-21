import { describe, expect, it } from 'vitest';
import { denyTermsFromSlices } from '../../web/lib/channel/linq/group-experience/deny-terms.ts';
import {
  FIXED_COPY_LINE,
  GROUP_EXPERIENCE_READ_FIXTURES,
  GROUP_EXPERIENCE_SCENES,
  GROUP_EXPERIENCE_VOICE_FIXTURES,
  leakingLine,
} from './group-experience-fixtures.mjs';

describe('VIL-399 group experience fixtures', () => {
  it('names a suite for each of the ten Barton scenes', () => {
    expect(GROUP_EXPERIENCE_SCENES.map((scene) => scene.scene)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
    ]);
    const here = new Set(
      [...GROUP_EXPERIENCE_READ_FIXTURES, ...GROUP_EXPERIENCE_VOICE_FIXTURES].map((f) => f.scene),
    );
    for (const scene of GROUP_EXPERIENCE_SCENES) {
      if (scene.coveredBy === 'eval:group-experience') expect(here.has(scene.scene)).toBe(true);
    }
  });

  it('every privacy case can fail: a read wants private_question, a line carries secrets', () => {
    const privacyReads = GROUP_EXPERIENCE_READ_FIXTURES.filter((f) => f.privacy);
    const privacyLines = GROUP_EXPERIENCE_VOICE_FIXTURES.filter((f) => f.privacy);
    expect(privacyReads.length).toBeGreaterThan(0);
    expect(privacyLines.length).toBeGreaterThan(0);
    for (const f of privacyReads) expect(f.accept).toEqual(['private_question']);
    for (const f of privacyLines) {
      expect(f.audience).toBe('group');
      expect(f.secrets.length).toBeGreaterThan(0);
      // Each secret is something the chat actually saw, so a leak is reachable.
      for (const secret of f.secrets) {
        expect(`${f.groupSaid}`.toLowerCase()).toContain(secret.toLowerCase());
      }
      // The calibration stand-in really leaks every secret.
      for (const secret of f.secrets) expect(leakingLine(f)).toContain(secret);
    }
  });

  it("privacy lines get production's deny terms, from the chat's seeded Hale households", () => {
    for (const f of GROUP_EXPERIENCE_VOICE_FIXTURES.filter((x) => x.privacy)) {
      expect(Array.isArray(f.households)).toBe(true);
    }
    const echo = GROUP_EXPERIENCE_VOICE_FIXTURES.find(
      (f) => f.id === 'link-other-family-registration',
    );
    // That family is no Hale household: production holds no term for them, so the line
    // itself (the voice, then the judge) is what must keep their registration out.
    const deny = denyTermsFromSlices(echo.households);
    expect(deny).toEqual(['Mira', 'peanut_allergy']);
    for (const secret of echo.secrets) expect(deny).not.toContain(secret);
  });

  it('the fixed-copy stand-in carries a reply keyword', () => {
    expect(FIXED_COPY_LINE).toMatch(/reply/i);
  });
});
