import { type AgentClient, pickLane, pickModel } from '@hale/agent';
import { z } from 'zod';
import { readEvidence } from '~/lib/channel/activity/evidence';
import { plainText } from '~/lib/channel/coach/reply';
import {
  namesAMentalCrisis,
  namesAnEmergency,
  reachesForTheHealthLine,
} from '~/lib/channel/off-domain/copy';
import { recMorningIntakeReply } from '~/lib/channel/rec-morning';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { forceToolJson } from '~/lib/pipeline/structured';
import { adultLearnIntakeReply } from './adult-learn';
import type { ExtractedChild } from './extract';
import {
  cheerUpIntakeReply,
  groundCurrentSource,
  isCheerUpAsk,
  isLiveLookupAsk,
  liveLookupFallbackReply,
  liveLookupReplyFromNotes,
} from './live-lookup';
import {
  deidentifyOfficialQuery,
  isOfficialPageAsk,
  notesGroundADate,
  officialPageFallbackReply,
  officialPageReplyFromNotes,
} from './official-page';

/**
 * THE ESCAPE FROM THE SCRIPT — what Hale says when a parent mid-signup asks a question
 * of their own.
 *
 * THE BUG THIS EXISTS FOR (live, founder's test, 2026-08-12). Three texts into intake,
 * with the consent ask outstanding, a parent texted "Does Sebastian needs eye exam?".
 * The machine had exactly one way to read an inbound on that step — is this a yes or a
 * no — so a question came back `ambiguous` and Hale asked its own question again.
 * Nobody answered the parent. The state machine was not broken; it had no branch in
 * which answering was possible, and every off-script text became a re-ask.
 *
 * THE MISSING PRIMITIVE was an intake turn that ANSWERS. This is it: one bounded model
 * call that writes the reply to what they asked plus the one line that gets back to
 * Hale's own question, so the conversation is served without losing its thread.
 *
 * WHY NOT THE COACH, and why not the off-domain lane. Both live downstream of a family
 * that has finished signing up. The coach is a tool loop over a week that does not
 * exist yet, and the off-domain lane is deliberately BLIND — it may not say a word
 * about Hale or about this family, which rules out the most common mid-intake question
 * there is ("what would you even be watching?"). This stage sees exactly what the
 * parent has already told Hale in this conversation and nothing else.
 *
 * FOUR THINGS MAKE IT SAFE TO PUT ON A STRANGER'S THIRD TEXT:
 *
 *   AN EMERGENCY NEVER REACHES A MODEL. `namesAnEmergency` is checked first, before the
 *   client is even resolved, and returns {@link IntakeAnswerOutcome} `safety` — the
 *   machine then sends {@link EMERGENCY_REPLY} (`Call 911 now.`), with no return-to-script
 *   tacked onto it. Intake has never had the screened safety lane the router has
 *   (off-domain/lane.ts), so this is the whole of it, and it works during a provider
 *   outage because it is a substring test.
 *
 *   NOTHING IS AGREED TO YET, and the gates say so in code. Consent is the question
 *   still outstanding on the seam that calls this, so a composed line claiming Hale is
 *   watching, has started, or will start is false at the moment it is sent — and
 *   {@link CLAIMED_WORK} refuses it rather than trusting the skill to have held.
 *
 *   IT CANNOT COST A PARENT THEIR TURN. Every degraded path comes back NAMED (rule #11)
 *   and the caller sends the reply it would have sent before this stage existed.
 *
 *   IT DECIDES WHETHER THERE IS ANYTHING TO ANSWER. A hedge, a pleasantry or more
 *   signup detail is `nothing_to_answer`, and the machine's own reply — which was
 *   written for exactly that — goes out instead.
 */

