import { type Database, schema } from '@hale/db';
import { cancelCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { familyHasSyntheticProbeChannel } from '~/lib/channels/sms-consent-core';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { posterLocation } from '~/lib/channel/intake/copy';
import { FOUNDER_PING_TEMPLATE_KEY, founderPing } from './copy';
import { type FounderChannel, resolveFounderChannel } from './channel';

/**
 * THE PING — a family arrives from one of the founder's own posters, and he is told, in
 * his own thread, with one word standing between him and a personal welcome.
 *
 * IT IS AN OFFER, SO IT IS A ROW. The sentence ends by ASKING ("Reply YES and I'll send
 * them your welcome note"), and on this product a question that lives only as prose
 * inside a sent SMS is a question the reply resolver cannot see — which is exactly how, on
 * 2026-08-20, a parent's acceptance of the health nudge's offer was read against two
 * unrelated standing questions and then refused. So the ping registers itself on the
 * MEM-10 open-loops ledger in the SAME flow as the send, and the YES resolves through the
 * same primitives every other answer on this channel does.
 *
 * WHOSE PROMISE IT IS. The offer is made TO THE FOUNDER, in his thread, so the ledger row
 * is his family's — that is what makes it readable by the family-scoped open-question
 * reader when he answers. What accepting it does is text a DIFFERENT household, which is
 * the one thing `family_id` cannot say, so the target travels on `subject_family_id`
 * (see the column's own note).
 *
 * WHAT THE PING MAY CONTAIN (rule #1). The poster, and nothing else. Not a parent's name,
 * not a child's, not an age, not a number, not an area finer than the place the poster
 * hangs in. The founder is a person reading an internal signal about a household he has
 * no relationship with yet; the location is enough to know which note to send, and
 * everything past it is a disclosure with no purpose.
 *
 * NOTHING IN HERE THROWS, for the reason the commitments ledger states about its own
 * writers: this runs immediately after a stranger has been provisioned and texted their
 * first radar, so an exception would cost the intake turn its success and buy a carrier
 * re-drive of the whole conversation. Every failure comes back as a named outcome with
 * the cost stated in the log (rule #11).
 */

/**
 * How long the offer stands.
 *
 * TWO DAYS. It is not a general number, it is this message's: the note says "one of our
 * first families", which is a thing you say to somebody who has just arrived. A welcome
 * that lands on the fourth day is not a welcome, it is a product remembering something.
 * Past the TTL the offer stops being answerable and no note is ever sent — the row stays
 * on the ledger as the account of an offer that lapsed.
 */
export const FOUNDER_WELCOME_TTL_HOURS = 48;

/** The at-most-once key for the ping, per arriving family. `channel_messages.dedupe_key`
 * is globally unique, so this is what makes a second completion — a re-drained job, a
 * carrier retry, a re-run of the same turn — cost one skipped send rather than a second
 * ping about a family the founder has already been told about. */
export function founderPingDedupeKey(newFamilyId: string): string {
  return `founder-welcome-ping:${newFamilyId}`;
}

/** The offer in one short sentence — the ledger's `summary`, and what the reply resolver
 * is shown as the standing question. It repeats the one fact the founder was already
 * texted and adds nothing (rule #1). */
export function founderWelcomeSummary(location: string): string {
  return `An offer to send your welcome note to a new family from the ${location} poster.`;
}

/**
 * What became of the ping. Four of the five are named separately on purpose (rule #11):
 * "this arrival was not from a poster" is the overwhelmingly common case and not a
 * failure, "already pinged" is a duplicate tick and not a failure either, and only the
 * remaining two cost the founder a signal he should have had.
 */
export type FounderPingOutcome =
  | { status: 'pinged'; commitmentId: string }
  /** The arriving family did not come from one of the founder's posters. Every other
   * intake in the product ends here, which is why it is silent. */
  | { status: 'not_a_poster_arrival' }
  /** This family has already been pinged about. The dedupe key held. */
  | { status: 'already_pinged' }
  /** The arriving family's channel sits in the operator's fictional probe range
   * (+1 437-555-XXXX) — a live probe exercising the real intake. The probe keeps its
   * own thread; the founder, a human, is never signalled about it (2026-08-28 ads-week
   * audit: a probe join masked the real partner's join). Named, never silent (#11). */
  | { status: 'skipped_synthetic' }
  | {
      status: 'not_pinged';
      reason: 'no_founder_channel' | 'send_failed' | 'write_failed' | 'not_recorded';
    };

export interface FounderPingPorts {
  /**
   * REQUIRED (rule #11). A ping lane holding a nullable transport would be a feature that
   * silently does nothing in exactly the deployment where nobody is watching — and the
   * whole point of the ledger row below is that an offer nobody received is not an offer.
   */
  transport: ChannelTransport;
  /**
   * Put the ping in the founder's OWN text thread — REQUIRED, same reason as the
   * transport (rule #11). This ping is a question, and the word that answers it is
   * "yes"; `channel_messages` carries no body (rule #1), so a ping that skips this is
   * one the coach reads a bare YES against with nothing above it. The anchor derives
   * from his family and user ids, so there is no absence to handle
   * (lib/channel/thread.ts).
   */
  threadMessage: typeof threadProactiveMessage;
  resolveFounder: typeof resolveFounderChannel;
  dedupeActive: typeof dedupeActive;
  cancelCommitment: typeof cancelCommitment;
  recordCommitment: typeof recordCommitment;
}

export function defaultFounderPingPorts(transport: ChannelTransport): FounderPingPorts {
  return {
    transport,
    threadMessage: threadProactiveMessage,
    resolveFounder: resolveFounderChannel,
    dedupeActive,
    cancelCommitment,
    recordCommitment,
  };
}

export async function offerFounderWelcome(
  database: Database,
  input: { newFamilyId: string; sourceCode: string | null; now: Date },
  ports: FounderPingPorts,
): Promise<FounderPingOutcome> {
  // Checked before anything else: this runs on EVERY intake completion, and an ordinary
  // arrival must not cost a query, a decrypt, or a read of the environment.
  const sourceCode = input.sourceCode;
  const location = posterLocation(sourceCode);
  if (sourceCode === null || location === null) return { status: 'not_a_poster_arrival' };

  // The synthetic-probe guard, at the chokepoint where the family's channel is resolved
  // (sms-consent-core.ts). After the poster check so an ordinary arrival still costs
  // nothing; before the founder is resolved because a probe must never get that far.
  // Fails toward the ping, in this module's own nothing-throws shape: a broken guard
  // read costing the founder one probe ping is cheaper than costing him a real family.
  try {
    if (await familyHasSyntheticProbeChannel(database, input.newFamilyId)) {
      console.warn(
        { newFamilyId: input.newFamilyId },
        'founder welcome: probe-range arrival - no human is signalled about a synthetic family',
      );
      return { status: 'skipped_synthetic' };
    }
  } catch (err) {
    console.error(
      { err, newFamilyId: input.newFamilyId },
      'founder welcome: the synthetic-probe guard failed - proceeding as a real arrival',
    );
  }

  const founder = await ports.resolveFounder(database);
  if (!founder) {
    console.error(
      { newFamilyId: input.newFamilyId },
      'founder welcome: no live founder channel - a poster family joined and nobody was told',
    );
    return { status: 'not_pinged', reason: 'no_founder_channel' };
  }

  const dedupeKey = founderPingDedupeKey(input.newFamilyId);
  if (await ports.dedupeActive(dedupeKey, database)) return { status: 'already_pinged' };

  const body = founderPing(location);
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.transport.send({
      to: founder.phoneE164,
      body,
    }));
  } catch (err) {
    console.error(
      { err, newFamilyId: input.newFamilyId },
      'founder welcome: the ping did not reach the provider - no offer stands, this family gets no note',
    );
    return { status: 'not_pinged', reason: 'send_failed' };
  }

  const outcome = await registerOffer(
    database,
    { ...input, sourceCode, location, founder, providerMessageId, dedupeKey },
    ports,
  );
  // THE THREAD, which is where his YES will be read. AFTER the registration and on
  // EVERY path that got this far, including the ones that failed to write the offer
  // down: the ping is on his phone either way, so it is a sentence he can answer, and
  // a thread missing it is the state that makes the answer unreadable. Last, so a
  // thread write can never be what stops the offer being recorded.
  await ports.threadMessage(database, {
    familyId: founder.familyId,
    parentUserId: founder.userId,
    body,
  });
  return outcome;
}

