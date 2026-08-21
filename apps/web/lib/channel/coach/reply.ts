import { SAFETY_REPLY, reachesForTheHealthLine } from '~/lib/channel/off-domain/copy';
import { smsSegments, smsUnits, smsUnitsBudget } from '~/lib/channel/sms-segments';
import { renderChildName, resolveChildNameLevel } from '~/lib/loop/prefs';

/**
 * VIL-221 · C2 — everything that happens to the model's answer between the loop
 * returning it and the carrier taking it.
 *
 * The skill already asks for short, plain, ASCII prose (see coach-channel-sms.md), so
 * none of this fires on a well-behaved answer. It exists for the answers that are not,
 * because the model is the one component on this path that cannot be made to behave by
 * construction — and each of the three things below is a real cost when it slips:
 *
 *   MARKDOWN is rendered literally by a phone. "**Two swims**" arrives with the
 *   asterisks, which reads as broken software rather than as emphasis.
 *
 *   ONE typographic character — a curly apostrophe, an em dash, an emoji — flips the
 *   entire body from GSM-7 to UCS-2 and cuts the character budget from 160 to 70, for a
 *   difference nobody reading it on a phone can see (see sms-segments.ts). So they are
 *   transliterated rather than counted: the parent gets more words for the same money.
 *
 *   A TEEN'S NAME is the one leak the tools cannot prevent. The agent context redacts a
 *   13+ child to stage (coach/context.ts), the child-content guard refuses their
 *   profile, and lookup_week reads through the teen-safe projections — but the PARENT
 *   can type the name, and the model can echo it back. This is the deterministic
 *   age-derived floor under all of that (rule #1), applied to the outbound body itself.
 *
 *   A SIREN is the fourth, and the only one that replaces the whole body rather than
 *   editing it. The lane screen in front of this path fails open, so a symptom reaches
 *   the coach whenever the screen could not run — and what a parent standing over a hurt
 *   child is told has to be the reviewed sentence, not the model's approximation of it
 *   (off-domain/copy.ts, skill audit P0 #3).
 */

/** The ceiling the ticket sets, and what the eval gates against. Two segments is about
 * two sentences of GSM-7 — the length a parent reads without opening the message. */
export const MAX_REPLY_SEGMENTS = 2;

/** A child of this family, as the redactor needs them: enough to age the gate and to
 * render the replacement identifier at the right level. */
export interface ReplyChild {
  name: string;
  gender: string;
  dateOfBirth: string;
}

export interface SmsReplyArgs {
  children: readonly ReplyChild[];
  now?: Date;
  /**
   * The offer sentence this turn registered through `offer_full_plan`, already gated by
   * that tool, or absent when the turn offered nothing.
   *
   * It is appended AFTER the answer is fitted, which is the whole reason it travels
   * separately: the model wrote both halves, but only this one may not be trimmed. A
   * coaching answer plus an offer runs past the two-segment ceiling, the trim takes from
   * the end, and parents were getting "Want the full plan?" with the half naming the
   * magic word cut off. Fitting the ANSWER around a protected offer inverts that, and
   * what gives way is a clause of background the plan carries anyway.
   */
  planOffer?: string;
  /**
   * The forwardable line plus the family's own link, registered through
   * `share_referral_link` and already gated by it, or absent when the turn shared
   * nothing (referral/share.ts `referralBlock`).
   *
   * Protected for the same reason the offer is, and more sharply: the last thing in it
   * is a URL, so a trim from the end does not shorten the message — it breaks the one
   * thing the message exists to deliver.
   */
  referral?: string;
}

/**
 * Replace every 13+ child's first name with their generic identifier (rule #1).
 *
 * The gate is `resolveChildNameLevel` — the same age-derived resolver the weekly plan
 * and the reminder templates use — so a child who turned 13 this morning is redacted
 * this afternoon without anything being re-stamped. A younger child is left named,
 * because a reply that will not say "Milo" is a reply the parent has to decode.
 */
export function redactTeenNames(
  text: string,
  children: readonly ReplyChild[],
  now: Date = new Date(),
): string {
  let out = text;
  for (const child of children) {
    if (resolveChildNameLevel(child.dateOfBirth, 'first_name', now) !== 'generic') continue;
    const generic = renderChildName(child, 'generic');
    out = out.replace(nameAnywhere(child.name), (_match, before: string) => `${before}${generic}`);
  }
  return out;
}

