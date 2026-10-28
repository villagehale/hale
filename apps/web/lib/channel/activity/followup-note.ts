import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { modelIsUnreachable } from '~/lib/channel/router/smoke-alarm';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PageVerdict } from './evidence';
import type { EmptySearch } from './lane';
import type { ActivityPick } from './lane';

/**
 * THE KEPT PROMISE, IN WORDS — the one text the activity follow-up sweep sends.
 *
 * Composed, never a template, for the reason the plan check-in is: a preset body is a
 * sentence nobody is writing for THIS family, and this is the message with the most to
 * gain from being written for them — it knows what they asked and what turned up. A gate
 * refusal is fed back and recomposed; exhausting the attempts leaves the promise OPEN for
 * the next tick rather than sending something canned.
 *
 * TWO SHAPES, one composer, because they are one message with different contents:
 *
 *   FOUND — up to three real picks, each read off somebody's own page. The top one leads,
 *   and {@link topPickLeads} makes that a GATE rather than a preference. See below.
 *
 *   EMPTY — the search ran and there is nothing. This is the half that had to exist before
 *   the promise could be made honestly: "I'll come back to you" is only true if Hale comes
 *   back when the answer is bad news, and a sweep that texts only on success is a sweep
 *   that silently drops every disappointing promise (rule #11 — the absence of the effect
 *   is a first-class outcome, and here it is an outcome the PARENT is told about).
 *
 * THE TOP PICK LANDS EARLY, as a gate. A phone shows the start of a message first, so the
 * name of the best find belongs in the opening. Chat replies are no longer cut to two
 * segments (VIL-434); the name still leads because that is what a parent reads first.
 *
 * NEVER CLAIMS WHAT IT DID NOT DO. Every pick here came off the WEB, and
 * {@link claimsVerification} refuses a body that says otherwise. It is deliberately narrow
 * in one direction: "I'll confirm before you book" is exactly what Hale SHOULD say, so a
 * future-tense promise to check is not a claim to have checked. The failure this gate
 * exists to prevent runs the other way — Hale telling a parent a time is confirmed when
 * all it has is a page that said so.
 *
 * AND IT NEVER GOES QUIET INSTEAD. There is no violation here for "unverified". A find
 * that is only as good as its source is still a find, and withholding it is the silence
 * that started all this.
 */

/** Same reasoning as the plan note's: a model that cannot fix a named mechanical fault in
 * three tries will not fix it on the fourth. */
export const MAX_FOLLOWUP_ATTEMPTS = 3;

const MAX_TOKENS = 1000;

const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

/**
 * Told to the model only when options were held back. It is an instruction, not a
 * sentence to send: the parent-facing words are the model's, in whatever language the
 * parent writes in.
 */
const MORE_REMAINING_INSTRUCTION =
  'In your own words, in the language named by `language` on this request, say that more options exist and that they can ask in this chat for the next ones. Do not list any option you were not given. Do not use a stock sentence.';

export type FollowUpFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_unreachable'
  | 'model_failed'
  | 'gates_exhausted'
  | 'quiet_hours'
  | 'coparent_ask';

export type FollowUpComposeOutcome =
  | { status: 'composed'; message: string }
  | { status: 'deferred'; reason: FollowUpFallback; violations: readonly string[] };

/**
 * One find, as the composer is given it.
 *
 * An {@link ActivityPick} plus the fact the DEEP PASS opens a page to get: when
 * registration opens, when it closes, or that it is open now — the one that decides
 * whether a parent acts today. Optional here rather than a field on `ActivityPick`
 * because the shallow lane reads search snippets and has never had one; a
 * {@link import('./deep').DeepSlot} always carries the field and nulls it when no page
 * said. Both arrive at the projection below as the same sentence to a composer — "I have
 * no registration fact for this" — which is all the model can act on.
 */
export type FollowUpPick = ActivityPick & { registration?: string | null };

