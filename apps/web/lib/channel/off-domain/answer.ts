import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { formatLongDate } from '~/lib/format/datetime';
import { StructuredOutputError, forceToolJson } from '~/lib/pipeline/structured';
import {
  type HomePlace,
  type LiveSearch,
  type PendingAsk,
  answerJsonSchema,
  answersPending,
  generalAnswerUserMessage,
  needsSearch,
  questionSanitizeUserMessage,
  sanitizeJsonSchema,
  scrubDirectIdentifiers,
  searchUserMessage,
  turnsOnTheirPlace,
} from './answer-request';
import {
  EMERGENCY_REPLY,
  MENTAL_CRISIS_REPLY,
  namesAMentalCrisis,
  namesAnEmergency,
  reachesForTheHealthLine,
} from './copy';
import { COMPOSE_MAX_TOKENS, normalizeLanguage } from './medical';

export {
  generalAnswerUserMessage,
  questionSanitizeUserMessage,
  scrubDirectIdentifiers,
  searchUserMessage,
};
export type { HomePlace, LiveSearch, PendingAsk };

/**
 * Boundary v3 — the general answer.
 *
 * The quiet-operator promise governs OUTBOUND: Hale never starts the chatter. INBOUND it
 * was over-applied. A parent who texted "who's the goat in football" got charm and a
 * closed door, and a closed door to a question a friend would just answer reads as a
 * product that cannot, not one that chooses not to. So the `off_domain_general` terminal
 * answers: brief, correct, in the tone of a friend texting back, and then done. Where the
 * answer turns on something current — a score, a forecast, a price, who holds a job —
 * Hale looks it up first (founder, 2026-10-12). It never deflects and never sends the
 * parent off to find out for themselves. The other two doors do not move — a symptom
 * still gets 811 and a parent hunting a paediatrician still gets Health Care Connect,
 * both from fixed copy no model touches (see copy.ts).
 *
 * Three phases, the medical lane's shape (medical.ts) and for its reasons:
 *
 *   0. SANITIZE. The one and only stage that sees the parent's raw words. It returns the
 *      question with the family taken out of it, the language they wrote in, and its
 *      judgment of whether a correct answer needs something current, or cannot be given
 *      at all without a detail the question leaves out (which city, for a forecast). The
 *      deterministic {@link scrubDirectIdentifiers} backstop then runs under it, before
 *      the question goes anywhere.
 *
 *   1. SEARCH. Only when the sanitizer judged the answer needs current facts AND
 *      {@link generalAnswerSearchEnabled} is lit: one STREAMED `web_search` server-tool
 *      turn on the de-identified question and today's date. The result items actually
 *      returned are counted, and zero is not a search. A question missing what its
 *      answer depends on is not searched: no search could answer it. While the flag is
 *      dark it is not asked about either, because asking for the city is a promise to
 *      look the forecast up once it is given.
 *
 *   2. COMPOSE. The skill writes the one reply from the de-identified question, today's
 *      date and the research when there is any, in the parent's language. Told a detail
 *      is missing, it asks for it.
 *
 * NOTHING ABOUT THE CHILDREN IS LOADED. No children, no calendar, no transcript. That is
 * rule #1 at its cheapest: an off-topic answer needs nothing about the kids, so nothing
 * about the kids is at risk. Two things are handed in from outside the message, both
 * worked out by the lane and asked for only once there is a de-identified question to
 * read them against: today's date where the family is, and the family's own city and
 * country.
 *
 * THE CITY AND THE COUNTRY, AND NOTHING FINER (founder, 2026-10-12). "How's the weather
 * tomorrow" has one answer for this family, so the search may be told where they are:
 * a city name and a country name, never the postal code they were worked out from, the
 * province, a neighbourhood or anything else on the family's row. Code is the only
 * source of it ({@link FamilyFacts.place}); no model is asked to guess. Whether a
 * question turns on it at all is the sanitizer's reading, and the place is read only for
 * a lit turn that reading says needs it. A question that names its own place, or does not
 * depend on place, carries none. Only the search is sent it; neither the sanitizer nor
 * the compose is.
 *
 * A QUESTION LEFT OPEN IS KEPT FOR THE REPLY. The lane is one text in and one out, so a
 * parent who answers "Toronto" to "which city?" starts a new turn with no question
 * attached. A lit turn that could not answer (a detail was missing, or the search came
 * back with nothing) therefore hands out the question it was working on, de-identified
 * and scrubbed, with what it was missing ({@link PendingAsk}; the router keeps it on the
 * reply's own ledger row). The parent's next text in that thread, once the lane's screen
 * has read it, is read beside it by the sanitizer, which alone judges whether the text
 * completes it ({@link GeneralAnswerComposer.continueAsk}). There is no keyword and no
 * time window. What is kept is never the parent's own words, and nothing is kept or read
 * while the flag is dark.
 *
 * EVERY WAY THE SEARCH DOES NOT HAPPEN IS NAMED ({@link LiveSearch}, rule #11), and none
 * of them costs the parent a reply or buys them an invented one: the compose is told that
 * nothing could be checked, and says so.
 *
 * A MODEL CANNOT COST A PARENT THEIR REPLY. Every degraded path of the calls made
 * here — no client, no skill, an outage, an answer that cannot be sent — comes back
 * NAMED (rule #11) and the lane sends its fixed could-not-get-to-it line instead. The
 * date is the lane's read, not a model's: when it cannot be made it throws to the
 * router, as every other database read on the turn does, and it is asked for after the
 * fixed lines so that none of them waits on it.
 *
 * PRIVACY. The raw message reaches ONLY the sanitize call; the search and the compose see
 * the de-identified question alone. Nothing here logs the question in either form, or
 * any provider text — only a named reason and a named detail (rule #1).
 */

