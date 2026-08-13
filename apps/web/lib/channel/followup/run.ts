import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { dedupeActive } from '~/lib/channel/ledger';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild } from '~/lib/loop/templates/reminder/payload';
import { discoverableUserIds } from '~/lib/village/intros/consent';
import { INTRO_FOLLOWUP_ASK, activityFollowupAsk } from './copy';

/**
 * THE FOLLOW-UP ASK — Hale checks back on the things it set up.
 *
 * Founder directive, 2026-08-12: after Hale introduces two families, or a family attends
 * an activity Hale placed, Hale asks how it went. What the parent says flows into memory.
 *
 * DERIVED BY QUERY, NOT MINTED. There is no follow-up table, no scheduled row, and no new
 * write path anywhere upstream. A follow-up is due when rows that ALREADY EXIST say so —
 * an intro pair that closed as `both_accepted` three days ago, a `source='placement'`
 * event whose start time passed yesterday — and the only thing this sweep writes is the
 * send itself. That is what makes the feature reversible: turn the flag off and there is
 * nothing left over, no ledger to drain, no orphaned jobs, no half-state to migrate.
 *
 * THE SEND IS THE CLAIM. `channel_messages.dedupe_key` is unique where present, so the
 * row that records the text is also the fact that stops the next hourly tick re-sending
 * it. No separate claim table and no "asked" boolean to keep in step with reality — the
 * question "have we asked yet?" has exactly one reader, and it reads the same row a
 * PIPEDA right-to-access request would.
 *
 * THE REPLY IS NOT HANDLED HERE, and there is deliberately no handler anywhere. A parent
 * who answers "we did, they were lovely" is just texting Hale, and that text goes down
 * the router into the coach exactly like any other, where the coach's memory tools
 * persist what they said. Zero new inbound surface is the point of the feature, not a
 * shortcut in it: a bespoke reply parser would be a second grammar competing with the
 * router's, and every message it claimed would be a message the coach never saw.
 *
 * WHY A STAGE ON THE NUDGE CRON. Same reason the intro sweep rides it (see
 * village/intros/run.ts): the hourly cadence already exists, and the question — may Hale
 * interrupt this parent right now, and with what — is the one that cron exists to ask.
 */

export const FOLLOWUP_ASKS_ENABLED_ENV = 'FOLLOWUP_ASKS_ENABLED';
export const FOLLOWUP_ASKS_ALLOWLIST_ENV = 'FOLLOWUP_ASKS_FAMILY_ALLOWLIST';

/**
 * Its OWN dark-launch flag, not F14's and not the intros'.
 *
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'`, and a
 * truthiness check reads that as ON.
 */
export function followupAsksEnabled(): boolean {
  return process.env[FOLLOWUP_ASKS_ENABLED_ENV] === 'true';
}

