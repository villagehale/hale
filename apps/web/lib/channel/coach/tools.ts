import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { CalendarPlacementPayload } from '@hale/types';
import { deriveStage } from '@hale/types';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { readWeekPlan } from '~/lib/loop/queries';
import { weekWindow, zonedLocalInstant } from '~/lib/plan/spine';
import type { ChannelDraftPort } from './draft';

/**
 * VIL-221 · C2 — the schedule verbs, over text.
 *
 * Three properties are held HERE, in code, rather than asked for in the skill. The
 * skill asks too (a prompt that contradicts its guardrails is a confusing prompt), but
 * a prompt is a request and these are guarantees:
 *
 *   1. AN EVENT MUST EXIST TO BE CHANGED. Every mutating verb takes an `eventId` and
 *      re-resolves it against live, non-deleted, THIS-FAMILY rows before drafting. A
 *      model can write a plausible uuid; it cannot make `resolveEvent` return one. This
 *      is what makes "cancel the swim" un-fabricatable rather than merely discouraged,
 *      and it is the reason the eval's fabrication gate can be a hard fail.
 *
 *   2. A MOVE RE-TIMES, IT DOES NOT RE-DESCRIBE. The title, location and child come
 *      from the resolved ROW; the model supplies only the new time. There is no
 *      argument through which a move could rename a family's event, which matters most
 *      for the teen case: the model is shown a genericized title and could not restate
 *      the real one even if asked to.
 *
 *   3. TWO CHANGES PER TURN, MAXIMUM. Not a spend limit — a cognitive one. A text that
 *      mints four drafts hands the parent a numbered list they must reconcile against a
 *      message they have already scrolled past, and the approval grammar ("YES 2")
 *      resolves against an order they cannot see. The third call is refused with a
 *      sentence the model is expected to relay, not swallowed.
 *
 * TIME is family-local by construction: every verb takes `date` + `time` as the wall
 * clock the parent said out loud, and this module converts. Asking a model for a UTC
 * instant is asking it to do zone arithmetic in its head an hour either side of a DST
 * boundary, and the failure mode is a child delivered to a class at the wrong time.
 */

/** The cognitive cap the ticket sets — see property 3 above. */
export const MAX_DRAFTS_PER_TURN = 2;

/** What the strictest outbound channel may say about a private item. Matches the
 * assistant-events convention: the item's EXISTENCE is the parent's to know, its
 * content is not (rule #1). */
const PRIVATE_EVENT_WHAT = 'A private calendar item';

/**
 * One changeable thing on the family's calendar, as the tools need it: the redaction
 * inputs (`teen`, `sensitive`) travel WITH the row rather than being applied by the
 * reader, because the read and the draft want opposite projections of the same row —
 * the model must be shown a genericized title, and the executor must be handed the
 * real one.
 */
export interface ScheduleEvent {
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  childId: string | null;
  /** Age-derived at read time from the joined child's DOB — never a stored flag. */
  teen: boolean;
  sensitive: boolean;
}

/** The reads behind the verbs, injected so the tool RULES are testable without a db. */
export interface ChannelScheduleReader {
  timeZone(familyId: string): Promise<string>;
  weekPlanSummary(familyId: string, weekStart: string): Promise<string | null>;
  eventsInWeek(familyId: string, start: Date, end: Date): Promise<ScheduleEvent[]>;
  resolveEvent(familyId: string, eventId: string): Promise<ScheduleEvent | null>;
}

export interface ChannelCoachToolArgs {
  familyId: string;
  reader: ChannelScheduleReader;
  draftPort: ChannelDraftPort;
  /** The shared Village read (coach/tools.ts `searchVillageTool`), or null in a test
   * that is not exercising it. */
  villageTool: RegisteredTool | null;
  now: Date;
}

const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD in the family’s own calendar');
const wallClock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM on a 24-hour family-local clock');

/**
 * How far ahead a text may reach. Zero is the week the parent is standing in, one is
 * the next — the two weeks "move swim to Tuesday" can possibly mean. A bounded offset
 * rather than the ticket's `week_start` string on purpose: a model-authored date that
 * lands on an empty week is exactly the moment a model starts inventing, and there is
 * no date it can write here that resolves to nothing.
 */
const weekOffset = z.number().int().min(0).max(1).optional();

/**
 * The parent-facing label for an instant, in their own week: "Thu 5:15pm".
 *
 * en-US rather than the repo's usual en-CA because en-CA renders the meridiem as
 * "p.m." — three characters of a segment budget spent on punctuation, in the one place
 * this label is read (a text message).
 */