export interface FollowUpGrounding {
  /** The de-identified subject the promise was about, off the ledger row. */
  subject: string;
  /**
   * The language this parent writes in, as a tag already stored on their profile
   * (`users.locale`). Passed through as stored. This leg never sees their words, and it
   * does not detect a language from them.
   */
  language: string;
  /** What the re-run search found. EMPTY is a valid, sendable grounding — see the module
   * note on why the bad-news half is the half that makes the promise honest. */
  picks: readonly FollowUpPick[];
  /**
   * WHAT HALE MAY SAY ABOUT WHAT A PAGE DOES NOT CARRY (evidence.ts {@link PageVerdict}).
   *
   * This was a boolean called `pagesOpened` until 2026-08-24, and the boolean answered the
   * wrong question. It says somebody opened something; the sentence it was licensing says
   * what the page CONTAINS. On the live run seven pages were opened, the fall grid was on
   * one of them, the refutation had refused every fact off it, and `pagesOpened: true`
   * licensed "no day, time or price on the fall page yet" about a schedule that was
   * published. A REFUSED FACT IS NOT AN ABSENT ONE — the first is Hale not knowing.
   *
   * Only `page_has_no_schedule` licenses a negative report, and it is positive evidence: a
   * page was opened today and carries no clock time and no price anywhere on it.
   *
   * It is REQUIRED rather than optional for the reason `registration` was the wrong shape
   * as an optional: a caller that forgets it is a caller that gets the permissive reading
   * by accident, and the permissive reading is the defect.
   */
  pageEvidence: PageVerdict;
  /**
   * IS THERE A CONTINUATION ROW BEHIND THIS MESSAGE — the sweep has already registered a
   * fresh `activity_followup` promise against the text about to go out, so the message
   * must SAY so.
   *
   * The two halves are one fact on purpose. On 2026-08-22 the sweep fulfilled its
   * promise, sent "Want me to check back once they're up?", and wrote nothing down: the
   * parent said "Yes, please" twenty minutes later and it landed on an unrelated
   * approvals queue. An offer is a proposal and a proposal is a row (#521) — so this
   * lane does not offer at all. It states what Hale has already committed to, and the
   * commitment is a row that existed before the sentence claimed it.
   */
  watch: boolean;
  /**
   * How many options were found and did not fit in this text. Zero omits the fact from
   * the payload so an unchanged recording stays a hit. Above zero, the model is told to
   * say, in its own words, that more exist and that the parent can ask here for them.
   */
  moreRemaining: number;
  /**
   * WHERE AN EMPTY SEARCH LOOKED AND WHAT IT SAW (lane.ts `EmptySearch`). Only an empty
   * shallow search carries it, and it reaches the composer only when `picks` is empty, so
   * every message with a find is composed from exactly the payload it always was.
   */
  searched?: EmptySearch;
}

export interface FollowUpComposer {
  compose(grounding: FollowUpGrounding): Promise<FollowUpComposeOutcome>;
}

const noteSchema = z.object({ message: z.string(), commits_to_return: z.boolean() });

/**
 * `commits_to_return` is the model's own reading of what it wrote: does this message tell
 * the parent Hale will come back to them about it? Code checks that fact against `watch`
 * (the row the sweep did or did not write). A word list cannot read that sentence in every
 * language a parent writes in; the model that wrote it can say what it says.
 */
const noteJsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    commits_to_return: {
      type: 'boolean',
      description:
        'true when the message tells the parent Hale will come back to them about this (keep watching, check again, text them later), in whatever language it is written; false otherwise.',
    },
  },
  required: ['message', 'commits_to_return'],
} as const;

/**
 * Shared with the eval, which REPLICATES this request shape. It carries the picks and the
 * subject and nothing else — no family, no child, no thread (rule #1).
 *
 * EVERY FACT THE PASS PAID FOR IS LISTED HERE, and the list is the hazard. This is a
 * hand-written projection: a field added to a slot upstream and not added here does not
 * fail, does not warn, and does not reach the model — it simply never gets said. That is
 * what happened to `registration`. The deep pass opened the venue's own page, read that
 * registration had been open since July 22, put it on the slot, and handed the slot to a
 * composer that was told six fields, none of them that one. The message came back gated,
 * honest and sendable, and the parent was told everything except the thing that decides
 * whether they act today.
 *
 * A null is sent rather than the key omitted: an absent key reads to a model as a field it
 * might fill in, and a `null` is Hale saying it does not have one.
 */