export const GENERAL_ANSWER_SEARCH_ENABLED_ENV = 'GENERAL_ANSWER_SEARCH_ENABLED';

/**
 * The live search is a new outbound data flow with a per-request fee, so it is dark until
 * lit. STRICT equality on the literal 'true': a piped `vercel env add` stores 'true\n',
 * which must stay off.
 */
export function generalAnswerSearchEnabled(): boolean {
  return process.env[GENERAL_ANSWER_SEARCH_ENABLED_ENV] === 'true';
}

/** Bounded because the provider bills per search. The same bound intake/live-lookup.ts
 * holds for this class of question. */
const MAX_SEARCHES = 2;
const SANITIZE_MAX_TOKENS = 512;
/** The medical GROUND turn's ceiling: thinking and the notes share it. */
const SEARCH_MAX_TOKENS = 4096;
/**
 * The compose call's budget, thinking and reply together, and the one bound on what goes
 * out. It is the medical compose's (medical.ts), generous for the same reason:
 * forceToolJson throws on a max_tokens cutoff, and a reply cut off there is swapped for
 * the fixed line. At 256 a compose handed long research notes wrote past it, live. There
 * is no segment or character cap on the reply: a correct answer that ran long is still
 * the answer.
 */
const MAX_TOKENS = COMPOSE_MAX_TOKENS;

/**
 * Why the answer did not happen. Deliberately four separate stories and not one:
 * `client_unavailable` is configuration, `skill_unavailable` is a deploy bug,
 * `model_failed` is an outage, and `unsendable` is the model itself writing something
 * that must not go on the wire. Only the last one is a prompt problem.
 *
 * A failed SANITIZE rides as a detail of `model_failed` rather than as a fifth reason. It
 * is that story — a model call that did not come back usable — and these four are
 * persisted (channel_messages.reply_source) against a vocabulary a migration restates.
 */
export type GeneralAnswerFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unsendable';

export type GeneralAnswerOutcome =
  /** `search` is set whenever a model wrote the reply. The fixed lines above the model
   * have no search to name. `pendingAsk` is set when the reply left the question open:
   * what the parent's next text is read beside. */
  | { status: 'composed'; reply: string; search?: LiveSearch; pendingAsk?: PendingAsk }
  /**
   * The question turned out to be about someone hurt or ill, and the model answered it
   * with a referral of its own (skill audit P0 #3). This branch carries NO reply on
   * purpose: the words a parent gets in that moment are the reviewed ones in copy.ts,
   * and a variant with a text field is one an edit could later fill from the model.
   */
  | { status: 'safety' }
  | { status: 'unavailable'; reason: GeneralAnswerFallback };

