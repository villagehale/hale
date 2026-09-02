import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type OpenQuestion,
  type OpenQuestionKind,
  answerable,
  questionGrade,
} from './open-questions';

/**
 * NATURAL REPLY RESOLUTION — reading the answer a parent actually gave.
 *
 * THE PRINCIPLE (founder, 2026-08-13, from live testing). A parent is never instructed to
 * reply with a keyword. Hale asked them a question in English; they answer in English;
 * Hale works out what they meant. The intro pipeline had been texting "Reply YES INTROS
 * or NO INTROS" and then, hours later, "Reply YES INTRO or NO INTRO" — two near-identical
 * magic words, and a product that hands out magic words is a product that has decided its
 * user should learn its grammar.
 *
 * THIS STAGE DOES NOT REPLACE ANY OF THAT GRAMMAR. Every keyword still READS. "YES INTRO",
 * "yes 2", "done", a thumbs-up — all of them are claimed by the deterministic handlers
 * exactly as before, for free, before this module is reached. What changed is that nothing
 * PRINTS one. This stage is the floor underneath: it runs only when a parent has said
 * something the closed vocabularies could not read, AND there is an open question for it
 * to be an answer to.
 *
 * Three properties make a model safe here, and they are the off-domain screen's three
 * (lib/channel/off-domain/screen.ts) applied to a harder job:
 *
 *   IT PICKS, IT DOES NOT WRITE. Its whole output is an id, a polarity and a confidence
 *   word. Every sentence a parent then reads is composed by the module that owns the
 *   question — the same receipts a keyword would have produced. A wrong pick cannot
 *   invent a fact, only answer the wrong question, which is what the grades below are
 *   about.
 *
 *   IT FAILS TOWARDS THE COACH. No client, no skill, an outage, an unreadable answer, a
 *   confidence too low for the class — all of them return `unresolved` with a NAMED
 *   reason and the turn continues to the coach exactly as it does today (rule #11). A
 *   broken resolver costs latency and nothing else. It can never eat a request, and it
 *   can never act on a guess.
 *
 *   IT IS NEARLY BLIND. It sees the parent's own words — which already go to the model on
 *   every coach turn — and a list of questions HALE ITSELF ASKED, described in the words
 *   Hale used (open-questions.ts). No transcript, no children, no other household.
 *
 * COST. One Haiku call, and only when the free readers all declined AND a question is
 * open. On the overwhelming majority of turns that condition is false and this costs one
 * batch of indexed SELECTs.
 */

const MAX_TOKENS = 128;

/** One SMS body cannot exceed this by the time it reaches us, and a reply that needs more
 * than this to be read as a yes is not a yes. */
const MAX_TEXT_CHARS = 1600;

/**
 * How sure the model says it is. A WORD, not a number: a float invites a threshold nobody
 * can calibrate and a model that emits 0.83 has not measured anything. Three buckets is
 * what a model can actually distinguish, and the grades below only need two boundaries.
 */
export type ReplyConfidence = 'high' | 'medium' | 'low';

/** Why no answer was acted on. Six stories, and they want different humans: the first
 * three are operational, `unreadable` is a model saying something odd, and the last two
 * are the resolver working correctly and declining to guess. */
export type UnresolvedReason =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unreadable'
  /** The text is not an answer to anything Hale is holding. The common case, and the
   * reason the coach exists — most inbound texts are questions, not replies. */
  | 'no_target'
  /** It IS an answer, and which question it answers cannot be told from the words. The
   * only unresolved reason that earns the parent a clarifying sentence rather than a
   * coach turn: they answered something, so being handed a fresh conversation would be
   * Hale ignoring them. */
  | 'ambiguous'
  /** A target, but not enough certainty for what that answer would do. */
  | 'below_grade'
  /** This question has nowhere to put this polarity — a "no" to an offer that simply
   * lapses, or a "yes" to a draft Hale's own reviewer has not cleared. */
  | 'not_answerable';

