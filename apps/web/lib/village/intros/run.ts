import { type Database, schema } from '@hale/db';
import type { FamilyStage } from '@hale/types';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { MIN_SURFACE_CONFIDENCE } from '~/lib/civic/parse-hours';
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
import { type ChildNameLevel, loadLoopPrefsView, loopChildName } from '~/lib/loop/prefs';
import { discoverableUserIds } from './consent';
import {
  DISCOVERABILITY_ASK,
  INTRO_SOFT_CLOSE,
  activityAnchor,
  coarseCard,
} from './copy';
import { type IntroEmailSender, createIntroEmailSender, introFirstName } from './email';
import {
  type IntroSkipReason,
  matchIntroPairs,
  normalizeFsa,
  pairKey,
} from './matcher';

/**
 * Village intros v1 — the sweep. Three phases, run in order, every tick.
 *
 *   1. ASK      — consent first, matching second. A family that shares an FSA with at
 *                 least one other Hale household is asked, ONCE, whether it wants to be
 *                 findable at all. At the moment that text is sent Hale has looked at
 *                 nobody: the only fact behind it is the postal system.
 *   2. MATCH    — pair the families that said yes, and text both sides the same coarse
 *                 card. Nothing about either household crosses over.
 *   3. RESOLVE  — turn a completed pair into one email, and a dead pair into one soft
 *                 close that does not say which of the three ways it died.
 *
 * WHY A STEP ON AN EXISTING CRON, NOT A CRON OF ITS OWN. The nudge cron already runs
 * hourly and already exists to decide whether to interrupt a parent; this is the same
 * question about a different subject. A second cron would be a second Vercel slot, a
 * second failure budget, and a second place to forget the dark-launch flag.
 *
 * NO HOUR SLOT OF ITS OWN, deliberately, and it is the one place this departs from the
 * nudge sweep's shape. The proactive gate's quiet hours (21:00-08:00 local) are the
 * real timing policy, and the per-side `asked_at` stamps are the volume policy — an
 * extra "only at 11am" gate would add nothing a parent can feel while making the whole
 * loop untestable in a live run that does not happen to start at 11am.
 *
 * CONVERGENT, NOT TRANSACTIONAL ACROSS SENDS. Every effect is guarded by a state the
 * previous effect wrote (`asked_at`, a reply, `closed_at`), so a tick that dies halfway
 * is picked up by the next one and nothing is sent twice. That is why the reply handler
 * only writes state and this file owns every send.
 */

export const VILLAGE_INTROS_ENABLED_ENV = 'VILLAGE_INTROS_ENABLED';
export const VILLAGE_INTROS_ALLOWLIST_ENV = 'VILLAGE_INTROS_FAMILY_ALLOWLIST';

/**
 * Its OWN flag, not F14's.
 *
 * F14_ENABLED arms the nudge sweep, and by the time this ships that flag is on for real
 * families. Riding it would mean one env var flip silently enrolling every SMS family
 * in a cross-household disclosure loop they were never asked about — which is the exact
 * failure the double opt-in exists to prevent, committed one level up.
 *
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'`, and a
 * truthiness check reads that as ON.
 */
export function villageIntrosEnabled(): boolean {
  return process.env[VILLAGE_INTROS_ENABLED_ENV] === 'true';
}

