import type { AgentClient } from '@hale/agent';
import { type Database, type UnmetIntentCategory, type UnmetIntentLane, schema } from '@hale/db';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { replyLanguage } from '~/lib/channel/language';
import { isUndefinedTable } from '~/lib/channel/linq/roster';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import {
  type FamilyFacts,
  type FamilyPlace,
  type GeneralAnswerComposer,
  type GeneralAnswerFallback,
  type GeneralAnswerOutcome,
  type PendingAsk,
  createGeneralAnswer,
  generalAnswerSearchEnabled,
  localDate,
} from './answer';
import {
  ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE,
  EMERGENCY_REPLY,
  MENTAL_CRISIS_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
  namesAMentalCrisis,
  namesAnEmergency,
  referralReply,
} from './copy';
import { type MedicalComposer, type MedicalReplySource, createMedicalComposer } from './medical';
import { readFamilyPlace } from './place';
import { type InboundLaneScreen, type LaneScreenFallback, createInboundLaneScreen } from './screen';

/**
 * VIL-273 — the off-domain capability lane, end to end minus the sending.
 *
 * Three kinds of text have an answer that the full coach turn does not improve: a
 * question about the world, a question about a symptom, and a parent trying to get a
 * doctor. This module turns one inbound message into whichever of those it is, the
 * answer that ends it, and a countable demand signal — and the router does the rest.
 *
 * BOUNDARY V3 (founder-locked 2026-08-11) moved ONE of those three. The quiet-operator
 * promise governs OUTBOUND: Hale never starts the chatter. Inbound it had been applied
 * too widely, and a parent who asked who the best striker is got charm and a closed
 * door — which reads as a product that CANNOT rather than one that chooses not to. So
 * `off_domain_general` now composes one brief, honest answer (see answer.ts) and stops
 * there. The other two do not move: a symptom still gets the fixed 811/911 line and a
 * parent hunting a paediatrician still gets Health Care Connect, both from copy.ts,
 * both untouched by any model. The provider door later grew a SECOND fixed line for the
 * classes Ontario books directly (eye care today) — still copy.ts, still no model, and
 * see the branch below for why the registry answer was wrong for those.
 *
 * WHY `status: 'deflected'` KEPT ITS NAME. It is the router's outcome enum and the
 * founder's X1 log taxonomy — it means "this lane finished the turn, no coach was
 * woken", which is still exactly what happened. What the parent actually received is
 * carried honestly beside it in {@link OffDomainVerdict.replySource}, and renaming a
 * logged enum to describe one of its three branches would cost the weekly counts their
 * history for no reader's benefit.
 *
 * WHY THE SIGNAL LIVES HERE AND NOT IN THE ROUTER. This lane is where Hale learns what
 * parents bring it that its own job does not cover, and the ONE thing worth knowing is
 * what was asked. Recording that is not the router's business (it deals in threads,
 * ledgers and audit rows); it is the last step of the lane's own decision. Keeping the
 * two in one call is also what makes the count trustworthy: there is no path that
 * answers off-domain without producing a signal, because it is the same return value —
 * and that stayed true through the flip, so the digest keeps counting (the bucket now
 * reads "questions parents ask us", which is if anything the more useful signal).
 *
 * Rule #11 all the way down. The screen's degraded paths come back NAMED
 * ({@link LaneScreenFallback}), the composer's come back NAMED
 * ({@link GeneralAnswerFallback}) and ride out in `replySource`, the record's outcome
 * comes back NAMED ({@link UnmetSignalOutcome}), and none of them can be silent. A
 * signal that failed to write must never cost a parent their reply, so the write is
 * best-effort and says so out loud rather than throwing.
 */

