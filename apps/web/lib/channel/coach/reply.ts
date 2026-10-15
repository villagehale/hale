import { distinctiveWords, mentionsActivity } from '~/lib/channel/followup/screen';
import { reachesForTheHealthLine } from '~/lib/channel/off-domain/copy';
import { renderChildName, resolveChildNameLevel } from '~/lib/loop/prefs';
import { type NamedActivityLink, activityLinkSuffix } from './activity-links';

/**
 * VIL-221 · C2 — everything that happens to the model's answer between the loop
 * returning it and the carrier taking it.
 *
 * The skill asks for short, plain prose in the parent's language (see
 * coach-channel-sms.md). Accents and other scripts stay. Typographic punctuation
 * is still folded to the plain mark, because one curly quote flips the carrier
 * encoding and none of that fires as a cut: a long answer leaves whole.
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
   * Appended by code after the model's answer. Nothing on this path shortens either
   * half: a long coaching answer goes out whole, and so does the offer.
   */
  planOffer?: string;
  /**
   * The forwardable line plus the family's own link, registered through
   * `share_referral_link` and already gated by it, or absent when the turn shared
   * nothing (referral/share.ts `referralBlock`).
   *
   * Appended by code so the family's real URL is always included. Code never cuts the
   * answer to make room for it.
   */
  referral?: string;
  /**
   * Pages for activities this turn offered. Appended only when the reply names the
   * activity. The model does not write the URL.
   */
  activityLinks?: readonly NamedActivityLink[];
  /**
   * WHAT OTHER FAMILIES NEARBY SAID about ONE of the activities this turn offered, and
   * the offered titles it must not be confused with.
   *
   * HALE-COMPOSED AND NEVER SEEN BY THE MODEL, unlike the two above. That is the whole
   * design: this surface has no fact lint (`findInventedFacts` guards six composers and
   * none of them is the SMS coach), and the skill forbids a count as its own sentence —
   * so a "3" handed to the model can come out as "a few", or attached to the wrong pick
   * when two are listed. It is appended by code so the model cannot reword it.
   *
   * The naming check is HERE so it sees the exact body the parent reads.
   */
  nearby?: { clause: string; title: string; otherTitles: readonly string[] };
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
  [/[‘’‛\u201a\u201e\u2032\u2033\u00b4]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―\u2010\u2011\u2012\u2212]/g, '-'],
  [/…/g, '...'],
  [/[\u00a0\u2007\u202f\u2009]/g, ' '],
  [/[•·]/g, ''],
  [/\u200b|\u200c|\u200d|\u2060|\ufeff|\u00ad/g, ''],
];

/**
 * Markdown out, one line in. The list markers are dropped rather than rewritten into
 * "1. 2. 3." — the skill's answer shape is prose, and a list that survived the strip
 * would just be prose with stray numbers in it.
 *
 * Exported for the off-domain lane's general answer (boundary v3), which is the second
 * model-composed body Hale texts back. It needs this treatment and none of the rest of
 * `toSmsReply`: it never sees a child to redact. A second copy of the substitution table
 * is the thing to avoid — two readers of "what is safe to send" would disagree the first
 * time one of them is edited.
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
 * The full outbound treatment: flatten to plain prose, redact teen names, then append
 * tool-supplied facts and links. No character or segment cap. Code never truncates what
 * the model wrote, including at an abbreviation such as "St." or "p.m.".
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
    // The model wrote a health-line number in its own words. That is the reply. The
    // log counts the screen miss; the body never reaches it (rule #1).
    console.error('channel coach: model composed a safety referral; sent what it wrote');
  }
  // Tool-accepted offers and links are appended whole. They are joined rather than made
  // exclusive: a turn that registered both is a turn where the parent must see both.
  //
  // Redacted with the answer, not after it: the referral line is composed by the model
  // and is the one piece of outbound text a parent forwards to somebody outside the
  // family, so the age-derived teen floor (rule #1) has to cover it too.
  const link = activityLinkSuffix(redacted, args.activityLinks);
  // A plan offer or a referral drops the nearby count. An activity URL does not:
  // the count is about that find, and the URL is that find's page, so both go out.
  const protectedTail = redactTeenNames(
    [args.planOffer, args.referral]
      .map((part) => part?.trim() ?? '')
      .filter((part) => part !== '')
      .join(' '),
    args.children,
    args.now,
  );
  if (protectedTail === '') {
    const answer = dropDuplicateOffer(redacted, link);
    const nearby = nearbyClause(answer, args.nearby);
    const tail = [nearby ?? '', link]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join(' ');
    if (tail === '') return answer;
    if (answer === '') return tail;
    return `${answer} ${tail}`;
  }

  const suffix = redactTeenNames(
    [protectedTail, link].filter((part) => part.trim() !== '').join(' '),
    args.children,
    args.now,
  );
  // The tools told the model to hand these in rather than write them into the answer;
  // this is the backstop for when it does both, because the visible cost is the same
  // sentence arriving twice.
  const answer = dropDuplicateOffer(redacted, suffix);
  // Nothing but the suffix left: the model answered with it and nothing else, so it IS
  // the reply. Joining an empty answer to it would send a leading space.
  if (answer === '') return suffix;
  // PRECEDENCE: a plan offer or a referral drops the nearby count. A count is the least
  // important thing in a message that also carries a promise. The activity URL still
  // rides along — it is the find, not a second ask.
  return `${answer} ${suffix}`;
}

/**
 * The nearby count, appended only when it is UNAMBIGUOUS — the gate is deterministic and
 * every failure is silence.
 *
 * The fitted body must name the subject of the count and must name no other activity the
 * turn offered — and the two tests are DELIBERATELY ASYMMETRIC, because both fail closed
 * in opposite directions. Naming the target takes EVERY distinctive word of its title;
 * naming another offer takes any one of them (`mentionsActivity`, the follow-up screen's
 * own matcher). Under the any-word rule in both places, "Saturday works, add it" counts
 * as naming "Saturday storytime", and a count about one activity lands on a sentence
 * about another.
 *
 * PRECEDENCE: a turn that also registered a plan offer or a referral drops this
 * altogether (see the caller). A count is the least important thing in any message that
 * also carries a promise. An activity URL does not drop it — the count is about that
 * find, and the page is how the parent opens it.
 */
function nearbyClause(fittedBody: string, nearby: SmsReplyArgs['nearby']): string | null {
  if (!nearby) return null;
  const haystack = [fittedBody.toLowerCase()];
  if (!namesInFull(haystack[0] as string, nearby.title)) return null;
  if (nearby.otherTitles.some((title) => mentionsActivity(haystack, title))) return null;
  return nearby.clause;
}

/** Every distinctive word of the title, and there has to be at least one — a title with
 * none ("Drop-in class") is a title this cannot tell apart from an ordinary sentence. */
function namesInFull(body: string, title: string): boolean {
  const words = distinctiveWords(title);
  return words.length > 0 && words.every((word) => body.includes(word));
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