export function villageIntrosAllowlist(): Set<string> {
  return new Set(
    (process.env[VILLAGE_INTROS_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** How long a card waits for an answer before the pair lapses. A week covers a busy
 * parent's whole cycle; longer and an intro arrives about a life that has moved on. */
export const INTRO_EXPIRY_DAYS = 7;

/** How far ahead a civic session may be and still be worth anchoring on. Same horizon
 * as the expiry: an activity after the card has lapsed is not a shared plan. */
const ANCHOR_HORIZON_DAYS = 7;

/** Filter first, then cap — a cap-then-filter would starve every family past the
 * oldest N of their FSA forever. */
const MAX_FAMILIES_PER_RUN = 200;

export interface IntroSweepChild {
  id: string;
  name: string;
  gender: string;
  dateOfBirth: string;
}

export interface IntroSweepFamily {
  familyId: string;
  parentUserId: string;
  /** The primary parent's display name; only its first token is ever disclosed. */
  parentName: string | null;
  parentEmail: string | null;
  areaCoarse: string | null;
  timeZone: string;
}

/** A live proposal, with the anchor already resolved to its title and instant so the
 * card renderer never touches the civic tables. */
export interface SweepProposal {
  id: string;
  fsa: string;
  stage: FamilyStage;
  status: 'proposed' | 'both_accepted' | 'declined' | 'expired';
  familyAId: string;
  familyBId: string;
  familyAChildId: string | null;
  familyBChildId: string | null;
  familyAAskedAt: Date | null;
  familyBAskedAt: Date | null;
  familyAReply: 'yes' | 'no' | null;
  familyBReply: 'yes' | 'no' | null;
  anchorTitle: string | null;
  anchorStartsAt: Date | null;
  expiresAt: Date;
}

export interface IntroSweepAudit {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

export interface IntroSweepDeps {
  selectFamilies(database: Database, now: Date): Promise<IntroSweepFamily[]>;
  discoverableUserIds(database: Database, userIds: readonly string[]): Promise<Set<string>>;
  /** Parents who already carry ANY answer on the discoverability scope. */
  askedUserIds(database: Database, userIds: readonly string[]): Promise<Set<string>>;
  loadChildren(database: Database, familyId: string): Promise<IntroSweepChild[]>;
  loadNameLevel(database: Database, parentUserId: string): Promise<ChildNameLevel>;
  loadOpenProposalFamilyIds(database: Database): Promise<Set<string>>;
  loadPairedBefore(database: Database): Promise<Set<string>>;
  loadAnchorSession(
    database: Database,
    fsa: string,
    now: Date,
  ): Promise<{ id: string; title: string; startsAt: Date } | null>;
  createProposal(
    database: Database,
    input: {
      familyAId: string;
      familyBId: string;
      familyAChildId: string;
      familyBChildId: string;
      fsa: string;
      stage: FamilyStage;
      civicSessionId: string | null;
      expiresAt: Date;
    },
  ): Promise<string>;
  /** Every proposal still awaiting an effect: not closed. */
  loadLiveProposals(database: Database, now: Date): Promise<SweepProposal[]>;
  markAsked(database: Database, proposalId: string, side: 'a' | 'b', now: Date): Promise<void>;
  setStatus(
    database: Database,
    proposalId: string,
    status: SweepProposal['status'],
    closed: boolean,
    now: Date,
  ): Promise<void>;
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
  audit(database: Database, row: IntroSweepAudit): Promise<void>;
  /** REQUIRED, both of them (rule #11). A sweep that can compose an introduction and
   * quietly fail to deliver it is the worst version of this feature: both families are
   * told yes, audited as disclosed-to, and never hear from each other. */
  transport: ChannelTransport;
  email: IntroEmailSender;
}

export interface IntroSweepResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  asked: number;
  proposed: number;
  carded: number;
  introduced: number;
  /** Both sides said yes and the email did not go. The pair stays open on purpose. */
  introFailed: number;
  closed: number;
  held: Record<ProactiveHoldReason, number>;
  skipped: Record<IntroSkipReason, number>;
  failed: number;
}

function emptyResult(enabled: boolean): IntroSweepResult {
  return {
    enabled,
    asked: 0,
    proposed: 0,
    carded: 0,
    introduced: 0,
    introFailed: 0,
    closed: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    skipped: { no_fsa: 0, no_parent_email: 0, no_parent_name: 0, no_matchable_child: 0 },
    failed: 0,
  };
}

/** The weekday an anchored session falls on, in the recipient's own wall clock. A
 * session at 14:00 UTC is Saturday in Toronto and Sunday in Auckland, and the parent
 * only cares about theirs. */
function weekdayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, weekday: 'long' }).format(instant);
}

interface SendOutcome {
  sent: boolean;
  held?: ProactiveHoldReason;
}

/**
 * The ONE way this feature reaches a phone: gate, dedupe, resolve, send, ledger.
 *
 * Every intro text goes through here, so the four gate checks and the idempotency key
 * cannot be forgotten by one call site. `dedupeKey` is the message's natural identity,
 * which is what lets an hourly cron fire twice in a slot and send once.
 */
async function sendIntroSms(
  database: Database,
  deps: IntroSweepDeps,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
  },
): Promise<SendOutcome> {
  const verdict = await assertProactiveSendAllowed(
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      kind: 'village_intro',
      now: input.now,
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) return { sent: false, held: verdict.reason };

  if (await deps.dedupeActive(database, input.dedupeKey)) return { sent: false };

  const to = await deps.resolveSendablePhone(database, input.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`village intros: no send target for parent ${input.parentUserId}`);
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
  return { sent: true };
}

