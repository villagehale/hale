import { matchPhrase, normalizeReply } from '../affirmative';
import { withOptOut } from '../opt-out';
import { isPrintableGsm7Basic, smsSegments } from '../sms-segments';

/**
 * THE ASIDE — a model writes at most one short clause, and CODE assembles it onto the
 * deterministic sentence the lane was going to send anyway.
 *
 * The spec this comes from asked for a rewrite of the whole message with an
 * extraction/diff guard proving every fact survived. That shape is self-defeating: to
 * verify preservation you need the fact list, and if you hold the fact list you do not
 * need the draft (that is composeVoice, and the lanes that HAVE a fact list already run
 * it). What is left are the two lanes whose facts are not enumerable — and on exactly
 * those the diff cannot be written.
 *
 * So this file builds the third door the repo has already built three times: APPEND,
 * NEVER SPLICE. `withOptOut` puts the CASL line on after the body; the email lane's offer
 * CTA is appended after `compose()` because "a clause spliced before that would put
 * Hale's own offer inside the vendor's sentence"; the radar hands the model a forward
 * beat as a FACT rather than letting the skill write one. Here the model never emits the
 * message — it emits a clause, and {@link assembleWithAside} puts clause and core
 * together. Fact preservation stops being a check and becomes the TYPE of the function.
 *
 * WHY THE RULES BELOW ARE SO BLUNT. Every other composer in this repo pays for a refusal:
 * the follow-up ask has no fallback at all, so a third refusal means the family hears
 * nothing. A refused aside costs a parent NOTHING — the reviewed deterministic sentence
 * goes out exactly as it does today. So there is one attempt, no recompose, no near-miss
 * tolerance, and no judgement call anywhere in here. Over-refusing is free.
 *
 * PURE, AND ALIAS-FREE ON PURPOSE. The only imports are three siblings that import
 * nothing themselves, so `apps/worker/evals/run-alert-aside-eval.mjs` can `tsImport` this
 * file REAL rather than replicating it — the drift `run-followup-voice-eval.mjs` accepts
 * because its composer sits behind `~/` and the tsx loader cannot resolve one.
 * `guard.alias-free.test.ts` fails on a `~/` here.
 */

export type AsideLane = 'email_alert' | 'calendar_alert';

export type AsidePlace = 'before' | 'after';

export interface Aside {
  clause: string;
  place: AsidePlace;
}

/**
 * What the model may see. The core is the already-redacted sentence the lane would send
 * today; the rest are things Hale knows and the model cannot.
 */
export interface AsideContext {
  core: string;
  lane: AsideLane;
  /**
   * Proactive sends of THIS CLASS that went out for THIS FAMILY in the trailing 24 h, as
   * `countFamilyProactiveSends` counts them (channel/outbound-gate.ts): rows in
   * `channel_messages` by `familyId` + `PROACTIVE_CATEGORY[kind]`, direction out,
   * `createdAt >= now - 24h`, status in `SENT_STATUSES` (`queued|sent|delivered`). Read
   * every word of that:
   *
   *   · NOT per sender. Three different schools in one afternoon is 2, not 1.
   *   · NOT per calendar day. It is a rolling window that crosses midnight.
   *   · NOT per parent. Both lanes text ONE parent (`integrations.user_id`) while the
   *     count is household-wide, so a two-Gmail household's parent B can be told "third"
   *     on the second alert B has seen.
   *
   * `null` for an uncapped class and for a first alert — it is present as a number ONLY
   * when at least one prior alert of this class reached this household in the window.
   * The one thing it honestly supports is an ordinal over HALE'S OWN TEXTS OF THIS KIND
   * TO THIS HOUSEHOLD IN THE LAST DAY.
   */
  priorAlertsToHousehold24h: number | null;
  /**
   * An occasion already in the family's own calendar matched this alert's subject. It
   * does NOT mean there is nothing to do: on a reschedule the matched occasion is the OLD
   * one and the parent still has to move it, which is exactly why `emailAlertOfferDraft`
   * refuses to offer on a match. The skill is forbidden from reading it as "handled".
   */
  matchedAKnownOccasion: boolean;
  /**
   * The exact trailing sentence the lane appended that invites a reply, or null.
   *
   * ONE field rather than a boolean, because it answers three questions at once and
   * cannot disagree with itself: whether the core ends in an ask, which capitals are
   * Hale's own boilerplate rather than the vendor's facts, and what text the allowed-set
   * is built from.
   */
  ctaSuffix: string | null;
}

/** A ceiling, not an allowance — {@link MAX_ALERT_SEGMENTS} is what actually decides. */
export const ASIDE_MAX_CHARS = 60;

/**
 * TWO. Both lanes are clamped so the body plus the FULL opt-out fits two GSM-7 segments,
 * and both have property tests over every shape they render — but the invariant lived as
 * a bare literal `2` inside `toBeLessThanOrEqual(2)` in those tests and nowhere else.
 * This is its first name; the two property tests keep their literal, because a test that
 * imports the constant it is checking measures nothing.
 */
