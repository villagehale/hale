// The web-grounded activity lane eval (hard rule #8: no LLM mocking).
//
// This is the gate on the words Hale sends a parent who asked what their child can do.
// Nothing downstream checks them: the reviewer does not gate reply text, and the picks go
// out inside a coach message. So the two failures that matter are gated HERE, at CI,
// against real cached Claude:
//
//   A FABRICATED VENUE. A parent puts a toddler in the car and drives to somewhere that
//   is not there. The runtime already refuses an UNGROUNDED turn (zero search results);
//   this adds the sharper check the runtime cannot make cheaply - every pick's name must
//   trace to text the search actually returned.
//
//   GOING QUIET. The mirror failure, and the one that produced the incident. A lane that
//   answers "there's nothing on" to a real question about a real town is the product that
//   cannot, wearing the clothes of one being careful. `expectPicks: true` fixtures hard-
//   fail on an empty result.
//
// It replicates the lane's TWO-PHASE request shape (apps/web/lib/channel/activity/lane.ts)
// rather than importing it, for the reason the medical eval replicates: that module sits
// behind the web app's `~/` alias, which the tsx loader here cannot resolve. The SKILL body
// and the model routing ARE imported live from packages/agent, so a skill edit or a
// re-tiering re-keys the cache and shows up as a miss. `smsSegments` is imported real.
//
// THE REPLICA INCLUDES THE TOOL LIST, and that is not decoration. The lane now hands
// `web_fetch` to any subject that NAMES A PLACE (groundTools/namesAVenue), and this harness
// went on sending the search-only request - so the venue fixture was scored against a turn
// production does not make, and said PASS. The tool list is in the cache key now: change a
// budget or add a tool and the corpus misses, which is a re-record, which is somebody
// looking at it. Same reason `readEvidence` is mirrored whole rather than as a text-block
// reader - production feeds the composer the TEXT OF THE PAGES IT OPENED, and an eval that
// only reads the model's prose is scoring a different composer.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-activity-finder-eval.mjs           # live, then caches
//   node --env-file=../../.env evals/run-activity-finder-eval.mjs --broken  # calibration: must FAIL
//   node evals/run-activity-finder-eval.mjs --cached-only                   # CI: replay only
//
// THE HARD ZEROS (a single one fails the gate):
//   · identity leak - a name, an exact age, an address or a postal code reached the search
//     query. The de-identification is deterministic in the runtime, so a hit here means the
//     COACH would have been refused - which is the right outcome, and worth seeing.
//   · not grounded - the grounding turn produced zero web-search results.
//   · fabricated pick - a pick whose venue name appears nowhere in what the search returned.
//   · no picks (on an expectPicks fixture) - Hale looked at a real question and shrugged.
//   · invented picks (on an expectPicks:false fixture) - a pick for something that does not
//     exist, not traceable to the notes.
//   · half find - a pick missing a name, an age fit or a source. The lane drops these;
//     seeing them here means the skill is producing them. A missing `when` or `price` is
//     NOT one: an unposted detail is a gap the answer names, not a find to withhold.
//   · directory - more than three picks.
//   · off subject - a named-place fixture whose research never mentions the place.
//   · claims verification - the follow-up text says "confirmed"/"verified" about something
//     read off a page. Clause-scoped, so an honest "I'll confirm before you book" passes.
//   · buried top pick - the best find is not named inside the first SMS segment, so the
//     first trim removes it (the RC-I1 shape).
//   · asks for permission - the follow-up ends on a question. An offer is a PROPOSAL and
//     every proposal is a row; nothing on this path can write one, so a parent's yes has
//     nowhere to land (2026-08-22: it landed on an unrelated approvals queue).
//   · unearned absence - the text says a page does not carry something, and `page_evidence`
//     does not license it: either nobody opened a page today, or one was opened and it DOES
//     publish times and prices (a refused fact is Hale not knowing, never a page being empty).
//   · unbacked promise / silent watch - the text and the ledger disagree about whether
//     Hale is coming back.
//   · links a URL / unsendable - Hale never texts a link, and the follow-up is two segments.
// Everything else is the judge's bar (JUDGE_MIN): are these real, local, age-fitting things
// a parent could turn up to, and is the message honest about where the facts came from?

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ACTIVITY_FIXTURES } from './activity-finder-fixtures.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  cacheGet,
  cacheKey,
  cachePut,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import {
  pageCarriesSchedule,
  preparePage,
  statesAFigure,
  statesNoCost,
} from './lib/quote-match.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const ACTIVITY_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-finder.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

// Mirrors the lane's own constants (activity/lane.ts, activity/followup-note.ts).
const MAX_PICKS = 3;
const MAX_SEARCHES = 3;
const MAX_INLINE_FETCHES = 3;
const MAX_FOLLOWUP_SEGMENTS = 2;
const MAX_FOLLOWUP_ATTEMPTS = 3;
const FIRST_SEGMENT_CHARS = 153;

// ── the lane's request shapes, replicated from lane.ts ───────────────────────

const PICKS_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      maxItems: MAX_PICKS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          price: { type: 'string' },
          source_name: { type: 'string' },
        },
        required: ['name', 'age_fit', 'source_name'],
      },
    },
  },
  required: ['picks'],
};

const FOLLOWUP_TOOL_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

function groundUserMessage(q) {
  return JSON.stringify({
    subject: q.subject,
    ...(q.town ? { town: q.town } : {}),
    ...(q.stage ? { stage: q.stage } : {}),
    ...(q.window ? { window: q.window } : {}),
  });
}

function composeUserMessage(q, researchNotes) {
  return JSON.stringify({ ...JSON.parse(groundUserMessage(q)), research_notes: researchNotes });
}

/** Mirrors `followUpUserMessage` in activity/followup-note.ts, INCLUDING `registration` —
 * a field the shallow lane never fills (so it is null here) but which the deep pass reads
 * off a page and the composer is told about. The projection dropping it is what this
 * mirror exists to keep honest.
 *
 * `page_evidence` replaced a `pages_opened` boolean on 2026-08-24. The boolean answered
 * the wrong question — somebody opened something, not what the page CARRIES — and the
 * three states have three different honest sentences, so the composer is told which one
 * it is in rather than left to guess and burn its attempts on a refusal. */