/** Phase 1 — ask the families that could be matched whether they want to be. */
async function runAskPhase(
  database: Database,
  deps: IntroSweepDeps,
  families: readonly IntroSweepFamily[],
  result: IntroSweepResult,
  now: Date,
): Promise<void> {
  const byFsa = new Map<string, number>();
  for (const family of families) {
    const fsa = normalizeFsa(family.areaCoarse);
    if (fsa) byFsa.set(fsa, (byFsa.get(fsa) ?? 0) + 1);
  }

  const asked = await deps.askedUserIds(
    database,
    families.map((f) => f.parentUserId),
  );

  for (const family of families) {
    const fsa = normalizeFsa(family.areaCoarse);
    // Alone in their FSA: there is nobody to introduce them to, so the question would
    // be an unprompted text about a thing that cannot happen.
    if (!fsa || (byFsa.get(fsa) ?? 0) < 2) continue;
    if (asked.has(family.parentUserId)) continue;

    try {
      const outcome = await sendIntroSms(database, deps, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        body: DISCOVERABILITY_ASK,
        templateKey: 'village_intro:discoverability_ask',
        dedupeKey: `village_intro:ask:${family.familyId}`,
        now,
      });
      if (outcome.held) {
        result.held[outcome.held] += 1;
        continue;
      }
      if (!outcome.sent) continue;
      result.asked += 1;
      await deps.audit(database, {
        familyId: family.familyId,
        actor: 'system',
        actionTaken: 'village_intro_ask_sent',
        targetTable: 'families',
        targetId: family.familyId,
        after: { fsa },
      });
    } catch (err) {
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'village intros: ask failed');
    }
  }
}