export function followupAsksAllowlist(): Set<string> {
  return new Set(
    (process.env[FOLLOWUP_ASKS_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * How long after the introduction email the check-in goes out, and how late it may still
 * go.
 *
 * Three days is the founder's number and it is the right one: soon enough that "did you
 * connect" is a live question, late enough that a weekend has had a chance to happen.
 *
 * The CEILING is the part that matters structurally. Without it, the first tick after
 * this ships would text every family that has ever been introduced, however long ago,
 * because none of them carries a claim yet — a query-derived feature's version of a
 * migration backfire. Ten days also gives the daily rail a week of slack to defer into
 * before the moment has simply passed.
 */
export const INTRO_FOLLOWUP_MIN_AGE_DAYS = 3;
export const INTRO_FOLLOWUP_MAX_AGE_DAYS = 10;

/**
 * The window after a placed activity's start time. One day, so the ask lands the morning
 * after rather than while the family is still in the car; two, so a tick lost to quiet
 * hours or to the day's intro follow-up gets exactly one more chance before the question
 * is stale. Same backfill reasoning as the ceiling above.
 */
export const ACTIVITY_FOLLOWUP_MIN_AGE_DAYS = 1;
export const ACTIVITY_FOLLOWUP_MAX_AGE_DAYS = 2;

const DAY_MS = 24 * 3_600_000;

/** Filter first, then cap — a cap-then-filter would starve every family past the
 * oldest N forever. */
const MAX_FAMILIES_PER_RUN = 200;

/** An intro is a PAIR: both sides are asked, or neither is. The skip counters count
 * unasked SIDES, so a pair-level refusal costs two. */
const SIDES_PER_INTRO = 2;

/**
 * The band of `closed_at` values an intro follow-up is due for, expressed as instants so
 * the SQL predicate and the intent share one arithmetic. `latest` is the NEWEST row still
 * old enough to ask about; `earliest` is the OLDEST still recent enough to be worth it.
 */
export function introFollowupWindow(now: Date): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(now.getTime() - INTRO_FOLLOWUP_MAX_AGE_DAYS * DAY_MS),
    latest: new Date(now.getTime() - INTRO_FOLLOWUP_MIN_AGE_DAYS * DAY_MS),
  };
}

/** The same band over a placement's `starts_at`. */
export function activityFollowupWindow(now: Date): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(now.getTime() - ACTIVITY_FOLLOWUP_MAX_AGE_DAYS * DAY_MS),
    latest: new Date(now.getTime() - ACTIVITY_FOLLOWUP_MIN_AGE_DAYS * DAY_MS),
  };
}

export interface FollowupFamily {
  familyId: string;
  parentUserId: string;
}

/** An introduction that happened, old enough to ask about. */
export interface DueIntro {
  proposalId: string;
  familyAId: string;
  familyBId: string;
}

/** A Hale-placed calendar item whose start time has passed. Carries exactly the fields
 * `isPrivateEvent` reads, plus the title the ask renders. */
export interface DueActivity {
  eventId: string;
  familyId: string;
  title: string;
  startsAt: Date;
  childId: string | null;
  sensitive: boolean;
}

/**
 * Why a follow-up Hale could have sent did not go — the reasons that are this sweep's
 * own, as opposed to the four the outbound gate owns (rule #11: a skipped send is a
 * named outcome, never a silent `continue`).
 *
 * Counted per SIDE that went unasked, not per pair, so the numbers read as "texts not
 * sent" and line up with `introAsked` / `activityAsked`.
 */
export type FollowupSkipReason =
  | 'opted_out'
  | 'already_claimed'
  | 'private_item'
  | 'out_of_scope';

export interface FollowupAudit {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

export interface FollowupSweepDeps {
  selectFamilies(database: Database, now: Date): Promise<FollowupFamily[]>;
  loadDueIntros(database: Database, now: Date): Promise<DueIntro[]>;
  /** Which of these parents are still discoverable — the intros opt-in, read
   * latest-row-wins. Reused verbatim from the intros lane so the two can never disagree
   * about what "opted out" means. */
  discoverableUserIds(database: Database, userIds: readonly string[]): Promise<Set<string>>;
  loadDueActivities(database: Database, familyId: string, now: Date): Promise<DueActivity[]>;
  loadChildren(database: Database, familyId: string): Promise<ReminderChild[]>;
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive(database: Database, dedupeKey: string): Promise<boolean>;
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  recordSend(
    database: Database,
    write: {
      familyId: string;
      parentUserId: string;
      templateKey: string;
      dedupeKey: string;
      providerMessageId: string;
      sentAt: Date;
    },
  ): Promise<string>;
  audit(database: Database, row: FollowupAudit): Promise<void>;
  /** REQUIRED (rule #11). A sweep that can decide to ask and quietly fail to ask is a
   * sweep whose counters lie. */
  transport: ChannelTransport;
}

export interface FollowupSweepResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  introAsked: number;
  activityAsked: number;
  held: Record<ProactiveHoldReason, number>;
  skipped: Record<FollowupSkipReason, number>;
  failed: number;
}