/**
 * ONE budget for the whole message, not one per half.
 *
 * 300 GSM-7 characters is two SMS segments (153 each) — the same ceiling the coach's own
 * replies and the off-domain answer are fitted to. Two rather than intake's usual one
 * because this turn is inherently two things, an answer and a question, and cutting the
 * answer to fit one segment would produce the terse non-reply the stage exists to
 * replace.
 *
 * IT WAS TWO CAPS (220/80, then 200/100) and both live recordings refused a perfectly
 * sendable pair on one half alone — a 105-character return line riding behind a
 * 58-character answer, well inside the message a carrier would have delivered as one
 * ordinary two-part text. The split was a budget invented for the model's convenience,
 * and what a carrier actually bills is the joined body; measuring anything else refuses
 * good messages for failing a rule nothing downstream enforces.
 */
export const MAX_REPLY_CHARS = 300;

const MAX_TOKENS = 300;

/** No links, held structurally: this stage has no tool it could have gotten one from,
 * so a URL here is a URL it invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

/**
 * The doctrine's standing rule (skill audit P0 #4), and doubly true here: a parent three
 * texts into intake has no account to log into, so a sentence locating anything "in the
 * app" is inventing a product.
 *
 * SCOPED TO THE DEFINITE ARTICLE, which is not fussiness — it is the difference between
 * the claim and its denial. The first live recording answered "is this a real person"
 * with "I'm a text number, not a person or AN APP", which is the correct answer, and a
 * gate that matched the word rather than the pointing refused it. Hale is allowed to say
 * there is no app; it is not allowed to say where one is. Same calibration as the
 * general-answer eval's.
 */
const APP_POINTER =
  /\b((?:the|your|their|our) (?:\w+ )?apps?|in-app|the website|the site|your dashboard|villagehale)\b/i;

/**
 * WORK HALE HAS NOT BEEN ASKED TO DO. The falsest thing this stage can say.
 *
 * The seam that calls it is the consent ask itself, so at the instant this message is
 * composed nothing has been agreed to: Hale is not watching, has not started, and has
 * found nothing. A warm model reaches for exactly these sentences, which is why this is
 * a refusal in code and not only a paragraph in the skill (rule #4).
 */