/** Phase 2a — pair the families that opted in. */
async function runMatchPhase(
  database: Database,
  deps: IntroSweepDeps,
  families: readonly IntroSweepFamily[],
  result: IntroSweepResult,
  now: Date,
): Promise<void> {
  const discoverable = await deps.discoverableUserIds(
    database,
    families.map((f) => f.parentUserId),
  );
  const optedIn = families.filter((f) => discoverable.has(f.parentUserId));
  if (optedIn.length < 2) return;

  const [openFamilyIds, pairedBefore] = await Promise.all([
    deps.loadOpenProposalFamilyIds(database),
    deps.loadPairedBefore(database),
  ]);

  const candidates = await Promise.all(
    optedIn.map(async (family) => ({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      fsa: family.areaCoarse,
      parentEmail: family.parentEmail,
      parentName: family.parentName,
      children: await deps.loadChildren(database, family.familyId),
    })),
  );

  const match = matchIntroPairs({
    families: candidates,
    familiesWithOpenProposal: openFamilyIds,
    pairedBefore,
    now,
  });
  for (const skip of match.skipped) result.skipped[skip.reason] += 1;

  const expiresAt = new Date(now.getTime() + INTRO_EXPIRY_DAYS * 24 * 3_600_000);
  for (const pairing of match.pairings) {
    try {
      const anchor = await deps.loadAnchorSession(database, pairing.fsa, now);
      const proposalId = await deps.createProposal(database, {
        ...pairing,
        civicSessionId: anchor?.id ?? null,
        expiresAt,
      });
      result.proposed += 1;
      for (const familyId of [pairing.familyAId, pairing.familyBId]) {
        await deps.audit(database, {
          familyId,
          actor: 'system',
          actionTaken: 'village_intro_proposed',
          targetTable: 'village_intro_proposals',
          targetId: proposalId,
          // The counterpart id is named on purpose: a PIPEDA right-to-access read has to
          // be able to answer "who were we lined up with", and a family id is not PII.
          after: {
            counterpartFamilyId: familyId === pairing.familyAId ? pairing.familyBId : pairing.familyAId,
            fsa: pairing.fsa,
            stage: pairing.stage,
            anchored: anchor !== null,
          },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error({ err, fsa: pairing.fsa }, 'village intros: pairing failed');
    }
  }
}

/** One side of a live proposal, resolved into everything a card or a close needs. */
interface Side {
  familyId: string;
  childId: string | null;
  askedAt: Date | null;
  reply: 'yes' | 'no' | null;
}

function sidesOf(proposal: SweepProposal): Array<{ key: 'a' | 'b'; self: Side; other: Side }> {
  const a: Side = {
    familyId: proposal.familyAId,
    childId: proposal.familyAChildId,
    askedAt: proposal.familyAAskedAt,
    reply: proposal.familyAReply,
  };
  const b: Side = {
    familyId: proposal.familyBId,
    childId: proposal.familyBChildId,
    askedAt: proposal.familyBAskedAt,
    reply: proposal.familyBReply,
  };
  return [
    { key: 'a', self: a, other: b },
    { key: 'b', self: b, other: a },
  ];
}

/** Phase 2b + 3 — card the open pairs, then resolve the finished ones. */
async function runProposalPhase(
  database: Database,
  deps: IntroSweepDeps,
  families: readonly IntroSweepFamily[],
  result: IntroSweepResult,
  now: Date,
): Promise<void> {
  const byId = new Map(families.map((family) => [family.familyId, family]));
  const proposals = await deps.loadLiveProposals(database, now);

  for (const proposal of proposals) {
    try {
      // Expiry is decided here rather than by a clock elsewhere, so "past its window"
      // and "told the other side" are one pass over one row.
      const status =
        proposal.status === 'proposed' && proposal.expiresAt <= now ? 'expired' : proposal.status;

      if (status === 'proposed') {
        await cardUnaskedSides(database, deps, proposal, byId, result, now);
        continue;
      }
      if (status === 'both_accepted') {
        await introduce(database, deps, proposal, byId, result, now);
        continue;
      }
      await softClose(database, deps, proposal, status, byId, result, now);
    } catch (err) {
      result.failed += 1;
      console.error({ err, proposalId: proposal.id }, 'village intros: proposal step failed');
    }
  }
}

/** Text the coarse card to any side that has not had it yet. */
async function cardUnaskedSides(
  database: Database,
  deps: IntroSweepDeps,
  proposal: SweepProposal,
  byId: ReadonlyMap<string, IntroSweepFamily>,
  result: IntroSweepResult,
  now: Date,
): Promise<void> {
  for (const side of sidesOf(proposal)) {
    if (side.self.askedAt !== null) continue;
    const family = byId.get(side.self.familyId);
    // A child removed since the pairing leaves nothing to word the card around, and
    // guessing a different child would change what the parent was asked about.
    if (!family || side.self.childId === null) continue;

    const children = await deps.loadChildren(database, family.familyId);
    const child = children.find((c) => c.id === side.self.childId);
    if (!child) continue;

    const nameLevel = await deps.loadNameLevel(database, family.parentUserId);
    const anchor =
      proposal.anchorTitle !== null && proposal.anchorStartsAt !== null
        ? activityAnchor(proposal.anchorTitle, weekdayIn(proposal.anchorStartsAt, family.timeZone))
        : null;
    // loopChildName composes the parent's dial with the deterministic teen gate, so a
    // 13+ child reads as "your kid" whatever the dial says (rule #1).
    const body = coarseCard(proposal.stage, `${loopChildName(child, nameLevel, now)}'s`, anchor);

    const outcome = await sendIntroSms(database, deps, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body,
      templateKey: 'village_intro:card',
      dedupeKey: `village_intro:card:${proposal.id}:${side.key}`,
      now,
    });
    if (outcome.held) {
      result.held[outcome.held] += 1;
      continue;
    }
    if (!outcome.sent) continue;

    await deps.markAsked(database, proposal.id, side.key, now);
    result.carded += 1;
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'village_intro_card_sent',
      targetTable: 'village_intro_proposals',
      targetId: proposal.id,
      // Enum-shaped provenance only, never the rendered body (rule #1).
      after: { stage: proposal.stage, anchored: anchor !== null },
    });
  }
}

