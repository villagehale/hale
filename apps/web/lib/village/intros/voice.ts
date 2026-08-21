import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE TWO INTRO ASKS, COMPOSED — the opt-in question and the coarse card.
 *
 * WHY THIS SUPERSEDES copy.ts's STANDING ARGUMENT. That file held (and still holds, for
 * the acks) that an intro is a cross-household disclosure and a disclosure must never be
 * improvised. The argument was right about the DISCLOSURE and wrong about the ASK. What
 * actually shipped were two fixed sentences ending "Reply YES INTROS or NO INTROS." and
 * "Reply YES INTRO or NO INTRO." — two near-identical magic words, hours apart, in
 * marketing-blast grammar. The founder read them live on 2026-08-13: it does not sound
 * human, and it does not sound like a chief of staff. A parent should never be handed a
 * keyword to recite; Hale reads what they actually say (lib/channel/router/resolve.ts).
 *
 * THE PRIVACY RULE DID NOT MOVE, AND IT IS STILL STRUCTURAL. {@link IntroAskRequest} is
 * the whole of what a composer sees, and it is exactly what `coarseCard` took: a stage
 * WORD (a fact about a band, not about a child), the RECIPIENT'S OWN child as already
 * rendered through the teen gate, and an activity title from the civic dataset. There is
 * no parameter here that could carry the other household's name, age, area or address, so
 * a future edit cannot leak what was never passed in. What changed is who chooses the
 * verbs; what crosses the boundary is byte-for-byte the same set of facts.
 *
 * MEANING PINNED, WORDS FREE. The refusals below are the pinned half: an opt-in ask that
 * never says "introduc" did not ask the question, and a card that drops the anchor threw
 * away the whole reason the introduction is a good one. Everything the refusals do not
 * name is the model's.
 *
 * NO PRESET UNDERNEATH (founder, 2026-08-12). A refused body is composed again with the
 * refusal handed back; a composer that cannot produce a sendable ask DEFERS, and the sweep
 * leaves its dedupe claim unspent so the next tick is a retry rather than a duplicate.
 */

/**
 * The ceiling, derived rather than typed: a proactive intro text must fit two SMS
 * segments INCLUDING the CASL opt-out line on the periods when it rides
 * (lib/channel/opt-out.ts), because a body that only fits when the line is absent is a
 * body that silently costs a third segment once a month.
 */
export const MAX_INTRO_ASK_CHARS = 306 - (OPT_OUT_LINE.length + 2);

/** The same two-segment envelope every other proactive class holds itself to. */
export const MAX_INTRO_SEGMENTS = 2;

/** Three attempts, then defer — the follow-up composer's rule, for its reason: a model
 * told its exact violation twice is not argued into it on the fourth try. */
export const MAX_COMPOSE_ATTEMPTS = 3;

const MAX_TOKENS = 256;

/** No links: this stage has no tool that could have produced one, so a URL here is
 * invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

/**
 * A keyword INSTRUCTION — the shape this whole arc exists to delete, made mechanical so
 * it cannot come back as a good-sounding sentence.
 *
 * It catches the instruction, never the word: "yes" and "no" are ordinary English and a
 * composed ask may well contain them. What may not appear is Hale telling a parent which
 * token to type back. STOP is deliberately absent from this pattern — the CASL line is
 * legally load-bearing and is appended by the gate, not by this composer.
 */
const KEYWORD_INSTRUCTION =
  /\b(reply|respond|text|send|type)\b[^.?!]{0,20}\b(yes|no|y\b|n\b|intro|intros)\b/i;

/**
 * Hale, talking about Hale in the third person — "Hale can make an introduction".
 *
 * Found by the first live recording of this stage: six asks out of six wrote it that way,
 * while every acknowledgement in copy.ts three lines away says "I'll introduce you both".
 * One feature, two speakers. nudge-voice.md already calls this a press-release voice; the
 * instruction was simply missing from this skill, and an instruction a live run can lose
 * is a gate this file should be holding.
 *
 * It matches Hale as the SUBJECT OF A VERB, never the brand name: "other Hale families
 * near you" is the only way to say what a Hale family is, and it is the whole premise of
 * the message.
 */
