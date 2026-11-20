import { z } from 'zod';
import { contactsOutside, mayHideContact } from '../format/contact-shape';
import { registrationUrlAllowed } from '../signup/url';
import { publicMediaUrl } from './public-url';

/**
 * VIL-413 · the photo-facts read contract: the tool the model is handed, the bounds its
 * answer must keep, and what code keeps of it. The page is someone else's words, so
 * every field is bounded, a text field that carries a link, a phone or an email is
 * dropped whole (VIL-633, the rule calendar titles follow), and the one URL kept is a
 * public https page.
 *
 * Relative imports only, so the inbound-photo-facts eval sends this schema and grades
 * this validator as-is.
 */

export const PHOTO_FACTS_TOOL_NAME = 'photo_facts';
export const PHOTO_FACTS_TOOL_DESCRIPTION =
  'Return the facts visible on this turn photo or PDF, or kind unreadable.';
/** The extract lane thinks before it answers, and max_tokens caps both. */
export const PHOTO_FACTS_MAX_TOKENS = 1024;

const KINDS = [
  'flyer',
  'schedule',
  'registration',
  'permission_slip',
  'other',
  'unreadable',
] as const;

export type PhotoFactKind = (typeof KINDS)[number];

export interface PhotoFacts {
  kind: Exclude<PhotoFactKind, 'unreadable'>;
  title: string | null;
  venue: string | null;
  whenText: string | null;
  registrationUrl: string | null;
  childName: string | null;
  notes: string | null;
  confidence: number;
}

export interface PhotoFactsMessage {
  parentWords: string;
  now: Date;
  timeZone: string | null;
}

/** The longest text the model may copy into each field. Past a bound the read fails. */
const MAX_CHARS = {
  title: 120,
  venue: 160,
  when: 160,
  childName: 60,
  notes: 240,
  url: 2048,
} as const;

const boundedText = (max: number) => z.string().max(max).nullable();

export const photoFactsSchema = z.strictObject({
  kind: z.enum(KINDS),
  title: boundedText(MAX_CHARS.title),
  venue: boundedText(MAX_CHARS.venue),
  when_text: boundedText(MAX_CHARS.when),
  registration_url: boundedText(MAX_CHARS.url),
  child_name: boundedText(MAX_CHARS.childName),
  notes: boundedText(MAX_CHARS.notes),
  confidence: z.number().min(0).max(1),
});

export type PhotoFactsAnswer = z.infer<typeof photoFactsSchema>;

const nullableText = (maxLength: number) => ({ type: ['string', 'null'], maxLength });

export const photoFactsJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    title: nullableText(MAX_CHARS.title),
    venue: nullableText(MAX_CHARS.venue),
    when_text: nullableText(MAX_CHARS.when),
    registration_url: nullableText(MAX_CHARS.url),
    child_name: nullableText(MAX_CHARS.childName),
    notes: nullableText(MAX_CHARS.notes),
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'kind',
    'title',
    'venue',
    'when_text',
    'registration_url',
    'child_name',
    'notes',
    'confidence',
  ],
} as const;

export function inboundPhotoFactsUserMessage(input: PhotoFactsMessage): string {
  return JSON.stringify({
    parent_words: input.parentWords,
    now: input.now.toISOString(),
    timezone: input.timeZone,
  });
}

function oneLine(raw: string | null): string | null {
  const flat = raw?.replace(/\s+/g, ' ').trim();
  return flat ? flat : null;
}

/** A field that holds a way to reach someone, or may hide one, is dropped whole. */
function pageText(raw: string | null): string | null {
  const flat = oneLine(raw);
  if (!flat) return null;
  return mayHideContact(flat) || contactsOutside(flat, []).length > 0 ? null : flat;
}

/**
 * The date as the page writes it. A date and a clock are digits by nature, so the
 * "may hide a phone" digit count would drop nearly every schedule; a phone, link or
 * email that reads as one still drops the field.
 */
function pageWhen(raw: string | null): string | null {
  const flat = oneLine(raw);
  if (!flat) return null;
  return contactsOutside(flat, []).length > 0 ? null : flat;
}

function seenUrl(raw: string | null): string | null {
  const flat = oneLine(raw);
  if (!flat) return null;
  const allowed = registrationUrlAllowed(flat);
  if (!allowed.ok) return null;
  // registrationUrlAllowed admits http on loopback for the local mock form and knows
  // only some private ranges. A page on a photo is a public https name: no IPv6 literal,
  // no CGNAT, multicast or reserved address, no internal-looking host.
  return publicMediaUrl(allowed.href);
}

/**
 * Drop an unreadable page, a page with no facts left, and a URL that is not a public
 * https page.
 */
export function validateInboundPhotoFacts(raw: PhotoFactsAnswer): PhotoFacts | null {
  if (raw.kind === 'unreadable') return null;
  const title = pageText(raw.title);
  const venue = pageText(raw.venue);
  const whenText = pageWhen(raw.when_text);
  const registrationUrl = seenUrl(raw.registration_url);
  const childName = pageText(raw.child_name);
  const notes = pageText(raw.notes);
  if (!title && !venue && !whenText && !registrationUrl && !childName && !notes) return null;
  return {
    kind: raw.kind,
    title,
    venue,
    whenText,
    registrationUrl,
    childName,
    notes,
    confidence: raw.confidence,
  };
}