/** Both sides said yes: send the one email, audit BOTH families, close the pair. */
async function introduce(
  database: Database,
  deps: IntroSweepDeps,
  proposal: SweepProposal,
  byId: ReadonlyMap<string, IntroSweepFamily>,
  result: IntroSweepResult,
  now: Date,
): Promise<void> {
  const familyA = byId.get(proposal.familyAId);
  const familyB = byId.get(proposal.familyBId);
  if (!familyA?.parentEmail || !familyA.parentName || !familyB?.parentEmail || !familyB.parentName) {
    // The matcher only pairs families that HAVE both, so losing one between the pairing
    // and the handoff is a real state change, not a shape to design around: the pair
    // stays open and visible rather than closing as if it had been introduced.
    result.introFailed += 1;
    return;
  }

  const outcome = await deps.email.send({
    parentA: { firstName: introFirstName(familyA.parentName), email: familyA.parentEmail },
    parentB: { firstName: introFirstName(familyB.parentName), email: familyB.parentEmail },
    stage: proposal.stage,
    anchorTitle: proposal.anchorTitle,
  });
  if (outcome.status !== 'sent') {
    // NOT closed and NOT audited as disclosed. Nothing was disclosed, so saying it was
    // would put a false entry in the one record PIPEDA right-to-access reads.
    result.introFailed += 1;
    console.error(
      { proposalId: proposal.id, outcome: outcome.status },
      'village intros: introduction not delivered',
    );
    return;
  }

  for (const [self, other] of [
    [proposal.familyAId, proposal.familyBId],
    [proposal.familyBId, proposal.familyAId],
  ] as const) {
    await deps.audit(database, {
      familyId: self,
      actor: 'system',
      actionTaken: 'village_intro_disclosed',
      targetTable: 'village_intro_proposals',
      targetId: proposal.id,
      // EXACTLY what crossed the household boundary, field by field. A disclosure the
      // trail describes only as "an intro was sent" is unanswerable in a right-to-access
      // request, which is the one question this row exists to answer (rule #6).
      after: {
        counterpartFamilyId: other,
        channel: 'email',
        disclosedFields: [
          'parent_first_name',
          'parent_email',
          'child_stage',
          'activity_title',
        ],
        anchored: proposal.anchorTitle !== null,
      },
    });
  }

  await deps.setStatus(database, proposal.id, 'both_accepted', true, now);
  result.introduced += 1;
}

/**
 * The pair is dead. Tell every side that was asked and did not itself refuse, in the
 * one sentence that is the same for all three ways it could have died.
 */
async function softClose(
  database: Database,
  deps: IntroSweepDeps,
  proposal: SweepProposal,
  status: 'declined' | 'expired',
  byId: ReadonlyMap<string, IntroSweepFamily>,
  result: IntroSweepResult,
  now: Date,
): Promise<void> {
  for (const side of sidesOf(proposal)) {
    // Never asked: they have no open question, so a close would be Hale answering
    // something it never said. Said no: they were already acknowledged.
    if (side.self.askedAt === null || side.self.reply === 'no') continue;
    const family = byId.get(side.self.familyId);
    if (!family) continue;

    const outcome = await sendIntroSms(database, deps, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: INTRO_SOFT_CLOSE,
      templateKey: 'village_intro:soft_close',
      dedupeKey: `village_intro:close:${proposal.id}:${side.key}`,
      now,
    });
    if (outcome.held) {
      result.held[outcome.held] += 1;
      continue;
    }
    if (!outcome.sent) continue;
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'village_intro_closed',
      targetTable: 'village_intro_proposals',
      targetId: proposal.id,
      // The REASON is recorded here and only here. It is the fact the outbound sentence
      // deliberately withholds, and the trail is the right place for it.
      after: { status },
    });
  }

  await deps.setStatus(database, proposal.id, status, true, now);
  result.closed += 1;
}

