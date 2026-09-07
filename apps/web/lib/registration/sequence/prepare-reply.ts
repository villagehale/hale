import { type Database, type Municipality, schema } from '@hale/db';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import {
  SPOT_PORTAL_HOSTS,
  type SpotPortal,
  sanitizeSpotUrl,
} from '~/lib/channel/spots/url';
import { asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { formatWhenPhrase } from '~/lib/format/datetime';
import { resolveFamilyOpen } from '~/lib/registration/match-registration-windows';
import { type FetchPage, createFetchBody } from '~/lib/registration/verify-sweep';
import { renderCourseBindAck, renderReadinessAck } from './copy.js';
import {
  BIND_FETCH_TIMEOUT_MS,
  MAX_BIND_DRIFT_DAYS,
  type PrepChild,
  readCoursePrep,
} from './prepare.js';
import { legDedupeKey } from './run.js';
import { SEQUENCE_LEGS } from './schedule.js';
import { type FitNote, buildShortlist } from './shortlist.js';
import { printsReadinessAsk } from './copy.js';

/**
 * VIL-338 · what a parent may SAY to a registration morning that has not happened yet.
 *
 * M7's `reply.ts` answers the morning AFTER: three certainties, a 36-hour clock. This
 * module answers the days BEFORE, and everything it does is a fact the parent stated
 * about their own world — which course they picked, and whether their portal account is
 * ready. Hale never logs in, never checks an account and never registers, so neither
 * writer here verifies anything: each one records a sentence and the message id that
 * carried it, and every downstream clause attributes it back ("You told me ...").
 *
 * WHY THE BIND GATE DECIDES ON CLOCKS AND NOT ON A VERDICT KIND. `readCoursePrep`'s
 * kinds describe a page against an anchor the sequence has already stored. At BIND time
 * there is no stored anchor yet — the M1 row is the only thing to compare against, and
 * disagreeing with the M1 row is the whole point of the feature (a Thornhill household
 * on Markham opens a DAY after the shipped row says). So the gate reads the page's own
 * applicable clock off the verdict and decides on that: past → the coach's turn, absent
 * → a sentence, more than a week out → a different season, otherwise BIND, drift and
 * all.
 *
 * ONE NON-NULLABLE EFFECT (rule #11). `fetchBody` is a required dep, not an optional
 * one: a bind that could not read the page must say so in a sentence, never bind on a
 * URL nobody opened.
 */

// ── the live pre-open sequence ───────────────────────────────────────────────

/** The municipalities Hale has read a portal for, derived from the registry so a host
 * added there is reachable here without a second edit. */
const PORTAL_MUNICIPALITIES: Municipality[] = [
  ...new Set(Object.values(SPOT_PORTAL_HOSTS).map((portal) => portal.municipality)),
];

export interface PreparingSequence {
  sequenceId: string;
  familyId: string;
  parentUserId: string;
  windowId: string;
  municipality: Municipality;
  /** Non-null by construction: a sequence whose municipality has no portal is not a
   * preparing sequence at all, and this loader does not return one. */
  portal: SpotPortal;
  /** The M1 row's instant for THIS family — the resident date where they have one. */
  opensForFamilyAt: Date;
  isResidentWindow: boolean;
  timeZone: string;
  courseUrl: string | null;
  courseOpensAt: Date | null;
  readinessReady: boolean | null;
  /**
   * The children the M1 band admits, and the SAME children the page's band is read
   * against. One set, deliberately: `fitNotes` is who the ack may talk about and
   * `children` is who the age verdict is computed from, and a verdict about a child the
   * sentence cannot name would print "Ages 4 to 6 - fits on the birthday I hold" with
   * nobody in front of the verb.
   */
  fitNotes: readonly FitNote[];
  children: readonly PrepChild[];
}

/**
 * THE live opted-in pre-open sequence for a portal municipality, or null.
 *
 * NOT a widening of `loadAwaitingSequence` (reply.ts), which orders by the M1 row's own
 * `open_at` and would hand back the sequence whose morning has already run. The filters
 * here are the four this feature needs, and three of them are SQL: the opt-in read off
 * the approval spine's own columns, the portal municipalities, and a superset of "the
 * anchor is still ahead" (`course_opens_at > now OR open_at > now` — the stored clock
 * where there is one, and otherwise the general date, which is never EARLIER than this
 * family's own instant). The exact anchor check is the one thing SQL cannot do, because
 * the resident head start is resolved from the family's FSA in code.
 */
export async function loadPreparingSequence(
  database: Database,
  familyId: string,
  now: Date,
): Promise<PreparingSequence | null> {
  const [row] = await database
    .select({
      sequenceId: schema.registrationSequences.id,
      parentUserId: schema.registrationSequences.parentUserId,
      courseUrl: schema.registrationSequences.courseUrl,
      courseOpensAt: schema.registrationSequences.courseOpensAt,
      readinessReady: schema.registrationSequences.readinessReady,
      window: schema.registrationWindows,
      timeZone: schema.users.timezone,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.registrationSequences)
    .innerJoin(
      schema.registrationWindows,
      eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.registrationSequences.parentUserId))
    .innerJoin(schema.families, eq(schema.families.id, schema.registrationSequences.familyId))
    .innerJoin(schema.actions, eq(schema.actions.id, schema.registrationSequences.actionId))
    .where(
      and(
        eq(schema.registrationSequences.familyId, familyId),
        isNull(schema.registrationSequences.outcome),
        inArray(schema.registrationWindows.municipality, PORTAL_MUNICIPALITIES),
        // The approval spine's own answer, in SQL: an executed draft is the opt-in, a
        // reverted one is a decline, and one still in the queue is neither yet.
        sql`${schema.actions.executedAt} is not null`,
        isNull(schema.actions.revertedAt),
        or(
          gt(schema.registrationSequences.courseOpensAt, now),
          gt(schema.registrationWindows.openAt, now),
        ),
      ),
    )
    .orderBy(
      sql`coalesce(${schema.registrationSequences.courseOpensAt}, ${schema.registrationWindows.openAt})`,
    )
    .limit(1);
  if (!row) return null;

  const portal = portalOf(row.window.municipality);
  if (portal === null) return null;

  const open = resolveFamilyOpen(row.window, row.areaCoarse);
  const anchor = row.courseOpensAt ?? open.opensForFamilyAt;
  if (anchor.getTime() <= now.getTime()) return null;

  const children = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const shortlist = buildShortlist(
    {
      window: row.window,
      cycleWindows: [row.window],
      matchedChildAgesMonths: [],
      ageApproximate: false,
      isResidentWindow: open.isResidentWindow,
      opensForFamilyAt: open.opensForFamilyAt,
      generalOpenAt: row.window.openAt,
    },
    children,
    now,
  );
  const fitNotes = shortlist?.fitNotes ?? [];
  const admitted = new Set(fitNotes.map((note) => note.childId));

  return {
    sequenceId: row.sequenceId,
    familyId,
    parentUserId: row.parentUserId,
    windowId: row.window.id,
    municipality: row.window.municipality,
    portal,
    opensForFamilyAt: open.opensForFamilyAt,
    isResidentWindow: open.isResidentWindow,
    timeZone: row.timeZone,
    courseUrl: row.courseUrl,
    courseOpensAt: row.courseOpensAt,
    readinessReady: row.readinessReady,
    fitNotes,
    children: children.filter((child) => admitted.has(child.id)),
  };
}

/** The registry's portal for a municipality, narrowed to the two the loader selects on
 * so the non-null field above is earned rather than asserted. */
function portalOf(municipality: Municipality): SpotPortal | null {
  return (
    Object.values(SPOT_PORTAL_HOSTS).find((portal) => portal.municipality === municipality) ?? null
  );
}

// ── the bind ─────────────────────────────────────────────────────────────────

/** Every way a pasted link can be refused, as a closed list — the test iterates it, so
 * a reason added without a sentence fails rather than falling through to a default. */
export const COURSE_BIND_REFUSALS = [
  'not_https',
  'has_credentials',
  'host_not_allowed',
  'not_a_course_page',
  'too_long',
  'wrong_municipality',
  'page_unreadable',
  'course_gone',
  'no_published_clock',
  'different_season',
] as const;

export type CourseBindRefusal = (typeof COURSE_BIND_REFUSALS)[number];

export type CourseBindOutcome =
  | { status: 'bound'; reply: string }
  | { status: 'already_bound'; reply: string }
  | { status: 'refused'; reason: CourseBindRefusal; reply: string }
  /**
   * NOT this module's message. A course whose registration is already open is what
   * VIL-337's watch verb and the coach are for, and a refusal here would be Hale
   * telling a parent it cannot do the thing it can actually do.
   */
  | { status: 'declined'; reason: 'already_open' };

export interface CourseBindInput {
  sequence: PreparingSequence;
  /** The link token as the parent pasted it — sanitized here, never upstream. */
  rawUrl: string;
  inboundChannelMessageId: string;
  now: Date;
}

export async function handleCourseBind(
  database: Database,
  input: CourseBindInput,
  deps: PrepareReplyDeps,
): Promise<CourseBindOutcome> {
  const { sequence, now } = input;
  const sanitized = sanitizeSpotUrl(input.rawUrl);
  if (!sanitized.ok) return refuse(sequence, sanitized.reason, now);

  const pasted = SPOT_PORTAL_HOSTS[sanitized.host];
  if (pasted === undefined || pasted.municipality !== sequence.municipality) {
    return refuse(sequence, 'wrong_municipality', now);
  }

  let raw: string;
  try {
    raw = await deps.fetchBody(sanitized.url);
  } catch {
    return refuse(sequence, 'page_unreadable', now);
  }

  const verdict = readCoursePrep(
    { ok: true, raw },
    {
      now,
      courseId: sanitized.courseId,
      timeZone: sequence.portal.timeZone,
      isResidentWindow: sequence.isResidentWindow,
      // The M1 row is the only anchor there is before a bind, and the drift it produces
      // is the number the ack and the audit row carry.
      anchor: sequence.opensForFamilyAt,
      children: sequence.children,
      readinessReady: sequence.readinessReady,
    },
  );
  if (verdict.kind === 'course_gone') return refuse(sequence, 'course_gone', now);
  if (verdict.kind === 'page_unreadable') return refuse(sequence, 'page_unreadable', now);

  const clock = verdict.clock;
  if (clock === null) return refuse(sequence, 'no_published_clock', now);
  if (clock.at.getTime() <= now.getTime()) return { status: 'declined', reason: 'already_open' };

  const driftMs = clock.at.getTime() - sequence.opensForFamilyAt.getTime();
  if (Math.abs(driftMs) > MAX_BIND_DRIFT_DAYS * 86_400_000) {
    return refuse(sequence, 'different_season', now, clock.at);
  }

  const replaced = sequence.courseUrl !== null && sequence.courseUrl !== sanitized.url;
  const written = await deps.recordCourseBinding(database, {
    sequenceId: sequence.sequenceId,
    familyId: sequence.familyId,
    parentUserId: sequence.parentUserId,
    inboundChannelMessageId: input.inboundChannelMessageId,
    url: sanitized.url,
    host: sanitized.host,
    courseOpensAt: clock.at,
    replaced,
    hasRegForm: verdict.facts.RegFormId != null,
    prerequisite: verdict.facts.PrerequisiteEvents === true,
    ageFit: verdict.age.fit,
    driftMinutes: Math.round(driftMs / 60_000),
    now,
  });

  const reply = renderCourseBindAck({
    portal: sequence.portal,
    page: verdict,
    clock,
    replaced,
    municipality: sequence.municipality,
    opensForFamilyAt: sequence.opensForFamilyAt,
    fitNotes: sequence.fitNotes,
    timeZone: sequence.timeZone,
    now,
  });
  return written === 'bound' ? { status: 'bound', reply } : { status: 'already_bound', reply };
}

function refuse(
  sequence: PreparingSequence,
  reason: CourseBindRefusal,
  now: Date,
  pageClock?: Date,
): CourseBindOutcome {
  return { status: 'refused', reason, reply: refusalSentence(sequence, reason, now, pageClock) };
}

/**
 * ONE SENTENCE PER REFUSAL, and none of them is an apology with no next step.
 *
 * No link is printed: the parent has one, and a link Hale sends back is a link nobody
 * asked for (the same rule the bind ack keeps). No question mark either — every ask in
 * this ladder is an imperative, which is what lets the composer's gate be absolute.
 */
function refusalSentence(
  sequence: PreparingSequence,
  reason: CourseBindRefusal,
  now: Date,
  pageClock?: Date,
): string {
  const town = townLabel(sequence.municipality);
  const portal = sequence.portal.portalLabel;
  switch (reason) {
    case 'not_https':
      return `That link is not a secure one, so I did not open it. Send me the course page from ${portal} as it appears in your address bar.`;
    case 'has_credentials':
      return `That link carries a sign-in inside it, so I did not open it. Send me the plain course page from ${portal}.`;
    case 'host_not_allowed':
      return `That is not ${portal}, and ${town} is the morning I am holding. Send me the course page from there.`;
    case 'not_a_course_page':
      return `That is not a course page I can read. Open the class on ${portal} and send me the link from the address bar.`;
    case 'too_long':
      return `That link is longer than I can read. Send the course page link from ${portal} on its own line.`;
    case 'wrong_municipality':
      return `That is another town's portal, and the morning I am holding is ${town}. Send me the ${town} course page.`;
    case 'page_unreadable':
      return 'I could not read that page just now. Nothing has changed on my side - send it again and I will try once more.';
    case 'course_gone':
      return `${portal} is not showing the course at that link any more. Open the class again and send me the new link.`;
    case 'no_published_clock':
      return `That page does not publish a registration date I can read, so I am staying on the ${town} dates I already have.`;
    case 'different_season':
      return `That course opens ${when(pageClock as Date, sequence.timeZone, now)} and the ${town} morning I am holding is ${when(sequence.opensForFamilyAt, sequence.timeZone, now)}. That looks like a different season, so I have left it as it was.`;
  }
}

function when(instant: Date, timeZone: string, now: Date): string {
  return asciiSpaces(formatWhenPhrase(instant, timeZone, now));
}

// ── the readiness answer ─────────────────────────────────────────────────────

export interface ReadinessAnswerInput {
  sequence: PreparingSequence;
  ready: boolean;
  /** Whether a person typed a token or a model read a sentence — rule #6's trail has to
   * be able to answer that months later (route.ts, `ResolvedAnswer.confidence`). */
  read: 'keyword' | 'resolver';
  confidence: string | null;
  inboundChannelMessageId: string;
  now: Date;
}

export type ReadinessOutcome = {
  status: 'readiness_recorded' | 'already_answered';
  reply: string;
};

export async function handleReadinessAnswer(
  database: Database,
  input: ReadinessAnswerInput,
  deps: PrepareReplyDeps,
): Promise<ReadinessOutcome> {
  const written = await deps.recordReadinessState(database, {
    sequenceId: input.sequence.sequenceId,
    familyId: input.sequence.familyId,
    parentUserId: input.sequence.parentUserId,
    inboundChannelMessageId: input.inboundChannelMessageId,
    ready: input.ready,
    read: input.read,
    confidence: input.confidence,
    now: input.now,
  });
  const reply = renderReadinessAck({
    portal: input.sequence.portal,
    ready: input.ready,
    fitNotes: input.sequence.fitNotes,
  });
  return {
    status: written === 'recorded' ? 'readiness_recorded' : 'already_answered',
    reply,
  };
}

// ── the open question, derived from the ledger ───────────────────────────────

/**
 * The readiness question, open ONLY while its ask is Hale's last outbound word to this
 * parent (`OpenQuestionSources.registrationReadiness`).
 *
 * THREE CONDITIONS, and dropping any one of them opens a question against a text that
 * asked nothing. The sequence must be live, opted-in and pre-open; the column must not
 * already say true; and an ask must have gone out with nothing after it. The ask row is
 * found by the dedupe keys of the legs `printsReadinessAsk` names — the predicate is
 * shared with the composer, so the copy and the ledger cannot drift — and `askedAt` is
 * the NEWEST of them, so the battle plan's re-ask the evening before outranks an older
 * solicited question rather than losing to it.
 *
 * WHY THE LEDGER AND NOT A COLUMN. A three-day window was the first draft, and inside
 * it a parent who asked about swim, was asked "want me to look?" by the coach, and said
 * "yes" would have had that YES filed as their portal setup. Both facts this needs —
 * when the ask went out, and whether anything went out after it — are already in
 * `channel_messages`, and a stored `readiness_asked_at` would be a second answer to a
 * question the ledger already answers.
 */
export async function readinessQuestion(
  database: Database,
  familyId: string,
  now: Date,
): Promise<{ id: string; summary: string; askedAt: Date } | null> {
  const sequence = await loadPreparingSequence(database, familyId, now);
  if (sequence === null) return null;
  const askedAt = await readinessAskedLastAt(database, sequence);
  if (askedAt === null) return null;
  return {
    id: sequence.sequenceId,
    // Hale's own words about its own ask: the portal, and nothing about the child.
    summary: `Whether the setup on ${sequence.portal.portalLabel} is done before the registration morning`,
    askedAt,
  };
}

/**
 * When the readiness ask last reached this parent with nothing after it, or null.
 *
 * Exported for the handler, which already holds the sequence and must not pay for a
 * second load of it to ask the same question the resolver's source asks.
 */
export async function readinessAskedLastAt(
  database: Database,
  sequence: PreparingSequence,
): Promise<Date | null> {
  if (sequence.readinessReady === true) return null;

  const askKeys = SEQUENCE_LEGS.filter((leg) => printsReadinessAsk(leg, sequence.portal)).map(
    (leg) => legDedupeKey(sequence.familyId, sequence.windowId, leg),
  );
  if (askKeys.length === 0) return null;

  // SENT_STATUSES rather than the dedupe key's own CONSUMED set: a 'failed' send
  // consumed the key but never reached the phone, and a question nobody was asked is
  // not open.
  const [ask] = await database
    .select({ createdAt: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, sequence.parentUserId),
        inArray(schema.channelMessages.dedupeKey, askKeys),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;

  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, sequence.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, ask.createdAt),
      ),
    )
    .limit(1);
  return newer ? null : ask.createdAt;
}