function localWhen(at: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  })
    .format(at)
    .replace(/\s/g, '')
    .toLowerCase();
  return `${weekday} ${time}`;
}

/** A private row is named only by its shape, and never by where it is (rule #1). */
function isPrivate(event: ScheduleEvent): boolean {
  return event.teen || event.sensitive;
}

export function buildChannelCoachTools(args: ChannelCoachToolArgs): RegisteredTool[] {
  const { familyId, reader, draftPort, now } = args;
  let draftsThisTurn = 0;

  /** Spend one unit of the turn's budget, or refuse. Counted only where a draft is
   * actually about to be minted, so a refused or unresolvable change costs nothing. */
  function claimDraftBudget(): void {
    if (draftsThisTurn >= MAX_DRAFTS_PER_TURN) {
      throw new Error(
        'I can draft at most two changes in one message. Tell the parent what is still outstanding and point them at the app link in your context.',
      );
    }
    draftsThisTurn += 1;
  }

  async function requireEvent(eventId: string): Promise<ScheduleEvent> {
    const event = await reader.resolveEvent(familyId, eventId);
    if (!event) {
      throw new Error(
        `Event ${eventId} is not on this family's calendar. Call lookup_week and use an eventId it returned — never one you composed.`,
      );
    }
    return event;
  }

  const lookupWeek = defineTool({
    name: 'lookup_week',
    description:
      "THIS family's week: the composed plan summary plus every calendar item that can be moved, cancelled, or referred to. Each item carries an `eventId` — the ONLY handle the propose_* tools accept. weekOffset 0 is the current week, 1 is next week.",
    inputSchema: z.object({ weekOffset }),
    handler: async (input) => {
      const timeZone = await reader.timeZone(familyId);
      const window = weekWindow(now, timeZone, 1, input.weekOffset ?? 0);
      const start = zonedLocalInstant(window.startKey, '00:00', timeZone);
      const end = zonedLocalInstant(window.dayKeys[6] as string, '23:59', timeZone);

      const [summary, events] = await Promise.all([
        reader.weekPlanSummary(familyId, window.startKey),
        reader.eventsInWeek(familyId, start, end),
      ]);

      return {
        weekStart: window.startKey,
        timeZone,
        summary,
        events: events.map((event) => ({
          eventId: event.eventId,
          what: isPrivate(event) ? PRIVATE_EVENT_WHAT : event.title,
          when: localWhen(event.startsAt, timeZone),
          where: isPrivate(event) ? null : event.location,
        })),
      };
    },
  });

  const proposeMove = defineTool({
    name: 'propose_calendar_move',
    description:
      "DRAFT a re-time of one existing event for the parent to approve — it does NOT move anything. `eventId` must come from lookup_week; `date`/`time` are the family's own wall clock. The event keeps its title, place and child.",
    inputSchema: z.object({ eventId: z.string().min(1), date: dayKey, time: wallClock }),
    handler: async (input, ctx) => {
      const event = await requireEvent(input.eventId);
      const timeZone = await reader.timeZone(familyId);
      const startsAt = zonedLocalInstant(input.date, input.time, timeZone);
      claimDraftBudget();

      const payload: CalendarPlacementPayload = {
        title: event.title,
        startsAt: startsAt.toISOString(),
        endsAt: null,
        location: event.location,
        childId: event.childId,
        privacySensitive: event.sensitive,
        reversalHandle: event.eventId,
      };
      const { actionId } = await draftPort.draft({
        familyId,
        actor: ctx.actor,
        actionType: 'calendar_move',
        payload,
        rationale: `Texted request: move to ${localWhen(startsAt, timeZone)}`,
        teenContent: event.teen,
      });
      return { drafted: true as const, actionId, newWhen: localWhen(startsAt, timeZone) };
    },
  });

  const proposeCancel = defineTool({
    name: 'propose_calendar_cancel',
    description:
      "DRAFT the removal of one existing event for the parent to approve — it does NOT cancel anything. `eventId` must come from lookup_week. Never call this on a reference that matched more than one event; ask which first.",
    inputSchema: z.object({ eventId: z.string().min(1) }),
    handler: async (input, ctx) => {
      const event = await requireEvent(input.eventId);
      const timeZone = await reader.timeZone(familyId);
      claimDraftBudget();

      const payload: CalendarPlacementPayload = {
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt?.toISOString() ?? null,
        location: event.location,
        childId: event.childId,
        privacySensitive: event.sensitive,
        reversalHandle: event.eventId,
      };
      const { actionId } = await draftPort.draft({
        familyId,
        actor: ctx.actor,
        actionType: 'calendar_cancel',
        payload,
        rationale: `Texted request: cancel the ${localWhen(event.startsAt, timeZone)} item`,
        teenContent: event.teen,
      });
      return { drafted: true as const, actionId };
    },
  });

  const proposeAdd = defineTool({
    name: 'propose_calendar_add',
    description:
      "DRAFT a new item on the family's calendar for the parent to approve — nothing is placed until they do. `date`/`time` are the family's own wall clock. Pass `childId` only when the parent named a specific child and lookup_week gave you their id.",
    inputSchema: z.object({
      title: z.string().min(1).max(120),
      date: dayKey,
      time: wallClock,
      location: z.string().max(120).optional(),
      childId: z.string().min(1).optional(),
    }),
    // A child-scoped placement names a child, so the guarded invoker's teen check runs
    // BEFORE this handler — a 13+ child's item cannot be drafted from a text at all
    // (rule #1/#5), which is the same refusal get_child_profile gets in the app.
    touchesChildContent: true,
    handler: async (input, ctx) => {
      const timeZone = await reader.timeZone(familyId);
      const startsAt = zonedLocalInstant(input.date, input.time, timeZone);
      claimDraftBudget();

      const payload: CalendarPlacementPayload = {
        title: input.title,
        startsAt: startsAt.toISOString(),
        endsAt: null,
        location: input.location ?? null,
        childId: input.childId ?? null,
        privacySensitive: false,
      };
      const { actionId } = await draftPort.draft({
        familyId,
        actor: ctx.actor,
        actionType: 'calendar_add',
        payload,
        rationale: `Texted request: add "${input.title}" on ${localWhen(startsAt, timeZone)}`,
        teenContent: false,
      });
      return { drafted: true as const, actionId, when: localWhen(startsAt, timeZone) };
    },
  });

  const tools: RegisteredTool[] = [lookupWeek, proposeMove, proposeCancel, proposeAdd];
  if (args.villageTool) tools.push(args.villageTool);
  return tools;
}

