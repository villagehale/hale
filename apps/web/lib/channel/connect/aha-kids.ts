import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { loadKidItemClassifierSkill } from '~/lib/cron/skill';
import { forceToolJson, llmTransport } from '~/lib/pipeline/structured';
import { type AhaSnapshot, calendarOverlaps } from './aha-read';

/**
 * Hard rule (Barton, VIL-417). Both wow moments are about the kids only.
 *
 * The connect-time read returns whatever the parent's calendar or mailbox
 * holds: their meetings, appointments, receipts, newsletters. None of that is
 * Hale's to mention. Before the snapshot reaches the model that writes the
 * wow line, a small fast-lane classifier reads every item with the kids'
 * names, nicknames and ages and says which ones are about the kids. Code
 * validates the answer against the ids it sent, keeps only those items, and
 * recomputes overlaps from that subset so a clash is a clash between kid
 * activities, never with a parent's meeting. When nothing kid-related is
 * left, the read is `none_for_kids` and the model writes a plain receipt.
 *
 * A keyword list did this before and got it wrong both ways ("Coffee with
 * Sebastian" from a colleague passed; "Seb 15-month checkup" did not). The
 * classifier is a port: tests inject a scripted one, production asks Haiku.
 * No classifier, or a classifier that fails, keeps nothing: the receipt is
 * plain and the reason is logged (rule #11).
 */

export interface KidContext {
  /** The kids' first names and ages as stored. */
  children: readonly { name: string; ageMonths: number | null }[];
  /** Titles of activities Hale found for this family. */
  activityTitles: readonly string[];
}

export interface KidItemsInput {
  children: readonly { name: string; ageMonths: number | null }[];
  activityTitles: readonly string[];
  items: readonly { id: string; text: string }[];
}

export interface KidItemClassifier {
  /** Returns the raw model answer. Code validates it; see {@link acceptKidItemIds}. */
  classify(input: KidItemsInput): Promise<unknown>;
}

export type KidFilterReason =
  | 'kept'
  | 'none_for_kids'
  | 'classifier_unavailable'
  | 'classifier_failed';

const verdictSchema = z.object({ kidItemIds: z.array(z.string()).default([]) }).strict();

const verdictJsonSchema = {
  type: 'object',
  properties: { kidItemIds: { type: 'array', items: { type: 'string' } } },
  required: ['kidItemIds'],
} as const;

const CLASSIFIER_MAX_TOKENS = 300;

export function createKidItemClassifier(client: AgentClient): KidItemClassifier {
  return {
    async classify(input) {
      const skill = await loadKidItemClassifierSkill();
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(input),
        toolName: 'kid_items',
        toolDescription: 'Return the ids of the items that are about the children.',
        inputJsonSchema: verdictJsonSchema,
        schema: verdictSchema,
        maxTokens: CLASSIFIER_MAX_TOKENS,
        transport: llmTransport(),
      });
      return value;
    },
  };
}

/** Only ids the classifier was handed count. Anything else in the answer is dropped. */
export function acceptKidItemIds(raw: unknown, offered: readonly string[]): Set<string> {
  const kept = new Set<string>();
  if (!raw || typeof raw !== 'object') return kept;
  const ids = (raw as { kidItemIds?: unknown }).kidItemIds;
  if (!Array.isArray(ids)) return kept;
  const allowed = new Set(offered);
  for (const id of ids) {
    if (typeof id === 'string' && allowed.has(id)) kept.add(id);
  }
  return kept;
}