/** Whether the demand signal actually landed. `not_recorded` is a real, countable
 * outcome — the deflection still went out, and the founder's weekly count is short one
 * row that the log line accounts for. `not_applicable` is the medical-symptom answer
 * lane: Hale ANSWERED it, so it was never an unmet intent and no row was written
 * (founder-locked 2026-08-17) — named rather than faked as a failed write (rule #11). It
 * is also a parent's reply to a question Hale left open: that question was counted when
 * it was first asked, and its answer ("Toronto") is not a second one. */
export type UnmetSignalOutcome = 'recorded' | 'not_recorded' | 'not_applicable';

/**
 * Where the words that went out came from. `fixed` is one of the two door lines in
 * copy.ts (or the medical lane's last-resort 811/911 line); `composed` is the general
 * answer; `web_grounded` is the medical-symptom answer, searched and composed; anything
 * else is a {@link GeneralAnswerFallback} naming why the composer could not run and the
 * deflect line stood in for it (rule #11).
 */
export type ReplySource = 'fixed' | 'composed' | 'web_grounded' | GeneralAnswerFallback;

export type OffDomainVerdict =
  /** Hale's job. The turn continues to the coach exactly as it did before this stage
   * existed — carrying WHY, when the screen could not run (rule #11). */
  | { status: 'in_domain'; fallback: LaneScreenFallback | null }
  /** The lane finished the turn itself. See the module note on why this kept its name
   * now that one of the three branches is an answer rather than a refusal. */
  | {
      status: 'deflected';
      lane: UnmetIntentLane;
      category: UnmetIntentCategory;
      reply: string;
      replySource: ReplySource;
      /**
       * The medical lane's own outcome, for the router to stamp on the reply it sends —
       * and null on every other branch, which is what MARKS a sent row as a medical
       * answer at all (migration 0090).
       *
       * Carried explicitly rather than narrowed out of `replySource` downstream. Both
       * fixed doors and the general answer's safety fallback also say `fixed`, so a
       * reader deriving this from the source alone would count a provider-access door as
       * a medical failure — in the one row of the founder scorecard that must never be
       * wrong in that direction.
       */
      medicalSource: MedicalReplySource | null;
      signal: UnmetSignalOutcome;
      /**
       * The question this reply left open, for the router to keep beside the reply's own
       * ledger row ({@link settlePendingAsks}), or null. Only a lit general answer ever
       * sets it.
       */
      pendingAsk: PendingAsk | null;
    };

/**
 * The thread an inbound text arrived in: its own ledger row's channel and chat, and what
 * the door said about who else is in it.
 */
export interface InboundThread {
  channel: schema.ChannelMessageRow['channel'];
  /** The provider's id for the chat, on a channel that has chats. */
  providerChatId: string | null;
  /**
   * The door's own group bit. `undefined` is a job that does not say: one queued before
   * the door carried the bit, one the reconciler re-drove from the row, an email. Unknown
   * is not a 1:1 thread, and nothing that belongs to one parent is read for it.
   */
  inGroup: boolean | undefined;
}

/**
 * What the ledger holds for a pending ask. A question left open in ANOTHER thread is its
 * own answer, not `none` (rule #11): the parent has one, and this is not where it was
 * asked.
 */
export type PendingAskRead =
  | { status: 'open'; ask: PendingAsk }
  | { status: 'none' }
  | { status: 'other_thread' }
  /** The table the questions are kept in has not reached this database (migration 0167). */
  | { status: 'not_migrated' };

