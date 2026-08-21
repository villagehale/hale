import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { CalendarPlacementPayload } from '@hale/types';
import { deriveStage } from '@hale/types';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import type { BoundActivityReader } from '~/lib/channel/activity/reader';
import { findActivitiesTool, promiseActivityFollowUpTool } from '~/lib/channel/activity/tools';
import { type PlanOffer, offerFullPlanTool } from '~/lib/channel/plan/offer';
import { type ReferralShare, shareReferralLinkTool } from '~/lib/channel/referral/share';
import { frameworkGuidanceTool } from '~/lib/coach/framework-tool';
import { EXAMPLE_CHILD_ID } from '~/lib/coach/tools';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { readWeekPlan } from '~/lib/loop/queries';
import { weekWindow, zonedLocalInstant } from '~/lib/plan/spine';
import type { ChannelDraftInput, ChannelDraftPort } from './draft';

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

/** An unmistakable placeholder, never a row — examples ride the cached tool
 * definition outside message protections (rule #1; see EXAMPLE_CHILD_ID). */
const EXAMPLE_EVENT_ID = 'evt_0000000000example';

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
  /**
   * The live web-search lane and the family facts phase 0 needs, or null in a test that
   * is not exercising them. The two travel together on purpose: a finder with no reader
   * could not de-identify a query, and a reader with no finder has nothing to answer —
   * so "the web verb is wired" is one condition rather than two that can disagree.
   */
  activity: { reader: BoundActivityReader; finder: ActivityFinder } | null;
  /** Told about every action this turn actually minted. A draft is committed the moment
   * the tool returns, so a turn that fails LATER has still changed the family's queue —
   * and the router can only be honest about that if something counted (VIL-260). */
  onDraft?: (actionId: string) => void;
  /**
   * Told when the turn OFFERS a full coaching plan. The mirror image of `onDraft`: a
   * draft is a row the tool already wrote, while an offer is a row that cannot be
   * written yet — `agent_commitments.created_from` needs the outbound message id, and
   * the message is still being composed. So the offer travels out of the turn and the
   * router mints it once the transport has taken the reply (see plan/offer.ts).
   *
   * Absent in a test that is not exercising it; the tool is then not registered at all,
   * so there is no path that can report an offer nobody is listening for.
   */
  onOffer?: (offer: PlanOffer) => void;
  /**
   * Told when the turn hands the parent their own referral link. Same shape and same
   * reason as `onOffer`: the tool composes nothing that can be sent on its own, and the
   * runtime is what appends the finished block to a reply that has been fitted around
   * it. Absent in a test that is not exercising it; the verb is then not registered, so
   * there is no path that promises a parent a link nobody collected (rule #11).
   */
  onShare?: (share: ReferralShare) => void;
  /**
   * Told when the turn PROMISES to come back about an activity search. Same shape and
   * same reason as `onOffer`: the ledger row is minted against the outbound message,
   * which is still being composed, so the promise travels out of the turn and the router
   * writes it once the transport has taken the reply.
   *
   * Absent in a test that is not exercising it; the verb is then not registered at all,
   * so there is no path on which Hale can say "I'll come back to you" with nobody
   * collecting the promise (rule #11) — which is precisely the 2026-08-20 defect.
   */
  onPromise?: (promise: ActivityPromise) => void;
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
  const { familyId, reader, draftPort, onDraft, now } = args;
  let draftsThisTurn = 0;

  /** The one place a draft is minted, so the turn's ledger cannot miss one. */
  async function mint(input: ChannelDraftInput): Promise<string> {
    const { actionId } = await draftPort.draft(input);
    onDraft?.(actionId);
    return actionId;
  }

  /** Spend one unit of the turn's budget, or refuse. Counted only where a draft is
   * actually about to be minted, so a refused or unresolvable change costs nothing.
   *
   * The refusal is a sentence the model reads mid-turn, so it is a prompt: it has to
   * name the RIGHT next move, not just the limit. The overflow stays Hale's — the
   * parent confirms these two and Hale lines up the rest next message. An earlier
   * version sent them to the app for the leftovers, which is the burden handed back. */
  function claimDraftBudget(): void {
    if (draftsThisTurn >= MAX_DRAFTS_PER_TURN) {
      throw new Error(
        'I can draft at most two changes in one message. Ask the parent to confirm these two and tell them you will line up the rest — you keep the outstanding ones and continue them in your next message. Do not send them anywhere else to finish the job.',
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
    inputExamples: [{}, { weekOffset: 1 }],
    monetary: false,
    touchesChildContent: false,
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
    inputExamples: [{ eventId: EXAMPLE_EVENT_ID, date: '2026-09-15', time: '17:15' }],
    monetary: false,
    touchesChildContent: false,
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
      const actionId = await mint({
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
      'DRAFT the removal of one existing event for the parent to approve — it does NOT cancel anything. `eventId` must come from lookup_week. Never call this on a reference that matched more than one event; ask which first.',
    inputSchema: z.object({ eventId: z.string().min(1) }),
    inputExamples: [{ eventId: EXAMPLE_EVENT_ID }],
    monetary: false,
    touchesChildContent: false,
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
      const actionId = await mint({
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
    // Five arguments, three of them optional — the shape most worth showing.
    // The second example is the child-scoped form; `childId` comes from the
    // run's context, never composed (rule #1: the id here is an invented
    // placeholder, since examples are cached outside message protections).
    inputExamples: [
      { title: 'Swim lesson', date: '2026-09-15', time: '17:15' },
      {
        title: 'Dentist',
        date: '2026-09-18',
        time: '09:30',
        location: 'Main Street Dental',
        childId: EXAMPLE_CHILD_ID,
      },
    ],
    // A child-scoped placement names a child, so the guarded invoker's teen check runs
    // BEFORE this handler — a 13+ child's item cannot be drafted from a text at all
    // (rule #1/#5), which is the same refusal get_child_profile gets in the app.
    monetary: false,
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
      const actionId = await mint({
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

  const tools: RegisteredTool[] = [
    lookupWeek,
    proposeMove,
    proposeCancel,
    proposeAdd,
    // The coaching tool the skill instructs (audit find, 2026-08-12): the skill's
    // "Parenting questions are yours" section calls get_framework_guidance, and
    // until now only the WEB coach carried it — the SMS runtime would have made
    // a tool call into a void. Shared definition: ~/lib/coach/framework-tool.
    frameworkGuidanceTool(),
  ];
  if (args.villageTool) tools.push(args.villageTool);
  // The live web verb. Registered only where the lane and the reader are both wired,
  // for the same reason the offer verb waits on its collector: a search tool with no
  // way to de-identify its query is one that must not exist at all (rule #1).
  // BOTH activity verbs need the collector now, for one reason: an inline answer that
  // ships with a gap registers its own follow-up (activity/tools.ts), so a search verb
  // wired without somewhere to put that promise would hand a parent half an answer and
  // drop the debt on the floor — the exact 2026-08-20 defect, arriving through a
  // different door. The absent collector removes the VERBS rather than discarding what
  // they produce (rule #11). Nothing loses a verb by this: the only caller that wires
  // `activity` is the SMS runtime, which wires the collector too; the voice relay passes
  // `activity: null` and never had them.
  if (args.activity && args.onPromise) {
    const onPromise = args.onPromise;
    tools.push(
      findActivitiesTool({
        reader: args.activity.reader,
        finder: args.activity.finder,
        onPromise,
      }),
    );
  }
  // The promise verb, registered only where something is COLLECTING the promise. An
  // "I'll come back to you" whose registration goes nowhere is the exact sentence that
  // produced this feature: a debt no sweep can see and no digest can count. The absent
  // collector removes the VERB rather than discarding what it produces (rule #11) — and
  // the skill may only say the sentence when it can call the verb.
  if (args.onPromise && args.activity) {
    const onPromise = args.onPromise;
    tools.push(promiseActivityFollowUpTool({ reader: args.activity.reader, onPromise }));
  }
  // Registered only where something is listening. An offer whose report goes nowhere is
  // an offer the parent is told about and the ledger never hears about — a YES with
  // nothing to resolve against — so the absent collector removes the VERB rather than
  // silently discarding what it produces (rule #11).
  if (args.onOffer) tools.push(offerFullPlanTool(args.onOffer));
  // The one fact the coach holds about Hale itself. Same registration rule as the offer,
  // and the same reason: a share the runtime is not collecting is a parent told to
  // forward a message with no link in it.
  if (args.onShare) tools.push(shareReferralLinkTool(familyId, args.onShare));
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