export function kidItemsFor(snapshot: AhaSnapshot, context: KidContext): KidItemsInput {
  const items: { id: string; text: string }[] = [];
  snapshot.calendar.forEach((item, index) => {
    items.push({
      id: `c${index}`,
      text: [item.title, item.location ? `at ${item.location}` : ''].filter(Boolean).join(' '),
    });
  });
  snapshot.email.forEach((item, index) => {
    items.push({
      id: `e${index}`,
      text: [
        item.subject,
        item.fromName ? `from ${item.fromName}` : '',
        item.snippet ? `- ${item.snippet}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
  });
  return { children: context.children, activityTitles: context.activityTitles, items };
}

/**
 * The snapshot with every parent-only item removed. Items the read never
 * produced (failed, withheld) pass through unchanged, since there is nothing
 * to filter and the read state already says why.
 */
export async function kidRelatedAha(
  snapshot: AhaSnapshot,
  context: KidContext,
  classifier: KidItemClassifier | undefined,
): Promise<AhaSnapshot & { kidFilter: KidFilterReason }> {
  if (snapshot.read === 'failed' || snapshot.read === 'withheld') {
    return { ...snapshot, kidFilter: 'kept' };
  }
  const hadItems = snapshot.calendar.length > 0 || snapshot.email.length > 0;
  if (!hadItems) return { ...snapshot, kidFilter: 'kept' };

  const nothing = (reason: KidFilterReason): AhaSnapshot & { kidFilter: KidFilterReason } => ({
    ...snapshot,
    calendar: [],
    email: [],
    overlaps: [],
    read: 'none_for_kids',
    kidFilter: reason,
  });

  if (!classifier) {
    console.error(
      { provider: snapshot.provider },
      'aha-kids: no classifier - nothing from the source will be mentioned',
    );
    return nothing('classifier_unavailable');
  }
  const input = kidItemsFor(snapshot, context);
  let kept: Set<string>;
  try {
    kept = acceptKidItemIds(
      await classifier.classify(input),
      input.items.map((item) => item.id),
    );
  } catch (err) {
    console.error(
      { provider: snapshot.provider, err: err instanceof Error ? err.name : 'unknown' },
      'aha-kids: classifier failed - nothing from the source will be mentioned',
    );
    return nothing('classifier_failed');
  }
  const calendar = snapshot.calendar.filter((_item, index) => kept.has(`c${index}`));
  const email = snapshot.email.filter((_item, index) => kept.has(`e${index}`));
  if (calendar.length === 0 && email.length === 0) return nothing('none_for_kids');
  return {
    ...snapshot,
    calendar,
    email,
    overlaps: calendarOverlaps(calendar),
    kidFilter: 'kept',
  };
}

/**
 * What the family already told Hale about the kids: names, ages and the
 * activities Hale found for them. Read once per receipt. The family calendar
 * is not read here on purpose: it is a named privacy door (teen rows), and
 * the found activities are vocabulary enough.
 */
function monthsSince(dateOfBirth: string | null | undefined, now: Date): number | null {
  if (!dateOfBirth) return null;
  const born = new Date(`${dateOfBirth}T12:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  const months =
    (now.getUTCFullYear() - born.getUTCFullYear()) * 12 + (now.getUTCMonth() - born.getUTCMonth());
  return months < 0 ? 0 : months;
}

export async function loadKidContext(
  database: Database,
  familyId: string,
  now: Date = new Date(),
): Promise<KidContext> {
  const children = await database
    .select({
      familyId: schema.children.familyId,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const candidates = await database
    .select({ familyId: schema.villageCandidates.familyId, title: schema.villageCandidates.title })
    .from(schema.villageCandidates)
    .where(
      and(
        eq(schema.villageCandidates.familyId, familyId),
        isNull(schema.villageCandidates.supersededAt),
      ),
    );
  const own = <T extends { familyId: string }>(rows: T[]) =>
    rows.filter((row) => row.familyId === familyId);
  return {
    children: own(children)
      .filter((row) => (row.name ?? '').trim().length > 0)
      .map((row) => ({
        name: (row.name ?? '').trim(),
        ageMonths: monthsSince(row.dateOfBirth, now),
      })),
    activityTitles: own(candidates)
      .map((row) => row.title)
      .filter((title): title is string => typeof title === 'string' && title.trim().length > 0),
  };
}