/**
 * Why a family's place cannot be named. Each is its own story: no country on the row
 * (never guessed, not even from a postal code), a country the lane has no postal table
 * for, no postal code to work a city out from, a postal area the table cannot give one
 * municipality for, or one that covers more than one town (never resolved to the likelier
 * one). The last two are the lane's and not the row's: the text arrived in a group thread,
 * or in one the job does not describe, and a family's home city is said in neither.
 */
export type PlaceUnknown =
  | 'no_country'
  | 'unsupported_country'
  | 'no_postal'
  | 'unmapped'
  | 'ambiguous'
  | 'group_thread'
  | 'thread_unknown';

export type FamilyPlace =
  | ({ status: 'known' } & HomePlace)
  | { status: 'unknown'; reason: PlaceUnknown };

/**
 * The lane's reads about the family, made lazily. Each is called at most once a turn, and
 * not at all for a text a fixed line answers.
 */
export interface FamilyFacts {
  /** Today's date where the family is (see {@link localDate}). */
  today(): Promise<string>;
  /** The family's own city and country, read only for a lit search the sanitizer judged
   * to depend on where they are. */
  place(): Promise<FamilyPlace>;
}

/** A text that is not the reply to the pending ask, or could not be read as one. The
 * lane routes it as it would any other text. */
export interface NotAReply {
  status: 'unrelated';
}

export interface GeneralAnswerComposer {
  compose(text: string, family: FamilyFacts): Promise<GeneralAnswerOutcome>;
  /**
   * The parent's next text after a reply that left `pending` open. Answered as the
   * completed question when the sanitizer judges it completes it; handed back as
   * `unrelated` otherwise, and also when that judgment could not be made at all, because
   * the text may be about the kids' week. The lane calls this only for a text its screen
   * has read and sent to the coach or to the general answer (lane.ts).
   */
  continueAsk(
    text: string,
    pending: PendingAsk,
    family: FamilyFacts,
  ): Promise<GeneralAnswerOutcome | NotAReply>;
}

/** Parsed loosely, for the reason screen.ts states at length: a strict schema turns a
 * parent's injected field name into a logged ZodError message (rule #1), and zod's
 * default strips unknown keys instead. The reading and the language are normalized in
 * code for the same reason. */
const sanitizeSchema = z.object({
  language: z.string().nullish(),
  answers_pending: z.string().nullish(),
  question: z.string(),
  missing_detail: z.string().nullish(),
  their_place: z.string().nullish(),
  current_fact: z.string().nullish(),
  needs_search: z.string().nullish(),
});

const answerSchema = z.object({ answer: z.string() });

/**
 * Today's date as the search and the compose are told it: the weekday and the full date
 * in the zone given, so "last night" and "tomorrow" have something to be read against.
 */
export function localDate(now: Date, timeZone: string): string {
  const { weekday, month, day, year } = formatLongDate(now, timeZone);
  return `${weekday}, ${month} ${day}, ${year}`;
}

/** What the two setup catches log. Neither call is passed the question, so the message
 * cannot hold it; the error object is still never logged (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/** What a failed MODEL call logs. Every request here holds the question in one form or
 * another and a provider error can quote the request back in its message, so this is the
 * error's name and, for a structured answer that came back unusable, why. Never the
 * message (rule #1). */
function failureName(err: unknown): string {
  if (err instanceof StructuredOutputError) return `${err.name}:${err.outcome}`;
  return err instanceof Error ? err.name : 'unknown';
}

function unavailable(reason: GeneralAnswerFallback, detail?: string): GeneralAnswerOutcome {
  console.error({ reason, detail }, 'off-domain answer: falling back to the fixed line');
  return { status: 'unavailable', reason };
}

/** A question that needed a search and went without one, named (rule #11). The reply is
 * still composed, so this is a warning and not a fallback. */
function wentWithout<T extends LiveSearch>(search: T, detail?: string): T {
  console.warn({ search, detail }, 'off-domain answer: no live search this turn');
  return search;
}

/**
 * What became of a text read beside a pending ask, named (rule #11) and never with a word
 * of either (rule #1): it `completed` the question, it was `unrelated`, or it went
 * `unread` because the judgment could not be made.
 */