/**
 * The production reader. Two projections of family_events live behind it because the
 * verbs need both: the redaction inputs ride on the row so the tool decides what the
 * MODEL sees, while the draft keeps the real values for the executor.
 */
export function channelScheduleReader(database: Database): ChannelScheduleReader {
  return {
    timeZone: (familyId) => readFamilyTimezone(database, familyId),

    weekPlanSummary: async (familyId, weekStart) => {
      const plan = await readWeekPlan(database, familyId, weekStart);
      return plan?.summary ?? null;
    },

    eventsInWeek: async (familyId, start, end) => {
      const rows = await database
        .select(eventColumns)
        .from(schema.familyEvents)
        .leftJoin(schema.children, eq(schema.familyEvents.childId, schema.children.id))
        .where(
          and(
            eq(schema.familyEvents.familyId, familyId),
            isNull(schema.familyEvents.deletedAt),
            gte(schema.familyEvents.startsAt, start),
            lte(schema.familyEvents.startsAt, end),
          ),
        )
        .orderBy(asc(schema.familyEvents.startsAt));
      return rows.map(toScheduleEvent);
    },

    resolveEvent: async (familyId, eventId) => {
      // Family-scoped AND live: an id from another household, or one already
      // soft-deleted, resolves to null and the verb refuses (rule #1).
      const rows = await database
        .select(eventColumns)
        .from(schema.familyEvents)
        .leftJoin(schema.children, eq(schema.familyEvents.childId, schema.children.id))
        .where(
          and(
            eq(schema.familyEvents.id, eventId),
            eq(schema.familyEvents.familyId, familyId),
            isNull(schema.familyEvents.deletedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toScheduleEvent(row) : null;
    },
  };
}

const eventColumns = {
  id: schema.familyEvents.id,
  title: schema.familyEvents.title,
  startsAt: schema.familyEvents.startsAt,
  endsAt: schema.familyEvents.endsAt,
  location: schema.familyEvents.location,
  sensitive: schema.familyEvents.sensitive,
  childId: schema.familyEvents.childId,
  childDob: schema.children.dateOfBirth,
};

type EventRow = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  sensitive: boolean;
  childId: string | null;
  childDob: string | null;
};

function toScheduleEvent(row: EventRow): ScheduleEvent {
  return {
    eventId: row.id,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    location: row.location,
    childId: row.childId,
    teen: row.childDob !== null && deriveStage(row.childDob) === 'teenager',
    sensitive: row.sensitive,
  };
}