export async function runVillageIntroSweep(
  database: Database,
  deps: IntroSweepDeps = defaultIntroSweepDeps(),
  now: Date = new Date(),
): Promise<IntroSweepResult> {
  const allFamilies = villageIntrosEnabled();
  const allowlist = villageIntrosAllowlist();
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const families = (await deps.selectFamilies(database, now))
    .filter((family) => allFamilies || allowlist.has(family.familyId))
    .slice(0, MAX_FAMILIES_PER_RUN);
  if (families.length === 0) return result;

  await runAskPhase(database, deps, families, result, now);
  await runMatchPhase(database, deps, families, result, now);
  await runProposalPhase(database, deps, families, result, now);
  return result;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The families an intro could reach: settled SMS households with a primary parent.
 * Consent, enrolment, volume and the clock are the GATE's business — selecting on them
 * here would put the same policy in two places and let them disagree. */
async function selectIntroFamilies(database: Database): Promise<IntroSweepFamily[]> {
  return database
    .select({
      familyId: schema.families.id,
      areaCoarse: schema.families.areaCoarse,
      parentUserId: schema.users.id,
      parentName: schema.users.name,
      parentEmail: schema.users.email,
      timeZone: schema.users.timezone,
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

async function readIntroChildren(
  database: Database,
  familyId: string,
): Promise<IntroSweepChild[]> {
  return database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      gender: schema.children.gender,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

/** Every parent who has ANY row on the discoverability scope — a grant or a decline.
 * Either one is proof the question was put, and the question is asked once. */
async function readAskedUserIds(
  database: Database,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await database
    .select({ userId: schema.consentRecords.userId })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.consentType, 'village_intro'),
        eq(schema.consentRecords.consentScope, 'village_intro:discoverability'),
      ),
    );
  const asked = new Set(rows.map((row) => row.userId));
  return new Set(userIds.filter((id) => asked.has(id)));
}

async function readOpenProposalFamilyIds(database: Database): Promise<Set<string>> {
  const rows = await database
    .select({
      familyAId: schema.villageIntroProposals.familyAId,
      familyBId: schema.villageIntroProposals.familyBId,
    })
    .from(schema.villageIntroProposals)
    .where(isNull(schema.villageIntroProposals.closedAt));
  return new Set(rows.flatMap((row) => [row.familyAId, row.familyBId]));
}

/** Every pair that has EVER been proposed. Not just declines: a pair is asked once,
 * whatever happened, because asking twice is how a "no" becomes nagging. */
async function readPairedBefore(database: Database): Promise<Set<string>> {
  const rows = await database
    .select({
      familyAId: schema.villageIntroProposals.familyAId,
      familyBId: schema.villageIntroProposals.familyBId,
    })
    .from(schema.villageIntroProposals);
  return new Set(rows.map((row) => pairKey(row.familyAId, row.familyBId)));
}

/**
 * The soonest free civic session in this FSA that both families could plausibly be at.
 *
 * Occurrence rows only. A weekly EarlyON slot has no date of its own — expanding it
 * into one is the civic projection's job, and an anchor that names a day Hale computed
 * rather than a day the venue published is the kind of small wrongness that makes a
 * parent show up on the wrong morning.
 *
 * The venue's FSA is derived in SQL from its own published postal code — a venue's
 * address is public, and it is the only postal code in this query.
 */
async function readAnchorSession(
  database: Database,
  fsa: string,
  now: Date,
): Promise<{ id: string; title: string; startsAt: Date } | null> {
  const horizon = new Date(now.getTime() + ANCHOR_HORIZON_DAYS * 24 * 3_600_000);
  const [row] = await database
    .select({
      id: schema.civicSessions.id,
      title: schema.civicSessions.title,
      startsAt: schema.civicSessions.startsAt,
    })
    .from(schema.civicSessions)
    .innerJoin(schema.civicVenues, eq(schema.civicVenues.id, schema.civicSessions.venueId))
    .where(
      and(
        eq(schema.civicSessions.recurrence, 'occurrence'),
        eq(schema.civicSessions.isCancelled, false),
        isNull(schema.civicSessions.supersededAt),
        gte(schema.civicSessions.confidence, MIN_SURFACE_CONFIDENCE),
        gte(schema.civicSessions.startsAt, now),
        lte(schema.civicSessions.startsAt, horizon),
        eq(sql`upper(left(replace(${schema.civicVenues.postalCode}, ' ', ''), 3))`, fsa),
      ),
    )
    .orderBy(asc(schema.civicSessions.startsAt))
    .limit(1);
  if (!row?.startsAt) return null;
  return { id: row.id, title: row.title, startsAt: row.startsAt };
}

async function insertProposal(
  database: Database,
  input: Parameters<IntroSweepDeps['createProposal']>[1],
): Promise<string> {
  const [row] = await database
    .insert(schema.villageIntroProposals)
    .values({
      familyAId: input.familyAId,
      familyBId: input.familyBId,
      familyAChildId: input.familyAChildId,
      familyBChildId: input.familyBChildId,
      fsa: input.fsa,
      stage: input.stage,
      status: 'proposed',
      civicSessionId: input.civicSessionId,
      expiresAt: input.expiresAt,
    })
    .returning({ id: schema.villageIntroProposals.id });
  if (!row) throw new Error('village intros: proposal insert returned no row');
  return row.id;
}

async function readLiveProposals(database: Database): Promise<SweepProposal[]> {
  const rows = await database
    .select({
      id: schema.villageIntroProposals.id,
      fsa: schema.villageIntroProposals.fsa,
      stage: schema.villageIntroProposals.stage,
      status: schema.villageIntroProposals.status,
      familyAId: schema.villageIntroProposals.familyAId,
      familyBId: schema.villageIntroProposals.familyBId,
      familyAChildId: schema.villageIntroProposals.familyAChildId,
      familyBChildId: schema.villageIntroProposals.familyBChildId,
      familyAAskedAt: schema.villageIntroProposals.familyAAskedAt,
      familyBAskedAt: schema.villageIntroProposals.familyBAskedAt,
      familyAReply: schema.villageIntroProposals.familyAReply,
      familyBReply: schema.villageIntroProposals.familyBReply,
      expiresAt: schema.villageIntroProposals.expiresAt,
      anchorTitle: schema.civicSessions.title,
      anchorStartsAt: schema.civicSessions.startsAt,
      anchorCancelled: schema.civicSessions.isCancelled,
      anchorSuperseded: schema.civicSessions.supersededAt,
    })
    .from(schema.villageIntroProposals)
    .leftJoin(
      schema.civicSessions,
      eq(schema.civicSessions.id, schema.villageIntroProposals.civicSessionId),
    )
    .where(isNull(schema.villageIntroProposals.closedAt));

  return rows.map((row) => ({
    ...row,
    stage: row.stage as FamilyStage,
    // An anchor that has since been cancelled or retired is dropped rather than
    // repeated: a card that names a session which is not happening is worse than one
    // with no anchor at all.
    anchorTitle:
      row.anchorCancelled === true || row.anchorSuperseded !== null ? null : row.anchorTitle,
    anchorStartsAt:
      row.anchorCancelled === true || row.anchorSuperseded !== null ? null : row.anchorStartsAt,
  }));
}

export function defaultIntroSweepDeps(): IntroSweepDeps {
  return {
    selectFamilies: (database) => selectIntroFamilies(database),
    discoverableUserIds,
    askedUserIds: readAskedUserIds,
    loadChildren: readIntroChildren,
    loadNameLevel: async (database, parentUserId) =>
      (await loadLoopPrefsView(parentUserId, database)).childNameLevel,
    loadOpenProposalFamilyIds: readOpenProposalFamilyIds,
    loadPairedBefore: readPairedBefore,
    loadAnchorSession: readAnchorSession,
    createProposal: insertProposal,
    loadLiveProposals: (database) => readLiveProposals(database),
    markAsked: async (database, proposalId, side, now) => {
      await database
        .update(schema.villageIntroProposals)
        .set(
          side === 'a'
            ? { familyAAskedAt: now, updatedAt: now }
            : { familyBAskedAt: now, updatedAt: now },
        )
        .where(eq(schema.villageIntroProposals.id, proposalId));
    },
    setStatus: async (database, proposalId, status, closed, now) => {
      await database
        .update(schema.villageIntroProposals)
        .set({ status, ...(closed ? { closedAt: now } : {}), updatedAt: now })
        .where(eq(schema.villageIntroProposals.id, proposalId));
    },
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
          category: 'village_intro',
          templateKey: write.templateKey,
          dedupeKey: write.dedupeKey,
          providerMessageId: write.providerMessageId,
          status: 'sent',
          sentAt: write.sentAt,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('village intros: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    transport: createTwilioTransport(),
    email: createIntroEmailSender(),
  };
}