function notAReply(detail?: string): NotAReply {
  if (detail === undefined) {
    console.info({ pendingAsk: 'unrelated' }, 'off-domain answer: the reply to a pending ask');
  } else {
    console.warn({ pendingAsk: 'unread', detail }, 'off-domain answer: the reply to a pending ask');
  }
  return { status: 'unrelated' };
}

/** The question a lit turn could not answer, as it is kept for the parent's reply. A turn
 * that answered, needed no search, or ran dark keeps nothing. */
function leftOpen(search: LiveSearch, question: string, missing: string): PendingAsk | null {
  if (search === 'missing_detail') return { question, missing };
  if (search === 'search_failed' || search === 'nothing_usable') return { question, missing: '' };
  return null;
}

/** A question no search could answer as asked, named (rule #11). Nothing went wrong, so
 * it is not a warning. */
function askedInstead(): 'missing_detail' {
  console.info({ search: 'missing_detail' }, 'off-domain answer: no live search this turn');
  return 'missing_detail';
}

/**
 * The family's city and country for this turn's search, or null with the reason named
 * (rule #11). The place itself is never logged (rule #1).
 */
async function homePlace(family: FamilyFacts): Promise<HomePlace | null> {
  const place = await family.place();
  if (place.status === 'known') return { city: place.city, country: place.country };
  console.info(
    { place: 'unknown', reason: place.reason },
    'off-domain answer: no place for this family',
  );
  return null;
}

interface SearchFindings {
  /** The URL of every result item the search returned. */
  urls: readonly string[];
  /** What the turn wrote down. */
  notes: string;
}

const NO_FINDINGS: SearchFindings = { urls: [], notes: '' };

/**
 * What a search turn returned. A search block that came back as an ERROR carries an
 * object rather than a list, so it contributes nothing — which is the point (rule #11:
 * "ran and found nothing" is not "was grounded"). Mirrors medical.ts countSearchResults.
 */
function readSearch(content: Anthropic.ContentBlock[]): SearchFindings {
  const urls: string[] = [];
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) urls.push(result.url);
  }
  const notes = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  return { urls, notes };
}

/**
 * Phase 1. One web_search turn on the de-identified question, through the medical lane's
 * seam: the same injected client, the same server tool, the model its skill names.
 *
 * STREAMED. A server-tool turn runs its searches before the response is complete, and a
 * non-streamed request gets no headers until it is: activity/deep.ts measured that shape
 * dying at the client timeout while the identical request streamed finished. Streaming
 * makes the client's bound time-to-headers.
 *
 * Notes with no results under them are what the model remembered, not what it found, so
 * they are dropped with the rest.
 */
async function liveSearch(
  client: AgentClient,
  skill: Awaited<ReturnType<typeof loadCronSkill>>,
  question: string,
  today: string,
  place: HomePlace | null,
): Promise<{ search: LiveSearch; findings: SearchFindings }> {
  if (!generalAnswerSearchEnabled()) {
    return { search: wentWithout('search_off'), findings: NO_FINDINGS };
  }
  let research: Anthropic.Message;
  try {
    research = await client.messages
      .stream({
        model: pickModel(skill.meta.task),
        max_tokens: SEARCH_MAX_TOKENS,
        system: skill.instructions,
        tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
        messages: [{ role: 'user', content: searchUserMessage({ question, today, place }) }],
      })
      .finalMessage();
  } catch (err) {
    return { search: wentWithout('search_failed', failureName(err)), findings: NO_FINDINGS };
  }
  // A turn the provider paused, or cut off at the ceiling, can hold result items and only
  // its opening sentence: what it wrote is not what it found.
  if (research.stop_reason !== 'end_turn') {
    return {
      search: wentWithout('nothing_usable', `stopped:${research.stop_reason}`),
      findings: NO_FINDINGS,
    };
  }
  const findings = readSearch(research.content);
  if (findings.urls.length === 0) {
    return { search: wentWithout('nothing_usable', 'no_results'), findings: NO_FINDINGS };
  }
  if (findings.notes === '') {
    return { search: wentWithout('nothing_usable', 'empty_notes'), findings: NO_FINDINGS };
  }
  // The one line a lit turn leaves when it worked: the count, never the question.
  console.info(
    { search: 'searched', results: findings.urls.length },
    'off-domain answer: live search ran',
  );
  return { search: 'searched', findings };
}