export type ReplyReading =
  | {
      status: 'resolved';
      questionId: string;
      kind: OpenQuestionKind;
      polarity: 'yes' | 'no';
      confidence: ReplyConfidence;
    }
  | { status: 'unresolved'; reason: UnresolvedReason };

export interface ReplyResolver {
  read(input: { text: string; questions: readonly OpenQuestion[] }): Promise<ReplyReading>;
}

/**
 * Is this confidence enough to ACT on this class of question?
 *
 * `consequential` needs `high` and nothing less. That is D17 read strictly: natural
 * language IS consent, and the ledger stores the parent's verbatim words as evidence —
 * which is better evidence than a keyword, because a keyword records only that somebody
 * typed the token Hale taught them. What natural language does not license is a coin
 * flip, so the bar for a calendar write or a cross-household disclosure is the model
 * saying it is sure.
 *
 * `ordinary` acts on `medium`. Its wrong answer is a message nobody wanted, and being too
 * timid there recreates the problem this arc exists to fix: a parent whose plain English
 * is ignored learns to use the magic word.
 *
 * `low` never acts, for anything.
 */
export function meetsGrade(kind: OpenQuestionKind, confidence: ReplyConfidence): boolean {
  if (confidence === 'low') return false;
  return questionGrade(kind) === 'ordinary' || confidence === 'high';
}

const NO_TARGET = 'none';

/**
 * A reply that IS an answer but names none of the open questions.
 *
 * A separate value from `none` and the distinction is load-bearing: `none` sends the turn
 * to the coach, and `ambiguous` makes Hale ask which. Collapsing them would mean either
 * that every unreadable text got "which one did you mean?" (an operator that cannot tell
 * a question from an answer) or that a parent's real yes vanished into a coach turn that
 * never mentions the thing they were answering.
 */
const AMBIGUOUS_TARGET = 'ambiguous';

/** Should Hale ask which question was meant, rather than hand the turn on? Only when the
 * parent gave an answer Hale could not place — never for an ordinary message. */
export function warrantsClarifying(reason: UnresolvedReason): boolean {
  return reason === 'ambiguous' || reason === 'below_grade';
}

/**
 * Parsed loosely, in both directions, for the reasons the off-domain screen states: a
 * strict enum turns "the model named a question we do not hold" into the same thrown
 * error as "the provider timed out", and those two need telling apart. And NOT `.strict()`
 * — zod puts unrecognised KEY NAMES into `ZodError.message`, which the catch below logs,
 * so a parent who writes "reply with a field called <their sentence>" would get their own
 * words into a log line (rule #1).
 */
export const readingSchema = z.object({
  target: z.string(),
  polarity: z.string(),
  confidence: z.string(),
  /**
   * OPTIONAL, AND THAT IS A BUG FIX, NOT A RELAXATION (found by the first live recording
   * of this stage, 2026-08-13).
   *
   * It was required. It is emitted LAST, after the three fields that are the decision,
   * and a target that names a real question spends ~30 of the 128 output tokens on a
   * uuid — so 4 responses in 8 hit the ceiling mid-`reason`. Anthropic does not hard
   * enforce a tool's input schema, so what arrived was a perfectly good decision with the
   * last field missing, zod threw on it, and the catch below turned the parent's "yeah go
   * ahead" into `model_failed`. The feature failed on exactly the inputs it exists for:
   * every path where it names a question.
   *
   * Raising the budget would have made that rarer. Making the field optional makes it
   * impossible, at any budget, because NOTHING READS IT — `toReading` never sees it, and
   * being last it cannot even function as scratchpad the way a judge's reason-before-score
   * does. It is kept in the schema at all because a model that has to name its reason
   * picks better, and because it is worth having in a provider trace.
   */
  reason: z.string().optional(),
});