export interface OffDomainPorts {
  screen: InboundLaneScreen;
  /** Writes the one brief answer to a question about the world. Non-nullable (rule
   * #11): "no composer wired" is not a state this lane has — a composer that cannot run
   * says so by name and the fixed line goes out instead. */
  answer: GeneralAnswerComposer;
  /** Today's date where this family is, as the general answer is told it. The date is
   * what travels on; the timezone it was read in does not. The composer asks for it,
   * after the fixed lines that need no date. */
  today(familyId: string): Promise<string>;
  /** This family's own city and country, or the named reason they cannot be given. Read
   * lazily like the date, and only by a lit general answer whose question turns on where
   * the family is. Non-nullable (rule #11): a place that is not known is an answer this
   * read gives by name, not a reader that is missing. */
  place(familyId: string): Promise<FamilyPlace>;
  /**
   * The question Hale's last word to this parent left open, when that word was said in
   * the thread this text arrived in. Read at most once a turn, after the screen, and only
   * while the general answer's search is lit. `asOf` is the turn's own clock: nothing this
   * turn sends while it works (the holding line) may close the ask the turn is about to
   * read.
   */
  pendingAsk(input: {
    familyId: string;
    parentUserId: string;
    channel: InboundThread['channel'];
    providerChatId: string | null;
    asOf: Date;
  }): Promise<PendingAskRead>;
  /** Answers a medical-symptom text: a web-grounded, coarse-age-aware reply with its own
   * triage, or the fixed 811/911 line as a last resort. Non-nullable for the same reason
   * (rule #11) — its own failure modes are named inside it, never a missing dependency. */
  medical: MedicalComposer;
  /** Stamps the inbound row with the lane + bucket. Never throws — see
   * {@link UnmetSignalOutcome}. */
  recordUnmetIntent(input: {
    channelMessageId: string;
    familyId: string;
    lane: UnmetIntentLane;
    category: UnmetIntentCategory;
  }): Promise<UnmetSignalOutcome>;
}

export interface OffDomainLane {
  consider(input: {
    familyId: string;
    /** Whose text this is. A question Hale left open was put to one parent's phone. */
    parentUserId: string;
    channelMessageId: string;
    text: string;
    /** The turn's clock. */
    now: Date;
    /** Where the text arrived. A question Hale left open was asked in one thread, and a
     * family's home city is said only in the parent's own. */
    thread: InboundThread;
  }): Promise<OffDomainVerdict>;
}