/**
 * The name as a whole word, bounded by anything that is not a letter or a digit.
 *
 * NOT `\b`: that boundary is defined on [A-Za-z0-9_], so it reads the é in "Chloé" as a
 * boundary character and then demands a word character after it — which a following
 * space is not. Chloé, Émile and Zoé went out to the carrier verbatim while Nora was
 * redacted, in a product whose compliance baseline is Quebec. The property-based
 * boundary holds in both directions for every alphabet: a sibling named Léana keeps her
 * name when Léa is the teen. (party/card.ts redacts host copy with the same shape.)
 *
 * Exported for the activity lane, which asks the OPPOSITE question of the same matcher:
 * this file replaces a name it finds in an outbound body, and that one REFUSES a search
 * query it finds one in (rule #1 — a name must not cross the border at all). One boundary
 * rule rather than two, so a household whose names this file redacts is exactly the
 * household whose names that one will not send.
 */
export function nameAnywhere(name: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Characters a model reaches for that cost more than twice what their ASCII twin does. */
const GSM7_SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[\u00a0\u2007\u202f\u2009]/g, ' '],
  [/[•·]/g, ''],
];

/**
 * Markdown out, one line in. The list markers are dropped rather than rewritten into
 * "1. 2. 3." — the skill's answer shape is prose, and a list that survived the strip
 * would just be prose with stray numbers in it.
 *
 * Exported for the off-domain lane's general answer (boundary v3), which is the second
 * model-composed body Hale texts back. It needs this treatment and none of the rest of
 * `toSmsReply`: it never sees a child to redact, and it refuses an over-long answer
 * rather than trimming one. A second copy of the substitution table is the thing to avoid — two
 * readers of "what is safe to send" would disagree the first time one of them is edited.
 */
export function plainText(text: string): string {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Sentence-ish chunks, kept WITH their terminator so re-joining them reads normally.
 *
 * The lookahead is what keeps "whole sentences" true. A period inside an abbreviation is
 * not a full stop, and a naked `[.!?]` cannot tell the difference: a live probe on
 * 2026-08-21 split "Kids & Me drop-ins Thursdays 1-2:30 p.m. at Acton Library - their
 * site says so" at the p.m. and sent the parent the time with the venue and the source
 * attribution cut off it. A find with no address is not a shorter answer, it is one
 * nobody can use — and an unattributed one is a web claim wearing Hale's own voice.
 *
 * WHAT FOLLOWS decides it, not what precedes. A list of abbreviations was the first
 * attempt and it was wrong in both directions: it needs a new entry for every a.m., i.e.
 * and U.S., the failure of a missing entry is silent, and it also refused the boundary in
 * "...1-2:30 p.m. Want me to confirm?" — which really is one — so the whole find went
 * over the side instead of the trailing question. A lowercase word after a full stop is a
 * continuation of the fact before it; anything else starts something new. That one
 * property covers every abbreviation without naming any of them.
 */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[^\p{Ll}])/u).filter((part) => part.trim().length > 0);
}

/**
 * Bring a body inside the segment budget by dropping whole sentences from the end.
 *
 * Sentence-first because a body cut mid-clause reads as a bug, and because the FIRST
 * sentence is where the skill puts the answer — so the part that survives is the part
 * that mattered. Only when a single sentence is itself over budget does it fall back to
 * a word-boundary trim, which is still never mid-word.
 *
 * It used to append "More in the app: <url>" to whatever survived, which meant the
 * app-point fired precisely when the answer was too long to send — the message where
 * the job mattered most, handed back to the person who texted to be rid of it (skill
 * audit P0 #4). Nothing replaces it. A parent who texted is owed a text back, and the
 * sentence they get is the one carrying the answer.
 */