function emptyResult(enabled: boolean): FollowupSweepResult {
  return {
    enabled,
    introAsked: 0,
    activityAsked: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    skipped: { opted_out: 0, already_claimed: 0, private_item: 0, out_of_scope: 0 },
    failed: 0,
  };
}

type SendOutcome =
  | { status: 'sent' }
  | { status: 'held'; reason: ProactiveHoldReason }
  | { status: 'already_claimed' };

/**
 * The ONE way this feature reaches a phone: claim, gate, resolve, send, ledger.
 *
 * THE CLAIM CHECK RUNS FIRST, which is where this departs from the intro sweep's order,
 * and the departure is deliberate. "Have we already asked?" is a fact about the MESSAGE
 * and can only ever prevent a send, while the gate's questions are about the FAMILY and
 * cost four reads. Asking the cheap, decisive one first also keeps the counters
 * truthful: with a one-per-family-per-day budget, a gate-first order would report an
 * already-sent follow-up as `frequency_cap` — the message's own prior send blocking
 * itself — and hide the fact that idempotency, not policy, is what stopped it.
 */
async function sendFollowup(
  database: Database,
  deps: FollowupSweepDeps,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
  },
): Promise<SendOutcome> {
  if (await deps.dedupeActive(database, input.dedupeKey)) return { status: 'already_claimed' };

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      kind: 'followup',
      now: input.now,
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) return { status: 'held', reason: verdict.reason };

  const to = await deps.resolveSendablePhone(database, input.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`followup asks: no send target for parent ${input.parentUserId}`);
  }

  const { providerMessageId } = await deps.transport.send({ to, body: input.body });
  await deps.recordSend(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    templateKey: input.templateKey,
    dedupeKey: input.dedupeKey,
    providerMessageId,
    sentAt: input.now,
  });
  return { status: 'sent' };
}

/** Fold one send's outcome into the run's counters. Returns whether it went. */
function tally(result: FollowupSweepResult, outcome: SendOutcome): boolean {
  if (outcome.status === 'held') {
    result.held[outcome.reason] += 1;
    return false;
  }
  if (outcome.status === 'already_claimed') {
    result.skipped.already_claimed += 1;
    return false;
  }
  return true;
}

/**
 * Stage 1 — "did you end up connecting?", three days after an introduction.
 *
 * THE PAIR IS THE UNIT: both sides are asked, or neither is. A pair where one household
 * has withdrawn — opted out of intros, left the SMS surface, or fallen outside this
 * run's scope — gets no follow-up at all, including to the side that is still here.
 * Asking the remaining parent how it went would be Hale nudging them toward a household
 * that has stepped back, on the strength of a connection the other side no longer wants
 * Hale in the middle of.
 *
 * IT RUNS BEFORE THE ACTIVITY STAGE, and that ordering is the whole of "intro wins".
 * The day's single slot in PROACTIVE_CAP goes to whoever asks first.
 */
