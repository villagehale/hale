import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type Skill, forceToolJson, pickLane } from '@hale/agent';
import { z } from 'zod';
import { contactsOutside, mayHideContact } from '../../../format/contact-shape';

/**
 * VIL-720 · THE MODEL READS WHAT TO BRING, from an email or a flyer.
 *
 * Organizers rarely label it ("don't forget shin pads", "n'oubliez pas vos patins"), and
 * matching a word like "Bring:" in code is the keyword rule in another form. So one
 * forced-tool turn (`bring-items-read`, task: extract) reads the source and returns only
 * the items it asks the family to bring for ONE event, each copied word for word. No
 * inference, no fixed copy, no length cap.
 *
 * What code keeps of the answer is decided here, and only here, so the eval grades the
 * same bytes production stores:
 *   - an item that carries a link, a phone or an email, or may hide one, is dropped whole
 *     (the rule the photo facts follow, VIL-633);
 *   - from an EMAIL, an item that is not a run of the email's own words is dropped. That is
 *     a grounding check on the model's copy against a third party's text, the same one
 *     `sourcedAddress` makes for an address: it reads no parent's words and decides no
 *     intent. It is what makes "never invent an item" true by construction for mail. A
 *     flyer arrives as pixels, so its items have no such check and rest on the read;
 *   - blank items and repeats go.
 *
 * The source is untrusted (VIL-560): the skill fences it as data, and the eval's injection
 * fixtures (run-bring-items-eval.mjs) hold the read to adding nothing a planted line asks.
 * The email body, the image and any quote of them are never returned or stored (rule #1).
 *
 * Relative imports only, so the eval imports this module as-is.
 */

export const BRING_ITEMS_SKILL = 'bring-items-read';
export const BRING_ITEMS_TOOL = 'bring_items';
export const BRING_ITEMS_TOOL_DESCRIPTION =
  'Return the things this source asks the family to bring for this one event, each copied word for word, or an empty list.';
/** The extract lane thinks before it answers, and max_tokens caps both. */
export const BRING_ITEMS_MAX_TOKENS = 1024;

export const bringItemsJsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Each thing to bring, wear or have for this event, copied from the source word for word. Empty when the source asks for nothing.',
    },
  },
  required: ['items'],
} as const;

export const bringItemsSchema = z.object({ items: z.array(z.string()) });

/** The event the items are read for. `startsAt` is ISO, or null when Hale has none. */
export interface BringItemsEvent {
  title: string;
  startsAt: string | null;
}

/** An email from the parent's own inbox: what the sentinel read, as text. */
export interface BringItemsEmail {
  kind: 'email';
  from: string;
  subject: string;
  body: string;
}

/** A flyer or screenshot the parent sent 1:1. The image rides as attachments. */
export interface BringItemsPhoto {
  kind: 'photo';
  /** What the parent typed beside it: which event they mean, never a source of items. */
  parentWords: string;
  attachments: readonly Anthropic.ContentBlockParam[];
}

export type BringItemsSource = BringItemsEmail | BringItemsPhoto;

export interface BringItemsInput {
  event: BringItemsEvent;
  source: BringItemsSource;
}

/** The user turn. Same bytes the eval replays (run-bring-items-eval.mjs). */
export function bringItemsUserMessage(input: BringItemsInput): string {
  const event = { title: input.event.title, starts_at: input.event.startsAt };
  if (input.source.kind === 'email') {
    return JSON.stringify({
      event,
      source: 'email',
      email: { from: input.source.from, subject: input.source.subject, body: input.source.body },
    });
  }
  return JSON.stringify({ event, source: 'photo', parent_words: input.source.parentWords });
}

/** Only the blocks a model can read off a flyer. A PDF is not read here (see photo.ts). */
export function bringItemsAttachments(source: BringItemsSource): Anthropic.ContentBlockParam[] {
  return source.kind === 'photo' ? source.attachments.filter((b) => b.type === 'image') : [];
}

function oneLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Letter and number runs, lowercased: case, spacing and punctuation aside. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether `item`'s words appear, in order and back to back, among `source`'s words. */
export function isRunOf(item: string, source: readonly string[]): boolean {
  const wanted = words(item);
  if (wanted.length === 0) return false;
  for (let start = 0; start + wanted.length <= source.length; start += 1) {
    if (wanted.every((w, i) => source[start + i] === w)) return true;
  }
  return false;
}

/** A field that holds a way to reach someone, or may hide one, is dropped whole. */
function carriesContact(item: string): boolean {
  return mayHideContact(item) || contactsOutside(item, []).length > 0;
}

export interface KeptBringItems {
  items: string[];
  /** Items the model returned that code would not keep (counted, never logged). */
  dropped: number;
}

/**
 * What code keeps of a reading. Pure: the reader and the eval both call it.
 */
export function keptBringItems(raw: readonly string[], source: BringItemsSource): KeptBringItems {
  const sourceWords = source.kind === 'email' ? words(`${source.subject}\n${source.body}`) : null;
  const seen = new Set<string>();
  const items: string[] = [];
  let dropped = 0;
  for (const value of raw) {
    const item = oneLine(value);
    if (item === '') continue;
    if (carriesContact(item) || (sourceWords !== null && !isRunOf(item, sourceWords))) {
      dropped += 1;
      continue;
    }
    const key = words(item).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return { items, dropped };
}

/**
 * Every ending is named (rule #11). `none` is the read finding nothing, the normal answer.
 * `unavailable` is a read that never started (no key, no skill), so nothing is counted;
 * `failed` is a read that started and broke.
 */
export type BringItemsRead =
  | { status: 'read'; items: string[]; dropped: number }
  | { status: 'none'; dropped: number }
  | { status: 'unavailable'; cause: 'no_key' | 'skill_unavailable' }
  | { status: 'failed' };

export type BringItemsReader = (input: BringItemsInput) => Promise<BringItemsRead>;

/** The outside effects a reader needs, so a test can hand in its own client and skill. */
export interface BringItemsReaderPorts {
  client: () => AgentClient;
  loadSkill: (name: string) => Promise<Skill>;
  /** Whether a model key is configured. False is `unavailable: no_key`, never a call. */
  hasKey: () => boolean;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export function createBringItemsReader(ports: BringItemsReaderPorts): BringItemsReader {
  return async (input) => {
    if (!ports.hasKey()) return { status: 'unavailable', cause: 'no_key' };
    let client: AgentClient;
    let skill: Skill;
    try {
      client = ports.client();
      skill = await ports.loadSkill(BRING_ITEMS_SKILL);
    } catch (err) {
      console.info({ outcome: 'unavailable', detail: className(err) }, 'bring items: read');
      return { status: 'unavailable', cause: 'skill_unavailable' };
    }
    try {
      const attachments = bringItemsAttachments(input.source);
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: bringItemsUserMessage(input),
        ...(attachments.length > 0 ? { attachments } : {}),
        toolName: BRING_ITEMS_TOOL,
        toolDescription: BRING_ITEMS_TOOL_DESCRIPTION,
        inputJsonSchema: bringItemsJsonSchema,
        schema: bringItemsSchema,
        maxTokens: BRING_ITEMS_MAX_TOKENS,
      });
      const kept = keptBringItems(value.items, input.source);
      return kept.items.length > 0
        ? { status: 'read', items: kept.items, dropped: kept.dropped }
        : { status: 'none', dropped: kept.dropped };
    } catch (err) {
      console.info({ outcome: 'failed', detail: className(err) }, 'bring items: read');
      return { status: 'failed' };
    }
  };
}