const THIRD_PERSON_SELF =
  /\bHale\s+(can|could|will|would|is|isn't|has|have|makes|make|made|might|may|does|knows|thinks|found|sends|texts|introduces)\b/i;

/** The royal we. Hale is one operator texting one parent; "let us know" is a support
 * queue. Caught live in the same recording. */
const FIRST_PERSON_PLURAL = /\b(we|we're|we'll|we've|us|our|ours)\b/i;

/** How Hale refers to the other family's child: a band word and nothing else. */
export type IntroAskRequest =
  | { kind: 'optin' }
  | {
      kind: 'proposal';
      /** The counterpart's stage as a NOUN ("toddler"), from copy.ts's `stageWord`. */
      counterpartWord: string;
      /** The recipient's OWN child, already through `loopChildName` and the teen gate,
       * with an apostrophe-s applied ("Maya's", "your kid's"). */
      ownChildPossessive: string;
      /** The civic session's title, VERBATIM from the dataset — never paraphrased, because
       * the dataset is the only thing that knows what the session is called. */
      anchorTitle: string | null;
      /** The weekday that session falls on, in the recipient's own wall clock. */
      anchorDay: string | null;
    };

export type IntroAskRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'over_segment_cap'
  | 'not_gsm7'
  | 'carries_link'
  | 'too_many_questions'
  | 'not_a_sentence'
  /** Hale told the parent which token to type. The defect this arc removes. */
  | 'instructs_keyword'
  /** Hale referred to itself by name instead of saying "I". */
  | 'third_person_self'
  /** "We" / "us". Hale is one person, not a team. */
  | 'first_person_plural'
  /** The opt-in ask never said what it was asking about. */
  | 'introduction_word_missing'
  /** The card dropped the one counterpart fact it is allowed to carry. */
  | 'counterpart_word_missing'
  /** The card is about the recipient's own child and did not mention them. */
  | 'own_child_missing'
  /** An anchor was supplied and the card threw it away. */
  | 'anchor_missing'
  | 'carries_address'
  | 'invented_number';

/**
 * Every reason this body cannot go out — all of them, so one recompose can fix everything
 * at once rather than one thing per round trip.
 *
 * AT MOST one question mark, not exactly one: the identity ask learned live that forcing
 * an interrogative makes the copy worse, and what has to be stopped is the interrogation.
 * Whether it actually asks is held by the required-word refusals.
 */
export function introAskRefusals(body: string, request: IntroAskRequest): IntroAskRefusal[] {
  const found: IntroAskRefusal[] = [];
  if (body === '') return ['empty'];
  if (body.length > MAX_INTRO_ASK_CHARS) found.push('over_char_cap');
  if (smsSegments(body) > MAX_INTRO_SEGMENTS) found.push('over_segment_cap');
  if (smsEncoding(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if ((body.match(/\?/g) ?? []).length > 1) found.push('too_many_questions');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  if (KEYWORD_INSTRUCTION.test(body)) found.push('instructs_keyword');
  if (THIRD_PERSON_SELF.test(body)) found.push('third_person_self');
  if (FIRST_PERSON_PLURAL.test(body)) found.push('first_person_plural');

  const lower = body.toLowerCase();
  if (!lower.includes('introduc') && !lower.includes('intro')) {
    found.push('introduction_word_missing');
  }

  // Facts Hale HANDED the model are stripped before the invented-number check: a digit
  // inside a session title ("Storytime at 10 Elm") came from the dataset, not from the
  // model. Everything left over is the model's own arithmetic, which it has no source for.
  let residue = body;
  if (request.kind === 'proposal') {
    if (!lower.includes(request.counterpartWord.toLowerCase())) {
      found.push('counterpart_word_missing');
    }
    if (!containsPossessive(lower, request.ownChildPossessive)) found.push('own_child_missing');
    if (request.anchorTitle !== null) {
      if (!lower.includes(request.anchorTitle.toLowerCase())) found.push('anchor_missing');
      residue = stripAll(residue, request.anchorTitle);
    }
    residue = stripAll(residue, request.ownChildPossessive);
  }

  if (body.includes('@')) found.push('carries_address');
  if (/\d/.test(residue)) found.push('invented_number');
  return found;
}

/**
 * Does the card name the recipient's own child?
 *
 * The possessive arrives already built ("Maya's", "your kid's") and a composer writing
 * good English may split it — "Maya" plus a differently-placed apostrophe, or "your kid"
 * in a sentence that does not need the possessive at all. What must survive is the NOUN,
 * so that is what is checked.
 */
function containsPossessive(lowerBody: string, possessive: string): boolean {
  const noun = possessive.toLowerCase().replace(/['’]s$/, '').trim();
  return noun.length > 0 && lowerBody.includes(noun);
}

function stripAll(body: string, fragment: string): string {
  if (fragment === '') return body;
  return body.split(fragment).join(' ').split(fragment.toLowerCase()).join(' ');
}

export interface RejectedIntroAsk {
  ask: string;
  problems: IntroAskRefusal[];
}

/**
 * The user-turn payload. Shared with the eval, which REPLICATES this request shape.
 * `rejected` is omitted on a first attempt so the common request stays the small one.
 */
export function introAskUserMessage(
  request: IntroAskRequest,
  rejected: readonly RejectedIntroAsk[] = [],
): string {
  const base: Record<string, unknown> =
    request.kind === 'optin'
      ? { kind: 'optin' }
      : {
          kind: 'proposal',
          counterpartWord: request.counterpartWord,
          ownChildPossessive: request.ownChildPossessive,
          anchorTitle: request.anchorTitle,
          anchorDay: request.anchorDay,
        };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/** Four stories, four different humans: configuration, a deploy bug, an outage, and a
 * prompt problem — the only one of the four that is anybody's fault here. */
export type IntroVoiceDeferral =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type IntroVoiceOutcome =
  | { status: 'composed'; body: string }
  /** Nothing sendable this tick. The sweep MUST leave its dedupe claim unspent (rule
   * #11): a deferral is a retry, and a retry that consumed its key never happens. */
  | { status: 'deferred'; reason: IntroVoiceDeferral };

export interface IntroVoice {
  compose(request: IntroAskRequest): Promise<IntroVoiceOutcome>;
}

const askSchema = z.object({ ask: z.string() });

const askJsonSchema = {
  type: 'object',
  properties: { ask: { type: 'string' } },
  required: ['ask'],
} as const;

/** The error's CLASS and nothing else — an Anthropic 400's `message` is the stringified
 * response body, which is the field most likely to quote what was sent (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function deferred(reason: IntroVoiceDeferral, detail?: string): IntroVoiceOutcome {
  console.error({ reason, detail }, 'village intros: no ask composed, deferring');
  return { status: 'deferred', reason };
}

export function createIntroVoice(client: () => AgentClient): IntroVoice {
  return {
    async compose(request) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return deferred('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('intro-voice');
      } catch (err) {
        return deferred('skill_unavailable', message(err));
      }

      const rejected: RejectedIntroAsk[] = [];
      for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: introAskUserMessage(request, rejected),
            toolName: 'ask',
            toolDescription: 'Return the one text asking this family about an introduction.',
            inputJsonSchema: askJsonSchema,
            schema: askSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.ask;
        } catch (err) {
          // An outage does not get three tries; the sweep has another tick to wait in.
          return deferred('model_failed', message(err));
        }

        const body = plainText(raw);
        const problems = introAskRefusals(body, request);
        if (problems.length === 0) return { status: 'composed', body };
        rejected.push({ ask: body, problems });
      }

      return deferred('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}

let cached: Anthropic | undefined;

/** Lazy and THROWING, the shape every sweep composer uses: the sweep builds its deps on
 * every tick including the ones that reach no model, so a missing key must not break
 * construction — it must produce the named `client_unavailable` deferral. */
export function introVoiceClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  cached ??= new Anthropic({ apiKey });
  return cached;
}

export function productionIntroVoice(): IntroVoice {
  return createIntroVoice(introVoiceClient);
}