// ── the writers ──────────────────────────────────────────────────────────────

export interface CourseBindingWrite {
  sequenceId: string;
  familyId: string;
  parentUserId: string;
  inboundChannelMessageId: string;
  url: string;
  host: string;
  courseOpensAt: Date;
  replaced: boolean;
  hasRegForm: boolean;
  prerequisite: boolean;
  ageFit: string;
  driftMinutes: number;
  now: Date;
}

export interface ReadinessWrite {
  sequenceId: string;
  familyId: string;
  parentUserId: string;
  inboundChannelMessageId: string;
  ready: boolean;
  read: 'keyword' | 'resolver';
  confidence: string | null;
  now: Date;
}

/**
 * The bind, as ONE transaction — the guarded UPDATE decides, the audit row describes.
 *
 * THE ORDER INSIDE IS UPDATE-THEN-AUDIT, and it is not a weakening of rule #6: both
 * statements land or neither does, which is the guarantee "audit first" exists to give.
 * What the guarded UPDATE decides is WHETHER there is a state change to describe — a
 * parent re-pasting the same link changes nothing, and an audit row saying a course was
 * bound while no column moved would be a receipt for something that did not happen.
 *
 * The payload is enum-shaped provenance: the host, never the rest of the URL; the age
 * verdict, never a birthday; nothing about the class and no price (rule #1).
 */