const LINK = /(?:https?:\/\/|www\.)\S+/gi;

/** Whose site a URL is, as it is compared: the host, without the scheme, a leading
 * `www.`, the page under it, or whatever punctuation the sentence put after it. Anything
 * odd in front of the host (a login name, a port) stays in and so matches nothing. */
function linkHost(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/[.,;:!?)\]'"]+$/, '');
}

/**
 * A URL in a reply is real only when it is on a site this turn's search returned. Before
 * this stage could search, any URL was one the model invented and all of them were
 * refused; now one can be the thing the parent asked for, so what is refused is a host the
 * search did not return. The page is not compared: the front page of a site the search
 * found a deeper page on is still that site.
 */
function carriesUnsearchedLink(body: string, searched: readonly string[]): boolean {
  const known = new Set(searched.map(linkHost));
  return (body.match(LINK) ?? []).some((link) => !known.has(linkHost(link)));
}

/**
 * The composed answer, or a named reason it cannot be sent.
 *
 * LENGTH IS NOT A REASON. A correct answer that ran long used to be swapped for the fixed
 * could-not-get-to-it line, which is a deflect sent in place of an answer. The reply is
 * bounded where it is written, by the compose call's token budget, and what the model
 * wrote is what goes out. `detail` separates the ways a body can be unsendable in the
 * LOG without splitting the outcome the caller acts on.
 *
 * There is no encoding gate either. A parent who writes in French or Chinese is answered
 * in kind (general-answer.md): a typographic dash or a curly quote is still folded to
 * ASCII by `plainText`, but an accented é or a Chinese character is content the answer
 * cannot exist without.
 */