export function followUpUserMessage(grounding: FollowUpGrounding): string {
  // Key order is the recording. `more_remaining` is inserted only when it is above zero,
  // and only before `picks`, so a follow-up that already fit everything produces the same
  // JSON it did before this fact existed.
  const payload: Record<string, unknown> = {
    mode: 'followup_text',
    subject: grounding.subject,
    language: grounding.language,
    // The two facts about the SWEEP rather than about a pick, and both are here for the
    // reason `registration` is: a projection that does not carry them is a model that
    // cannot act on them. `page_evidence` is what Hale knows about the pages themselves;
    // `watch: true` is Hale saying the row is already written.
    //
    // It is told rather than merely gated on, because the three states have three
    // different honest sentences and a model that cannot see which one it is in writes the
    // negative report, gets refused, and burns its three attempts arriving at silence.
    //
    // AND WITH NO PICKS IT IS NOT TOLD AT ALL. There is no find to have a gap in and no
    // venue whose pages could be at fault, so every honest sentence about a page is one
    // this message cannot contain. The skill said as much in prose and the prose lost: on
    // 2026-08-24 an empty search for a programme that does not exist came back "I could
    // not get into any pages today for toddler underwater basket weaving", which tells a
    // parent it exists. A model handed no page fact cannot blame a page. What replaces it
    // is not silence — `picks_empty` is the one fact this message is about, and an omitted
    // key reads to a model as a field it may fill in (rule #11).
    ...(grounding.picks.length === 0
      ? {
          picks_empty: true,
          ...(grounding.searched
            ? { searched: { town: grounding.searched.town, notes: grounding.searched.notes } }
            : {}),
        }
      : { page_evidence: grounding.pageEvidence }),
    watch: grounding.watch,
  };
  if (grounding.moreRemaining > 0) {
    payload.more_remaining = grounding.moreRemaining;
    payload.more_remaining_instruction = MORE_REMAINING_INSTRUCTION;
  }
  payload.picks = grounding.picks.map((pick) => ({
    name: pick.name,
    age_fit: pick.ageFit,
    when: pick.when,
    price: pick.price,
    registration: pick.registration ?? null,
    source_name: pick.sourceName,
    source: pick.source,
  }));
  return JSON.stringify(payload);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/**
 * Whether the message names the best find.
 *
 * Matched on the pick's NAME rather than on sentence order, because "the top pick leads"
 * is about what a parent can tell, and a body that opens with a clause of preamble and then
 * names the place is fine. Replies are sent whole (VIL-434), so the name may land anywhere.
 *
 * Matched on the name's distinctive WORDS, not the field verbatim and not its phrases.
 * `name` is a composite assembled for a structured payload — "Kinderfun (Toddler Program),
 * Halton Hills Gymnastics Centre", "Learn to Swim: Parent and Tot / Preschool, Town of
 * Oakville" — and no SMS repeats one whole or even in contiguous chunks. Two real corpus
 * answers named their find in the first six words and were refused anyway: "Halton Hills
 * Gymnastics Centre has a Kinderfun toddler program running Sept 10", and "Oakville's
 * Learn to Swim Preschool program looks like a good fit". Each costs three recompositions
 * and then a deferral — Hale going quiet on a good find, which is the failure and not the
 * guard.
 *
 * So the question is the one a parent would ask: can I tell WHICH find this is? Two or
 * more of the name's identifying words anywhere in the message is a yes. Programme
 * nouns are not identifying — a body leading with "a toddler program" has named nothing.
 * (The eval mirrors this rule and mirrors it word for word; it replicates rather than
 * imports, like every other gate here.)
 */
const GENERIC_NAME_WORDS = new Set([
  'gymnastics',
  'program',
  'programs',
  'programme',
  'lessons',
  'class',
  'classes',
  'centre',
  'center',
  'community',
  'parent',
  'toddler',
  'preschool',
  'swimming',
  'library',
  'recreation',
  'session',
  'fall',
  'winter',
  'spring',
  'summer',
]);

/**
 * A PARENTHESIS IS A DISAMBIGUATOR, NOT A NAME — and a number is never a name.
 *
 * Live, 2026-08-24, once the merge could finally see the grid: thirty rows came back
 * differing only by weekday, and it told them apart in the `name` field — "Parent and Tot
 * 1, 2, 3 - Gellert Community Centre (Mon 10:00AM daytime, code 108969)". Read whole,
 * that name's identifying words are "gellert", "daytime" and "108969", so the gate
 * demanded an SMS quote a session code to prove it had named the find. No message can,
 * three recompositions failed, and the promise deferred with a complete verified schedule
 * in hand — the fix causing the silence it was fixing.
 *
 * What a parent needs in the first segment is which PLACE and which PROGRAMME. The day,
 * the clock time and the code are what `when` is for, and they are in the message anyway.
 *
 * ONE STRIPPED NAME, READ BY BOTH RULES. The first version stripped the parenthetical for
 * the word test and then fell back to matching the RAW name whole — so a pick called
 * "Parent and Tot (18 months - 3.11 yrs)", whose stripped name has no distinctive word in
 * it at all, was asked to reproduce the very bracket just declared not part of the name.
 * That is the same defect as the one above wearing the other face, and it deferred a good
 * message for a fixture that had been passing.
 */
function spokenName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function identifyingWords(name: string): string[] {
  return spokenName(name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !/^\d+$/.test(word) && !GENERIC_NAME_WORDS.has(word));
}

/**
 * A FIND IS IDENTIFIED BY ITS PROGRAMME OR BY ITS PLACE, and a composite `name` does not
 * always carry either.
 *
 * "Toddler Program (18 months - 3 years), Preschool and Kinderfun" at Halton Hills
 * Gymnastics Centre reduces to the single word "kinderfun" — a programme stream nobody
 * would text — so a message opening "Halton Hills Gymnastics Centre runs a Toddler Program
 * for 18 months-3 years" was refused for not naming the find. A parent reading that knows
 * exactly which find it is. The question this gate asks is "can I tell WHICH one?", and the
 * venue answers it as well as the programme does.
 */
export function topPickLeads(body: string, picks: readonly ActivityPick[]): boolean {
  const top = picks[0];
  if (!top) return true;
  const head = body.toLowerCase();
  const venue = identifyingWords(top.sourceName ?? '');
  if (venue.length > 0 && venue.every((word) => head.includes(word))) return true;
  const words = identifyingWords(top.name);
  // A name with nothing distinctive in it at all ("Toddler Class") can only be matched
  // whole — there is no word in it that would tell one find from another.
  if (words.length === 0) return head.includes(spokenName(top.name).toLowerCase());
  return words.filter((word) => head.includes(word)).length >= Math.min(2, words.length);
}

/**
 * Whether the body claims Hale VERIFIED something it only read.
 *
 * Clause-scoped with a qualifier guard, the shape `hasEmergencyDirective` uses in the
 * medical lane and for the same reason: every phrase that makes an honest future promise
 * ("I'll confirm the time before you book") contains the very word that makes a dishonest
 * past claim, so a whole-body match would refuse the sentence Hale is supposed to write.
 * A clause carrying the word and NO qualifier is the claim.
 */
const CLAUSE_BOUNDARY = /[.!?;:,\n]|\s-\s/;
const VERIFICATION_CLAIM = /\b(?:confirmed|verified|double-?checked|vetted)\b/i;
const FUTURE_OR_NEGATED =
  /\bi'?ll\b|\bi will\b|\bwe'?ll\b|\bwe will\b|\bgoing to\b|\bcan\b|\bto (?:confirm|verify|double-?check)\b|\bbefore\b|\bonce\b|\bafter\b|\byet\b|\bnot\b|\bn'?t\b|\bunconfirmed\b/i;

export function claimsVerification(body: string): boolean {
  return body
    .split(CLAUSE_BOUNDARY)
    .some((clause) => VERIFICATION_CLAIM.test(clause) && !FUTURE_OR_NEGATED.test(clause));
}

/** Hale saying it could not get at something — never the page saying it has nothing. */
const SELF_LIMITED =
  /\b(?:i|we)\b[^.!?]{0,40}?\b(?:could\s?n[o']?t|could not|can\s?n[o']?t|cannot|ca\s?n't|was\s?n[o']?t able|were\s?n[o']?t able|failed to)\b/i;

/**
 * WHETHER THE COMING-BACK SENTENCE IS WAITING ON A PAGE THAT HAS ALREADY POSTED.
 *
 * The same claim can wear the future. "I'll keep watching and text you
 * once the details are up" asserts nothing and presupposes everything: that they are not
 * up, and that the venue is the one Hale is waiting on.
 *
 * Live, 2026-08-24: the composer got the gap right in Hale's own voice ("I couldn't pin
 * down the day, time or price from their term PDF") and gave it straight back to the page
 * one clause later, about a venue whose term schedule WAS posted — in a PDF it could not
 * decode, behind a registration login it could not enter. Two of three judge draws scored
 * that 2. The first half of the sentence is the fix that commit 6d0fc033 made for the gap
 * sentence; this is the same defect surviving in the sentence after it.
 *
 * THE SUBJECT DECIDES IT, so the trigger clause may not open on Hale: "when I can get to
 * them" and "once I can look it up" are Hale waiting on its own access, which is the
 * true sentence here and the one this predicate must never refuse.
 */
const AWAITS_PUBLICATION =
  /\b(?:when|once|as soon as)\s+(?!i\b|i'|we\b|we')[^.!?]{0,40}?\b(?:post(?:s|ed|ing)?|publish(?:es|ed)?|listed|up|out|available|lands?)\b/i;

/**
 * ONE MESSAGE MAY NOT SAY BOTH. If Hale says it could not get at a fact, it cannot also
 * say it is waiting for the venue to publish that fact: one of those sentences is false,
 * and it is always the second one — Hale is waiting on its own access, not on them.
 *
 * READ OFF THE BODY, not off `page_evidence`, and that is a correction to the first
 * version of this gate. `page_evidence` is ONE verdict for the whole message while the
 * gaps are per-field (the skill's own rule: never let one field's reason swallow
 * another's). Fired on `page_has_schedule` alone it refused a true sentence — an Oakville
 * find whose schedule the page published and whose FEES really do live in a Council guide
 * Hale never claimed to have read — three times, and the promise deferred on a message
 * the judge scored 4. The contradiction is what is provable, and it needs no verdict.
 */
export function waitsOnAPageItCouldNotRead(body: string): boolean {
  return SELF_LIMITED.test(body) && AWAITS_PUBLICATION.test(body);
}

/**
 * DOES THIS MESSAGE ASK THE PARENT ANYTHING?
 *
 * ONE READER, TWO STRINGS, and that is the whole point of it being a function. The gate
 * below runs on the sentence the MODEL wrote; the sweep runs it again on the body it is
 * about to hand the transport (deliver.ts), because a venue page is appended after the
 * model's gates. A question appended after the gate reached the parent with the gate
 * green, which is the 2026-08-22 defect. A question mark inside a venue address is not
 * a question to the parent, so those addresses are set aside before the check.
 */
export function asksTheParent(body: string): boolean {
  return plainText(body).replace(/https?:\/\/\S+/gi, '').includes('?');
}

/**
 * Everything wrong with this follow-up, phrased for the model that will rewrite it. An
 * empty array means it may be sent.
 */
export function followUpViolations(
  body: string,
  grounding: FollowUpGrounding,
  commitsToReturn: boolean,
): string[] {
  const violations: string[] = [];
  const text = plainText(body);

  if (text === '') return ['The message was empty.'];
  if (LINK_SHAPE.test(text)) {
    violations.push('The message contains a link or a web address. Never send one.');
  }
  if (claimsVerification(text)) {
    violations.push(
      'The message says these details are confirmed or verified. They are not - they came off the venue\'s own page. Say whose page it was ("their site says...") and offer to confirm before they book.',
    );
  }
  if (!topPickLeads(text, grounding.picks)) {
    const top = grounding.picks[0];
    violations.push(`The best find (${top?.name}) is not named. Lead with it.`);
  }
  // NO OFFER, BECAUSE AN OFFER IS A PROPOSAL AND A PROPOSAL IS A ROW. Nothing in this
  // lane can write one: the sweep has already decided what it will do next and put THAT
  // on the ledger, so a question here can only ask for permission Hale either already
  // has or cannot act on. On 2026-08-22 the question was "Want me to check back once
  // they're up?", the row behind it did not exist, and the parent's "Yes, please" was
  // answered by an unrelated approvals menu twenty minutes later.
  if (asksTheParent(text)) {
    violations.push(
      'The message asks the parent a question. This message keeps a promise; it never asks for permission. Say what you found and what you are already doing about it, and end on a statement.',
    );
  }
  // BOTH DIRECTIONS, and the second one is not symmetry for its own sake. The first live
  // re-recording of this composer, handed a complete find and `watch: false`, wrote
  // "I'll keep looking and text you what it says" anyway — a promise to come back with
  // no row behind it, which is the 2026-08-20 defect verbatim, produced by the very
  // change that was fixing it. A sentence claiming a commitment is only true when the
  // commitment exists, and `watch` is the one value that knows.
  // AND THE COMING-BACK SENTENCE CARRIES THE SAME ATTRIBUTION AS THE GAP SENTENCE.
  if (waitsOnAPageItCouldNotRead(text)) {
    violations.push(
      'The message says Hale could not get at these details AND that it will come back when the venue posts them. Both cannot be true - what Hale is waiting on is its own access, not their next update. Keep the first sentence and say you will come back when YOU can get at them, and change nothing else.',
    );
  }
  if (grounding.watch !== commitsToReturn) {
    // THE EXAMPLE IS PAGE-STATE-AWARE OR THE TWO CORRECTIONS FIGHT: under
    // `page_has_schedule` the page contradicts the very sentence this one used to hand
    // the model as the remedy, and a composer bounced between two contradictory fixes
    // spends its three attempts and sends nothing.
    violations.push(
      grounding.watch
        ? `This follow-up leaves something open and Hale has already committed to going back. Say so in the first person, as a statement, in the language of the message: that Hale will keep watching and text them when ${
            grounding.pageEvidence === 'page_has_schedule' ? 'it can get to the details' : 'the details post'
          }.`
        : 'The message says Hale will come back or keep looking. Nothing is outstanding on this one and no such promise has been written down, so that sentence would be false. Hand the find over and stop.',
    );
  }
  return violations;
}

export function createFollowUpComposer(client: () => AgentClient): FollowUpComposer {
  return {
    async compose(grounding) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return deferred('client_unavailable', [message(err)]);
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('activity-finder');
      } catch (err) {
        return deferred('skill_unavailable', [message(err)]);
      }

      let violations: string[] = [];
      for (let attempt = 1; attempt <= MAX_FOLLOWUP_ATTEMPTS; attempt += 1) {
        let value: z.infer<typeof noteSchema>;
        try {
          const result = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: retryFollowUpMessage(followUpUserMessage(grounding), violations),
            toolName: 'followup_text',
            toolDescription: 'Return the one message to send this parent.',
            inputJsonSchema: noteJsonSchema,
            schema: noteSchema,
            maxTokens: MAX_TOKENS,
          });
          value = result.value;
        } catch (err) {
          if (modelIsUnreachable(err)) return deferred('model_unreachable', [message(err)]);
          return deferred('model_failed', [message(err)]);
        }

        violations = followUpViolations(value.message, grounding, value.commits_to_return);
        if (violations.length === 0) {
          return { status: 'composed', message: plainText(value.message) };
        }
        console.error(
          { attempt, picks: grounding.picks.length, violations: violations.length },
          'activity follow-up: refused by the gates, recomposing',
        );
      }
      return deferred('gates_exhausted', violations);
    },
  };
}

function deferred(reason: FollowUpFallback, violations: readonly string[]): FollowUpComposeOutcome {
  console.error(
    { reason, violations },
    'activity follow-up: deferring rather than sending a canned line',
  );
  return { status: 'deferred', reason, violations };
}

export function retryFollowUpMessage(base: string, violations: readonly string[]): string {
  if (violations.length === 0) return base;
  return JSON.stringify({
    ...(JSON.parse(base) as Record<string, unknown>),
    rejectedLastAttempt: violations,
  });
}