function fitToBudget(body: string, max: number, suffix = ''): string {
  // The suffix is measured with the body, never after it: a reviewed line appended to a
  // reply that was already at the ceiling is how the budget gets quietly exceeded.
  const withSuffix = (text: string) => (suffix === '' ? text : `${text} ${suffix}`);
  const whole = withSuffix(body);
  if (smsSegments(whole) <= max) return body;

  // Named rather than dropped in silence, like the siren below and for the same reason:
  // what goes over the side here is work this turn already paid for. On 2026-08-21 the
  // flagship question — "what's on Sept-Dec near me" — composed a verified Sep 1 opening
  // plus two finds from a ~50s live web search, and the entire second paragraph was cut
  // from a message that opened "Two things worth flagging here". Nothing downstream could
  // tell that reply from one that fit, so it took a human reading a graded bench run to
  // see it. A count makes the next one countable. The BODY never reaches the log — it can
  // carry back what the parent typed (rule #1).
  console.warn(
    `channel coach: model answer ran ${smsUnits(whole) - smsUnitsBudget(whole, max)} units past the ${max}-segment budget; sending the prefix that fits`,
  );

  const parts = sentences(body);
  for (let count = parts.length - 1; count >= 1; count -= 1) {
    const candidate = parts.slice(0, count).join(' ');
    if (smsSegments(withSuffix(candidate)) <= max) return candidate;
  }

  const words = (parts[0] ?? body).split(' ');
  for (let count = words.length - 1; count >= 1; count -= 1) {
    const candidate = `${words.slice(0, count).join(' ')}...`;
    if (smsSegments(withSuffix(candidate)) <= max) return candidate;
  }

  // Not even the first word fits: a model returning one unbroken 300-character token,
  // which is a failed turn and not a long answer. Throwing hands it to the router's
  // honesty template, the same place an empty body goes (rule #8 — no invented body).
  throw new Error('channel coach: model answer had no prefix inside the segment budget');
}

/**
 * The full outbound treatment, in the order the steps depend on each other: flatten to
 * plain ASCII prose first (so the redactor and the counter both see the real body),
 * redact teen names second (so a trim can never be what removes the leak), then fit the
 * budget last (so the count is of exactly what goes on the wire).
 *
 * An empty body THROWS rather than sending whitespace: the router reads a throw as a
 * failed turn and answers with the honesty template, which is the correct outcome for a
 * model that returned nothing (rule #8 — no silent no-op).
 */
export function toSmsReply(raw: string, args: SmsReplyArgs): string {
  const flattened = plainText(raw);
  if (flattened === '') {
    throw new Error('channel coach: model answer was empty after post-processing');
  }
  const redacted = redactTeenNames(flattened, args.children, args.now);
  if (reachesForTheHealthLine(redacted)) {
    // Named rather than swapped in silence: this only fires when the screen in front of
    // the coach did not, so each one is a screen outage worth counting. The body itself
    // never reaches the log — it can carry back what the parent typed (rule #1).
    console.error('channel coach: model composed a safety referral; sent the fixed line');
    return SAFETY_REPLY;
  }
  // The protected tail. Both sources are model-composed and both were accepted by the
  // tool that gated them, so both are appended after the fit rather than trimmed with
  // the answer. They are JOINED rather than made exclusive because "which one wins" is
  // not a judgement this function is in a position to make — and a turn that somehow
  // registered both is a turn where the parent must see both, or be promised something
  // that is not in the message.
  //
  // Redacted with the answer, not after it: the referral line is composed by the model
  // and is the one piece of outbound text a parent forwards to somebody outside the
  // family, so the age-derived teen floor (rule #1) has to cover it too.
  const suffix = redactTeenNames(
    [args.planOffer, args.referral]
      .map((part) => part?.trim() ?? '')
      .filter((part) => part !== '')
      .join(' '),
    args.children,
    args.now,
  );
  if (suffix === '') return fitToBudget(redacted, MAX_REPLY_SEGMENTS);

  // The tools told the model to hand these in rather than write them into the answer;
  // this is the backstop for when it does both, because the visible cost is the same
  // sentence arriving twice.
  const answer = dropDuplicateOffer(redacted, suffix);
  // Nothing but the suffix left: the model answered with it and nothing else, so it IS
  // the reply. Joining an empty answer to it would send a leading space.
  if (answer === '') return suffix;
  const fitted = fitToBudget(answer, MAX_REPLY_SEGMENTS, suffix);
  return `${fitted} ${suffix}`;
}

/**
 * Drop the offer when the model also wrote it into the answer.
 *
 * Matched as a SUFFIX of the whole body rather than sentence by sentence, because the
 * offer is itself two sentences ("Want the full plan? Reply YES and I'll send it.") and
 * a per-sentence walk from the end stops at the first one it does not recognise. Only
 * at the end, so an answer that legitimately uses those words mid-sentence is untouched.
 */
function dropDuplicateOffer(body: string, offer: string): string {
  const needle = offer.trim().toLowerCase();
  if (needle === '') return body;
  const haystack = body.trim();
  if (!haystack.toLowerCase().endsWith(needle)) return haystack;
  return haystack.slice(0, haystack.length - needle.length).trim();
}