export const MAX_ALERT_SEGMENTS = 2;

/**
 * Every reason a clause does not go out. Named, ALL of them returned rather than the
 * first (the follow-up's discipline), counted and logged — never the clause itself.
 */
export type AsideRefusal =
  | 'over_char_cap'
  | 'not_gsm7_printable'
  | 'carries_digit'
  | 'carries_link'
  | 'asks_a_question'
  | 'solicits_reply'
  | 'addresses_the_parent'
  | 'echoes_a_reply_word'
  | 'invented_capital'
  | 'after_an_ask'
  | 'echoes_the_core'
  | 'too_many_segments'
  | 'no_terminator';

/**
 * THE WHOLE FACT GUARANTEE, in three lines.
 *
 * The core is a PARAMETER, not a model output. Every date, time, sender, title, link and
 * CTA survives by construction — there is no extraction, no diff, no tolerance, and no
 * way for a later edit to loosen it without changing this signature.
 */
export function assembleWithAside(core: string, aside: Aside | null): string {
  if (aside === null) return core;
  return aside.place === 'before' ? `${aside.clause} ${core}` : `${core} ${aside.clause}`;
}

/** No tool at this stage could have handed the model a URL, so one here is invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

/**
 * THE DOOR, half one — communication ACTS only.
 *
 * A clause that invites a bare YES is the one failure here with a consequence beyond a
 * bad sentence: the router binds a bare affirmative to whatever question is newest or
 * sole (`router/open-questions.ts`), and on these two lanes that can be an unrelated
 * `email_alert_add` whose handler writes `family_events` directly, with no reviewer.
 *
 * A DECLINE TABLE, and it holds verbs of SPEAKING rather than household words — the
 * credential-matcher rule: anchor on the act, never on a bare noun a parent might use
 * about anything. `word` is in because "say the word" is the canonical door and the frame
 * list cannot carry every spelling of it.
 */
const REPLY_ACTS: ReadonlySet<string> = new Set([
  'say',
  'says',
  'said',
  'saying',
  'tell',
  'tells',
  'told',
  'reply',
  'replies',
  'replied',
  'text',
  'texts',
  'texted',
  'answer',
  'answers',
  'respond',
  'responds',
  'confirm',
  'confirms',
  'ask',
  'asks',
  'word',
]);

/** The multiword doors a single verb does not catch. Written apostrophe-free, because
 * {@link wordsOf} deletes apostrophes before this runs. */
const REPLY_FRAMES: readonly string[] = [
  'let me know',
  'shall i',
  'should i',
  'want me',
  'if you want',
  'if youd like',
  'just ask',
  'say the word',
  'happy to',
];

/**
 * THE DOOR, half two, and the subtraction that makes half one sufficient.
 *
 * An offer needs a second person; a third-person observation about the occasion does not.
 * Banning the grammatical person deletes the entire offer-clause class by construction
 * rather than detecting doors one phrase at a time. It costs real warmth — a friend says
 * "busy day for you" and this clause has to say "busy stretch over there" — and the
 * founder took that trade (decision 8) because a refusal here costs nothing.
 */
const SECOND_PERSON: ReadonlySet<string> = new Set([
  'you',
  'your',
  'yours',
  'youre',
  'youll',
  'youve',
  'yourself',
  'u',
  'ur',
]);

/**
 * Case, punctuation and spacing removed — the TypeScript twin of the eval side's
 * `normalizeForCompare` (apps/worker/evals/lib/variation.mjs), which is the only other
 * implementation in the repo and sits behind a package boundary this file may not cross.
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The clause as whole words: apostrophes deleted so "you're" reads as one token, every
 * other symbol a separator so "let's-go" is two words rather than one unknown one. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * THE DOOR, half three — and it is NOT a new list.
 *
 * `affirmative.ts` is the repo's one table of what a parent's YES and NO look like, in
 * EN/FR/zh plus emoji, and it exists because four modules once held private copies that
 * drifted — "every word missing from a copy was a parent whose answer was silently
 * dropped". A fifth private copy inside a guard is that same defect pointed outward: the
 * router would widen its table and this door would quietly stay open. Running
 * `matchPhrase` over every 1–3 word window means widening that table NARROWS this guard,
 * on the same commit.
 */
function echoesAReplyWord(clause: string): boolean {
  const words = normalizeReply(clause).split(' ').filter(Boolean);
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= words.length; size += 1) {
      if (matchPhrase(words.slice(start, start + size).join(' ')) !== 'unclear') return true;
    }
  }
  return false;
}

