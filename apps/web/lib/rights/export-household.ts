import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNull, notLike, or } from 'drizzle-orm';
import { CHANNEL_SMS_NOTE_KEY_LIKE, isChannelGroupNoteKey } from '~/lib/coach/note-key';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { ExportTeenGate } from './export-memory';

/**
 * VIL-622 · what the whole household shares with Hale, in the right-to-access copy: the
 * household calendar, the threads every parent can read, and the group lists.
 *
 * Each block reads the same boundary its in-app surface draws:
 *   - the calendar is every row the household sees (`google_event_id` null), cancelled
 *     ones included with when. A mirror of one parent's Google Calendar is that parent's,
 *     so it is in their own section (export-requester.ts) and in no one else's copy;
 *   - a shared thread is every conversation that is not a parent's 1:1 text thread
 *     (isConversationVisibleToParent). The requester's own 1:1 is in their own section; a
 *     co-parent's never leaves. A turn someone removed keeps its dates, not its words;
 *   - a group list is read through `group_lists`, because its items carry no family id.
 *     A list lives in a group thread that can hold other households, so an adder is
 *     `you`, `your_household` (a seat in this family today) or `another_household`.
 *     Another household's adult is never named and their user id never leaves: their name
 *     is theirs, and this copy is a durable file that leaves the app. Null is a person
 *     Hale no longer has a row for.
 * A row about a 13+ child, or whose words name one, keeps its dates and becomes the
 * placeholder (rule #1), with `withheld: 'teen'`.
 */
export type HouseholdWithheldReason = 'teen';

export type ListPerson = 'you' | 'your_household' | 'another_household';

export interface HouseholdExport {
  calendarEvents: {
    title: string;
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    source: string;
    child: string | null;
    duty: { label: string | null; kind: string | null; role: string | null } | null;
    notes: { parking: string | null; bring: string | null } | null;
    createdAt: string;
    cancelledAt: string | null;
    withheld: HouseholdWithheldReason | null;
  }[];
  sharedThreads: {
    kind: 'ask' | 'note' | 'group';
    startedAt: string;
    turns: {
      role: 'user' | 'assistant';
      /** Null once someone removed the turn. */
      content: string | null;
      topic: string | null;
      child: string | null;
      sentAt: string;
      removedAt: string | null;
      withheld: HouseholdWithheldReason | null;
    }[];
  }[];
  groupLists: {
    name: string;
    createdBy: ListPerson | null;
    createdAt: string;
    archivedAt: string | null;
    withheld: HouseholdWithheldReason | null;
    items: {
      text: string;
      addedBy: ListPerson | null;
      addedAt: string;
      checkedAt: string | null;
      checkedBy: ListPerson | null;
      withheld: HouseholdWithheldReason | null;
    }[];
  }[];
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export async function loadHouseholdExport(
  database: Database,
  familyId: string,
  requesterUserId: string,
  gate: ExportTeenGate,
): Promise<HouseholdExport> {
  const teen = (childIds: readonly (string | null)[], texts: readonly string[]) =>
    gate.isPrivate(childIds, texts) ? ('teen' as const) : null;

  const events = schema.familyEvents;
  const eventRows = await database
    .select({
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      source: events.source,
      childId: events.childId,
      dutyOwnerLabel: events.dutyOwnerLabel,
      dutyOwnerKind: events.dutyOwnerKind,
      dutyRole: events.dutyRole,
      notes: events.notes,
      createdAt: events.createdAt,
      deletedAt: events.deletedAt,
    })
    .from(events)
    .where(and(eq(events.familyId, familyId), isNull(events.googleEventId)))
    .orderBy(asc(events.startsAt));
  const calendarEvents = eventRows.map((row) => {
    const withheld = teen(
      [row.childId],
      [row.title, row.location ?? '', row.notes?.parking ?? '', row.notes?.bring ?? ''],
    );
    const hasDuty = row.dutyOwnerKind !== null || row.dutyRole !== null;
    const hasNotes = row.notes?.parking !== undefined || row.notes?.bring !== undefined;
    return {
      title: withheld ? TEEN_REDACTED_PLACEHOLDER : row.title,
      startsAt: row.startsAt.toISOString(),
      endsAt: iso(row.endsAt),
      location: withheld ? null : row.location,
      source: row.source,
      child: gate.childName(row.childId),
      duty:
        withheld || !hasDuty
          ? null
          : { label: row.dutyOwnerLabel, kind: row.dutyOwnerKind, role: row.dutyRole },
      notes:
        withheld || !hasNotes
          ? null
          : { parking: row.notes?.parking ?? null, bring: row.notes?.bring ?? null },
      createdAt: row.createdAt.toISOString(),
      cancelledAt: iso(row.deletedAt),
      withheld,
    };
  });

  const conversations = schema.conversations;
  const messages = schema.messages;
  const turnRows = await database
    .select({
      conversationId: conversations.id,
      noteKey: conversations.noteKey,
      startedAt: conversations.createdAt,
      role: messages.role,
      content: messages.content,
      topic: messages.topic,
      childId: messages.childId,
      sentAt: messages.createdAt,
      deletedAt: messages.deletedAt,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.familyId, familyId),
        or(
          isNull(conversations.noteKey),
          notLike(conversations.noteKey, CHANNEL_SMS_NOTE_KEY_LIKE),
        ),
      ),
    )
    .orderBy(asc(conversations.createdAt), asc(conversations.id), asc(messages.createdAt));
  const threads = new Map<string, HouseholdExport['sharedThreads'][number]>();
  for (const row of turnRows) {
    let thread = threads.get(row.conversationId);
    if (!thread) {
      thread = {
        kind: row.noteKey === null ? 'ask' : isChannelGroupNoteKey(row.noteKey) ? 'group' : 'note',
        startedAt: row.startedAt.toISOString(),
        turns: [],
      };
      threads.set(row.conversationId, thread);
    }
    if (row.role === null || row.content === null || row.sentAt === null) continue;
    const withheld = teen([row.childId], [row.content]);
    thread.turns.push({
      role: row.role,
      content: row.deletedAt !== null ? null : withheld ? TEEN_REDACTED_PLACEHOLDER : row.content,
      topic: withheld ? null : row.topic,
      child: gate.childName(row.childId),
      sentAt: row.sentAt.toISOString(),
      removedAt: iso(row.deletedAt),
      withheld,
    });
  }