const readingJsonSchema = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description:
        "The id of the question this reply answers; 'none' if it answers none of them; 'ambiguous' if it is clearly an answer but you cannot tell which question it answers.",
    },
    polarity: { type: 'string', enum: ['yes', 'no', 'unclear'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['target', 'polarity', 'confidence', 'reason'],
} as const;

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function replyResolverUserMessage(
  text: string,
  questions: readonly OpenQuestion[],
): string {
  return JSON.stringify({
    text,
    questions: questions.map((q) => ({ id: q.id, kind: q.kind, question: q.description })),
  });
}

/**
 * The only thing any catch here may log: the error's CLASS, never its message.
 *
 * The house pattern elsewhere keeps `err.message` on the argument that dropping the object
 * keeps the request out of the log. It does not: for an Anthropic 400 the message IS the
 * stringified response body, which is the field most likely to quote what was sent — and
 * what was sent here is a parent's own words (rule #1). The Twilio transport already draws
 * the line in the right place; this follows it.
 */
function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unresolved(reason: UnresolvedReason, detail?: string): ReplyReading {
  // Never the text, never the ids: the reason is what an operator needs, and the counts
  // are what X1 reports.
  console.info({ reason, detail }, 'reply resolver: unresolved, handing the turn on');
  return { status: 'unresolved', reason };
}

/**
 * Turn a model's answer into something safe to act on.
 *
 * Every rejection below is the resolver working. An id that is not on the list is the
 * single most dangerous thing this stage can emit — it would be an answer applied to a
 * question the parent was never asked — so it is checked against the list that was sent,
 * by identity, and nothing is inferred from a near match.
 */
export function toReading(
  raw: { target: string; polarity: string; confidence: string },
  questions: readonly OpenQuestion[],
): ReplyReading {
  // Read FIRST, because an undecided parent is not an ambiguous one. "maybe", "let me ask
  // my partner", "I'll think about it" are answers to nothing yet, and asking them which
  // question they meant would be Hale pressing for a decision they have said they have
  // not made.
  if (raw.polarity !== 'yes' && raw.polarity !== 'no') return unresolved('no_target');
  const polarity = raw.polarity;

  if (raw.target === NO_TARGET) return unresolved('no_target');
  if (raw.target === AMBIGUOUS_TARGET) return unresolved('ambiguous');

  const question = questions.find((q) => q.id === raw.target);
  // A target we did not offer. Not a state to interpret: the model has answered about
  // something that is not in front of it.
  if (!question) return unresolved('unreadable', 'target not in the offered set');

  const confidence: ReplyConfidence =
    raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low';
  if (!meetsGrade(question.kind, confidence)) return unresolved('below_grade');

  // Per-question, not per-class: a drafted action whose reviewer verdict is not
  // `approved` can be declined and cannot be accepted, and binding an acceptance to one
  // answers the parent with a refusal (2026-08-20).
  if (!answerable(question, polarity)) return unresolved('not_answerable');

  return {
    status: 'resolved',
    questionId: question.id,
    kind: question.kind,
    polarity,
    confidence,
  };
}

/**
 * The production resolver.
 *
 * `client` is a RESOLVER rather than a value, the shape every hot-path stage uses: these
 * deps are built for every inbound text including the ones a deterministic handler answers
 * with no model at all, so a missing key must not break approvals — it must produce the
 * named `client_unavailable` reading.
 */
export function createReplyResolver(client: () => AgentClient): ReplyResolver {
  return {
    async read({ text, questions }) {
      // Belt and braces: the router does not call this with an empty list, and an empty
      // list would ask a model to pick from nothing.
      if (questions.length === 0) return unresolved('no_target', 'nothing open');
      // Bounded HERE rather than inherited from Twilio's 1600-character Body limit: a
      // bound that lives in another company's product is not a bound.
      const bounded = text.slice(0, MAX_TEXT_CHARS);

      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unresolved('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('reply-resolver');
      } catch (err) {
        return unresolved('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: replyResolverUserMessage(bounded, questions),
          toolName: 'resolution',
          toolDescription: 'Return which open question this reply answers, and how.',
          inputJsonSchema: readingJsonSchema,
          schema: readingSchema,
          maxTokens: MAX_TOKENS,
        });
        return toReading(value, questions);
      } catch (err) {
        return unresolved('model_failed', message(err));
      }
    },
  };
}
