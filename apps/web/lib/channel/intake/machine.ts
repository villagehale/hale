import { type Database, schema } from '@hale/db';
import {
  resolveVerifiedChannelByPhone,
  revokeSmsChannel,
} from '~/lib/channels/sms-consent-core';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import {
  declineOpenInviteOnStop,
  loadOpenInviteByPhone,
} from '~/lib/channel/caregiver/invites';
import {
  type CaregiverOutcome,
  handleCaregiverInviteReply,
  handleKnownNumberInbound,
} from '~/lib/channel/caregiver/route';
import { projectCivicCandidates } from '~/lib/civic/project';
import {
  type DiscoveryTrigger,
  defaultDiscoveryTrigger,
} from '~/lib/onboarding/trigger-discovery';
import { optOutGuestRemindersOnStop } from '~/lib/party/store';
import { findRevokedChannelOwner, reenrolOnStart } from './channel-state';
import {
  AMBIGUOUS_CLARIFY,
  ASSENT_ACK,
  DECLINE_ACK,
  HELP_REPLY,
  type IntakeGap,
  REGION_UNAVAILABLE_REPLY,
  START_ACK,
  STOP_ACK,
  WATCH_OFFER,
  assistantDisclosure,
  detailsBlocked,
  followUp,
  greeting,
  sourceCodeFromBody,
  venueForCode,
} from './copy';
import { parseCanadianPostal, summarizeChildren } from './derive';
import type { ExtractedChild, IntakeCollected, IntakeExtractor } from './extract';
import type { ReplyIntent, ReplyIntentReader } from './intent';
import { matchKeyword } from './keywords';
import { type IntakeLocation, type ProvisionChild, provisionFromIntake } from './provision';
import type { RadarComposer } from './radar';
import {
  type IntakeSession,
  type IntakeState,
  type SessionPatch,
  type TranscriptEntry,
  createSession,
  loadOpenSession,
  saveSession,
} from './session';
import { recordWatchConsent } from './watch-consent';

/**
 * VIL-237 · M2 — the conversational SMS intake state machine.
 *
 * ONE entry point, `handleInboundSms`, and a strict order of operations that the whole
 * design rests on:
 *
 *   1. normalize the number   — a number we can't parse can't be replied to at all
 *   2. rate limit             — before any spend, any write, any model call
 *   3. duplicate check        — a carrier retry must be a no-op, not a second reply
 *   4. CASL keywords          — STOP is a legal instruction, never an interpretation
 *   5. the stored state       — read from the row, never inferred from the transcript
 *   6. only then, the model
 *
 * Steps 1–4 are deterministic and cannot be reordered: every one of them exists
 * because doing it AFTER the model call would mean a model deciding something that
 * isn't a model's to decide, or spending money on traffic we should have dropped.
 */

const INTAKE_ROUTE = 'sms-inbound';

export interface IntakeDeps {
  transport: { send(input: { to: string; body: string }): Promise<{ providerMessageId: string }> };
  extractor: IntakeExtractor;
  intentReader: ReplyIntentReader;
  radar: RadarComposer;
  limiter: RateLimiter;
  /** Places this family near the free civic sessions already on file, INLINE — pure DB
   * work over rows the civic sweep wrote days ago, so it is fast enough to run before
   * the first reply is composed and is the difference between a real first radar and
   * "still learning your area". */
  seedCivic?: (
    database: Database,
    familyId: string,
    areaCoarse: string | null,
    now: Date,
  ) => Promise<number>;
  /** Populates the village in the BACKGROUND (one model call + geocodes — far too slow
   * for an inbound webhook). Its payoff is the 48h nudge, which otherwise sweeps a
   * family whose candidate table is empty. Same trigger the web onboarding path uses. */
  discoveryTrigger?: DiscoveryTrigger;
  now?: Date;
}