export function offDomainLane(ports: OffDomainPorts): OffDomainLane {
  return {
    async consider(input) {
      // VIL-328: a physical emergency token never waits on the screen or the
      // medical composer. 811 is Telehealth and must not lead this inbound.
      if (namesAnEmergency(input.text)) {
        const signal = await ports.recordUnmetIntent({
          channelMessageId: input.channelMessageId,
          familyId: input.familyId,
          lane: 'safety_critical',
          category: 'emergency',
        });
        return {
          status: 'deflected',
          lane: 'safety_critical',
          category: 'emergency',
          reply: EMERGENCY_REPLY,
          replySource: 'fixed',
          medicalSource: null,
          signal,
          pendingAsk: null,
        };
      }

      const family: FamilyFacts = {
        today: () => ports.today(input.familyId),
        place: () => homePlaceIn(input.thread, () => ports.place(input.familyId)),
      };

      // THE SCREEN READS EVERY TEXT FIRST, a reply to a question Hale left open included.
      // The sanitizer that judges whether a text answers "which city?" is not a safety
      // screen: a reply that gives the city AND describes a symptom would be read as the
      // answer and composed as a general question, past the medical lane and both doors.
      const reading = await ports.screen.read(input.text);
      const inDomain = reading.lane === 'in_domain' || reading.category === null;

      // A REPLY TO A QUESTION HALE LEFT OPEN is considered only for a text the screen
      // would send to the coach or to the general answer. "Toronto" on its own is not a
      // question about the world, so the screen files it with the family's week, and the
      // open question is what makes it the general answer's turn. The composer judges
      // whether the text completes it; one that does not is routed below exactly as it
      // would be with nothing open. The demand signal is not written twice: the question
      // was counted on the text that first asked it.
      if (inDomain || reading.lane === 'off_domain_general') {
        const pending = await standingAsk(ports, input, reading.fallback);
        if (pending !== null) {
          const continued = await ports.answer.continueAsk(input.text, pending, family);
          if (continued.status !== 'unrelated') {
            return {
              status: 'deflected',
              lane: 'off_domain_general',
              category: 'other',
              ...replyFor(continued, input.text),
              medicalSource: null,
              signal: 'not_applicable',
            };
          }
        }
      }

      if (reading.lane === 'in_domain' || reading.category === null) {
        return { status: 'in_domain', fallback: reading.fallback };
      }
      const lane = reading.lane;

      // MEDICAL SYMPTOMS ARE ANSWERED NOW (founder-locked 2026-08-17), not deflected to a
      // fixed line. Hale composes a web-grounded, coarse-age-aware reply with its own
      // triage (medical.ts) — every word model-generated, the 811/911 line kept only as
      // the last-resort fallback inside the composer. It leaves by its own branch BEFORE
      // the demand-signal write: a question Hale answered is not an unmet intent, and its
      // `signal` says `not_applicable` rather than pretending a write was even attempted
      // (rule #11). Every OTHER safety_critical category still gets SAFETY_REPLY below.
      if (lane === 'safety_critical' && reading.category === 'medical-symptom') {
        const { reply, replySource } = await ports.medical.answer(input.text);
        return {
          status: 'deflected',
          lane,
          category: reading.category,
          reply,
          replySource,
          medicalSource: replySource,
          signal: 'not_applicable',
          pendingAsk: null,
        };
      }

      // The two doors are fixed sentences and the composer is never woken for them. Not
      // a prompt asked nicely to decline — a branch it cannot reach. Letting a model
      // anywhere near what a parent is told about their child's head injury is the
      // failure this shape makes impossible rather than merely discouraged.
      //
      // The provider door is a TABLE keyed by service (copy.ts referralReply), not a
      // model and not a default. Ontario's answer to "get me X" depends entirely on WHICH
      // X: a family doctor or paediatrician means the Health Care Connect registry, an
      // optometrist means no registry at all (you book one directly and OHIP pays), and a
      // paediatric dentist, an OT, a speech therapist or an audiologist mean none of the
      // above — Health Care Connect has never placed one. This door used to be a two-way
      // if/else whose DEFAULT was the registry, so every one of those got a line that was
      // not vague but WRONG (founder, live gate, 2026-08-13, on an optometrist). The
      // table's miss branch says so instead, which is a correct answer where a guessed
      // registry is a wasted phone call.
      // Which LANGUAGE those fixed sentences go out in is decided the same way and for
      // the same reason — off the words in front of it, with no model consulted.
      const language = replyLanguage(input.text);
      const { reply, replySource, pendingAsk } =
        lane === 'safety_critical'
          ? namesAMentalCrisis(input.text) || reading.category === 'mental-health'
            ? fixedLine(MENTAL_CRISIS_REPLY)
            : fixedLine(SAFETY_REPLY_BY_LANGUAGE[language])
          : lane === 'provider_access'
            ? fixedLine(referralReply(input.text, language))
            : replyFor(await ports.answer.compose(input.text, family), input.text);

      const signal = await ports.recordUnmetIntent({
        channelMessageId: input.channelMessageId,
        familyId: input.familyId,
        lane,
        category: reading.category,
      });

      return {
        status: 'deflected',
        lane,
        category: reading.category,
        reply,
        replySource,
        // Every branch below the medical one is a door Hale chose or an answer about the
        // world; none of them is a medical answer, and stamping one would put a
        // deliberate door in the safety row's fallback count.
        medicalSource: null,
        signal,
        pendingAsk,
      };
    },
  };
}

/** What the lane sends and what the router keeps beside it. */
interface LaneReply {
  reply: string;
  replySource: ReplySource;
  pendingAsk: PendingAsk | null;
}

/** One of the doors in copy.ts. It leaves no question open. */
function fixedLine(reply: string): LaneReply {
  return { reply, replySource: 'fixed', pendingAsk: null };
}