const CLAIMED_WORK =
  /\b(i'?(ll|m going to|ve)\s+(keep|watch|track|start|set|add|find|found|remind|send|text|check|look)|i'?m\s+(already\s+)?(watching|tracking|keeping|monitoring)|i\s+(?!don'?t|do not|won'?t|can'?t|never|would|could)(?:watch|track|monitor)\b|already\s+(started|set up|watching|tracking|found)|from now on|starting\s+(today|tomorrow|now))/i;

/**
 * CLAIMING TO BE A PERSON. The first live recording answered "wait is this a real person
 * or a bot" with "It's a real person on the other end." — a lie, to a stranger, on the
 * turn where they are deciding whether to trust Hale with their children's details, and
 * the one thing the greeting already discloses in its own first sentence.
 *
 * NEGATION-SAFE BY REQUIRING THE DISCLOSURE rather than by trying to spot the lie: a
 * pattern for "real person" refuses the honest "I'm not a real person, I'm an AI" just
 * as readily. So the rule is a conditional — say what you are, if you are going to
 * discuss what you are — and it has no false positive on an answer that never raises the
 * subject at all.
 */
const HUMANNESS = /\b(real (person|human)|actual (person|human)|a human|not a (bot|robot))\b/i;
const DISCLOSES_AI = /\b(ai|a\.i\.|bot|software|a program|not a (real )?(person|human))\b/i;

/**
 * Why a composed pair may not be sent. Mechanical, and each one is a different story in
 * the log: the first six are a model writing something a carrier mangles or a shape the
 * turn cannot use, and the last four are a model writing something FALSE.
 */
export type IntakeAnswerRefusal =
  | 'over_char_cap'
  | 'not_gsm7'
  | 'carries_link'
  | 'answer_carries_question'
  | 'return_asks_nothing'
  | 'return_repeats_the_ask'
  | 'invented_fact'
  | 'points_at_the_app'
  | 'claimed_work'
  | 'claimed_to_be_human';

/** Why the stage produced no words. Four separate operational stories, none of them
 * silence (rule #11): `skill_unavailable` is a deploy bug, `model_failed` an outage,
 * `unusable` the model getting it wrong and the gates catching it. */
export type IntakeAnswerFallback = 'skill_unavailable' | 'model_failed' | 'unusable';

export type IntakeAnswerOutcome =
  /** The whole message: the answer, then Hale's question again in different words. */
  | { status: 'answered'; body: string }
  /** Not a question. The caller's own reply is the right one and this cost one call. */
  | { status: 'nothing_to_answer' }
  /**
   * Someone is hurt, ill or in danger. Carries NO body on purpose — the words a parent
   * gets in that moment are the reviewed ones in off-domain/copy.ts, and a variant with
   * a text field is one a later edit could fill from a model.
   */
  | { status: 'safety' }
  /**
   * Caregiver mental crisis. Carries NO body — the machine sends
   * {@link MENTAL_CRISIS_REPLY} (988 / 911), never the child-health 811 line.
   */
  | { status: 'mental_crisis' }
  | { status: 'unavailable'; reason: IntakeAnswerFallback };

export interface IntakeAnswerInput {
  /** What the parent just texted, verbatim — the question being answered. */
  parentWords: string;
  /** The question intake is still waiting on, in the words Hale already used. */
  pendingAsk: string;
  /** The children collected so far: the ONLY child facts the answer may state, and all
   * of them things the parent typed into this same conversation. */
  children: readonly ExtractedChild[];
  /**
   * Coarse postal/FSA already collected in this conversation. Rec-morning routing
   * only — never shown to the model (see {@link intakeAnswerContext}).
   */
  postalCode?: string | null;
}

export interface IntakeAnswerComposer {
  compose(input: IntakeAnswerInput): Promise<IntakeAnswerOutcome>;
}

const answerSchema = z.object({ answer: z.string(), returnLine: z.string() });

const answerJsonSchema = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description:
        'The reply to what the parent asked, or an empty string if they did not ask anything.',
    },
    returnLine: {
      type: 'string',
      description: "Hale's own pending question again, in different words, ending in '?'.",
    },
  },
  required: ['answer', 'returnLine'],
} as const;

/**
 * What the model is handed. The parent's own words, Hale's own question, and the
 * children the parent named minutes ago — no family id, no postal code, no transcript,
 * no session state (rule #1: the model sees only what the message may contain).
 */
export function intakeAnswerContext(input: IntakeAnswerInput): unknown {
  return {
    parentWords: input.parentWords,
    pendingAsk: input.pendingAsk,
    children: input.children.map((child) => ({ name: child.name, ageMonths: child.ageMonths })),
  };
}

/** Every fact the pair may reuse, for the invented-fact lint. */
export function intakeAnswerFactSlots(input: IntakeAnswerInput): string[] {
  const slots = [input.parentWords, input.pendingAsk];
  for (const child of input.children) {
    if (child.name) slots.push(child.name);
    if (child.ageMonths !== null) slots.push(String(child.ageMonths));
  }
  return slots;
}

/**
 * Every reason this pair cannot go out — all of them, not the first, so one log line
 * says everything the model got wrong.
 *
 * `return_repeats_the_ask` is the gate this whole arc is named after: sending a parent
 * the identical sentence they just ignored, after answering them, would be the re-ask
 * with a preamble on it.
 */