/**
 * The row the ping just earned, and the two writes it needs — the ledger row that proves
 * the message went, and the audit row rule #6 requires for the decision itself.
 *
 * Separated from the send only so the try/catch below cannot swallow a transport error
 * as a write failure: the two cost completely different things, and an operator reading
 * the log has to be able to tell "the founder never saw it" from "the founder saw it and
 * his YES will find nothing".
 */
async function registerOffer(
  database: Database,
  input: {
    newFamilyId: string;
    sourceCode: string;
    location: string;
    founder: FounderChannel;
    providerMessageId: string;
    dedupeKey: string;
    now: Date;
  },
  ports: FounderPingPorts,
): Promise<FounderPingOutcome> {
  const { founder, location } = input;
  let channelMessageId: string;
  try {
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: founder.familyId,
        parentUserId: founder.userId,
        channel: 'sms',
        direction: 'out',
        category: 'founder',
        templateKey: FOUNDER_PING_TEMPLATE_KEY,
        dedupeKey: input.dedupeKey,
        providerMessageId: input.providerMessageId,
        status: acceptedStatus('sms'),
        sentAt: input.now,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('founder ping: channel_messages insert returned no row');
    channelMessageId = row.id;

    // Rule #6, on the FOUNDER's family: the decision was Hale's, the message was his, and
    // the arriving family is not named here. Their own audit row is written on their own
    // family when the note actually goes — one household's trail never carries another
    // household's identifier.
    await database.insert(schema.auditLog).values({
      familyId: founder.familyId,
      actor: founder.userId,
      actionTaken: 'founder_welcome_offered',
      targetTable: 'channel_messages',
      targetId: channelMessageId,
      after: { poster: location },
    });
  } catch (err) {
    console.error(
      { err, newFamilyId: input.newFamilyId },
      'founder welcome: the ping was sent but not written down - his YES will find nothing',
    );
    return { status: 'not_pinged', reason: 'write_failed' };
  }

  // SUPERSEDE FIRST, for the reason recordPlanOffer and recordCheckupOffer both state:
  // the partial unique index permits one open offer of a kind per family, so two poster
  // arrivals inside the TTL would leave the second ping's row silently refused and a YES
  // sending the note to the FIRST family. The message that just went out is the offer now.
  await ports.cancelCommitment(database, {
    familyId: founder.familyId,
    kind: 'founder_welcome_offer',
    reason: 'founder_welcome_superseded',
    now: input.now,
  });

  const outcome = await ports.recordCommitment(database, {
    familyId: founder.familyId,
    kind: 'founder_welcome_offer',
    summary: founderWelcomeSummary(location),
    // The POSTER CODE, a registry key and never free text — the column's own contract
    // (see its note: a category, or an id naming a row in a reviewed table of constants).
    // It is what the YES reads the place name back off, so the note and the ping cannot
    // disagree about which poster this family walked in from.
    topic: input.sourceCode,
    subjectFamilyId: input.newFamilyId,
    dueAt: new Date(input.now.getTime() + FOUNDER_WELCOME_TTL_HOURS * 3_600_000),
    channelMessageId,
  });
  if (outcome.status === 'recorded') {
    return { status: 'pinged', commitmentId: outcome.commitmentId };
  }
  // `already_open` after a successful supersede is a lost write, not a duplicate tick —
  // named as a failure here rather than folded in with the ledger's benign reading,
  // because at THIS call site it means a YES would send the note to the wrong household.
  console.error(
    { newFamilyId: input.newFamilyId, reason: outcome.status },
    'founder welcome: the ping was sent but the offer was not recorded - his YES will not resolve to it',
  );
  return { status: 'not_pinged', reason: 'not_recorded' };
}
