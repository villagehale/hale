import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { teenChildIds } from '~/lib/channel/role-scope';

/**
 * VIL-570. Which calendar changes may become a 1:1 notice, and what the writer is told.
 *
 * Only an event Hale already tracks as the kids' may be spoken about: a live
 * `family_events` mirror of it whose `kid_verdict_id` points at a `kid` verdict (VIL-548).
 * The connector sweep alerts before it mirrors, so the copy read here is the one from the
 * previous pass, which is what still carries the title and verdict of an event Google now
 * sends back as a bare tombstone.
 *
 * A teenager's event never reaches the parent from here (rule #1): the deterministic age
 * gate reads each child's date of birth, and a kid verdict tied to no child is held when
 * the family has a teenager at all.
 */

export type KidNoticeGate =
  | { cleared: true; title: string; kidName: string | null }
  | { cleared: false; why: 'not_kid_tracked' | 'teen_held' };

const NOT_TRACKED: KidNoticeGate = { cleared: false, why: 'not_kid_tracked' };

export async function readKidNoticeGates(
  database: Database,
  input: { familyId: string; integrationId: string; now: Date },
  eventIds: readonly string[],
): Promise<Map<string, KidNoticeGate>> {
  const gates = new Map<string, KidNoticeGate>(eventIds.map((id) => [id, NOT_TRACKED]));
  if (eventIds.length === 0) return gates;
  const events = schema.familyEvents;
  const verdicts = schema.kidRelevanceVerdicts;
  const [rows, children] = await Promise.all([
    database
      .select({
        eventId: events.googleEventId,
        title: events.title,
        eventChildId: events.childId,
        verdict: verdicts.verdict,
        teen: verdicts.teen,
        verdictChildId: verdicts.childId,
      })
      .from(events)
      .innerJoin(verdicts, eq(events.kidVerdictId, verdicts.id))
      .where(
        and(
          eq(events.familyId, input.familyId),
          eq(events.integrationId, input.integrationId),
          inArray(events.googleEventId, [...new Set(eventIds)]),
          isNull(events.deletedAt),
        ),
      ),
    database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId)),
  ]);
  const teens = teenChildIds(children, input.now);
  for (const row of rows) {
    if (row.eventId === null || row.verdict !== 'kid') continue;
    const childId = row.verdictChildId ?? row.eventChildId;
    const teen = row.teen || (childId === null ? teens.size > 0 : teens.has(childId));
    if (teen) {
      gates.set(row.eventId, { cleared: false, why: 'teen_held' });
      continue;
    }
    const kid = childId === null ? undefined : children.find((child) => child.id === childId);
    gates.set(row.eventId, { cleared: true, title: row.title, kidName: kid?.name ?? null });
  }
  return gates;
}

/** The parent's own title, made safe to hand the writer: one line, no mailbox, bounded. */
const NOTICE_TITLE_MAX = 80;

export function kidNoticeTitle(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.includes('@')) return '';
  return text.length <= NOTICE_TITLE_MAX ? text : `${text.slice(0, NOTICE_TITLE_MAX - 3)}...`;
}

/**
 * Keyed on what a parent plans around (status, start, end, title) and never on Google's
 * `updated` stamp, so a description or attendee edit re-delivered by the sync claims the
 * key already spent. The material is hashed: the ledger never carries the title.
 */
export function kidNoticeDedupeKey(
  integrationId: string,
  subject: string,
  members: ReadonlyArray<{ status: string; startMs: number; endMs: number; title: string }>,
): string {
  const material = members
    .map((m) => `${m.status}|${m.startMs}|${m.endMs}|${m.title}`)
    .sort()
    .join('\n');
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 24);
  return `calendar_kid_notice:${integrationId}:${subject}:${digest}`;
}

export const KID_NOTICE_PURPOSE = 'calendar_kid_change';