function sendable(
  raw: string,
  search: LiveSearch,
  searched: readonly string[],
  pendingAsk: PendingAsk | null,
): GeneralAnswerOutcome {
  const flattened = plainText(raw);
  // Before every other gate, because this one SUBSTITUTES where the rest refuse: a
  // parent who turns out to be describing a hurt child must get the fixed line, never
  // the "couldn't get to that one" a refusal would send them.
  if (reachesForTheHealthLine(flattened)) {
    console.error('off-domain answer: composer reached for a referral; sent the fixed line');
    return { status: 'safety' };
  }
  if (flattened === '') return unavailable('unsendable', 'empty');
  if (carriesUnsearchedLink(flattened, searched)) {
    return unavailable('unsendable', 'link_not_from_search');
  }
  return { status: 'composed', reply: flattened, search, ...(pendingAsk ? { pendingAsk } : {}) };
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER for the same reason the screen's is: the router builds its
 * dependencies for every inbound text including the ones a deterministic handler answers
 * with no model at all, so constructing a client at wiring time would make a missing key
 * break approvals — and deferring it buys the honest `client_unavailable` outcome.
 */
export function createGeneralAnswer(client: () => AgentClient): GeneralAnswerComposer {
  type Skill = Awaited<ReturnType<typeof loadCronSkill>>;
  interface Stage {
    client: AgentClient;
    sanitize: Skill;
    search: Skill;
    answer: Skill;
  }

  /** The client and the three skills, or the name of what is missing. */
  async function setUp(): Promise<
    Stage | { missing: 'client_unavailable' | 'skill_unavailable'; detail: string }
  > {
    let resolved: AgentClient;
    try {
      resolved = client();
    } catch (err) {
      return { missing: 'client_unavailable', detail: message(err) };
    }
    try {
      return {
        client: resolved,
        sanitize: await loadCronSkill('general-answer-sanitize'),
        search: await loadCronSkill('general-answer-search'),
        answer: await loadCronSkill('general-answer'),
      };
    } catch (err) {
      return { missing: 'skill_unavailable', detail: message(err) };
    }
  }

  /** Phase 0 — SANITIZE (the family out of the question; the language; the readings).
   * Throws what the call throws: the two callers name a failure differently. */
  async function sanitize(
    stage: Stage,
    text: string,
    pending: PendingAsk | null,
  ): Promise<z.infer<typeof sanitizeSchema>> {
    const { value } = await forceToolJson({
      client: stage.client,
      lane: pickLane(stage.sanitize.meta.task),
      system: stage.sanitize.instructions,
      userMessage: questionSanitizeUserMessage(text, pending),
      toolName: 'sanitize',
      toolDescription: 'Return the de-identified question.',
      inputJsonSchema: sanitizeJsonSchema,
      schema: sanitizeSchema,
      maxTokens: SANITIZE_MAX_TOKENS,
    });
    return value;
  }

  /** Phases 1 and 2, from what the sanitizer returned. */
  async function answer(
    stage: Stage,
    sanitized: z.infer<typeof sanitizeSchema>,
    family: FamilyFacts,
  ): Promise<GeneralAnswerOutcome> {
    // Nothing is composed from a question nobody de-identified: the raw text may not go
    // to the compose, and there is no other question to hand it.
    if (sanitized.question.trim() === '') {
      return unavailable('model_failed', 'sanitize_failed:empty_question');
    }
    // Deterministic backstop UNDER the sanitizer, before the question goes anywhere.
    const question = scrubDirectIdentifiers(sanitized.question.trim());
    // The model may leave it out; it is scrubbed like the question it came with.
    const missing = scrubDirectIdentifiers((sanitized.missing_detail ?? '').trim());
    const language = normalizeLanguage(sanitized.language);
    const today = await family.today();

    // Phase 1 — SEARCH (only when judged needed, and only when lit). Where the family
    // is, is read only for a lit search the sanitizer judged to depend on it. A detail
    // still missing after that is asked for, and only while lit: dark, there is nothing
    // the answer could be used for.
    const lit = generalAnswerSearchEnabled();
    const searching = needsSearch(sanitized.needs_search);
    const place =
      lit && searching && turnsOnTheirPlace(sanitized.their_place) ? await homePlace(family) : null;
    const { search, findings } = !searching
      ? { search: 'not_needed' as const, findings: NO_FINDINGS }
      : lit && sanitized.needs_search === 'missing_detail' && place === null
        ? { search: askedInstead(), findings: NO_FINDINGS }
        : await liveSearch(stage.client, stage.search, question, today, place);

    // Phase 2 — COMPOSE (blind: the question and the research, never the raw message).
    try {
      const { value } = await forceToolJson({
        client: stage.client,
        lane: pickLane(stage.answer.meta.task),
        system: stage.answer.instructions,
        userMessage: generalAnswerUserMessage({
          question,
          language,
          today,
          search,
          notes: findings.notes,
          missing,
        }),
        toolName: 'answer',
        toolDescription: 'Return the one brief answer to this question.',
        inputJsonSchema: answerJsonSchema,
        schema: answerSchema,
        maxTokens: MAX_TOKENS,
      });
      return sendable(value.answer, search, findings.urls, leftOpen(search, question, missing));
    } catch (err) {
      return unavailable('model_failed', failureName(err));
    }
  }

  return {
    async compose(text, family) {
      // VIL-328: physical emergency is Call 911 now., never the 811 Telehealth
      // line. Mental crisis is the reviewed 988 line, no return ask.
      if (namesAnEmergency(text)) {
        return { status: 'composed', reply: EMERGENCY_REPLY };
      }
      if (namesAMentalCrisis(text)) {
        return { status: 'composed', reply: MENTAL_CRISIS_REPLY };
      }

      const stage = await setUp();
      if ('missing' in stage) return unavailable(stage.missing, stage.detail);

      let sanitized: z.infer<typeof sanitizeSchema>;
      try {
        sanitized = await sanitize(stage, text, null);
      } catch (err) {
        return unavailable('model_failed', `sanitize_failed:${failureName(err)}`);
      }
      return answer(stage, sanitized, family);
    },

    async continueAsk(text, pending, family) {
      // The backstop under the lane's screen, which read this text first: a crisis by
      // name is never continued as a question, whatever the screen made of it.
      if (namesAnEmergency(text) || namesAMentalCrisis(text)) return notAReply();

      const stage = await setUp();
      if ('missing' in stage) return notAReply(stage.missing);

      let sanitized: z.infer<typeof sanitizeSchema>;
      try {
        sanitized = await sanitize(stage, text, pending);
      } catch (err) {
        return notAReply(failureName(err));
      }
      if (!answersPending(sanitized.answers_pending)) return notAReply();
      console.info({ pendingAsk: 'completed' }, 'off-domain answer: the reply to a pending ask');
      return answer(stage, sanitized, family);
    },
  };
}