export type IntakeOutcome =
  | { status: 'greeted' }
  | { status: 'follow_up_asked' }
  /** Something Hale will not invent is still missing after the one follow-up. */
  | { status: 'details_blocked'; missing: IntakeGap[] }
  | { status: 'provisioned'; familyId: string }
  | { status: 'watch_recorded'; intent: ReplyIntent; granted: boolean }
  | { status: 'clarified' }
  | { status: 'stopped' }
  | { status: 'helped' }
  | { status: 'restarted' }
  | { status: 'region_unavailable' }
  | { status: 'rate_limited' }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: 'invalid_number' | 'no_open_conversation' }
  // VIL-241 · M6 — the caregiver branches. They share this entry point because a
  // caregiver texts the SAME number a parent does; what differs is who the number
  // belongs to, which is a lookup, not a second inbox.
  | CaregiverOutcome;

interface Inbound {
  from: string;
  body: string;
  providerId: string;
  receivedAt: Date;
}

export async function handleInboundSms(
  database: Database,
  inbound: Inbound,
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const now = deps.now ?? inbound.receivedAt;

  // 1. A number we cannot canonicalize is a number we cannot hash, look up, or text
  // back. Dropping it is the only honest option — there is nobody to answer.
  const phoneE164 = normalizePhoneE164(inbound.from);
  if (!phoneE164) {
    return { status: 'ignored', reason: 'invalid_number' };
  }
  const phoneHash = phoneBlindIndex(phoneE164);

  // 2. Rate limit, keyed by the BLIND INDEX (the raw number never reaches the limiter
  // table). Over the limit we go SILENT rather than replying "slow down": a reply is
  // itself an outbound SMS, so answering a flood would hand an SMS-pumping attacker
  // exactly the amplification they came for.
  const decision = await deps.limiter.check(phoneHash, INTAKE_ROUTE, RATE_LIMITS[INTAKE_ROUTE]);
  if (!decision.allowed) {
    return { status: 'rate_limited' };
  }

  const session = await loadOpenSession(database, phoneE164);

  // 3. The carrier retried. The provider id is the same, so this is not a parent
  // texting twice — replying again would double every message in the conversation.
  if (session && session.lastProviderId === inbound.providerId) {
    return { status: 'duplicate' };
  }

  const keyword = matchKeyword(inbound.body);
  if (keyword) {
    return handleKeyword(database, { keyword, phoneE164, inbound, session, now }, deps);
  }

  if (!session || session.state === 'stopped') {
    // No conversation is open. A first-ever text starts one; a text after the flow has
    // finished belongs to the loop's inbound-reply seam (A3/C3), not here — answering
    // it with a canned blurb would teach a parent that Hale doesn't listen.
    if (session) {
      return { status: 'ignored', reason: 'no_open_conversation' };
    }

    // VIL-241 · a number we have texted an invite to is answering a QUESTION we asked.
    // Checked before the greeting, or a caregiver's "yes" would be read as a stranger
    // starting an intake and they would be asked for their children's names.
    const invite = await loadOpenInviteByPhone(database, phoneE164, now);
    if (invite?.state === 'awaiting_caregiver_reply') {
      return handleCaregiverInviteReply(database, { invite, phoneE164, inbound, now }, deps);
    }

    const existing = await resolveVerifiedChannelByPhone(database, phoneE164);
    if (existing) {
      // Either a caregiver (who gets the one scoped line) or a parent adding one. Any
      // other message keeps the old silence.
      const outcome = await handleKnownNumberInbound(
        database,
        { owner: existing, phoneE164, inbound, now },
        deps,
      );
      return outcome ?? { status: 'ignored', reason: 'no_open_conversation' };
    }
    return greet(database, { phoneE164, inbound, now }, deps);
  }

  if (session.state === 'awaiting_watch_reply' || session.state === 'awaiting_clarify') {
    return handleWatchReply(database, { session, phoneE164, inbound, now }, deps);
  }

  return handleDetails(database, { session, phoneE164, inbound, now }, deps);
}

// ── outbound plumbing ────────────────────────────────────────────────────────

interface SendContext {
  session: IntakeSession;
  phoneE164: string;
  now: Date;
}

