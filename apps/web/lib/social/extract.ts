import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { parseStatedAgeBand } from '~/lib/civic/age-band';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-378 — caption to a structured spot.
 *
 * Deterministic first. A model is used only when a caller passes a client,
 * and a fact the caption does not contain is dropped. Placeholder confidence
 * stays under the alert bar unless the caption itself states an age and a date
 * or a registration URL. No parent-facing copy is produced here.
 *
 * Caption-first on purpose. Ask Hale can already hand the model an image
 * block (lib/coach/attachment-blocks.ts), but forceToolJson only accepts a
 * text user message, and Business Discovery does not give Hale a durable
 * copy of the flyer. TODO(VIL-378): when a post image is cached locally,
 * read it through that image block and drop any fact the caption and the
 * image do not both support. Do not store expiring CDN media URLs.
 */

/** The poll extracts captions. Flyer vision is not wired. */
export const FLYER_VISION = 'caption_only' as const;

export const PLACEHOLDER_CONFIDENCE_CEILING = 0.75;
export const LLM_CONFIDENCE_CEILING = 0.9;

const URL_RE = /https?:\/\/[^\s)<>"]+/gi;
const ISO_RE = /\b(20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/;

export interface ExtractedSocialSpot {
  title: string;
  description: string | null;
  ageMin: number | null;
  ageMax: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  registrationOpensAt: Date | null;
  registrationUrl: string | null;
  venueName: string | null;
  priceCents: number | null;
  capacity: number | null;
  confidence: number;
  method: 'llm' | 'placeholder';
}

const llmSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  age_min: z.number().int().nullable(),
  age_max: z.number().int().nullable(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  registration_opens_at: z.string().nullable(),
  registration_url: z.string().nullable(),
  venue_name: z.string().nullable(),
  price_cents: z.number().int().nullable(),
  capacity: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
});

const llmJsonSchema = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    age_min: { type: ['integer', 'null'] },
    age_max: { type: ['integer', 'null'] },
    starts_at: { type: ['string', 'null'] },
    ends_at: { type: ['string', 'null'] },
    registration_opens_at: { type: ['string', 'null'] },
    registration_url: { type: ['string', 'null'] },
    venue_name: { type: ['string', 'null'] },
    price_cents: { type: ['integer', 'null'] },
    capacity: { type: ['integer', 'null'] },
    confidence: { type: 'number' },
  },
  required: [
    'title',
    'description',
    'age_min',
    'age_max',
    'starts_at',
    'ends_at',
    'registration_opens_at',
    'registration_url',
    'venue_name',
    'price_cents',
    'capacity',
    'confidence',
  ],
} as const;

function yearsFromMonths(months: number): number {
  return Math.floor(months / 12);
}

function isRegistrationUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return (
      host !== 'instagram.com' && host !== 'facebook.com' && !host.endsWith('.cdninstagram.com')
    );
  } catch {
    return false;
  }
}

function firstRegistrationUrl(caption: string): string | null {
  const matches = caption.match(URL_RE) ?? [];
  return matches.find((url) => isRegistrationUrl(url)) ?? null;
}

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function extractSocialSpotPlaceholder(
  caption: string,
  fallbackTitle: string,
): ExtractedSocialSpot {
  const text = caption.trim();
  const title = text.split('\n')[0]?.trim().slice(0, 120) || fallbackTitle;
  const band = parseStatedAgeBand(text);
  const registrationUrl = firstRegistrationUrl(text);
  const iso = ISO_RE.exec(text)?.[1] ?? null;
  const dated = parseIso(iso);
  const mentionsOpen = /regist(?:er|ration)|ticket|sign[\s-]?up|opens/i.test(text);
  let confidence = text.length === 0 ? 0 : 0.35;
  if (band) confidence += 0.2;
  if (registrationUrl) confidence += 0.15;
  if (dated) confidence += 0.15;
  confidence = Math.min(confidence, PLACEHOLDER_CONFIDENCE_CEILING);

  return {
    title,
    description: text.length > 0 ? text.slice(0, 500) : null,
    ageMin: band ? yearsFromMonths(band.ageMinMonths) : null,
    ageMax: band ? yearsFromMonths(band.ageMaxMonths) : null,
    startsAt: mentionsOpen ? null : dated,
    endsAt: null,
    registrationOpensAt: mentionsOpen ? dated : null,
    registrationUrl,
    venueName: null,
    priceCents: null,
    capacity: null,
    confidence,
    method: 'placeholder',
  };
}

function corroborated(caption: string, extracted: ExtractedSocialSpot): ExtractedSocialSpot | null {
  const haystack = caption.toLowerCase();
  if (extracted.registrationUrl && !caption.includes(extracted.registrationUrl)) return null;
  if (extracted.ageMin !== null && !caption.includes(String(extracted.ageMin))) return null;
  if (extracted.ageMax !== null && !caption.includes(String(extracted.ageMax))) return null;
  const word = extracted.title
    .toLowerCase()
    .split(/\W+/)
    .find((part) => part.length >= 4);
  if (word && !haystack.includes(word)) return null;
  return {
    ...extracted,
    confidence: Math.min(extracted.confidence, LLM_CONFIDENCE_CEILING),
    method: 'llm',
  };
}

export async function extractSocialSpotWithLlm(
  caption: string,
  client: AgentClient,
  fallbackTitle: string,
): Promise<ExtractedSocialSpot> {
  const skill = await loadCronSkill('extract-social-spot');
  const { value } = await forceToolJson({
    client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: JSON.stringify({ caption }),
    toolName: 'social_spot',
    toolDescription: 'Return the kids activity stated in the caption.',
    inputJsonSchema: llmJsonSchema,
    schema: llmSchema,
    maxTokens: 1024,
  });
  const candidate: ExtractedSocialSpot = {
    title: value.title?.trim() || fallbackTitle,
    description: value.description,
    ageMin: value.age_min,
    ageMax: value.age_max,
    startsAt: parseIso(value.starts_at),
    endsAt: parseIso(value.ends_at),
    registrationOpensAt: parseIso(value.registration_opens_at),
    registrationUrl: value.registration_url,
    venueName: value.venue_name,
    priceCents: value.price_cents,
    capacity: value.capacity,
    confidence: value.confidence,
    method: 'llm',
  };
  return corroborated(caption, candidate) ?? extractSocialSpotPlaceholder(caption, fallbackTitle);
}

export async function extractSocialSpot(
  caption: string,
  fallbackTitle: string,
  deps: { client?: AgentClient | null } = {},
): Promise<ExtractedSocialSpot> {
  if (!deps.client) return extractSocialSpotPlaceholder(caption, fallbackTitle);
  try {
    return await extractSocialSpotWithLlm(caption, deps.client, fallbackTitle);
  } catch {
    return extractSocialSpotPlaceholder(caption, fallbackTitle);
  }
}