export async function recordCourseBinding(
  database: Database,
  input: CourseBindingWrite,
): Promise<'bound' | 'already_bound'> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.registrationSequences)
      .set({ courseUrl: input.url, courseOpensAt: input.courseOpensAt, updatedAt: input.now })
      .where(
        and(
          eq(schema.registrationSequences.id, input.sequenceId),
          sql`(${schema.registrationSequences.courseUrl} is distinct from ${input.url}
               or ${schema.registrationSequences.courseOpensAt} is distinct from ${input.courseOpensAt})`,
        ),
      )
      .returning({ id: schema.registrationSequences.id });
    if (!row) return 'already_bound';

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'registration_course_bound',
      targetTable: 'channel_messages',
      targetId: input.inboundChannelMessageId,
      after: {
        sequenceId: input.sequenceId,
        host: input.host,
        replaced: input.replaced,
        hasRegForm: input.hasRegForm,
        prerequisite: input.prerequisite,
        ageFit: input.ageFit,
        driftMinutes: input.driftMinutes,
      },
    });
    return 'bound';
  });
}

/**
 * The readiness answer, on the same terms. `IS DISTINCT FROM` rather than `<>` because
 * the column starts NULL and NULL is "unasked" — a first NO must write, and a repeat NO
 * must not.
 */