export function refusals(
  answer: string,
  returnLine: string,
  input: IntakeAnswerInput,
): IntakeAnswerRefusal[] {
  const found: IntakeAnswerRefusal[] = [];
  const joined = `${answer} ${returnLine}`;
  if (joined.length > MAX_REPLY_CHARS) found.push('over_char_cap');
  if (smsEncoding(joined) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(joined)) found.push('carries_link');
  if (answer.includes('?')) found.push('answer_carries_question');
  if (!returnLine.endsWith('?')) found.push('return_asks_nothing');
  if (returnLine === input.pendingAsk.trim()) found.push('return_repeats_the_ask');
  if (findInventedFacts(joined, intakeAnswerFactSlots(input)).length > 0)
    found.push('invented_fact');
  if (APP_POINTER.test(joined)) found.push('points_at_the_app');
  if (CLAIMED_WORK.test(joined)) found.push('claimed_work');
  if (HUMANNESS.test(joined) && !DISCLOSES_AI.test(joined)) found.push('claimed_to_be_human');
  return found;
}

/** The only thing any catch here may log: a provider error can carry the request back,
 * and the request is a parent's own words (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unavailable(reason: IntakeAnswerFallback, detail?: string): IntakeAnswerOutcome {
  console.error({ reason, detail }, 'intake answer: no answer composed, the script reply stands');
  return { status: 'unavailable', reason };
}

/**
 * Read the model's pair.
 *
 * The health-line tripwire runs BEFORE every other gate because it SUBSTITUTES where
 * the rest refuse: a parent who turns out to be describing a hurt child must get the
 * reviewed 811/911 line, never the flat signup question a refusal would send them
 * (skill audit P0 #3, the same ordering off-domain/answer.ts uses).
 */
export function readPair(
  raw: { answer: string; returnLine: string },
  input: IntakeAnswerInput,
): IntakeAnswerOutcome {
  const answer = plainText(raw.answer);
  const returnLine = plainText(raw.returnLine);
  if (reachesForTheHealthLine(`${answer} ${returnLine}`)) {
    console.error('intake answer: composer reached for a referral; sent the fixed line');
    return { status: 'safety' };
  }
  // Read before the gates, not after: an empty answer is the model declining, which is
  // a correct outcome, and grading a declined turn against a character cap would log a
  // refusal for a stage that did its job.
  if (answer === '') return { status: 'nothing_to_answer' };

  const problems = refusals(answer, returnLine, input);
  if (problems.length > 0) return unavailable('unusable', problems.join('+'));
  return { status: 'answered', body: `${answer} ${returnLine}` };
}

/**
 * The production composer.
 *
 * The client is a VALUE rather than a resolver, unlike the router's stages: intake's
 * deps are built only after a Twilio signature passes and `buildIntakeDeps` already
 * throws without a key, so "no client" is not a state this seam can be in — and rule
 * #11 says an effect that cannot be absent must not be nullable.
 */
const MAX_OFFICIAL_SEARCHES = 2;
const OFFICIAL_GROUND_MAX_TOKENS = 2048;

type OfficialGround =
  | { status: 'grounded'; notes: string }
  | { status: 'ungrounded'; reason: string };

/**
 * GROUND a rec/camp clock against official pages. Zero searches, empty notes,
 * or notes with no date are the same parent-facing sentence — not posted yet —
 * and each reason is named in the log (rule #11). The search is Anthropic's US
 * tool, so the query is de-identified first.
 */
async function groundOfficialPages(
  client: AgentClient,
  input: IntakeAnswerInput,
): Promise<OfficialGround> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('intake-official-ground');
  } catch (err) {
    return { status: 'ungrounded', reason: `skill_unavailable:${message(err)}` };
  }

  const query = deidentifyOfficialQuery(input.parentWords, input.children);
  try {
    const research = await client.messages.create({
      model: pickModel(skill.meta.task),
      max_tokens: OFFICIAL_GROUND_MAX_TOKENS,
      system: skill.instructions,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_OFFICIAL_SEARCHES }],
      messages: [{ role: 'user', content: query }],
    });
    const evidence = readEvidence(new Date(), research.content);
    if (evidence.searchResults === 0) return { status: 'ungrounded', reason: 'not_grounded' };
    if (evidence.notes === '') return { status: 'ungrounded', reason: 'empty_research' };
    if (!notesGroundADate(evidence.notes)) return { status: 'ungrounded', reason: 'no_date' };
    return { status: 'grounded', notes: evidence.notes };
  } catch (err) {
    return { status: 'ungrounded', reason: `ground_failed:${message(err)}` };
  }
}