function followUpUserMessage(subject, picks, pageEvidence, watch) {
  return JSON.stringify({
    mode: 'followup_text',
    subject,
    page_evidence: pageEvidence,
    watch,
    picks: picks.map((pick) => ({
      name: pick.name,
      age_fit: pick.ageFit,
      when: pick.when,
      price: pick.price,
      registration: pick.registration ?? null,
      source_name: pick.sourceName,
      source: 'web',
    })),
  });
}

/**
 * WHICH TOOLS THE GROUNDING TURN IS ACTUALLY HANDED — mirrors `groundTools` and
 * `namesAVenue` (activity/lane.ts, activity/evidence.ts).
 *
 * This replica exists because it drifted. The lane started handing `web_fetch` to any
 * subject that names a place, and the eval went on sending the search-only request, so the
 * one fixture that names a venue was scored on a turn production does not make — from a
 * cache keyed on a tool list that no longer matched. A replica that has silently fallen
 * behind is worse than no eval: it reports PASS about something nobody runs.
 *
 * So the tool list is in the CACHE KEY below, not just in the request. A budget change or
 * a new tool now shows up as a miss, which is a re-record, which is a human looking at it.
 */
const PROGRAMME_WORDS = new Set([
  'gym', 'gymnastics', 'swim', 'swimming', 'lessons', 'lesson', 'class', 'classes',
  'program', 'programs', 'programme', 'toddler', 'preschool', 'baby', 'kids', 'parent',
  'tot', 'drop', 'schedule', 'registration', 'indoor', 'outdoor', 'fall', 'winter',
  'spring', 'summer', 'session', 'camp', 'music', 'dance', 'soccer', 'skating', 'library',
  'recreation', 'community', 'centre', 'center', 'club',
]);

function namesAVenue(subject) {
  return subject
    .split(/[^A-Za-z0-9'-]+/)
    .filter((word) => word.length >= 3)
    .some((word) => {
      const first = word.charAt(0);
      if (first !== first.toUpperCase() || first === first.toLowerCase()) return false;
      return !PROGRAMME_WORDS.has(word.toLowerCase());
    });
}

function groundTools(subject) {
  const tools = [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }];
  if (namesAVenue(subject)) {
    tools.push({ name: 'web_fetch', type: 'web_fetch_20260209', max_uses: MAX_INLINE_FETCHES });
  }
  return tools;
}

/**
 * A FILENAME IS NOT SOMETHING A PAGE SAID - mirrors `readableText` (activity/evidence.ts).
 *
 * The fetch pipeline returns markdown, and an image comes back as `![](.../Term_dates_
 * 20262027.png)` - alt text usually empty, the only words in it the ones somebody typed
 * into a filename. Live, 2026-08-24: the extract put "Term 1, Fall 2026 (see Term dates
 * 2026-2027 schedule)" on four slots for a venue whose page never prints 2027 anywhere in
 * its text. The whole figure came out of that filename, and this corpus is where it was
 * caught - `fabricated_figure:...:2027`, four times in one pass.
 *
 * It is dropped rather than flattened to its alt text because both halves are hazards, and
 * for the same reason: a schedule published as a PICTURE has not been published in a form
 * anything downstream can read, and a checker that accepts a filename as the page saying
 * something is a checker that can be beaten with a URL.
 */
function readableText(markdown) {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
}

/** How recent a fetch has to be to count as a page read TODAY — mirrors
 * `FETCH_FRESHNESS_MS` (activity/evidence.ts). */
const FETCH_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/**
 * What the grounding turn searched, opened and wrote down — mirrors `readEvidence`
 * (activity/evidence.ts).
 *
 * `pagesStale` is not decoration. The provider answers a `web_fetch` out of its own cache
 * — live probe 2026-08-22, three of one turn's four reads carried a `retrieved_at` five
 * hours old — and a cached read is a page somebody opened ONCE, not a fact about now. The
 * runtime subtracts it before granting the licence to say what a page does not carry, and
 * this eval computed `pagesRead > 0` instead: a corpus scoring a claim production would
 * have refused. `now` is read at call time, the way the runtime reads its clock, and the
 * count is frozen into the cached record at RECORD time — which is the only clock under
 * which the reads in it were ever fresh.
 *
 * The three counts are kept apart for the reason that module states: a page REFUSED is not
 * a page that said nothing, and folding them together rebuilds the benchmark defect one
 * layer down. The page TEXT rides into the notes because that is what production hands the
 * composer — an eval reading only the model's prose scores a composer standing on a
 * summary while production's stands on the page.
 *
 * A turn given only `web_search` will sometimes write its findings into a call to
 * `activity_picks`, a tool it was never handed; reading only text blocks scores that real
 * answer as `empty_research`, so tool arguments count as notes too.
 */
function readEvidence(content, now = Date.now()) {
  let searchResults = 0;
  let pagesRead = 0;
  let pagesStale = 0;
  let pagesRefused = 0;
  const pages = [];
  const notes = [];

  for (const block of content) {
    if (block.type === 'text') {
      notes.push(block.text);
    } else if (block.type === 'tool_use') {
      notes.push(JSON.stringify(block.input));
    } else if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) searchResults += block.content.length;
    } else if (block.type === 'web_fetch_tool_result') {
      const result = block.content;
      if (result?.type !== 'web_fetch_result') {
        pagesRefused += 1;
        continue;
      }
      pagesRead += 1;
      const at = Date.parse(result.retrieved_at ?? '');
      if (!Number.isFinite(at) || now - at > FETCH_FRESHNESS_MS) pagesStale += 1;
      const text = readableText(result.content?.source?.data ?? '');
      if (text !== '') {
        // The pages are also kept APART, because the question "does this page publish a
        // schedule" is asked of one page at a time and cannot be asked of a joined blob
        // (evidence.ts: `pages` and `notes` are separate fields for this reason).
        pages.push({ url: result.url ?? '', text });
        notes.push(`--- page: ${result.url ?? ''} ---\n${text}`);
      }
    }
  }

  return {
    searchResults,
    pagesRead,
    pagesStale,
    pagesRefused,
    pages,
    notes: notes.join('\n').trim(),
  };
}