const NO_PENDING_ASK = 'off-domain lane: no pending ask for this parent';
const NO_PENDING_ASK_KEPT = 'off-domain lane: the question this reply left open was not kept';

/**
 * The question Hale's last word to this parent left open in THIS thread, or null with
 * the reason named (rule #11). Nothing is read while the general answer's search is dark:
 * a dark lane leaves no question open, so there is nothing to find.
 *
 * Nothing is read either for a text the screen could not read (none of its doors saw it,
 * so it goes to the coach as a failed screen's always has), or for a thread the job does
 * not describe: the answer to a question asked in a parent's own chat must not go out to
 * a chat that may have other people in it.
 */
async function standingAsk(
  ports: OffDomainPorts,
  input: { familyId: string; parentUserId: string; now: Date; thread: InboundThread },
  screenFallback: LaneScreenFallback | null,
): Promise<PendingAsk | null> {
  if (!generalAnswerSearchEnabled()) return null;
  if (screenFallback !== null) {
    console.info({ pendingAsk: 'not_read', reason: 'screen_unavailable' }, NO_PENDING_ASK);
    return null;
  }
  if (input.thread.inGroup === undefined) {
    console.info({ pendingAsk: 'not_read', reason: 'thread_unknown' }, NO_PENDING_ASK);
    return null;
  }
  const pending = await ports.pendingAsk({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    channel: input.thread.channel,
    providerChatId: input.thread.providerChatId,
    asOf: input.now,
  });
  if (pending.status !== 'open') {
    console.info({ pendingAsk: pending.status }, NO_PENDING_ASK);
    return null;
  }
  return pending.ask;
}

/**
 * The family's home city, for a thread it may be said in.
 *
 * A reply in a group goes to everyone in it, and a reply carries no household content
 * there (linq/group-audience.ts): answering "the weather tomorrow" for a city would tell
 * the thread where one family lives. So the place is read only in a thread the door said
 * is the parent's own. In a group, or when the job does not say, the port is not read at
 * all and the composer gets the reason by name, which is the turn it had before a place
 * existed: it asks which city.
 */
function homePlaceIn(thread: InboundThread, read: () => Promise<FamilyPlace>): Promise<FamilyPlace> {
  if (thread.inGroup === false) return read();
  return Promise.resolve({
    status: 'unknown',
    reason: thread.inGroup ? 'group_thread' : 'thread_unknown',
  });
}

/**
 * The general terminal: the composed answer, or the honest line when it could not be
 * written.
 *
 * The parent always gets SOMETHING — that is the whole contract. What they get on the
 * failure branch says what actually happened rather than reciting a boundary, because
 * under v3 there is no boundary here to recite: the same question tomorrow gets a real
 * answer, and a line claiming otherwise would be the one false thing in the exchange.
 */
function replyFor(composed: GeneralAnswerOutcome, text: string): LaneReply {
  if (composed.status === 'composed') {
    return {
      reply: composed.reply,
      replySource: 'composed',
      pendingAsk: composed.pendingAsk ?? null,
    };
  }
  const language = replyLanguage(text);
  // A question about the world that turned out to be about a hurt child. It leaves by
  // the same door a screened symptom does, words and all, and `fixed` says so — crediting
  // the composer for a sentence it did not write would cost the founder's weekly count
  // the one distinction it is for (skill audit P0 #3).
  if (composed.status === 'safety') {
    return fixedLine(namesAnEmergency(text) ? EMERGENCY_REPLY : SAFETY_REPLY_BY_LANGUAGE[language]);
  }
  return {
    reply: ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE[language],
    replySource: composed.reason,
    pendingAsk: null,
  };
}