/**
 * A capital the draft did not have.
 *
 * The allowed set is built from the core WITH THE CTA STRIPPED: `Reply` and `YES` are
 * Hale's own boilerplate, not facts the vendor supplied, and a clause inheriting them is
 * how "Just say YES and I will sort it." once read as a capital already present.
 *
 * Broken into the same pieces on both sides, for the reason the intro suite found the
 * hard way: "Drop-In" is two allowed words rather than one unknown one, and the head
 * before an apostrophe is what carries the name ("I'll" is a pronoun, "Mia's" is not).
 *
 * `\p{Lu}` rather than the GSM-7 uppercase list: a capital outside GSM-7 is already
 * refused by {@link isPrintableGsm7Basic}, so the broader class costs nothing and catches
 * `Émile`, which `/^[A-Z]/` waves straight through.
 *
 * THE FIRST TOKEN IS EXEMPT, because sentence case capitalises it and no mechanical rule
 * can tell "Third" from "Mia". The one exception is a POSSESSIVE — "Mia's", "Today's" —
 * which is never sentence-case grammar and is always a name or a noun the clause was not
 * handed. That is the honest limit: a bare invented name in position one ("Saturday looks
 * busy.") is caught by the judge and not by this rule.
 */
function inventedCapitals(clause: string, coreWithoutCta: string): boolean {
  const allowed = new Set<string>();
  for (const word of coreWithoutCta.split(/[^\p{L}\p{N}]+/u)) {
    if (word !== '') allowed.add(word.toLowerCase());
  }
  const tokens = clause.trim().split(/\s+/);
  for (const [index, raw] of tokens.entries()) {
    const possessive = /['’]s(?:\b|$)/.test(raw);
    if (index === 0 && !possessive) continue;
    for (const piece of raw.split(/[^\p{L}\p{N}'’]+/u)) {
      const word = piece.split(/['’]/)[0] ?? '';
      if (word === '' || word === 'I' || !/^\p{Lu}/u.test(word)) continue;
      if (!allowed.has(word.toLowerCase())) return true;
    }
  }
  return false;
}

/** The core with the lane's own appended ask removed — see {@link inventedCapitals}. */
function coreWithoutCta(ctx: AsideContext): string {
  const cta = ctx.ctaSuffix;
  if (cta === null) return ctx.core;
  const trimmed = ctx.core.trimEnd();
  return trimmed.endsWith(cta) ? trimmed.slice(0, -cta.length).trimEnd() : ctx.core;
}

/**
 * Every reason this clause may not be assembled onto this core — all of them, never the
 * first, so a reader of the counters can see which rule is actually doing the work.
 *
 * THE CLAUSE IS ALREADY PLAIN when it gets here. `plainText` runs in the COMPOSER, the
 * way the follow-up runs it before its own `refusals()`: `*` and `_` are GSM-7 basic
 * characters, so a markdown-wrapped clause would otherwise ship its asterisks to a phone,
 * and `plainText` lives behind `~/` where this file may not reach.
 *
 * AN EMPTY CLAUSE IS NOT A REFUSAL. It is the model saying "nothing to add", which is the
 * right answer most of the time and is the composer's named `empty` outcome.
 */
export function asideViolations(aside: Aside, ctx: AsideContext): AsideRefusal[] {
  const clause = aside.clause;
  if (clause === '') return [];

  const found: AsideRefusal[] = [];
  const words = wordsOf(clause);
  const normalized = normalizeForCompare(clause);

  if (clause.length > ASIDE_MAX_CHARS) found.push('over_char_cap');
  if (!isPrintableGsm7Basic(clause)) found.push('not_gsm7_printable');
  // The clause is handed NO facts, so any digit in it is invented. No slot subtraction,
  // therefore none of the ordering hazard the spot-open composer records.
  if (/\d/.test(clause)) found.push('carries_digit');
  if (LINK_SHAPE.test(clause)) found.push('carries_link');
  // D14: one reply-able ask per message, and the core owns it.
  if (clause.includes('?')) found.push('asks_a_question');
  if (
    words.some((word) => REPLY_ACTS.has(word)) ||
    REPLY_FRAMES.some((frame) => words.join(' ').includes(frame))
  ) {
    found.push('solicits_reply');
  }
  if (words.some((word) => SECOND_PERSON.has(word))) found.push('addresses_the_parent');
  if (echoesAReplyWord(clause)) found.push('echoes_a_reply_word');
  if (inventedCapitals(clause, coreWithoutCta(ctx))) found.push('invented_capital');
  // Words after the ask. Derived from the context rather than taken as a per-lane
  // literal, so a future calendar ask cannot silently lose the guard.
  if (aside.place === 'after' && (ctx.ctaSuffix !== null || ctx.core.trimEnd().endsWith('?'))) {
    found.push('after_an_ask');
  }
  if (normalized !== '' && normalizeForCompare(ctx.core).includes(normalized)) {
    found.push('echoes_the_core');
  }
  // Measured against the FULL opt-out because that is the conservative bound: the short
  // form is cheaper, and the lanes' own property tests are written against the full one.
  if (smsSegments(withOptOut(assembleWithAside(ctx.core, aside), 'full')) > MAX_ALERT_SEGMENTS) {
    found.push('too_many_segments');
  }
  // The assembler adds nothing between clause and core but a space, so a clause without
  // an ending runs into the core.
  if (!clause.endsWith('.') && !clause.endsWith('!')) found.push('no_terminator');

  return found;
}