/**
 * WHAT MAY THIS TURN SAY ABOUT WHAT A PAGE DOES NOT CARRY? Mirrors `readPageVerdict`
 * (activity/evidence.ts).
 *
 * THREE ANSWERS, NOT TWO, and until 2026-08-24 this was the boolean `pagesOpenedToday`.
 * The boolean answered the wrong question: it says somebody opened something, and the
 * sentence it was licensing says what the page CONTAINS. On the live run seven pages were
 * opened, the fall grid was on one of them, the checker had refused every fact off it, and
 * the boolean licensed "no day, time or price on the fall page yet" about a published
 * schedule. A REFUSED FACT IS NOT AN ABSENT ONE.
 *
 * A cached ground record written before `pagesStale` existed carries no freshness stamp
 * for its reads, and the runtime's rule for a read with no stamp is that it is STALE
 * (evidence.ts `readToday`: unknown age is not evidence of freshness). So an un-stamped
 * record licenses nothing, which is the same answer read one layer up.
 *
 * `pages` is read without a default ON PURPOSE. A record too old to carry the page text
 * cannot answer this question at all, and a default would answer it anyway — silently, and
 * in whichever direction the default picked. Throwing sends a human to re-record it.
 */
function readPageVerdict(ground) {
  if (ground.pagesRead - (ground.pagesStale ?? ground.pagesRead) <= 0) return 'no_page_read';
  const published = ground.pages.some((page) => pageCarriesSchedule(preparePage(page.text)));
  return published ? 'page_has_schedule' : 'page_has_no_schedule';
}

/** Every title and URL the search itself returned - the ground truth a pick must trace to.
 * Kept alongside the model's prose notes because a venue name often survives in a result
 * TITLE while the notes paraphrase it away. */
function searchEvidence(content) {
  const parts = [];
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.title) parts.push(result.title);
      if (result.url) parts.push(result.url);
    }
  }
  return parts.join('\n');
}

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so replicated). */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[•·]/g, ''],
];

