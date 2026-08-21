import type { Metadata } from 'next';
import type { PublicActivityCard } from './public-activity.js';
import type { PublicPicks } from './public-picks.js';
import type { PublicWeekPlan } from './public.js';

/**
 * The share-preview metadata for the three PUBLIC artifacts (rule #1). This is
 * what a pasted /w, /picks, or /a link renders as in WhatsApp/iMessage/Slack, so
 * it must be share-SPECIFIC — the idea count and coarse area, or the pick's own
 * public title — never the generic site tagline the root layout carries.
 *
 * The inputs are ONLY the already-redacted public payloads (coarse area, safe
 * capped title/kind, aggregate count). No child name, DOB, precise location, or
 * parent identity is reachable here — they aren't in the props — so no builder
 * can leak PII by construction. A null payload (revoked/expired/no-DB) returns a
 * benign branded fallback so a dead link previews cleanly instead of crashing or
 * inheriting the generic tagline.
 *
 * The file-based `opengraph-image.tsx` per route supplies og:image via the Next
 * convention, so these builders deliberately do NOT set openGraph.images.
 */

/** Shared openGraph/twitter scaffold so every share card is Meadow-consistent. */
function shareMetadata(title: string, description: string): Metadata {
  return {
    title,
    description,
    openGraph: {
      type: 'article',
      title,
      description,
      siteName: 'Hale',
      locale: 'en_CA',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

/** " near {area}" when a coarse area is present, else "" — never fabricated. */
function nearArea(area: string | null): string {
  return area ? ` near ${area}` : '';
}

export function weekShareMeta(plan: PublicWeekPlan | null): Metadata {
  if (!plan) {
    return shareMetadata(
      'this week with Hale',
      'A handful of genuinely good local things for families to do this week, gathered by Hale.',
    );
  }

  const count = plan.activities.length;
  const noun = count === 1 ? 'idea' : 'ideas';
  const title = `${count} ${noun} for families${nearArea(plan.areaCoarse)} this week · Hale`;
  const description = `${count} genuinely good local ${noun} for families${nearArea(plan.areaCoarse)} this week — gathered by Hale, the family assistant you text.`;
  return shareMetadata(title, description);
}

export function picksShareMeta(picks: PublicPicks | null): Metadata {
  if (!picks) {
    return shareMetadata(
      "a family's village picks · Hale",
      'The local things families near here actually love — endorsed picks, gathered by Hale.',
    );
  }

  const count = picks.activities.length;
  const area = nearArea(picks.areaCoarse);
  const title =
    count === 1
      ? `1 pick a family${area} actually loves · Hale`
      : `${count} picks families${area} actually love · Hale`;
  const description = `The local things families${area} actually love — ${count} endorsed ${count === 1 ? 'pick' : 'picks'}, not an algorithm. Gathered by Hale.`;
  return shareMetadata(title, description);
}

export function activityShareMeta(card: PublicActivityCard | null): Metadata {
  if (!card) {
    return shareMetadata(
      'a local pick · Hale',
      'A genuinely good local thing for families, gathered by Hale.',
    );
  }

  const title = `${card.activity.title} · Hale`;
  const description = `A genuinely good local thing for families${nearArea(card.areaCoarse)} — shared from Hale, the family assistant you text.`;
  return shareMetadata(title, description);
}