  const seats = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const household = new Set(seats.map((seat) => seat.userId));
  const who = (userId: string | null): ListPerson | null => {
    if (userId === null) return null;
    if (userId === requesterUserId) return 'you';
    return household.has(userId) ? 'your_household' : 'another_household';
  };

  const lists = schema.groupLists;
  const items = schema.groupListItems;
  const listRows = await database
    .select({
      listId: lists.id,
      name: lists.name,
      createdByUserId: lists.createdByUserId,
      createdAt: lists.createdAt,
      archivedAt: lists.archivedAt,
      text: items.text,
      addedByUserId: items.addedByUserId,
      addedAt: items.addedAt,
      checkedAt: items.checkedAt,
      checkedByUserId: items.checkedByUserId,
    })
    .from(lists)
    .leftJoin(items, eq(items.listId, lists.id))
    .where(eq(lists.familyId, familyId))
    .orderBy(asc(lists.createdAt), asc(lists.id), asc(items.addedAt));
  const groupLists = new Map<string, HouseholdExport['groupLists'][number]>();
  for (const row of listRows) {
    let list = groupLists.get(row.listId);
    if (!list) {
      const withheld = teen([], [row.name]);
      list = {
        name: withheld ? TEEN_REDACTED_PLACEHOLDER : row.name,
        createdBy: who(row.createdByUserId),
        createdAt: row.createdAt.toISOString(),
        archivedAt: iso(row.archivedAt),
        withheld,
        items: [],
      };
      groupLists.set(row.listId, list);
    }
    if (row.text === null || row.addedAt === null) continue;
    const withheld = teen([], [row.text]);
    list.items.push({
      text: withheld ? TEEN_REDACTED_PLACEHOLDER : row.text,
      addedBy: who(row.addedByUserId),
      addedAt: row.addedAt.toISOString(),
      checkedAt: iso(row.checkedAt),
      checkedBy: who(row.checkedByUserId),
      withheld,
    });
  }

  return {
    calendarEvents,
    sharedThreads: [...threads.values()],
    groupLists: [...groupLists.values()],
  };
}
