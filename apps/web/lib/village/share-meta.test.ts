import type { Metadata } from 'next';
import { describe, expect, it } from 'vitest';
import type { PublicActivityCard } from './public-activity.js';
import type { PublicPicks } from './public-picks.js';
import type { PublicWeekPlan } from './public.js';
import { activityShareMeta, picksShareMeta, weekShareMeta } from './share-meta.js';

/**
 * The share-preview copy is what a pasted link renders as in WhatsApp/iMessage/
 * Slack. These lock the two things that matter: (1) a resolved share produces
 * share-SPECIFIC copy derived from the privacy-safe payload — never the generic
 * site tagline; (2) an unresolved share (revoked/expired/no-DB → null) still
 * produces sane branded fallback copy, and (3) neither path can leak PII, because
 * only coarse area + count/title/kind are ever inputs (rule #1).
 */

const GENERIC_TAGLINE = 'the village your family lost';

function metaText(meta: Metadata): string {
  return JSON.stringify(meta).toLowerCase();
}

const AREA = 'M4L';
const FULL_NAME = 'Amelia Thompson';
const STREET = '42 Baker Street';

describe('weekShareMeta', () => {
  const plan: PublicWeekPlan = {
    weekOf: '2026-06-15',
    areaCoarse: AREA,
    activities: [
      { title: 'Saturday family swim', kind: 'drop_in', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 0 },
      { title: 'Library story time', kind: 'library', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 0 },
      { title: 'Park meetup', kind: 'outdoor', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 0 },
    ],
  };

  it('derives a share-specific title with the idea count and coarse area (not the generic tagline)', () => {
    const meta = weekShareMeta(plan);
    expect(meta.title).toBe('3 ideas for families near M4L this week · Hale');
    expect(String(meta.title).toLowerCase()).not.toContain(GENERIC_TAGLINE);
    expect(meta.description).toBeTruthy();
    expect(String(meta.description)).toContain('3');
  });

  it('sets openGraph (article, en_CA) and a summary_large_image twitter card', () => {
    const meta = weekShareMeta(plan);
    expect(meta.openGraph?.title).toBe(meta.title);
    expect(meta.openGraph?.description).toBe(meta.description);
    expect((meta.openGraph as { locale?: string }).locale).toBe('en_CA');
    expect((meta.openGraph as { siteName?: string }).siteName).toBe('Village Hale');
    expect((meta.twitter as { card?: string })?.card).toBe('summary_large_image');
  });

  it('omits the area when the family opted out — never fabricates one', () => {
    const meta = weekShareMeta({ ...plan, areaCoarse: null });
    expect(meta.title).toBe('3 ideas for families this week · Hale');
    expect(String(meta.title)).not.toContain('near');
  });

  it('uses singular "idea" for a one-activity week', () => {
    const meta = weekShareMeta({ ...plan, activities: plan.activities.slice(0, 1) });
    expect(meta.title).toBe('1 idea for families near M4L this week · Hale');
  });

  it('falls back to sane branded copy for a null (revoked/expired/no-DB) plan without crashing', () => {
    const meta = weekShareMeta(null);
    expect(meta.title).toBe('this week with Hale');
    expect(String(meta.title)).not.toContain('undefined');
    expect(meta.description).toBeTruthy();
    expect((meta.twitter as { card?: string })?.card).toBe('summary_large_image');
  });
});

describe('picksShareMeta', () => {
  const picks: PublicPicks = {
    areaCoarse: AREA,
    activities: [
      { title: 'The good bakery', kind: 'other', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 3 },
      { title: 'Toddler gym', kind: 'class', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 5 },
    ],
  };

  it('derives a share-specific title with the pick count and coarse area (not the generic tagline)', () => {
    const meta = picksShareMeta(picks);
    expect(meta.title).toBe('2 picks families near M4L actually love · Hale');
    expect(String(meta.title).toLowerCase()).not.toContain(GENERIC_TAGLINE);
  });

  it('uses singular "pick" for a single-pick share', () => {
    const meta = picksShareMeta({ ...picks, activities: picks.activities.slice(0, 1) });
    expect(meta.title).toBe('1 pick a family near M4L actually loves · Hale');
  });

  it('falls back to sane branded copy for a null picks payload', () => {
    const meta = picksShareMeta(null);
    expect(meta.title).toBe("a family's village picks · Hale");
    expect(String(meta.title)).not.toContain('undefined');
    expect((meta.twitter as { card?: string })?.card).toBe('summary_large_image');
  });
});

describe('activityShareMeta', () => {
  const card: PublicActivityCard = {
    areaCoarse: AREA,
    activity: {
      title: 'Riverdale Saturday swim drop-in',
      kind: 'drop_in',
      summary: 'Parent-and-child swim at the community centre.',
      sourceUrl: null,
      coverageNote: null,
      endorsementCount: 4,
    },
  };

  it('uses the (public, capped) activity title as the share title (not the generic tagline)', () => {
    const meta = activityShareMeta(card);
    expect(meta.title).toBe('Riverdale Saturday swim drop-in · Hale');
    expect(String(meta.title).toLowerCase()).not.toContain(GENERIC_TAGLINE);
    expect(String(meta.description)).toContain('M4L');
  });

  it('falls back to sane branded copy for a null (revoked/child-attributed) card', () => {
    const meta = activityShareMeta(null);
    expect(meta.title).toBe('a local pick · Hale');
    expect(String(meta.title)).not.toContain('undefined');
    expect((meta.twitter as { card?: string })?.card).toBe('summary_large_image');
  });
});

describe('share-meta — PII safety (rule #1)', () => {
  it('never emits a full name or street: only coarse area + safe fields are ever inputs', () => {
    const weekMeta = weekShareMeta({
      weekOf: '2026-06-15',
      areaCoarse: AREA,
      activities: [
        { title: 'Family swim', kind: 'drop_in', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 0 },
      ],
    });
    const picksMeta = picksShareMeta({
      areaCoarse: AREA,
      activities: [
        { title: 'The bakery', kind: 'other', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 2 },
      ],
    });
    const activityMeta = activityShareMeta({
      areaCoarse: AREA,
      activity: { title: 'Family swim', kind: 'drop_in', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 2 },
    });

    for (const meta of [weekMeta, picksMeta, activityMeta]) {
      const text = metaText(meta);
      expect(text).not.toContain(FULL_NAME.toLowerCase());
      expect(text).not.toContain(STREET.toLowerCase());
      // The coarse FSA is the ONLY location granularity that may appear.
      expect(text).not.toContain('street');
    }
  });
});
