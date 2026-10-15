import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FollowUpPick } from './followup-note';

/**
 * WHERE A LINK GOES.
 *
 * The model never writes a URL (followup-note.ts refuses one). Code appends the page
 * the option was read off, after the composer's gates, with no label of its own. A
 * parent who wants the options that did not fit asks in the chat; those options are
 * stored on the thread under {@link ACTIVITY_HELD_TOPIC} and a later reply that names
 * one of them gets that option's page appended the same way.
 *
 * The Linq text part refuses a body over 10_000 characters (linq/transport.ts). This
 * file keeps both the wire body and the held note under that cap, dropping whole
 * options from the end rather than cutting a URL in half.
 */

/** Coach-only topic. The receipts timeline hides it; the transcript the coach re-reads does not. */
export const ACTIVITY_HELD_TOPIC = 'activity_held';

/** Same ceiling the Linq transport enforces on a text part. */
export const OUTBOUND_TEXT_MAX = 10_000;

/** The held note stays under the wire cap with room for the wrapper. */
const HELD_NOTE_MAX = 9_000;

/** A one-word stub is not a name. Matching it would attach a page the parent did not ask for. */
const MIN_NAME_CHARS = 8;

const ABSOLUTE_HTTP = /^https?:\/\/\S+$/i;

export interface HeldActivityOption {
  name: string;
  age_fit: string | null;
  when: string | null;
  price: string | null;
  registration: string | null;
  source_url: string | null;
}

/**
 * The venue's own page, or null when the pick has no absolute http(s) address.
 *
 * A retired Hale activity-share address is not a venue page. Prefer the deep pass's
 * citation (`sourceUrl`) and fall back to the shallow pick's `url`.
 */
export function venuePage(pick: { sourceUrl?: string | null; url?: string | null }): string | null {
  const raw = (pick.sourceUrl ?? pick.url ?? '').trim();
  if (!isVenuePage(raw)) return null;
  return raw;
}

/** Append each venue page on its own line. Drops a page that would push the body over the cap. */
export function withVenuePages(body: string, urls: readonly string[]): string {
  let next = body;
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url || seen.has(url) || !isVenuePage(url) || next.includes(url)) continue;
    seen.add(url);
    const candidate = `${next}\n${url}`;
    if (candidate.length > OUTBOUND_TEXT_MAX) break;
    next = candidate;
  }
  return next;
}

/**
 * The options that did not fit in the text, as JSON the coach can re-read.
 *
 * Not a sentence. Whole options only: if the next one would pass the cap, it is left off.
 * Returns null when there is nothing to remember.
 */
export function heldOptionsNote(picks: readonly FollowUpPick[]): string | null {
  const options: HeldActivityOption[] = [];
  for (const pick of picks) {
    const option: HeldActivityOption = {
      name: pick.name,
      age_fit: pick.ageFit,
      when: pick.when,
      price: pick.price,
      registration: pick.registration ?? null,
      source_url: venuePage(pick),
    };
    const serialized = JSON.stringify({ unsent_activity_options: [...options, option] });
    if (serialized.length > HELD_NOTE_MAX) break;
    options.push(option);
  }
  if (options.length === 0) return null;
  return JSON.stringify({ unsent_activity_options: options });
}

/**
 * If the reply names a held option in full, append that option's venue page.
 *
 * A partial or short name does not match. A page already in the reply is not repeated.
 */
export function attachNamedVenueLinks(
  body: string,
  held: readonly Pick<HeldActivityOption, 'name' | 'source_url'>[],
): string {
  const lower = body.toLowerCase();
  const urls: string[] = [];
  for (const option of held) {
    const name = option.name.trim();
    if (name.length < MIN_NAME_CHARS) continue;
    if (!lower.includes(name.toLowerCase())) continue;
    if (!option.source_url) continue;
    urls.push(option.source_url);
  }
  return withVenuePages(body, urls);
}

/**
 * Read the latest held-options note on this conversation and append any venue page the
 * reply named.
 *
 * A missing note is the ordinary case and returns the body unchanged. A note that cannot
 * be read is logged under `held_options_unreadable` and the reply still goes out (rule #11):
 * losing the page is a named gap, losing the reply is not.
 */
export async function foldHeldVenuePages(
  database: Database,
  conversationId: string,
  body: string,
): Promise<string> {
  try {
    const [row] = await database
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.topic, ACTIVITY_HELD_TOPIC),
          eq(schema.messages.role, 'assistant'),
          isNull(schema.messages.deletedAt),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (!row) return body;
    const held = parseHeldOptions(row.content);
    if (!held) {
      console.error(
        { conversationId, reason: 'held_options_unreadable' },
        'activity held options: the latest note could not be read - sending the reply without venue pages',
      );
      return body;
    }
    return attachNamedVenueLinks(body, held);
  } catch (err) {
    console.error(
      { err, conversationId, reason: 'held_options_unreadable' },
      'activity held options: could not read the note - sending the reply without venue pages',
    );
    return body;
  }
}

function parseHeldOptions(content: string): HeldActivityOption[] | null {
  try {
    const parsed = JSON.parse(content) as { unsent_activity_options?: unknown };
    if (!Array.isArray(parsed.unsent_activity_options)) return null;
    const options: HeldActivityOption[] = [];
    for (const row of parsed.unsent_activity_options) {
      if (!row || typeof row !== 'object') return null;
      const option = row as Record<string, unknown>;
      if (typeof option.name !== 'string') return null;
      options.push({
        name: option.name,
        age_fit: typeof option.age_fit === 'string' ? option.age_fit : null,
        when: typeof option.when === 'string' ? option.when : null,
        price: typeof option.price === 'string' ? option.price : null,
        registration: typeof option.registration === 'string' ? option.registration : null,
        source_url: typeof option.source_url === 'string' ? option.source_url : null,
      });
    }
    return options;
  } catch {
    return null;
  }
}

function isVenuePage(url: string): boolean {
  if (!ABSOLUTE_HTTP.test(url)) return false;
  return !isRetiredActivityShare(url);
}

/** A Hale host whose first path segment is the retired activity-share route. */
function isRetiredActivityShare(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const hale = host === 'villagehale.com' || host.endsWith('.villagehale.com');
  if (!hale) return false;
  const [head] = parsed.pathname.split('/').filter((part) => part.length > 0);
  return head === 'a';
}
