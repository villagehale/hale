import type { Metadata } from 'next';
import { describe, expect, it } from 'vitest';
import type { PublicActivityCard } from './public-activity.js';
import { activityShareMeta } from './share-meta.js';

/**
 * The share-preview copy is what a pasted link renders as in WhatsApp/iMessage/
 * Slack. These lock the things that matter: (1) a resolved share produces
 * share-SPECIFIC copy derived from the privacy-safe payload — never the generic
 * site tagline; (2) an unresolved share (revoked/expired/no-DB → null) still
 * produces sane branded fallback copy, and (3) neither path can leak PII, because
 * only coarse area + capped title/kind are ever inputs (rule #1).
 */

const GENERIC_TAGLINE = 'the village your family lost';

function metaText(meta: Metadata): string {
  return JSON.stringify(meta).toLowerCase();
}

const AREA = 'M4L';
const FULL_NAME = 'Amelia Thompson';
const STREET = '42 Baker Street';

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

  it('sets openGraph (article, en_CA) and a summary_large_image twitter card', () => {
    const meta = activityShareMeta(card);
    expect(meta.openGraph?.title).toBe(meta.title);
    expect(meta.openGraph?.description).toBe(meta.description);
    expect((meta.openGraph as { locale?: string }).locale).toBe('en_CA');
    expect((meta.openGraph as { siteName?: string }).siteName).toBe('Hale');
    expect((meta.twitter as { card?: string })?.card).toBe('summary_large_image');
  });

  it('omits the area when the family opted out — never fabricates one', () => {
    const meta = activityShareMeta({ ...card, areaCoarse: null });
    expect(String(meta.description)).not.toContain('near');
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
    const activityMeta = activityShareMeta({
      areaCoarse: AREA,
      activity: { title: 'Family swim', kind: 'drop_in', summary: '', sourceUrl: null, coverageNote: null, endorsementCount: 2 },
    });

    const text = metaText(activityMeta);
    expect(text).not.toContain(FULL_NAME.toLowerCase());
    expect(text).not.toContain(STREET.toLowerCase());
    // The coarse FSA is the ONLY location granularity that may appear.
    expect(text).not.toContain('street');
  });
});