/**
 * The production read behind {@link OffDomainPorts.pendingAsk}.
 *
 * NO STATUS OF ITS OWN, the readiness and check-in asks' pattern: a question is open
 * while the reply that left it is Hale's last word to this parent, so "is it still
 * pending" is a read of the ledger and not a flag every other sender would have to
 * remember to clear. That also makes it one-shot by construction. Whatever answers the
 * parent's next text, the completed question or anything else, is a newer last word. The
 * question itself is in a table of its own beside that reply's row (migration 0167).
 *
 * PER PARENT, like those asks: it was put to one phone. A send that failed reached no
 * phone and is not a last word (SENT_STATUSES).
 *
 * AND PER THREAD. The last word is still Hale's last word to this parent ANYWHERE, so
 * the one-shot rule above holds across chats. But a question is open only to a text in
 * the thread it was asked in: the same channel and the same chat. A parent's next text
 * in a family or multi-family group must not complete a question from their own chat,
 * because the answer would go to the group.
 */
export function readPendingAsk(database: Database) {
  return async (input: {
    familyId: string;
    parentUserId: string;
    channel: InboundThread['channel'];
    providerChatId: string | null;
    asOf: Date;
  }): Promise<PendingAskRead> => {
    let last: {
      question: string | null;
      missing: string | null;
      channel: InboundThread['channel'];
      providerChatId: string | null;
    }[];
    try {
      last = await database
        .select({
          question: schema.channelPendingAsks.question,
          missing: schema.channelPendingAsks.missing,
          channel: schema.channelMessages.channel,
          providerChatId: schema.channelMessages.providerChatId,
        })
        .from(schema.channelMessages)
        .leftJoin(
          schema.channelPendingAsks,
          and(
            eq(schema.channelPendingAsks.channelMessageId, schema.channelMessages.id),
            eq(schema.channelPendingAsks.familyId, schema.channelMessages.familyId),
          ),
        )
        .where(
          and(
            eq(schema.channelMessages.familyId, input.familyId),
            eq(schema.channelMessages.parentUserId, input.parentUserId),
            eq(schema.channelMessages.direction, 'out'),
            inArray(schema.channelMessages.status, [...SENT_STATUSES]),
            lte(schema.channelMessages.createdAt, input.asOf),
          ),
        )
        .orderBy(desc(schema.channelMessages.createdAt))
        .limit(1);
    } catch (err) {
      // A lit lane on a database the table has not reached keeps and finds no question;
      // it does not cost the parent this turn.
      if (isUndefinedTable(err)) return { status: 'not_migrated' };
      throw err;
    }
    const [row] = last;
    if (!row || row.question === null) return { status: 'none' };
    if (row.channel !== input.channel || row.providerChatId !== input.providerChatId) {
      return { status: 'other_thread' };
    }
    return { status: 'open', ask: { question: row.question, missing: row.missing ?? '' } };
  };
}

/**
 * What a reply Hale just sent a parent does to the questions it has left open for them,
 * which is the production write behind a pending ask (migration 0167).
 *
 * EVERY EARLIER QUESTION IS CLOSED, AND CLOSED MEANS DELETED. A question is open only
 * while its reply is Hale's last word to that parent ({@link readPendingAsk}), and this
 * reply is a newer one. So the question lives exactly as long as it can still be read:
 * the answer to it, or anything else Hale replies with, takes it out, and the retention
 * sweep is the backstop for one nothing ever followed. Then the question THIS reply left
 * open, if it left one, is kept beside its row.
 *
 * A QUESTION LONGER THAN THE TABLE HOLDS IS NOT KEPT (channel-pending-asks.ts names the
 * two bounds, and the table's CHECKs restate them). It is named (rule #11), and the
 * parent's next text is read as a new one.
 *
 * Nothing is read or written while the general answer's search is dark: a dark lane
 * leaves no question open, and a database that does not have the table sends as before.
 */