async function runIntroFollowups(
  database: Database,
  deps: FollowupSweepDeps,
  byId: ReadonlyMap<string, FollowupFamily>,
  result: FollowupSweepResult,
  now: Date,
): Promise<void> {
  const due = await deps.loadDueIntros(database, now);
  if (due.length === 0) return;

  const parentIds = [...byId.values()].map((family) => family.parentUserId);
  const discoverable = await deps.discoverableUserIds(database, parentIds);

  for (const intro of due) {
    try {
      const familyA = byId.get(intro.familyAId);
      const familyB = byId.get(intro.familyBId);
      if (!familyA || !familyB) {
        result.skipped.out_of_scope += SIDES_PER_INTRO;
        continue;
      }

      const sides = [
        { key: 'a', family: familyA },
        { key: 'b', family: familyB },
      ] as const;
      if (sides.some((side) => !discoverable.has(side.family.parentUserId))) {
        result.skipped.opted_out += sides.length;
        continue;
      }

      for (const side of sides) {
        const outcome = await sendFollowup(database, deps, {
          familyId: side.family.familyId,
          parentUserId: side.family.parentUserId,
          body: INTRO_FOLLOWUP_ASK,
          templateKey: 'followup:intro',
          dedupeKey: `followup:intro:${intro.proposalId}:${side.key}`,
          now,
        });
        if (!tally(result, outcome)) continue;

        result.introAsked += 1;
        await deps.audit(database, {
          familyId: side.family.familyId,
          actor: 'system',
          actionTaken: 'followup_intro_asked',
          targetTable: 'village_intro_proposals',
          targetId: intro.proposalId,
          // Which side, and nothing else. The counterpart is already named on the
          // `village_intro_disclosed` row this one points at; repeating it here would
          // widen the trail without answering a question it cannot already answer.
          after: { side: side.key },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error({ err, proposalId: intro.proposalId }, 'followup asks: intro ask failed');
    }
  }
}

/**
 * Stage 2 — "how was {title}?", the day after something Hale put on the calendar.
 *
 * A PRIVATE ITEM GETS NO FOLLOW-UP AT ALL, rather than a genericized one. The reminders
 * engine genericizes ("an appointment") because a reminder still has a job to do when it
 * cannot say what the thing is — the parent needs to be somewhere. A follow-up has no
 * such job: "how was an appointment?" is unanswerable AND it discloses that something
 * private happened, which for a 13+ child is Hale volunteering the existence of their
 * calendar to a parent, unprompted (rule #1). Dropping it is both simpler and stricter,
 * and it reuses the reminders engine's own {@link isPrivateEvent} predicate so the two
 * surfaces can never disagree about which items those are.
 *
 * Oldest first: with one slot a day, the item closest to falling out of its window is
 * the one worth spending it on.
 */
async function runActivityFollowups(
  database: Database,
  deps: FollowupSweepDeps,
  families: readonly FollowupFamily[],
  result: FollowupSweepResult,
  now: Date,
): Promise<void> {
  for (const family of families) {
    try {
      const due = await deps.loadDueActivities(database, family.familyId, now);
      if (due.length === 0) continue;
      const children = await deps.loadChildren(database, family.familyId);

      for (const event of due) {
        const isPrivate = isPrivateEvent(
          {
            eventRef: event.eventId,
            title: event.title,
            startsAt: event.startsAt.toISOString(),
            childId: event.childId,
            sensitive: event.sensitive,
          },
          children,
          now,
        );
        if (isPrivate) {
          result.skipped.private_item += 1;
          continue;
        }

        const outcome = await sendFollowup(database, deps, {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          body: activityFollowupAsk(event.title),
          templateKey: 'followup:activity',
          dedupeKey: `followup:activity:${event.eventId}`,
          now,
        });
        if (!tally(result, outcome)) continue;

        result.activityAsked += 1;
        await deps.audit(database, {
          familyId: family.familyId,
          actor: 'system',
          actionTaken: 'followup_activity_asked',
          targetTable: 'family_events',
          targetId: event.eventId,
          // The title is NOT recorded. It is family calendar content, the audit row
          // already points at the row that holds it, and a trail that copies content
          // is a second place to leak it from (rule #1).
          after: { startsAt: event.startsAt.toISOString() },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'followup asks: activity ask failed');
    }
  }
}

export async function runFollowupSweep(
  database: Database,
  deps: FollowupSweepDeps = defaultFollowupSweepDeps(),
  now: Date = new Date(),
): Promise<FollowupSweepResult> {
  const allFamilies = followupAsksEnabled();
  const allowlist = followupAsksAllowlist();
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const families = (await deps.selectFamilies(database, now))
    .filter((family) => allFamilies || allowlist.has(family.familyId))
    .slice(0, MAX_FAMILIES_PER_RUN);
  if (families.length === 0) return result;

  const byId = new Map(families.map((family) => [family.familyId, family]));
  await runIntroFollowups(database, deps, byId, result, now);
  await runActivityFollowups(database, deps, families, result, now);
  return result;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The families a follow-up could reach: settled SMS households with a primary parent.
 * Consent, enrolment, volume and the clock are the GATE's business. */
async function selectFollowupFamilies(database: Database): Promise<FollowupFamily[]> {
  return database
    .select({
      familyId: schema.families.id,
      parentUserId: schema.users.id,
    })
    .from(schema.families)
    .innerJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.familyId, schema.families.id),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(
      and(
        eq(schema.families.onboardingStage, 'sms_active'),
        isNull(schema.families.scheduledDeletionAt),
      ),
    );
}

/**
 * The introductions that actually happened, inside the ask window.
 *
 * `status = 'both_accepted'` IS "the email went": the intro sweep sets that status only
 * after the send comes back `sent`, and stamps `closed_at` in the same call
 * (village/intros/run.ts `introduce`). So `closed_at` is the delivery instant, and there
 * is no separate timestamp to keep in step with it.
 */
async function readDueIntros(database: Database, now: Date): Promise<DueIntro[]> {
  const { earliest, latest } = introFollowupWindow(now);
  const rows = await database
    .select({
      proposalId: schema.villageIntroProposals.id,
      familyAId: schema.villageIntroProposals.familyAId,
      familyBId: schema.villageIntroProposals.familyBId,
    })
    .from(schema.villageIntroProposals)
    .where(
      and(
        eq(schema.villageIntroProposals.status, 'both_accepted'),
        gte(schema.villageIntroProposals.closedAt, earliest),
        lte(schema.villageIntroProposals.closedAt, latest),
      ),
    );
  return rows;
}

/**
 * The activities HALE placed, whose start time has passed inside the ask window.
 *
 * `source = 'placement'` is the provenance test, and it is the only one that means what
 * this feature needs. A placement is a row the calendar_add executor wrote from an
 * artifact the parent approved — Hale put it there, so Hale may ask how it went. The
 * other four sources are occasions the family told Hale ABOUT ('parent', 'channel',
 * 'email', 'party'); Hale did not set those up, and checking back on one is Hale asking
 * about a family's own life for no reason it can name.
 *
 * `deleted_at IS NULL` is the not-cancelled test: `calendar_cancel` soft-deletes the
 * placement rather than erasing it, so a live row is one that was never called off.
 */
async function readDueActivities(
  database: Database,
  familyId: string,
  now: Date,
): Promise<DueActivity[]> {
  const { earliest, latest } = activityFollowupWindow(now);
  return database
    .select({
      eventId: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      childId: schema.familyEvents.childId,
      sensitive: schema.familyEvents.sensitive,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        eq(schema.familyEvents.source, 'placement'),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, earliest),
        lte(schema.familyEvents.startsAt, latest),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));
}

async function readFollowupChildren(
  database: Database,
  familyId: string,
): Promise<ReminderChild[]> {
  return database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      gender: schema.children.gender,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

export function defaultFollowupSweepDeps(): FollowupSweepDeps {
  return {
    selectFamilies: (database) => selectFollowupFamilies(database),
    loadDueIntros: readDueIntros,
    discoverableUserIds,
    loadDueActivities: readDueActivities,
    loadChildren: readFollowupChildren,
    buildGate: buildOutboundGatePorts,
    dedupeActive: (database, dedupeKey) => dedupeActive(dedupeKey, database),
    resolveSendablePhone,
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({
          familyId: write.familyId,
          parentUserId: write.parentUserId,
          channel: 'sms',
          direction: 'out',
          category: 'followup',
          templateKey: write.templateKey,
          dedupeKey: write.dedupeKey,
          providerMessageId: write.providerMessageId,
          status: 'sent',
          sentAt: write.sentAt,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('followup asks: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    transport: createTwilioTransport(),
  };
}