export function createIntakeAnswerComposer(client: AgentClient): IntakeAnswerComposer {
  return {
    async compose(input) {
      // FIRST, and with no model in the loop. See the module note: intake has never had
      // the screened safety lane, and an emergency must not wait on a provider that may
      // be the reason this turn is degraded at all.
      if (namesAnEmergency(input.parentWords)) return { status: 'safety' };
      if (namesAMentalCrisis(input.parentWords)) return { status: 'mental_crisis' };

      // VIL-323: adult-learn is a Designer-locked kids-only door, not a model "I
      // don't do that" and not a city clock. Checked before rec-morning so
      // "I wanna learn swimming in Brampton" never invents a date.
      const adultLearn = adultLearnIntakeReply({
        parentWords: input.parentWords,
        pendingAsk: input.pendingAsk,
      });
      if (adultLearn !== null) return { status: 'answered', body: adultLearn };

      // Rec-morning clock and portal are reviewed copy, not a composition. A first-time
      // texter asking which morning / which login must not wait on a model that still
      // remembers ActiveTO. Same shape as the emergency tripwire: no client, no skill.
      const recMorning = recMorningIntakeReply({
        parentWords: input.parentWords,
        pendingAsk: input.pendingAsk,
        postal: input.postalCode,
      });
      if (recMorning !== null) return { status: 'answered', body: recMorning };

      // VIL-326: a rec/camp/registration clock that missed the city pins. Search
      // official pages; if a date is not on them, say so. Never invent a clock,
      // and never return unavailable — that was the greet/ask-alone leak.
      if (isOfficialPageAsk(input.parentWords)) {
        const ground = await groundOfficialPages(client, input);
        if (ground.status === 'ungrounded') {
          console.error(
            { reason: ground.reason },
            'intake answer: official page not grounded, said the date is not posted',
          );
          return { status: 'answered', body: officialPageFallbackReply(input.pendingAsk) };
        }
        return {
          status: 'answered',
          body: officialPageReplyFromNotes(ground.notes, input.pendingAsk),
        };
      }

      // VIL-327 caregiver cheer-up: reviewed warmth, not a clinician, then
      // one return ask. Crisis already left above. Therapist-find is live lookup.
      if (isCheerUpAsk(input.parentWords)) {
        return { status: 'answered', body: cheerUpIntakeReply(input.pendingAsk) };
      }

      // VIL-327: raising-kids, leftover current-source facts, therapist-find.
      // Live lookup only. The SMS may only restate what search returned.
      // Framework-only / model memory is not a path.
      if (isLiveLookupAsk(input.parentWords)) {
        const ground = await groundCurrentSource(client, input.parentWords, input.children);
        if (ground.status === 'ungrounded') {
          console.error(
            { reason: ground.reason },
            'intake answer: current source not grounded, said so',
          );
          return { status: 'answered', body: liveLookupFallbackReply(input.pendingAsk) };
        }
        return {
          status: 'answered',
          body: liveLookupReplyFromNotes(ground.notes, input.pendingAsk),
        };
      }

      // Loaded INSIDE the fallback boundary, like intake-voice's: this sits in the
      // middle of a stranger's first conversation, and no deploy problem is worth
      // leaving that conversation unanswered.
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('intake-answer');
      } catch (err) {
        return unavailable('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: JSON.stringify(intakeAnswerContext(input)),
          toolName: 'reply',
          toolDescription:
            "Return the answer to the parent's question and the line back to Hale's.",
          inputJsonSchema: answerJsonSchema,
          schema: answerSchema,
          maxTokens: MAX_TOKENS,
        });
        return readPair(value, input);
      } catch (err) {
        return unavailable('model_failed', message(err));
      }
    },
  };
}
