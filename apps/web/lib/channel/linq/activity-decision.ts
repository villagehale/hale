import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { type GroupActivityDecision, queueGroupActivityDecision } from './family-outbound';

/**
 * A complete kid-logistics decision a parent typed in 1:1.
 *
 * Deterministic. A question, an email, a registration outcome (got in,
 * waitlisted, missed, booked), or a slot this template does not cover is
 * not a decision. The kid still has to be one of this family's children
 * before anything is queued — that check is {@link queueActivityDecisionFromReply}.
 */

const REGISTRATION = /\b(got in|wait-?list(?:ed)?|missed|booked|inscription|liste d'attente)\b/i;

const ACTIVITY = String.raw`[\p{L}][\p{L}\p{N}'’ -]{0,40}`;
const KID = String.raw`[\p{L}][\p{L}'’-]{0,30}`;
const DAY = String.raw`[\p{L}][\p{L}'’-]{1,20}`;
const TIME = String.raw`\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|h))?`;

const PICKS: readonly RegExp[] = [
  new RegExp(`^picked (${ACTIVITY}) for (${KID}), (${DAY}) at (${TIME})$`, 'iu'),
  new RegExp(
    `^(?:we(?:'ll|’ll| will)|i(?:'ll|’ll| will)) take (${ACTIVITY}) for (${KID}),? (${DAY}) at (${TIME})$`,
    'iu',
  ),
  new RegExp(`^(?:j'ai |a )?choisi (${ACTIVITY}) pour (${KID}), (${DAY}) (?:a|à) (${TIME})$`, 'iu'),
];

const PASSES: readonly RegExp[] = [
  new RegExp(`^(?:passed|pass) on (${ACTIVITY}) for (${KID})$`, 'iu'),
  new RegExp(`^(?:passé|passe) sur (${ACTIVITY}) pour (${KID})$`, 'iu'),
];

export function readGroupActivityDecision(body: string): GroupActivityDecision | null {
  const trimmed = body
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
  if (!trimmed || trimmed.includes('?') || trimmed.includes('@')) return null;
  if (REGISTRATION.test(trimmed)) return null;

  for (const pattern of PICKS) {
    const match = pattern.exec(trimmed);
    const activity = match?.[1]?.trim();
    const kid = match?.[2]?.trim();
    const day = match?.[3]?.trim();
    const time = match?.[4]?.trim();
    if (activity && kid && day && time) {
      return { decision: 'picked', activity, kid, day, time };
    }
  }
  for (const pattern of PASSES) {
    const match = pattern.exec(trimmed);
    const activity = match?.[1]?.trim();
    const kid = match?.[2]?.trim();
    if (activity && kid) return { decision: 'passed', activity, kid };
  }
  return null;
}

/**
 * Queue a 1:1 decision for the household group. The kid must be a child on
 * this family (given name, case-insensitive). Anything else is skipped.
 */
export async function queueActivityDecisionFromReply(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    originChatId: string | null;
    body: string;
    now: Date;
  },
): Promise<'queued' | 'skipped'> {
  const decision = readGroupActivityDecision(input.body);
  if (!decision) return 'skipped';
  if (typeof database.select !== 'function') return 'skipped';
  const kids = await database
    .select({ name: schema.children.name, familyId: schema.children.familyId })
    .from(schema.children)
    .where(eq(schema.children.familyId, input.familyId));
  const named = kids.find(
    (row) =>
      row.familyId === input.familyId &&
      row.name.trim().toLowerCase() === decision.kid.toLowerCase(),
  );
  if (!named) return 'skipped';
  return queueGroupActivityDecision(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    originChatId: input.originChatId,
    decision: { ...decision, kid: named.name.trim() },
    now: input.now,
  });
}