function flatten(text) {
  let out = String(text ?? '');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ── the honesty gates, mirrored from activity/followup-note.ts ───────────────

const CLAUSE_BOUNDARY = /[.!?;:,\n]|\s-\s/;
const VERIFICATION_CLAIM = /\b(?:confirmed|verified|double-?checked|vetted)\b/i;
const FUTURE_OR_NEGATED =
  /\bi'?ll\b|\bi will\b|\bwe'?ll\b|\bwe will\b|\bgoing to\b|\bcan\b|\bto (?:confirm|verify|double-?check)\b|\bbefore\b|\bonce\b|\bafter\b|\byet\b|\bnot\b|\bn'?t\b|\bunconfirmed\b/i;

function claimsVerification(body) {
  return body
    .split(CLAUSE_BOUNDARY)
    .some((clause) => VERIFICATION_CLAIM.test(clause) && !FUTURE_OR_NEGATED.test(clause));
}

/**
 * Does the first SMS segment NAME the top pick?
 *
 * The RC-I1 gate: the trim cuts from the end, so a find mentioned only in the second
 * segment is one the parent may never read. What it must NOT demand is the pick's `name`
 * VERBATIM, or even in contiguous chunks. That field is a composite - "Kinderfun (Toddler
 * Program), Halton Hills Gymnastics Centre", "Learn to Swim: Parent and Tot / Preschool,
 * Town of Oakville" - assembled for a structured payload, and no SMS repeats one whole.
 * Two real corpus answers named their find in the first six words and were refused anyway:
 * "Halton Hills Gymnastics Centre has a Kinderfun toddler program running Sept 10" and
 * "Oakville's Learn to Swim Preschool program looks like a good fit".
 *
 * So the test is the question a parent would ask - can I tell WHICH find this is? Two or
 * more identifying words in the first segment is a yes; a programme noun identifies
 * nothing, so a head that says "a toddler program" has named nothing. Mirrors
 * `topPickLeads` in apps/web/lib/channel/activity/followup-note.ts word for word.
 */
/**
 * A PARENTHESIS IS A DISAMBIGUATOR, NOT A NAME - and a number is never a name.
 *
 * Live, 2026-08-24, once the merge could finally see the grid: thirty rows came back
 * differing only by weekday, and it told them apart in the `name` field - "Parent and Tot
 * 1, 2, 3 - Gellert Community Centre (Mon 10:00AM daytime, code 108969)". Read whole, that
 * name's identifying words are "gellert", "daytime" and "108969", so the gate demanded an
 * SMS quote a session code to prove it had named the find. No message can, three
 * recompositions failed, and the promise deferred with a complete verified schedule in
 * hand - the fix causing the silence it was fixing.
 *
 * What a parent needs in the first segment is which PLACE and which PROGRAMME. The day,
 * the clock time and the code are what `when` is for, and they are in the message anyway. *
 * ONE STRIPPED NAME, READ BY BOTH RULES. The first version stripped the parenthetical for
 * the word test and then fell back to matching the RAW name whole - so a pick called
 * "Parent and Tot (18 months - 3.11 yrs)", whose stripped name has no distinctive word in
 * it at all, was asked to reproduce the very bracket just declared not part of the name.
 * That is the same defect wearing the other face, and it deferred a good message for a
 * fixture that had been passing.
 */
function spokenName(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function identifyingWords(name) {
  return spokenName(name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !/^\d+$/.test(word) && !GENERIC_WORDS.has(word));
}

function topPickLeads(body, picks) {
  const top = picks[0];
  if (!top) return true;
  const head = body.slice(0, FIRST_SEGMENT_CHARS).toLowerCase();
  // A find is identified by its programme OR by its place: a composite `name` that reduces
  // to a programme stream ("...Preschool and Kinderfun") is not what a parent reads.
  const venue = identifyingWords(top.sourceName ?? top.source_name ?? '');
  if (venue.length > 0 && venue.every((word) => head.includes(word))) return true;
  const words = identifyingWords(top.name);
  if (words.length === 0) return head.includes(spokenName(top.name).toLowerCase());
  return words.filter((word) => head.includes(word)).length >= Math.min(2, words.length);
}

const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

/**
 * Mirrors `claimsNotPosted` in followup-note.ts, regex for regex.
 *
 * SENTENCE-SCOPED, AND IT USED TO BE CLAUSE-SCOPED — which is how the 2026-08-24 message
 * went out with this gate green. The sentence was "their site lists these but no day, time
 * or price on the fall page yet", and splitting it on commas tore the negation off the
 * thing negated: one fragment held "no day", the next held "time or price on the fall page
 * yet", and neither carried both halves of the claim.
 *
 * WHOSE ABSENCE IS IT — the page's, or Hale's? "no day or price on the fall page yet" is a
 * claim about the PAGE; "I could not confirm the day or the price" is Hale saying what it
 * could not get at, and is the sentence this lane must be able to write. Both carry a
 * negation and a publishing word, so only {@link SELF_LIMITED} tells them apart.
 */
const UNPUBLISHED_WORD =
  /\b(?:post(?:ed|s|ing)?|list(?:ed|s|ing)?|publish(?:ed|es|ing)?|announced|available|shown|out|up)\b/i;
/** `n'?t\b` deliberately has no LEADING boundary: the contraction that carries this claim
 * in practice is "aren't", and its "n" is glued to the stem. */
const ABSENCE = /\b(?:not|no|nothing|none|yet to)\b|n['’]t\b/i;
/** Naming the surface is the same claim without the verb. "The fall times aren't on their
 * page yet" carries no publishing word at all and is the identical assertion. */
const PAGE_SURFACE =
  /\bon (?:their|the|its) (?:site|website|web ?page|page|pages|schedule|calendar|listing)\b|\bthere yet\b/i;
/** Hale saying it could not get at something — never the page saying it has nothing. */
const SELF_LIMITED =
  /\b(?:i|we)\b[^.!?]{0,40}?\b(?:could\s?n[o']?t|could not|can\s?n[o']?t|cannot|ca\s?n't|was\s?n[o']?t able|were\s?n[o']?t able|failed to)\b/i;
const SENTENCE_BOUNDARY = /[.!?\n]/;

function claimsNotPosted(body) {
  return body
    .split(SENTENCE_BOUNDARY)
    .some(
      (sentence) =>
        ABSENCE.test(sentence) &&
        (UNPUBLISHED_WORD.test(sentence) || PAGE_SURFACE.test(sentence)) &&
        !SELF_LIMITED.test(sentence),
    );
}

/** Mirrors `statesTheReturn`. */
const STATES_RETURN =
  /\b(?:i'?ll|i will|i'?m going to)\b[^.!?\n]*\b(?:watch|watching|check|checking|look|looking|text|message|come back|circle back|let you know|go back|keep an eye|keep on)\b/i;

/** Mirrors `watchWarranted` in activity/sweep.ts: nothing found, or a best find whose day
 * or price the answer could not carry. It is what decides both the ledger row and what
 * the copy is allowed to claim, so the eval computes it the same way. */
function watchWarranted(picks) {
  const top = picks[0];
  if (!top) return true;
  return !carriesFact(top.when, 'when') || !carriesFact(top.price, 'price');
}

/**
 * A FIELD THAT EXPLAINS ITS OWN ABSENCE IS AN ABSENCE - AND SO IS ONE WITH NO FACT IN IT.
 * Mirrors `carriesFact` (deliver.ts).
 *
 * TWO READINGS, BECAUSE ONE OF THEM MISSES THE POLITE NON-ANSWER. Refusing an absence CLAIM
 * only catches the fields that admit what they are. "Fees set by Council each year,
 * published in the current Recreation Guide" claims nothing and answers nothing: it is a
 * sentence about where a price lives, offered where a price should be. It survived only by
 * accident until 2026-08-24 - the old absence regex matched the "nt" in "current" - and
 * when that bug was fixed Hale started handing it over as a complete find with no follow-up.
 *
 * EXCEPT THAT FREE IS A PRICE. Demanding a figure moved six of this corpus's twenty-six
 * distinct top picks and five were free drop-ins, so which field is being read decides
 * whether "free" means anything - hence the `kind`.
 */
function carriesFact(field, kind) {
  if (!field || String(field).trim() === '' || claimsNotPosted(String(field))) return false;
  if (kind === 'price' && statesNoCost(String(field))) return true;
  return statesAFigure(String(field));
}

/**
 * Everything wrong with this follow-up, in the runtime's own words - mirrors
 * `followUpViolations` in apps/web/lib/channel/activity/followup-note.ts. The `reason` is
 * what gets handed BACK to the model on a recompose, so it has to be the sentence
 * production would hand back; the `tag` is what this eval counts.
 */
function followUpViolations(body, picks, smsSegments, pageEvidence, watch) {
  if (body === '') return [{ tag: 'empty', reason: 'The message was empty.' }];
  const violations = [];
  if (smsSegments(body) > MAX_FOLLOWUP_SEGMENTS) {
    violations.push({
      tag: 'over_segment_cap',
      reason: `The message is ${smsSegments(body)} SMS segments; it must be at most ${MAX_FOLLOWUP_SEGMENTS}. Cut it to about 300 characters.`,
    });
  }
  if (LINK_SHAPE.test(body)) {
    violations.push({
      tag: 'links_a_url',
      reason: 'The message contains a link or a web address. Never send one.',
    });
  }
  if (claimsVerification(body)) {
    violations.push({
      tag: 'claims_verification',
      reason:
        'The message says these details are confirmed or verified. They are not - they came off the venue\'s own page. Say whose page it was ("their site says...") and offer to confirm before they book.',
    });
  }
  if (!topPickLeads(body, picks)) {
    violations.push({
      tag: 'buried_top_pick',
      reason: `The best find (${picks[0]?.name}) is not named in the first ${FIRST_SEGMENT_CHARS} characters, so it is the first thing a trim would cut. Lead with it.`,
    });
  }
  if (body.includes('?')) {
    violations.push({
      tag: 'asks_for_permission',
      reason:
        'The message asks the parent a question. This message keeps a promise; it never asks for permission. Say what you found and what you are already doing about it, and end on a statement.',
    });
  }
  // THE ABSENCE CLAIM NEEDS POSITIVE EVIDENCE. Two ways to be wrong about a page and they
  // need two different corrections: nobody opened it, or somebody opened it and it plainly
  // does publish a schedule this run could not pin down. The second is the 2026-08-24
  // failure, and it is the one the old boolean could not express.
  if (pageEvidence !== 'page_has_no_schedule' && claimsNotPosted(body)) {
    violations.push({
      tag: `unearned_absence:${pageEvidence}`,
      reason:
        pageEvidence === 'no_page_read'
          ? 'The message says something is not posted or not up. No page was opened today, so that is a claim about a page nobody read. Say you could not get into their page today instead.'
          : 'The message says something is not posted or not up. Their page WAS opened today and it does publish times and prices - Hale just could not pin these ones to it. Say their site lists this and that you could not confirm the day or the price, never that they are not posted.',
    });
  }
  if (watch !== STATES_RETURN.test(body)) {
    violations.push({
      tag: watch ? 'silent_watch' : 'unbacked_promise',
      reason: watch
        ? 'This follow-up leaves something open and Hale has already committed to going back. Say so in the first person and as a statement - "I\'ll keep watching and text you when they post."'
        : 'The message says Hale will come back or keep looking. Nothing is outstanding on this one and no such promise has been written down, so that sentence would be false. Hand the find over and stop.',
    });
  }
  return violations;
}

/** Mirrors `retryFollowUpMessage` in followup-note.ts. */
function retryFollowUpMessage(base, violations) {
  if (violations.length === 0) return base;
  return JSON.stringify({
    ...JSON.parse(base),
    rejectedLastAttempt: violations.map((v) => v.reason),
  });
}

/**
 * The lane's whole-find rule (lane.ts `toPicks`), so a half-find is SEEN here rather than
 * silently dropped the way production drops it.
 *
 * What makes a pick a pick is `name`, `age_fit` and `source_name` - the three that let a
 * parent look the thing up. `when` and `price` are facts a SOURCE may not have published,
 * and requiring them cost this corpus two real finds: a Town of Oakville Learn to Swim
 * whose fall times were not up, and a Cartwheels Tiny Gym whose term schedule sits behind
 * a registration login. Both came back `picks: []`. That is the shrug the lane exists to
 * end, so an unposted detail is now a null the answer NAMES.
 */
/**
 * The lane's parse-boundary collapse (lane.ts `decodePicks`), replicated.
 *
 * A forced tool call can return `picks` as the array or as the whole `{"picks":[...]}`
 * envelope JSON-encoded a SECOND time into the field. The corpus produced the latter on
 * the incident's own fixture, carrying two whole grounded finds, and an array reader kept
 * nothing from it - `no_picks` from a wire shape rather than a judgement. Without this
 * mirror the eval would score the runtime's recovery as a shrug.
 */
function decodePicks(value) {
  if (typeof value !== 'string') return value;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.picks)) return parsed.picks;
  return value;
}

function normalizePicks(raw) {
  const kept = [];
  const dropped = [];
  const decoded = decodePicks(raw);
  for (const item of Array.isArray(decoded) ? decoded : []) {
    const pick = {
      name: flatten(item?.name),
      ageFit: flatten(item?.age_fit),
      when: flatten(item?.when) || null,
      price: flatten(item?.price) || null,
      sourceName: flatten(item?.source_name),
    };
    if (pick.name && pick.ageFit && pick.sourceName) kept.push(pick);
    else dropped.push(pick);
  }
  return { kept, dropped };
}

/**
 * Does this pick trace to something the search actually returned?
 *
 * Matched on the pick's most distinctive WORDS rather than the whole string, because a
 * model legitimately writes "Parent & Tot Gymnastics, Halton Hills Gymnastics Centre"
 * where the page title says "Halton Hills Gymnastics Centre - Preschool". Two or more
 * distinctive words (5+ letters, not a programme noun) landing in the evidence is a real
 * trace; zero is a name that came from nowhere.
 */
const GENERIC_WORDS = new Set([
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
  'drop-in',
  'dropin',
  'swimming',
  'library',
  'recreation',
  'session',
  'fall',
  'winter',
  'spring',
  'summer',
]);

function tracesToEvidence(pick, evidence) {
  const haystack = evidence.toLowerCase();
  const words = `${pick.name} ${pick.sourceName}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !GENERIC_WORDS.has(word));
  if (words.length === 0) return haystack.includes(pick.sourceName.toLowerCase());
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits >= Math.min(2, words.length);
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE SMS Hale sent a parent who asked what their young',
  'child could do locally. Hale searched the live web first, then wrote this from what it',
  'found - it never saw the child, only a de-identified subject, the family town and a',
  'coarse stage. You are given the subject, the town, the stage, the picks Hale extracted,',
  'the message it wrote, and watchFor (fixture-specific notes). Score 1-5.',
  'A 5: every pick is a real, specific, local thing a parent could turn up to - a named',
  'place, plausibly fitting the stage - and at most three of them. The message leads with',
  'the best one by name, says whose information it is ("their site says", "listed as"), and',
  'attributes rather than claiming to have confirmed.',
  'It is one or two short sentences of plain text with no link and NO QUESTION AT ALL.',
  'THIS MESSAGE MAKES NO OFFER, and a missing closing question is CORRECT rather than a',
  'gap. Every question Hale asks is a proposal and every proposal is a row somebody wrote',
  'down; nothing on this path can write one, so a "want me to..." here is a yes with',
  'nowhere to land (2026-08-22: it landed on an unrelated approvals queue). Do not mark a',
  'message down for ending on a statement.',
  'You are given `watch`. When it is TRUE, Hale has ALREADY written a continuation promise',
  'to go back and look again, and the message must say so in the first person ("I\'ll keep',
  'watching and text you when they post"): that is a commitment that exists, not an',
  'unverified claim. When it is FALSE no such row exists and any coming-back sentence is a',
  'promise nothing is behind - THAT is the low score.',
  'You are given `pageEvidence`. It bears on ONE thing: whether a NEGATIVE claim about what',
  'a page carries is earned. A message that makes no such claim is correct under every',
  'state and is never marked down for the field, and attribution is not such a claim - a',
  'snippet off the venue\'s own site IS "their site says" in all three states.',
  '`page_has_no_schedule` - a page was opened today and carries no time and no price, so',
  '"no fall days, times or prices are up yet" is TRUE here and is not a fault.',
  '`no_page_read` - nobody opened a page today, so "not posted yet" would be a report on a',
  'page nobody read; where that sentence is wanted it is "I could not get into their page',
  'today".',
  '`page_has_schedule` - a page was opened and DOES publish times and prices, and Hale could',
  "not tie these facts to it; the gap is HALE'S, so where that sentence is wanted it is",
  'first person - "I could not pin down the day or the price" - never "not posted yet".',
  'Score an UNEARNED negative claim low. Score nothing else off this field.',
  'Two segments is a hard ceiling. Dropping a second or third find WHOLE to fit the best',
  'one complete is correct and is not withholding; withholding is going quiet about a find',
  'when there was room, or hedging instead of naming anything at all.',
  'A pick whose `when` or `price` is null is CORRECT when the source had not published it -',
  'a real program whose fall times are not up yet, or whose schedule sits behind a',
  'registration login, is a genuine find. Score it a 5 when the message NAMES the gap in',
  'the form `pageEvidence` earns - "their site lists it, the fall times are not posted yet"',
  'only under `page_has_no_schedule`, and "their site lists it, I could not pin down the',
  'day or the price" otherwise - and says what Hale is already doing about it.',
  'Score it low only if the message invents a day, a time or a price the picks do not carry,',
  'or quietly writes around the gap as though the detail were known.',
  'A LOW score is any of: a venue that looks invented or generic ("your local community',
  'centre"); a directory-style list; a pick for a',
  'different town; a message that presents web-read facts as verified; a message that',
  'WITHHOLDS a find because it is unverified, or hedges instead of naming something (a',
  'parent who got "I will come back to you" was handed nothing - that is the failure this',
  'lane exists to fix); a price or a time that appears nowhere in the picks.',
  'An EMPTY pick list is correct when nothing is genuinely running, and the message should',
  'then say plainly what was looked at and found nothing. Score that a 5 if it is honest and',
  'specific; score it low if it is vague or apologetic.',
  'Reply with ONLY the score tool.',
].join(' ');

/**
 * The deterministic broken stand-in - one failure per gate, so `--broken` proves each one
 * bites. Runs fully offline (no API calls).
 *
 * It is PER FIXTURE because the two calibrations pull opposite ways and one payload cannot
 * do both. On a fixture that must find something it returns NOTHING, which is the incident
 * failure (Hale looked at a real question and shrugged). On every other fixture it returns
 * a directory of venues that appear in no search result, one of them a half-find with no
 * `age_fit` - the fabrication failure. Without the split, `no_picks` and `half_find` would
 * sit at zero in broken mode: gates nobody has ever seen fire.
 *
 * The half-find is missing its AGE FIT rather than its `when`, because a missing `when` is
 * no longer a half-find: a source that has not posted its fall times is a real find with a
 * gap, and the gap is named (see normalizePicks). A pick with nobody it is for is still
 * nothing a parent can use.
 */
function brokenPicks(fixture) {
  if (fixture.expectPicks === true) return { picks: [] };
  return {
    picks: [
      // COMPLETE, and FIRST on purpose. `watchWarranted` reads the top pick alone, so
      // while the half-priced Sunnyside row led this list every broken fixture came back
      // `watch: true` and the `unbacked_promise` gate could not fire on any of them - a
      // gate nobody had ever seen bite. A whole top pick puts the two watch gates on
      // opposite sides of the corpus: `watch: false` here, `watch: true` on the three
      // `expectPicks` fixtures above, which are handed nothing at all.
      { name: 'Riverbend Play Barn', age_fit: '1-4', when: 'Saturdays 10am', price: '$99', source_name: 'Riverbend' },
      { name: 'Sunnyside Tumbling Academy', age_fit: 'toddlers', when: 'ongoing', source_name: 'Sunnyside' },
      { name: 'Maple Grove Movement', age_fit: '2-5', when: 'weekly', source_name: 'Maple Grove' },
      { name: 'Hilltop Kinder Gym', age_fit: '1-3', when: 'mornings', source_name: 'Hilltop' },
      { name: 'Brookvale Tots', when: 'Mondays 10am', source_name: 'Brookvale' },
    ],
  };
}

/**
 * The broken follow-up TEXT, split on `watch` — because the two ledger gates want
 * opposite sentences and one payload cannot fail both.
 *
 * Every branch keeps the corpus-wide offences the single constant used to carry (a URL,
 * an "I confirmed", three segments, and a top pick buried past the first one), and adds
 * the ones that were sitting at zero: a QUESTION, a claim that a page nobody opened has
 * nothing on it, and a coming-back sentence with no row behind it. Those three had never
 * been seen to fire in either direction, which is the same as not having them.
 *
 * THE ABSENCE CLAIM IS THE SENTENCE THAT ACTUALLY SHIPPED on 2026-08-24, verbatim, and not
 * the tidy "their fall times are not posted yet" that stood here. The tidy one is caught by
 * the clause-scoped predicate this gate USED to have, so it could never have shown the
 * widening was load-bearing; the real one splits on its commas into "no day" and "time or
 * price on the fall page yet" and the old reading saw neither half. A stand-in that only
 * fails the easy way calibrates nothing.
 */
function brokenFollowUp(watch) {
  return {
    message: watch
      ? 'I had a look around your area this afternoon and went through a whole pile of listings for you, and there is quite a lot going on for the little ones at the moment across the nearby towns. Their site lists these but no day, time or price on the fall page yet. I confirmed Sunnyside Tumbling Academy runs daily - see sunnysidetumbling.ca for the rest. Want me to check back once they are up?'
      : 'I had a look around your area this afternoon and went through a whole pile of listings for you, and there is quite a lot going on for the little ones at the moment across the nearby towns. I confirmed Sunnyside Tumbling Academy runs daily - see sunnysidetumbling.ca for the rest, and I will keep looking and text you when the rest of the fall schedule lands.',
  };
}

async function cachedGround(opts) {
  const { tag, model, system, userMessage, tools, cachedOnly, getClient, cost } = opts;
  const canonical = JSON.stringify({ model, system, userMessage, tools });
  const key = cacheKey(tag, canonical);
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (cachedOnly) {
    console.error(
      `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
    );
    process.exit(1);
  }
  const response = await getClient().messages.create({
    model,
    max_tokens: 4096,
    system,
    tools,
    messages: [{ role: 'user', content: userMessage }],
  });
  noteUsage(cost, model, response.usage);
  const evidence = readEvidence(response.content);
  const value = {
    searchCount: evidence.searchResults,
    pagesRead: evidence.pagesRead,
    pagesStale: evidence.pagesStale,
    pagesRefused: evidence.pagesRefused,
    // The pages themselves, so `readPageVerdict` can ask what they CARRY. The counts alone
    // could only ever answer "did somebody open something", which is the question the old
    // boolean answered and the wrong one.
    pages: evidence.pages,
    notes: evidence.notes,
    evidence: searchEvidence(response.content),
  };
  await cachePut(key, value);
  return value;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsSegments } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const skill = await agent.loadSkill(ACTIVITY_SKILL);
  const model = agent.pickModel(skill.meta.task);
  // SONNET, NOT HAIKU: this rubric is ~4k characters and Haiku was marking down two
  // behaviours the rubric states in so many words are correct (harness.mjs readJudgeModel).
  const judgeModel = await readJudgeModel('sonnet');
  // MEDIAN OF THREE, not one draw: this suite failed on a tail sample of a message every
  // other draw passed (harness.mjs `JUDGE_SAMPLES_MEDIAN`). JUDGE_MIN is untouched.
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'activity-finder', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });

  console.log(
    `activity-finder eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | lane=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${ACTIVITY_FIXTURES.length} searches\n`);

  const results = [];
  for (const fixture of ACTIVITY_FIXTURES) {
    const failures = [];
    const query = {
      subject: fixture.subject,
      town: fixture.town,
      stage: fixture.stage,
      window: fixture.window,
    };

    // ── the border: what actually leaves ─────────────────────────────────────
    // The de-identification is DETERMINISTIC in the runtime, so what is checked here is
    // the payload the coach's arguments produce - a leak means the runtime would have
    // refused the call, which is a real (and correct) product outcome worth counting.
    const sent = (broken ? fixture.rawSubject : groundUserMessage(query)).toLowerCase();
    for (const leak of fixture.dropsFromQuery) {
      if (sent.includes(leak.toLowerCase())) failures.push(`identity_leak:${leak}`);
    }

    // ── phase 1: GROUND (web_search) ─────────────────────────────────────────
    const ground = broken
      ? { searchCount: 0, pagesRead: 0, pagesStale: 0, pagesRefused: 0, notes: '', evidence: '' }
      : await cachedGround({
          tag: `activity-ground:${fixture.id}`,
          model,
          system: skill.instructions,
          userMessage: groundUserMessage(query),
          // The wire shape production sends for THIS subject — search-only for a general
          // question, search plus fetch when it names a place (see groundTools).
          tools: groundTools(fixture.subject),
          cachedOnly,
          getClient,
          cost,
        });
    // Mirrors the lane's grounding invariant, BOTH halves of it (lane.ts): zero results is
    // ungrounded, and so is a turn that searched and wrote nothing down. The second half
    // exists because the corpus produced it - 24 real results and an empty notes string,
    // which the composer can only answer by inventing or shrugging.
    if (ground.searchCount === 0) failures.push('not_grounded');
    else if (ground.notes.trim() === '') failures.push('not_grounded:empty_research');
    if (
      fixture.mustMentionInNotes &&
      !`${ground.notes}\n${ground.evidence}`.toLowerCase().includes(fixture.mustMentionInNotes)
    ) {
      failures.push(`off_subject:${fixture.mustMentionInNotes}`);
    }

    // ── phase 2: EXTRACT ─────────────────────────────────────────────────────
    const extracted = broken
      ? brokenPicks(fixture)
      : (
          await cachedToolCall({
            tag: `activity-picks:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: composeUserMessage(query, ground.notes),
            toolName: 'activity_picks',
            toolSchema: PICKS_TOOL_SCHEMA,
            toolDescription: 'Return the concrete programs the search actually found.',
            maxTokens: 1024,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    const { kept, dropped } = normalizePicks(extracted.picks);
    if (dropped.length > 0) failures.push(`half_find:${dropped.length}`);
    if (kept.length > MAX_PICKS) failures.push(`directory:${kept.length}`);
    const evidence = `${ground.notes}\n${ground.evidence}`;
    for (const pick of kept) {
      if (!tracesToEvidence(pick, evidence)) failures.push(`fabricated_pick:${pick.name}`);
    }
    // Both directions, and this is the whole calibration: a real question answered with
    // nothing is the incident, and a made-up question answered with something is worse.
    if (fixture.expectPicks === true && kept.length === 0) failures.push('no_picks');
    if (fixture.expectPicks === false && kept.length > 0) {
      // Only a failure if it is not traceable — a real "nearest thing" that IS on a page
      // is a legitimate answer. The trace check above already caught the invented ones,
      // so this counts only what got through it.
      const untraceable = kept.filter((pick) => !tracesToEvidence(pick, evidence));
      if (untraceable.length > 0) failures.push(`invented_picks:${untraceable.length}`);
    }

    // ── phase 3: THE FOLLOW-UP TEXT ──────────────────────────────────────────
    // COMPOSED, GATED, RECOMPOSED - the runtime's loop (followup-note.ts), not one shot.
    // What reaches a parent is never the first draft: a body that breaks a gate is refused
    // with the reason and rewritten, up to MAX_FOLLOWUP_ATTEMPTS, and only then deferred.
    // Scoring the first draft failed this corpus on a 340-character Oakville answer that
    // production would have shortened and sent, which is measuring something the product
    // does not do. First-draft quality still has to be VISIBLE or it could rot behind the
    // repair loop, so it is counted and printed - just not fatal.
    // The two facts about the SWEEP that the composer is now told, computed the way the
    // sweep computes them (deliver.ts). `pageEvidence` is what licenses a negative claim
    // about a page; `watch` is whether a continuation row exists to be spoken for.
    const pageEvidence = readPageVerdict(ground);
    const watch = watchWarranted(kept);
    let body = '';
    let violations = [];
    let firstDraftViolations = [];
    for (let attempt = 1; attempt <= MAX_FOLLOWUP_ATTEMPTS; attempt += 1) {
      const composed = broken
        ? brokenFollowUp(watch)
        : (
            await cachedToolCall({
              tag: `activity-followup:${fixture.id}:${attempt}`,
              model,
              system: skill.instructions,
              userMessage: retryFollowUpMessage(
                followUpUserMessage(fixture.subject, kept, pageEvidence, watch),
                violations,
              ),
              toolName: 'followup_text',
              toolSchema: FOLLOWUP_TOOL_SCHEMA,
              toolDescription: 'Return the one message to send this parent.',
              maxTokens: 400,
              cachedOnly,
              getClient,
              cost,
            })
          ).value;

      body = flatten(composed.message);
      violations = followUpViolations(body, kept, smsSegments, pageEvidence, watch);
      if (attempt === 1) firstDraftViolations = violations;
      if (violations.length === 0 || broken) break;
    }
    failures.push(...violations.map((v) => v.tag));

    // ── the judge (skipped in broken mode; the deterministic layer proves calibration) ──
    if (!broken) {
      const verdict = await judge(fixture.id, {
        watch,
        pageEvidence,
        subject: fixture.subject,
        town: fixture.town,
        stage: fixture.stage,
        picks: kept,
        message: body,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} of ${verdict.samples.join('/')} (${verdict.reason})`);
      }
    }

    results.push({
      fixture,
      picks: kept,
      body,
      searchCount: ground.searchCount,
      pagesRead: ground.pagesRead,
      pagesRefused: ground.pagesRefused,
      failures,
      firstDraftViolations,
    });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- answers ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${tag}  ${r.fixture.id.padEnd(38)} picks=${r.picks.length} searches=${r.searchCount} pages=${r.pagesRead}read/${r.pagesRefused}refused`,
    );
    console.log(`      "${r.body.slice(0, 100)}"`);
    for (const pick of r.picks) {
      console.log(`      · ${pick.name} | ${pick.when ?? 'when not posted'} | ${pick.sourceName}`);
    }
    for (const f of r.failures) console.log(`      ! ${f}`);
  }

  const count = (name) => results.filter((r) => r.failures.some((f) => f.startsWith(name))).length;
  console.log('\n--- corpus metrics (0 required each) ---');
  console.log(`identity leaks:          ${count('identity_leak')}  (a name or an exact age never crosses the border)`);
  console.log(
    `ungrounded:              ${count('not_grounded')}  (no results, or results the turn never wrote up)`,
  );
  console.log(`fabricated picks:        ${count('fabricated_pick')}  (a venue the search never returned)`);
  console.log(`invented picks:          ${count('invented_picks')}`);
  console.log(`found nothing:           ${count('no_picks')}  (a real question answered with a shrug)`);
  console.log(`half finds:              ${count('half_find')}`);
  console.log(`directory:               ${count('directory')}`);
  console.log(`off subject:             ${count('off_subject')}  (a named place must be what was researched)`);
  console.log(`claims verification:     ${count('claims_verification')}  (web-read is not confirmed)`);
  console.log(`buried top pick:         ${count('buried_top_pick')}  (the trim cuts from the end)`);
  console.log(`links a URL:             ${count('links_a_url')}`);
  console.log(
    `asks for permission:     ${count('asks_for_permission')}  (an offer is a proposal, and this lane can write no row)`,
  );
  console.log(
    `unearned absence:        ${count('unearned_absence')}  (a page's silence claimed without a page that is silent)`,
  );
  console.log(
    `unbacked promise:        ${count('unbacked_promise')}  (a coming-back sentence with no continuation row)`,
  );
  console.log(
    `silent watch:            ${count('silent_watch')}  (a row was written and the text never said so)`,
  );
  // NOT a gate, and deliberately: a fetch refused (`url_not_allowed`) is a real and common
  // shape on these very venues, production logs it and answers from the snippets anyway.
  // What it must never become is invisible - a corpus where the venue fixtures stop
  // opening pages is a corpus scoring the lane this arc replaced.
  const venueFixtures = results.filter((r) => namesAVenue(r.fixture.subject));
  console.log(
    `\npages opened (venue fixtures): ${venueFixtures.filter((r) => r.pagesRead > 0).length}/${venueFixtures.length}  (NOT a gate - a refused fetch is a real shape. Watch it: zero means the fetch budget is buying nothing)`,
  );
  console.log(
    `unsendable:              ${results.filter((r) => r.failures.some((f) => ['empty', 'over_segment_cap'].includes(f))).length}`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${count('judge')}`);
  const repaired = results.filter((r) => r.firstDraftViolations.length > 0);
  console.log(
    `\nfirst draft needed repair: ${repaired.length}/${results.length}  (NOT a gate - production recomposes. Watch it: a corpus that only passes on the third attempt has rotted)`,
  );
  for (const r of repaired) {
    console.log(`      ~ ${r.fixture.id}: ${r.firstDraftViolations.map((v) => v.tag).join(', ')}`);
  }

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);

  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one gate): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('activity-finder eval harness error:', err);
  process.exit(2);
});