export async function recordReadinessState(
  database: Database,
  input: ReadinessWrite,
): Promise<'recorded' | 'already_answered'> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.registrationSequences)
      .set({ readinessReady: input.ready, updatedAt: input.now })
      .where(
        and(
          eq(schema.registrationSequences.id, input.sequenceId),
          sql`${schema.registrationSequences.readinessReady} is distinct from ${input.ready}`,
        ),
      )
      .returning({ id: schema.registrationSequences.id });
    if (!row) return 'already_answered';

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'registration_readiness_stated',
      targetTable: 'channel_messages',
      targetId: input.inboundChannelMessageId,
      after: {
        sequenceId: input.sequenceId,
        ready: input.ready,
        read: input.read,
        confidence: input.confidence,
      },
    });
    return 'recorded';
  });
}

// ── prod wiring ──────────────────────────────────────────────────────────────

export interface PrepareReplyDeps {
  /** Non-nullable (rule #11): a bind that cannot read the page refuses in a sentence. */
  fetchBody: FetchPage;
  recordCourseBinding(
    database: Database,
    input: CourseBindingWrite,
  ): Promise<'bound' | 'already_bound'>;
  recordReadinessState(
    database: Database,
    input: ReadinessWrite,
  ): Promise<'recorded' | 'already_answered'>;
}

export function defaultPrepareReplyDeps(): PrepareReplyDeps {
  return {
    fetchBody: createFetchBody(BIND_FETCH_TIMEOUT_MS),
    recordCourseBinding,
    recordReadinessState,
  };
}