export async function settlePendingAsks(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    /** The reply's own ledger row. */
    channelMessageId: string;
    ask: PendingAsk | null;
  },
): Promise<void> {
  if (!generalAnswerSearchEnabled()) return;
  await database.delete(schema.channelPendingAsks).where(
    and(
      eq(schema.channelPendingAsks.familyId, input.familyId),
      inArray(
        schema.channelPendingAsks.channelMessageId,
        database
          .select({ id: schema.channelMessages.id })
          .from(schema.channelMessages)
          .where(
            and(
              eq(schema.channelMessages.familyId, input.familyId),
              eq(schema.channelMessages.parentUserId, input.parentUserId),
              eq(schema.channelMessages.direction, 'out'),
            ),
          ),
      ),
    ),
  );
  if (input.ask === null) return;
  if (
    input.ask.question.length > schema.PENDING_ASK_QUESTION_MAX_CHARS ||
    input.ask.missing.length > schema.PENDING_ASK_MISSING_MAX_CHARS
  ) {
    console.info({ pendingAsk: 'not_kept', reason: 'too_long' }, NO_PENDING_ASK_KEPT);
    return;
  }
  await database.insert(schema.channelPendingAsks).values({
    channelMessageId: input.channelMessageId,
    familyId: input.familyId,
    question: input.ask.question,
    missing: input.ask.missing,
  });
}

/**
 * The demand-signal write: two columns on the inbound row the parent's message already
 * occupies (migration 0080).
 *
 * The family id is in the WHERE clause as well as the id, matching the router's own
 * rule-#1 backstop in loadInboundContext: the only thing asserting whose message this
 * is came off a queue, and a mismatch must stamp nothing rather than attribute one
 * family's question to another's week.
 *
 * Best-effort by construction. This is telemetry sitting between a parent's question
 * and Hale's answer; a dead index or a locked row is not a reason for them to hear
 * nothing back, so the failure is caught, named and counted rather than thrown. The
 * catch is deliberately broad for that reason and that reason only — it is the boundary,
 * not business logic.
 */
export function recordUnmetIntent(database: Database) {
  return async (input: {
    channelMessageId: string;
    familyId: string;
    lane: UnmetIntentLane;
    category: UnmetIntentCategory;
  }): Promise<UnmetSignalOutcome> => {
    try {
      const updated = await database
        .update(schema.channelMessages)
        .set({ unmetLane: input.lane, unmetCategory: input.category })
        .where(
          and(
            eq(schema.channelMessages.id, input.channelMessageId),
            eq(schema.channelMessages.familyId, input.familyId),
          ),
        )
        .returning({ id: schema.channelMessages.id });
      if (updated.length > 0) return 'recorded';
      console.error(
        { channelMessageId: input.channelMessageId, lane: input.lane },
        'off-domain lane: unmet-intent stamp matched no row',
      );
      return 'not_recorded';
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.message : 'unknown', lane: input.lane },
        'off-domain lane: unmet-intent stamp failed',
      );
      return 'not_recorded';
    }
  };
}

/**
 * The production lane. Every model stage — the screen, the general answer, and the
 * medical composer — shares ONE client resolver: they are calls on the same turn, and a
 * screen that could reach Anthropic while a composer could not is not a state worth being
 * able to represent.
 *
 * It used to take a `pendingApprovals` reader as well, bound to the approvals query so
 * the count in the deflect could never disagree with the list a "YES 1" would hit. The
 * count is gone with the append that printed it (skill audit P0 #4: nothing Hale texts
 * points at the app), and the reader went with it rather than staying wired to nothing.
 */
export function productionOffDomainLane(
  database: Database,
  client: () => AgentClient,
): OffDomainLane {
  return offDomainLane({
    screen: createInboundLaneScreen(client),
    answer: createGeneralAnswer(client),
    today: async (familyId) => localDate(new Date(), await readFamilyTimezone(database, familyId)),
    place: (familyId) => readFamilyPlace(database, familyId),
    pendingAsk: readPendingAsk(database),
    medical: createMedicalComposer(client),
    recordUnmetIntent: recordUnmetIntent(database),
  });
}