/**
 * Send one message and record it. Where the record LANDS depends on whether a family
 * exists yet: channel_messages.family_id and .parent_user_id are NOT NULL, so a
 * pre-provisioning message has no row it could legally occupy. Those live encrypted on
 * the intake session and are replayed into channel_messages at provisioning — so the
 * ledger ends up complete either way, it just cannot be written in real time.
 */
async function sendAndRecord(
  database: Database,
  ctx: SendContext,
  body: string,
  deps: IntakeDeps,
  transcript: TranscriptEntry[],
): Promise<TranscriptEntry[]> {
  const { providerMessageId } = await deps.transport.send({ to: ctx.phoneE164, body });
  const entry: TranscriptEntry = {
    direction: 'out',
    body,
    providerId: providerMessageId,
    at: ctx.now.toISOString(),
  };
  if (ctx.session.familyId && ctx.session.userId) {
    await writeChannelMessage(database, ctx.session, entry, ctx.now);
    return transcript;
  }
  return [...transcript, entry];
}

/** Record an inbound. Same pre/post-provisioning split as {@link sendAndRecord};
 * returns the channel_messages id when there was one to write (the consent evidence
 * points at it). */
async function recordInbound(
  database: Database,
  ctx: SendContext,
  inbound: Inbound,
  transcript: TranscriptEntry[],
): Promise<{ transcript: TranscriptEntry[]; channelMessageId: string | null }> {
  const entry: TranscriptEntry = {
    direction: 'in',
    body: inbound.body,
    providerId: inbound.providerId,
    at: inbound.receivedAt.toISOString(),
  };
  if (ctx.session.familyId && ctx.session.userId) {
    const id = await writeChannelMessage(database, ctx.session, entry, ctx.now);
    return { transcript, channelMessageId: id };
  }
  return { transcript: [...transcript, entry], channelMessageId: null };
}

/** One channel_messages row + its audit row (rule #6: no message without a trail). */
async function writeChannelMessage(
  database: Database,
  session: IntakeSession,
  entry: TranscriptEntry,
  now: Date,
): Promise<string> {
  const familyId = session.familyId as string;
  const parentUserId = session.userId as string;
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: entry.direction,
      category: 'intake',
      providerMessageId: entry.providerId,
      status: entry.direction === 'in' ? 'delivered' : 'sent',
      // Verbatim bodies for INBOUND only — an outbound is reconstructable from the
      // copy module, and storing rendered child data is a liability (rule #1).
      body: entry.direction === 'in' ? entry.body : null,
      sentAt: now,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) {
    throw new Error('writeChannelMessage: channel_messages insert returned no row');
  }
  await database.insert(schema.auditLog).values({
    familyId,
    actor: parentUserId,
    actionTaken: entry.direction === 'in' ? 'sms_intake_inbound' : 'sms_intake_outbound',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

// ── branches ─────────────────────────────────────────────────────────────────

async function greet(
  database: Database,
  args: { phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const sourceCode = sourceCodeFromBody(args.inbound.body);
  const session = await createSession(database, {
    phoneE164: args.phoneE164,
    state: 'awaiting_details',
    sourceCode,
  });
  const ctx: SendContext = { session, phoneE164: args.phoneE164, now: args.now };

  const recorded = await recordInbound(database, ctx, args.inbound, session.transcript);
  const venue = venueForCode(sourceCode);
  // The disclosure rides on the first reply only — one message in, a stranger knows
  // they are texting software and where the privacy terms are.
  const body = `${greeting(venue?.name ?? null)}\n\n${assistantDisclosure()}`;
  const transcript = await sendAndRecord(database, ctx, body, deps, recorded.transcript);

  await saveSession(
    database,
    session,
    { state: 'awaiting_details', transcript, lastProviderId: args.inbound.providerId },
    args.now,
  );
  return { status: 'greeted' };
}

async function handleDetails(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const ctx: SendContext = { session, phoneE164: args.phoneE164, now };
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);
  let transcript = recorded.transcript;

  const collected = await deps.extractor.extract({
    message: inbound.body,
    alreadyKnown: session.collected,
  });

  const base: SessionPatch = { collected, lastProviderId: inbound.providerId };

  // Nothing readable came back. The honest response is to say what Hale is for, not to
  // ask the same question again in different words.
  if (collected.children.length === 0) {
    transcript = await sendAndRecord(database, ctx, HELP_REPLY, deps, transcript);
    await saveSession(database, session, { ...base, transcript }, now);
    return { status: 'helped' };
  }

  const location = resolveLocation(collected, session.sourceCode);
  if (location === 'unsupported_region') {
    transcript = await sendAndRecord(database, ctx, REGION_UNAVAILABLE_REPLY, deps, transcript);
    await saveSession(
      database,
      session,
      { ...base, transcript, state: 'complete', closedAt: now },
      now,
    );
    return { status: 'region_unavailable' };
  }

  // The two things Hale refuses to make up. They share ONE ladder because they are the
  // same kind of blocker: a family cannot be set up on a guess, and a guessed age is
  // worse than a guessed postal code — the date it produces is what every stage,
  // checkpoint and registration band is computed from ever after.
  const children = withKnownAges(collected.children);
  if (children === null || location === null) {
    const missing: IntakeGap[] = [
      ...(children === null ? (['ages'] as const) : []),
      ...(location === null ? (['location'] as const) : []),
    ];
    // Exactly ONE targeted follow-up — asking for everything outstanding, because it is
    // the only ask there will be. After that, Hale states the blocker once and goes
    // quiet: a third ask is nagging, and the session stays open so an answer sent later
    // still completes the setup.
    if (session.followUpCount === 0) {
      const body = followUp(summarizeChildren(collected.children), missing);
      transcript = await sendAndRecord(database, ctx, body, deps, transcript);
      await saveSession(
        database,
        session,
        { ...base, transcript, state: 'awaiting_follow_up', followUpCount: 1 },
        now,
      );
      return { status: 'follow_up_asked' };
    }
    if (session.followUpCount === 1) {
      transcript = await sendAndRecord(database, ctx, detailsBlocked(missing), deps, transcript);
      await saveSession(database, session, { ...base, transcript, followUpCount: 2 }, now);
      return { status: 'details_blocked', missing };
    }
    await saveSession(database, session, { ...base, transcript }, now);
    return { status: 'details_blocked', missing };
  }

  return provision(database, { session, phoneE164: args.phoneE164, inbound, now }, deps, {
    collected,
    children,
    location,
    transcript,
  });
}

/**
 * The children, every one of whose age we were actually told — or null when any was
 * left out. Null is the whole point: {@link ProvisionChild} has a non-null age, so a
 * child we know only the name of cannot reach provisioning at all, and no branch
 * downstream has to decide what date to invent for them.
 */
function withKnownAges(children: readonly ExtractedChild[]): ProvisionChild[] | null {
  const known: ProvisionChild[] = [];
  for (const child of children) {
    if (child.ageMonths === null || child.agePrecision === null) return null;
    known.push({ name: child.name, ageMonths: child.ageMonths, agePrecision: child.agePrecision });
  }
  return known;
}

/**
 * Where the family is, or why we can't say. Three outcomes, and the distinction
 * matters: a postal code we can't place is a COMPLIANCE refusal (rule #1 — Hale is
 * cleared for Canada only), while no postal code at all is just an unanswered
 * question. Conflating them would either turn a shy parent away or quietly onboard a
 * family Hale isn't cleared to serve.
 */
function resolveLocation(
  collected: IntakeCollected,
  sourceCode: string | null,
): IntakeLocation | null | 'unsupported_region' {
  if (collected.postalCode) {
    return parseCanadianPostal(collected.postalCode) ?? 'unsupported_region';
  }
  const venue = venueForCode(sourceCode);
  if (venue) {
    // The venue's own area — a fact about where the poster hangs, never an address.
    return { postalCode: null, areaCoarse: venue.areaCoarse };
  }
  return null;
}

async function provision(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  gathered: {
    collected: IntakeCollected;
    children: ProvisionChild[];
    location: IntakeLocation;
    transcript: TranscriptEntry[];
  },
): Promise<IntakeOutcome> {
  const { session, phoneE164, inbound, now } = args;
  const firstInbound = gathered.transcript.find((e) => e.direction === 'in');

  const { familyId, userId } = await provisionFromIntake(database, {
    phoneE164,
    phoneHash: session.phoneHash,
    children: gathered.children,
    location: gathered.location,
    sourceCode: session.sourceCode,
    firstMessage: firstInbound?.body ?? inbound.body,
    transcript: gathered.transcript,
    now,
  });

  // From here the session HAS a family, so messages go straight to channel_messages —
  // the transcript it carried has just been replayed there.
  const provisioned: IntakeSession = { ...session, familyId, userId };
  const ctx: SendContext = { session: provisioned, phoneE164, now };

  await seedFirstRadar(database, { familyId, areaCoarse: gathered.location.areaCoarse, now }, deps);

  const radar = await deps.radar.compose({
    familyId,
    children: gathered.collected.children,
    areaCoarse: gathered.location.areaCoarse,
  });
  await sendAndRecord(database, ctx, `${radar.message}\n\n${WATCH_OFFER}`, deps, []);

  await saveSession(
    database,
    session,
    {
      collected: gathered.collected,
      transcript: gathered.transcript,
      state: 'awaiting_watch_reply',
      familyId,
      userId,
      lastProviderId: inbound.providerId,
    },
    now,
  );
  return { status: 'provisioned', familyId };
}

/**
 * Give the first reply something true to say, and the 48h nudge something to find.
 *
 * A family that has existed for four milliseconds has no village candidates and no
 * civic placements, so the radar could only ever answer "still learning your area" —
 * the emptiest possible first impression, on the one message a stranger is guaranteed
 * to read. The web onboarding path already solved half of this (complete-onboarding
 * fires the same discovery trigger); intake never did either half.
 *
 * The split is by COST. The civic projection is pure DB work over rows the sweep wrote
 * days ago, so it runs INLINE and its output is visible to the radar composed one line
 * later. Discovery is a model call plus geocodes, far past a Twilio webhook's budget,
 * so it runs in the background and pays off at the 48h nudge instead.
 *
 * Neither may fail the intake: a parent has already been provisioned by this point, and
 * a missing weekend suggestion is not worth losing them over (rule #8 boundary catch).
 */
async function seedFirstRadar(
  database: Database,
  args: { familyId: string; areaCoarse: string | null; now: Date },
  deps: IntakeDeps,
): Promise<void> {
  try {
    const seedCivic = deps.seedCivic ?? projectCivicCandidates;
    await seedCivic(database, args.familyId, args.areaCoarse, args.now);
  } catch (err) {
    console.error('intake civic projection failed (intake unaffected)', err);
  }
  try {
    const trigger = deps.discoveryTrigger ?? defaultDiscoveryTrigger();
    trigger(args.familyId, database);
  } catch (err) {
    console.error('intake first-village discovery trigger failed (intake unaffected)', err);
  }
}

async function handleWatchReply(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const ctx: SendContext = { session, phoneE164: args.phoneE164, now };
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);

  const reading = await deps.intentReader.read({ question: WATCH_OFFER, reply: inbound.body });

  // One gentle clarification, then Hale decides conservatively. Asking twice about
  // the same yes/no is pestering; guessing "yes" would manufacture consent.
  if (reading.intent === 'ambiguous' && session.clarifyCount === 0) {
    await sendAndRecord(database, ctx, AMBIGUOUS_CLARIFY, deps, recorded.transcript);
    await saveSession(
      database,
      session,
      { state: 'awaiting_clarify', clarifyCount: 1, lastProviderId: inbound.providerId },
      now,
    );
    return { status: 'clarified' };
  }

  const granted = reading.intent === 'assent';
  const interpretation =
    reading.intent === 'ambiguous'
      ? `still unclear after one clarification — recorded as no (${reading.interpretation})`
      : reading.interpretation;

  // Consent BEFORE the stage flip, in one transaction (see watch-consent.ts).
  await recordWatchConsent(
    database,
    {
      familyId: session.familyId as string,
      userId: session.userId as string,
      granted,
      verbatimReply: reading.verbatim,
      interpretation,
      channelMessageId: recorded.channelMessageId,
    },
    now,
  );

  await sendAndRecord(database, ctx, granted ? ASSENT_ACK : DECLINE_ACK, deps, recorded.transcript);
  await saveSession(
    database,
    session,
    { state: 'complete', closedAt: now, lastProviderId: inbound.providerId },
    now,
  );
  return { status: 'watch_recorded', intent: reading.intent, granted };
}

async function handleKeyword(
  database: Database,
  args: {
    keyword: 'stop' | 'help' | 'start';
    phoneE164: string;
    inbound: Inbound;
    session: IntakeSession | null;
    now: Date;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { keyword, phoneE164, inbound, session, now } = args;

  if (keyword === 'stop') {
    return handleStop(database, { phoneE164, inbound, session, now }, deps);
  }

  if (keyword === 'help') {
    if (!session) {
      // No conversation to record against (channel_messages needs a family, and the
      // session is what holds a pre-family transcript). Answer and stop there.
      await deps.transport.send({ to: phoneE164, body: HELP_REPLY });
      return { status: 'helped' };
    }
    const ctx: SendContext = { session, phoneE164, now };
    const recorded = await recordInbound(database, ctx, inbound, session.transcript);
    const transcript = await sendAndRecord(database, ctx, HELP_REPLY, deps, recorded.transcript);
    await saveSession(database, session, { transcript, lastProviderId: inbound.providerId }, now);
    return { status: 'helped' };
  }

  // START. If the number was unsubscribed, the keyword itself is express re-consent
  // (see channel-state.ts) — otherwise it opens a fresh conversation.
  const owner = await findRevokedChannelOwner(database, phoneE164);
  if (owner) {
    await reenrolOnStart(
      database,
      { ...owner, phoneE164, verbatimReply: inbound.body },
      now,
    );
    await deps.transport.send({ to: phoneE164, body: START_ACK });
    return { status: 'restarted' };
  }
  if (session) {
    return { status: 'ignored', reason: 'no_open_conversation' };
  }
  return greet(database, { phoneE164, inbound, now }, deps);
}

async function handleStop(
  database: Database,
  args: {
    phoneE164: string;
    inbound: Inbound;
    session: IntakeSession | null;
    now: Date;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { phoneE164, inbound, session, now } = args;

  // VIL-241 · "Reply STOP anytime" is printed on the invite, so it has to reach the
  // invite: a STOP from someone we asked but who never accepted closes the invitation
  // itself. Otherwise the only promise we made them would cover nothing.
  await declineOpenInviteOnStop(database, phoneE164, now);

  // VIL-245 · the same promise, printed on every party-guest text. A guest is not a
  // parent and has no channel to revoke — their consent lives on the RSVP row — so a
  // STOP has to reach that row directly, and it erases the stored number along with the
  // opt-in: the consent was the only basis for holding a non-user's number at all.
  await optOutGuestRemindersOnStop(database, phoneE164, now);

  // A STOP after provisioning must revoke the real channel + append the consent
  // withdrawal + audit — the enrolment engine already owns that transaction, so this
  // reuses it rather than writing a second revocation path that could drift from it.
  // Per-USER by construction: a caregiver's STOP revokes the caregiver's channel and
  // leaves every parent in the household subscribed.
  const owner =
    session?.familyId && session.userId
      ? { userId: session.userId, familyId: session.familyId }
      : await resolveVerifiedChannelByPhone(database, phoneE164);
  if (owner) {
    await revokeSmsChannel(
      database,
      { userId: owner.userId, familyId: owner.familyId },
      { now },
    );
  }

  // The one final confirmation carriers expect, and then silence.
  await deps.transport.send({ to: phoneE164, body: STOP_ACK });

  if (session) {
    await saveSession(
      database,
      session,
      { state: 'stopped', closedAt: now, lastProviderId: inbound.providerId },
      now,
    );
  }
  return { status: 'stopped' };
}

export type { IntakeState };
