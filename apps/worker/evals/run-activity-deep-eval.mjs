// The DEEP PASS eval — the follow-up sweep's page-opening leg (hard rule #8: no LLM
// mocking).
//
// The sweep's whole justification is that it opens the operator's own pages instead of
// reading search snippets. Two model legs carry that: a RESEARCH turn holding `web_search`
// and `web_fetch`, and an EXTRACT turn that turns what it read into structured slots. The
// slots then go to the follow-up composer and out to a parent's phone as facts they will
// act on. Nothing between here and that phone scores them, so it is scored here.
//
// WHAT THIS GATES, and each one is a real way a parent gets hurt:
//
//   · fabricated figure - a price or a date in a slot that appears nowhere in what the turn
//     read. A parent turns up with the wrong money, or on the wrong week.
//   · fabricated page - a URL in `pages_read` the turn never opened. `pages_read` is what
//     licenses Hale to say "their page doesn't list it"; a hallucinated entry rebuilds the
//     benchmark defect one layer down (rule #11).
//   · claimed read on refusal - every fetch came back refused and the model reported pages
//     read anyway. The sharper half of the same thing.
//   · read but reported nothing / stretched to fit - the two directions of `expectSlots`.
//   · uncited slot - a row with no absolute source URL. Production DROPS these silently
//     (deep.ts `toDeepSlots`), so without this gate a skill quietly producing them looks
//     like a skill finding nothing.
//   · dropped registration - the notes carry a registration date and no slot does, or a
//     slot carries it and the TEXT does not. That fact is the entire return on opening the
//     page, and it has been dropped in production once already: the composer's projection
//     did not list the field, so the deep pass learned it and the parent never heard it.
//   · the follow-up gates, mirrored from followup-note.ts - links, segment cap, claiming
//     verification, and burying the top pick past the first segment.
//
// SHAPE. It replicates the runtime's request shapes (deep.ts, followup-note.ts) rather than
// importing them - those modules sit behind the web app's `~/` alias, which the tsx loader
// here cannot resolve. Both SKILL bodies and the model routing are imported LIVE from
// packages/agent, so an edit to either skill re-keys the cache and shows up as a miss.
//
// THE RESEARCH TURN IS RUN LIVE FOR ONE FIXTURE and supplied as `notes` for the rest. That
// is deliberate: a live search+fetch turn measured 50-130 seconds and its refusals vary by
// the day, so a corpus built entirely out of them is a corpus nobody can re-record. The
// adversarial fixtures need a FIXED page to be adversarial about, and the one live fixture
// keeps the whole chain honest against the real web.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-activity-deep-eval.mjs           # live, then caches
//   node --env-file=../../.env evals/run-activity-deep-eval.mjs --broken  # calibration: must FAIL
//   node evals/run-activity-deep-eval.mjs --cached-only                   # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { DEEP_FIXTURES } from './activity-deep-fixtures.mjs';
import {
  JUDGE_MIN,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const DEEP_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-deep.md');
const FINDER_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-finder.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

// Mirrors the runtime's constants (activity/deep.ts, activity/followup-note.ts,
// activity/share-page.ts).
const MAX_DEEP_SEARCHES = 4;
const MAX_DEEP_FETCHES = 4;
const RESEARCH_MAX_TOKENS = 8192;
// 16384, matching the runtime (activity/deep.ts). It was 4096 here long after production
// raised it, so this eval was scoring a request production does not make — and on a real
// municipal page's worth of notes that budget TRUNCATES, which the harness then cached as
// an empty extraction.
const EXTRACT_MAX_TOKENS = 16384;
const SLOTS_IN_TEXT = 2;
const MAX_FOLLOWUP_SEGMENTS = 2;
const MAX_FOLLOWUP_ATTEMPTS = 3;
const FIRST_SEGMENT_CHARS = 153;

// ── the runtime's request shapes, replicated ─────────────────────────────────

const DEEP_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    pages_read: { type: 'array', items: { type: 'string' } },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          price: { type: 'string' },
          registration: { type: 'string' },
          source_name: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['name', 'age_fit', 'source_name', 'source_url'],
      },
    },
  },
  required: ['slots'],
};

const FOLLOWUP_TOOL_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

const RESEARCH_TOOLS = [
  { name: 'web_search', type: 'web_search_20250305', max_uses: MAX_DEEP_SEARCHES },
  { name: 'web_fetch', type: 'web_fetch_20260209', max_uses: MAX_DEEP_FETCHES },
];

function deepUserMessage(q) {
  return JSON.stringify({
    mode: 'deep_research',
    subject: q.subject,
    ...(q.town ? { town: q.town } : {}),
    ...(q.stage ? { stage: q.stage } : {}),
    ...(q.window ? { window: q.window } : {}),
  });
}

function deepExtractMessage(q, notes) {
  return JSON.stringify({ ...JSON.parse(deepUserMessage(q)), research_notes: notes });
}

/**
 * Mirrors the runtime's PARSE BOUNDARY (activity/deep.ts `unwrapStringifiedEnvelope` +
 * `arrayFromMaybeString`) — and it has to, because a request shape replica that stops at
 * the request is only half a replica.
 *
 * Sonnet 5 fills a container it is not given a grammar for with a stringified blob: `slots`
 * comes back as the whole tool payload as a JSON STRING, `{"pages_read":[...],"slots":[...]}`
 * stuffed into one of its own fields. Production collapses both encodings where the value
 * is read and carries on. This eval did not, so on 2026-08-24 it scored a live extraction
 * that had found four real programmes as "a real page answered with a shrug" — a FAILURE
 * PRODUCTION DOES NOT HAVE, cached and reported as a skill regression.
 */
function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function arrayFromMaybeString(value) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : value;
}

function unwrapStringifiedEnvelope(value) {
  if (typeof value !== 'object' || value === null) return value;
  for (const field of Object.values(value)) {
    const inner = parseJson(field);
    if (inner !== null && !Array.isArray(inner) && typeof inner === 'object' && 'slots' in inner) {
      return { ...value, ...inner };
    }
  }
  return value;
}

/** The extract payload, read the way the runtime reads it. */
function readExtract(raw) {
  const envelope = unwrapStringifiedEnvelope(raw) ?? {};
  return {
    pages_read: arrayFromMaybeString(envelope.pages_read),
    slots: arrayFromMaybeString(envelope.slots),
  };
}

/** Mirrors `followUpUserMessage` (followup-note.ts) — INCLUDING `registration`, whose
 * absence from that projection is the defect this eval's last gate exists for. */
function followUpUserMessage(subject, slots, pagesOpened, watch) {
  return JSON.stringify({
    mode: 'followup_text',
    subject,
    pages_opened: pagesOpened,
    watch,
    picks: slots.map((slot) => ({
      name: slot.name,
      age_fit: slot.ageFit,
      when: slot.when,
      price: slot.price,
      registration: slot.registration,
      source_name: slot.sourceName,
      source: 'web',
    })),
  });
}

/** How recent a fetch has to be to count as a page read TODAY - mirrors
 * `FETCH_FRESHNESS_MS` (activity/evidence.ts). */
const FETCH_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/** Mirrors `readEvidence` (activity/evidence.ts): the counts kept apart, and the text of
 * the pages that opened riding into the notes.
 *
 * `pagesStale` is not decoration here. The provider answers a `web_fetch` out of its own
 * cache — live probe 2026-08-22, three of one turn's four reads carried a `retrieved_at`
 * five hours old — and a cached read licenses no claim about what a page carries now. The
 * eval mirrors the count so the corpus cannot quietly score a turn on pages nobody
 * opened today. `now` is read at call time, the way the runtime reads its clock. */
function readEvidence(content, now = Date.now()) {
  let searchResults = 0;
  let pagesRead = 0;
  let pagesStale = 0;
  let pagesRefused = 0;
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
      const text = result.content?.source?.data ?? '';
      if (text !== '') notes.push(`--- page: ${result.url ?? ''} ---\n${text}`);
    }
  }
  return { searchResults, pagesRead, pagesStale, pagesRefused, notes: notes.join('\n').trim() };
}

/** Mirrors `plainText` (coach/reply.ts), which sits behind `~/`. */
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

/** Mirrors `toDeepSlots` (deep.ts): the whole-row rule, and the citation that makes a row a
 * row. Production drops these silently, so what is DROPPED is counted here. */
function normalizeSlots(raw) {
  const kept = [];
  const dropped = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const slot = {
      name: flatten(item?.name),
      ageFit: flatten(item?.age_fit),
      when: flatten(item?.when) || null,
      price: flatten(item?.price) || null,
      registration: flatten(item?.registration) || null,
      sourceName: flatten(item?.source_name),
      sourceUrl: /^https?:\/\/\S+$/i.test(String(item?.source_url ?? '').trim())
        ? String(item.source_url).trim()
        : null,
    };
    if (slot.name && slot.ageFit && slot.sourceName && slot.sourceUrl) kept.push(slot);
    else dropped.push(slot);
  }
  return { kept, dropped };
}

// ── the honesty gates, mirrored from followup-note.ts ────────────────────────

const CLAUSE_BOUNDARY = /[.!?;:,\n]|\s-\s/;
const VERIFICATION_CLAIM = /\b(?:confirmed|verified|double-?checked|vetted)\b/i;
const FUTURE_OR_NEGATED =
  /\bi'?ll\b|\bi will\b|\bwe'?ll\b|\bwe will\b|\bgoing to\b|\bcan\b|\bto (?:confirm|verify|double-?check)\b|\bbefore\b|\bonce\b|\bafter\b|\byet\b|\bnot\b|\bn'?t\b|\bunconfirmed\b/i;

function claimsVerification(body) {
  return body
    .split(CLAUSE_BOUNDARY)
    .some((clause) => VERIFICATION_CLAIM.test(clause) && !FUTURE_OR_NEGATED.test(clause));
}

const GENERIC_WORDS = new Set([
  'gymnastics', 'program', 'programs', 'programme', 'lessons', 'class', 'classes', 'centre',
  'center', 'community', 'parent', 'toddler', 'preschool', 'swimming', 'library',
  'recreation', 'session', 'fall', 'winter', 'spring', 'summer',
]);

function identifyingWords(name) {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !GENERIC_WORDS.has(word));
}

function topPickLeads(body, slots) {
  const top = slots[0];
  if (!top) return true;
  const head = body.slice(0, FIRST_SEGMENT_CHARS).toLowerCase();
  const words = identifyingWords(top.name);
  if (words.length === 0) return head.includes(top.name.toLowerCase());
  return words.filter((word) => head.includes(word)).length >= Math.min(2, words.length);
}

const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

/** Mirrors `claimsNotPosted`, `statesTheReturn` and `watchWarranted` — see the same three
 * in run-activity-finder-eval.mjs and in the runtime (followup-note.ts, sweep.ts). */
const UNPUBLISHED_WORD = /\b(?:posted|listed|published|announced|out|up)\b/i;
const ABSENCE = /\b(?:not|no|nothing|none|yet to)\b|n'?t\b/i;
const STATES_RETURN =
  /\b(?:i'?ll|i will|i'?m going to)\b[^.!?\n]*\b(?:watch|watching|check|checking|look|looking|text|message|come back|circle back|let you know|go back|keep an eye|keep on)\b/i;

function claimsNotPosted(body) {
  return body
    .split(CLAUSE_BOUNDARY)
    .some((clause) => ABSENCE.test(clause) && UNPUBLISHED_WORD.test(clause));
}

function watchWarranted(slots) {
  const top = slots[0];
  if (!top) return true;
  return !carriesFact(top.when) || !carriesFact(top.price);
}

/** Mirrors `carriesFact` (sweep.ts). */
function carriesFact(field) {
  return Boolean(field) && String(field).trim() !== '' && !claimsNotPosted(String(field));
}

function followUpViolations(body, slots, smsSegments, pagesOpened, watch) {
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
  if (!topPickLeads(body, slots)) {
    violations.push({
      tag: 'buried_top_pick',
      reason: `The best find (${slots[0]?.name}) is not named in the first ${FIRST_SEGMENT_CHARS} characters, so it is the first thing a trim would cut. Lead with it.`,
    });
  }
  if (body.includes('?')) {
    violations.push({
      tag: 'asks_for_permission',
      reason:
        'The message asks the parent a question. This message keeps a promise; it never asks for permission. Say what you found and what you are already doing about it, and end on a statement.',
    });
  }
  if (!pagesOpened && claimsNotPosted(body)) {
    violations.push({
      tag: 'unread_not_unposted',
      reason:
        'The message says something is not posted or not up. No page was opened today, so that is a claim about a page nobody read. Say you could not get into their page today instead.',
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

function retryFollowUpMessage(base, violations) {
  if (violations.length === 0) return base;
  return JSON.stringify({
    ...JSON.parse(base),
    rejectedLastAttempt: violations.map((v) => v.reason),
  });
}

// ── the deterministic traceability checks ────────────────────────────────────

/**
 * Every multi-digit figure in a slot's facts, so it can be looked for in the notes.
 *
 * Two or more digits, because single digits are everywhere in a clock time and prove
 * nothing either way. A year, a fee, a session date and a class time all land here, and
 * every one of them is a thing a parent acts on.
 */
function figures(slot) {
  return `${slot.when ?? ''} ${slot.price ?? ''} ${slot.registration ?? ''}`.match(/\d{2,}/g) ?? [];
}

function untraceableFigures(slot, notes) {
  const digitsInNotes = notes.match(/\d{2,}/g) ?? [];
  const seen = new Set(digitsInNotes);
  return figures(slot).filter((figure) => !seen.has(figure));
}

/** A URL the model says it opened has to appear in what the turn actually read. */
function untraceablePages(pagesRead, notes) {
  return pagesRead.filter((url) => !notes.includes(String(url).trim()));
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE deep research pass Hale ran to keep a promise it',
  'made a parent about what their young child could do locally. Hale searched, opened the',
  "operator's own pages, extracted structured slots, and wrote one SMS from them. It never",
  'saw the child - only a de-identified subject, the town and a coarse stage. You are given',
  'the subject, the town, the stage, what the pages said (notes), the slots it extracted,',
  'the message it wrote, and watchFor (fixture-specific notes). Score 1-5.',
  'A 5: every slot is a real thing on the page, with the day, the session dates and the fee',
  'exactly as printed, each cited to the page it was read off, and where the page gave a',
  'REGISTRATION date the slot carries it and so does the message. The message leads with the',
  'best slot by name, attributes the facts ("their site says"), carries the registration',
  'window, attributes rather than claiming to have confirmed, and is one or two short',
  'plain-ASCII sentences with no link and NO QUESTION AT ALL.',
  'THIS MESSAGE MAKES NO OFFER, and a missing closing question is CORRECT rather than a',
  'gap. Every question Hale asks is a proposal and every proposal is a row somebody wrote',
  'down; nothing on this path can write one, so a "want me to..." here is a yes with',
  'nowhere to land (2026-08-22: it landed on an unrelated approvals queue). Do not mark a',
  'message down for ending on a statement.',
  'You are given `watch`. When it is TRUE, Hale has ALREADY written a continuation promise',
  'to go back and look again, and the message must say so in the first person ("I\'ll keep',
  'watching and text you when they post"): that is a commitment that exists, not an',
  'unverified claim, and scoring it as one is wrong. When it is FALSE no such row exists',
  'and any coming-back sentence is a promise nothing is behind - THAT is the low score.',
  'You are given `pagesOpened`. FALSE means Hale read SEARCH SNIPPETS rather than opening',
  "a page. Attribution is still correct and still expected - a snippet off the venue's own",
  'site IS "their site says", and marking that down is wrong. What FALSE forbids is a',
  'NEGATIVE claim about what a page carries ("the fall times are not posted yet"), because',
  'nobody looked; the honest form of that sentence is "I could not get into their page',
  'today". Score the negative claim low, never the attribution.',
  'Two segments is a hard ceiling. Dropping a second or third find WHOLE to fit the best',
  'one complete is correct and is not withholding; withholding is going quiet about a find',
  'when there was room, or hedging instead of naming anything at all.',
  'A LOW score is any of: a price or a date that is not on the page it is attributed to;',
  'a figure borrowed from a different program or a room rental on the same site; a slot for',
  'an age band the page does not serve; reporting a schedule as "not posted" when the notes',
  'show the page was never opened; an empty result when the page plainly lists something',
  'fitting; a message that drops the registration date the slots carried; a message that',
  'presents page-read facts as verified.',
  'An EMPTY slot list is CORRECT when the page was read and genuinely has nothing for this',
  'age. Score that a 5 when the message says so plainly and specifically.',
  'When `message` is NULL no text was composed for this pass - production discards a',
  'research turn that opened no page before it reaches the composer - so score the slots',
  'alone and ignore everything above about the message.',
  'Reply with ONLY the score tool.',
].join(' ');

/**
 * The deterministic broken stand-in — one failure per gate, so `--broken` proves each one
 * bites. Fully offline.
 *
 * PER FIXTURE, and each fixture declares which failure it calibrates (`brokenMode`),
 * because the calibrations pull in opposite directions and one payload cannot do all of
 * them. A shrug proves `no_slots`; a confident extraction proves fabrication; and the two
 * registration gates need OPPOSITE payloads — one where the extract never carried the date,
 * and one where it did and the text threw it away. Deriving the mode from `expectSlots`
 * (which is what this started as) left four gates sitting at zero in broken mode: gates
 * nobody had ever seen fire.
 */
function brokenExtract(fixture) {
  const registration = fixture.registrationMustSay?.[0] ?? null;
  switch (fixture.brokenMode) {
    // A real page, answered with nothing. The incident failure.
    case 'shrug':
      return { pages_read: [], slots: [] };

    // The page printed the date in plain sight and the extract walked past it — and did not
    // report opening the page it read the rest off either.
    case 'drop_registration':
      return {
        pages_read: [],
        slots: [
          {
            name: 'Tiny Gym, Cartwheels Gym Centre',
            age_fit: 'walking to 3.5 years, with a parent',
            when: 'Sundays 9:30 - 10:15 a.m., September 14 to October 26',
            price: '$124 per child',
            source_name: 'Cartwheels Gym Centre',
            source_url: 'https://www.cartwheelsgymcentre.com/programs.php',
          },
        ],
      };

    // The extract carried it and the composer's projection dropped it — production's own
    // defect, reproduced as a calibration.
    case 'text_drops_registration':
      return {
        pages_read: ['https://www.oakville.ca/recreation/swimming/learn-to-swim.html'],
        slots: [
          {
            name: 'Learn to Swim Preschool A, Town of Oakville',
            age_fit: '3 - 5 years',
            when: 'Saturdays 9:00 - 9:30 a.m., September 12 to November 28',
            registration: `Fall registration opens ${registration} at 7 a.m.`,
            source_name: 'Town of Oakville',
            source_url: 'https://www.oakville.ca/recreation/swimming/learn-to-swim.html',
          },
        ],
      };

    // Confident, cited to a page it never opened, wearing the rentals page's money, with a
    // year on no page and a second row carrying no citation at all.
    default:
      return {
        pages_read: ['https://www.invented-source.example/schedule'],
        slots: [
          {
            name: 'Tiny Tumblers, Riverbend Community Centre',
            age_fit: '12 months to 4 years',
            when: 'Tuesdays 9:30 - 11:00 a.m., September 8 to December 11',
            price: '$185 per term',
            source_name: 'Riverbend Community Centre',
            source_url: 'https://www.invented-source.example/schedule',
          },
          {
            name: 'Weekend Play Barn',
            age_fit: 'ages 1-4',
            when: 'Saturdays, fall 2031 session',
            price: '$99',
            source_name: 'Riverbend Community Centre',
            source_url: 'not-a-url',
          },
        ],
      };
  }
}

/**
 * The broken follow-up TEXT, split on `watch` — for the reason `brokenExtract` is split
 * per fixture: the two ledger gates want opposite sentences, and one payload cannot fail
 * both. The single constant this replaces failed on a URL, an "I confirmed" and three
 * segments, and left three gates at zero across the whole broken corpus — a QUESTION, a
 * claim that a page nobody opened carries nothing, and a coming-back sentence with no row
 * behind it. A gate nobody has seen fire is a gate nobody knows works.
 *
 * The unposted claim rides the `watch` branch because the one fixture whose research
 * opened NO page (`cartwheels-live-research`, notes null) is also the one the shrug hands
 * no slots — so `watch` is true there and the claim is unlicensed, which is the pair the
 * gate exists to catch.
 */
function brokenFollowUp(watch) {
  return {
    message: watch
      ? 'I went and had a proper look through everything on their website this afternoon and there is quite a lot going on for the little ones at the moment across the nearby towns. Their fall times are not posted yet. I confirmed Tiny Tumblers runs Tuesdays and Thursdays - see riverbendcommunity.ca for the rest. Want me to check back once they are up?'
      : 'I went and had a proper look through everything on their website this afternoon and there is quite a lot going on for the little ones at the moment across the nearby towns. I confirmed Tiny Tumblers runs Tuesdays and Thursdays - see riverbendcommunity.ca for the rest, and I will keep looking and text you when the fall schedule lands.',
  };
}

async function cachedResearch(opts) {
  const { tag, model, system, userMessage, cachedOnly, getClient, cost } = opts;
  const canonical = JSON.stringify({ model, system, userMessage, tools: RESEARCH_TOOLS });
  const key = cacheKey(tag, canonical);
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (cachedOnly) {
    console.error(
      `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
    );
    process.exit(1);
  }
  // STREAMED, because the runtime streams and a non-streamed turn of this shape does not
  // come back: live probe 2026-08-22, `messages.create` on this request timed out at
  // 50s and died at 120s on a 600s ceiling, while the stream returned in 88.8s. An eval
  // that posts the un-streamed request is scoring a call production cannot make (deep.ts).
  const response = await getClient()
    .messages.stream({
      model,
      max_tokens: RESEARCH_MAX_TOKENS,
      system,
      tools: RESEARCH_TOOLS,
      messages: [{ role: 'user', content: userMessage }],
    })
    .finalMessage();
  noteUsage(cost, model, response.usage);
  const value = readEvidence(response.content);
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
  const deepSkill = await agent.loadSkill(DEEP_SKILL);
  const finderSkill = await agent.loadSkill(FINDER_SKILL);
  const model = agent.pickModel(deepSkill.meta.task);
  const composerModel = agent.pickModel(finderSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'activity-deep', cachedOnly, getClient, cost);

  console.log(
    `activity-deep eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | deep=${model} composer=${composerModel} judge=${judgeModel}`,
  );
  console.log(`corpus: ${DEEP_FIXTURES.length} passes\n`);

  const results = [];
  for (const fixture of DEEP_FIXTURES) {
    const failures = [];
    const query = {
      subject: fixture.subject,
      town: fixture.town,
      stage: fixture.stage,
      window: fixture.window,
    };

    // ── the border: what actually leaves ─────────────────────────────────────
    // De-identification is deterministic in the runtime, so what is checked is the payload
    // the sweep's stored subject produces. A hit means the promise would have been refused
    // before it was ever stored (rule #1).
    const sent = (broken ? fixture.rawSubject : deepUserMessage(query)).toLowerCase();
    for (const leak of fixture.dropsFromQuery) {
      if (sent.includes(leak.toLowerCase())) failures.push(`identity_leak:${leak}`);
    }

    // ── leg 1: RESEARCH ──────────────────────────────────────────────────────
    // A fixture carrying `notes` IS the research turn, frozen — that is what lets the
    // adversarial cases be adversarial about a specific page.
    const evidence =
      fixture.notes !== null
        ? {
            searchResults: 1,
            pagesRead: fixture.expectPagesRead === false ? 0 : 1,
            pagesStale: 0,
            pagesRefused: fixture.expectPagesRead === false ? 2 : 0,
            notes: fixture.notes,
          }
        : broken
          ? { searchResults: 0, pagesRead: 0, pagesStale: 0, pagesRefused: 0, notes: '' }
          : await cachedResearch({
              tag: `activity-deep-research:${fixture.id}`,
              model,
              system: deepSkill.instructions,
              userMessage: deepUserMessage(query),
              cachedOnly,
              getClient,
              cost,
            });

    // The runtime's grounding invariant (deep.ts): a turn that did not search, or searched
    // and wrote nothing down, is an outage rather than news — nothing is said and nothing
    // closes.
    if (evidence.searchResults === 0) failures.push('not_grounded');
    else if (evidence.notes.trim() === '') failures.push('not_grounded:empty_research');

    // ── leg 2: EXTRACT ───────────────────────────────────────────────────────
    const extracted = broken
      ? brokenExtract(fixture)
      : (
          await cachedToolCall({
            tag: `activity-deep-extract:${fixture.id}`,
            model,
            system: deepSkill.instructions,
            userMessage: deepExtractMessage(query, evidence.notes),
            toolName: 'activity_deep',
            toolSchema: DEEP_TOOL_SCHEMA,
            toolDescription: 'Return the concrete slots the pages actually printed.',
            maxTokens: EXTRACT_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    const payload = readExtract(extracted);
    const { kept, dropped } = normalizeSlots(payload.slots);
    const pagesRead = Array.isArray(payload.pages_read) ? payload.pages_read : [];
    if (dropped.length > 0) failures.push(`uncited_or_half_slot:${dropped.length}`);

    // A CLAIM ABOUT A PAGE REQUIRES A PAGE — both directions.
    const invented = untraceablePages(pagesRead, evidence.notes);
    if (invented.length > 0) failures.push(`fabricated_page:${invented.length}`);
    if (fixture.expectPagesRead === false && pagesRead.length > 0) {
      failures.push(`claimed_read_on_refusal:${pagesRead.length}`);
    }
    // NOT gated in the positive direction, and the first live run is why. The extract leg
    // is BLIND — it sees the notes, never the tool blocks — so `pages_read` is a claim it
    // makes, not a fact it holds, and three fixtures correctly left it empty. Production
    // never reads it either: `deepResult.status` comes from `readEvidence` counting the
    // research turn's own `web_fetch_tool_result` blocks (deep.ts), which is the only
    // reading of it that cannot be talked into a wrong answer. So what is gated is the
    // direction that can hurt somebody - CLAIMING a page nobody opened.

    for (const slot of kept) {
      const loose = untraceableFigures(slot, evidence.notes);
      if (loose.length > 0) failures.push(`fabricated_figure:${slot.name}:${loose.join(',')}`);
      for (const forbidden of fixture.slotsMustNotContain ?? []) {
        const row = `${slot.when ?? ''} ${slot.price ?? ''} ${slot.registration ?? ''}`;
        if (row.includes(forbidden)) failures.push(`borrowed_figure:${slot.name}:${forbidden}`);
      }
    }

    // Both directions, and this is the calibration: a real page answered with nothing is
    // the shrug this arc exists to end, and a page with nothing on it answered with
    // something is a parent driving somewhere for a class that does not take their child.
    if (fixture.expectSlots === true && kept.length === 0) failures.push('no_slots');
    if (fixture.expectSlots === false && kept.length > 0) failures.push(`invented_slots:${kept.length}`);

    // THE FACT THE PAGE-OPEN WAS FOR.
    const saysRegistration = (text) =>
      (fixture.registrationMustSay ?? []).some((phrase) => text.includes(phrase));
    if (fixture.registrationMustSay && kept.length > 0) {
      if (!kept.some((slot) => saysRegistration(slot.registration ?? ''))) {
        failures.push(`dropped_registration:${fixture.registrationMustSay[0]}`);
      }
    }

    // ── leg 3: THE FOLLOW-UP TEXT, from the deep slots ───────────────────────
    // The text carries the best two; the rest go on a share page (share-page.ts). Composed,
    // GATED and RECOMPOSED, the way production does it — scoring a first draft measures
    // something the product does not do.
    // PRODUCTION'S OWN CONTROL FLOW. A research turn that opened no page comes back
    // `unread`, and the sweep DISCARDS its slots and falls back to the shallow search
    // (sweep.ts) - so those slots never reach the composer, and composing from them here
    // would be scoring a message the product does not send.
    const composesText = fixture.composesText !== false;
    const inText = composesText ? kept.slice(0, SLOTS_IN_TEXT) : [];
    // The two sweep facts the composer is told (sweep.ts). A page read out of the
    // provider's cache is not a page read today, so it buys no licence to say what a page
    // does not carry.
    const pagesOpened = evidence.pagesRead - evidence.pagesStale > 0;
    const watch = watchWarranted(inText);
    let body = '';
    let violations = [];
    let firstDraftViolations = [];
    for (let attempt = 1; composesText && attempt <= MAX_FOLLOWUP_ATTEMPTS; attempt += 1) {
      const composed = broken
        ? brokenFollowUp(watch)
        : (
            await cachedToolCall({
              tag: `activity-deep-followup:${fixture.id}:${attempt}`,
              model: composerModel,
              system: finderSkill.instructions,
              userMessage: retryFollowUpMessage(
                followUpUserMessage(fixture.subject, inText, pagesOpened, watch),
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
      violations = followUpViolations(body, inText, smsSegments, pagesOpened, watch);
      if (attempt === 1) firstDraftViolations = violations;
      if (violations.length === 0 || broken) break;
    }
    failures.push(...violations.map((v) => v.tag));

    // The last hop, and the one that was broken in production: the slot carried the
    // registration date and the composer's projection did not list the field, so the fact
    // died between the page and the phone.
    if (fixture.registrationMustSay && inText.some((slot) => saysRegistration(slot.registration ?? ''))) {
      if (!saysRegistration(body)) {
        failures.push(`registration_not_in_text:${fixture.registrationMustSay[0]}`);
      }
    }

    if (!broken) {
      const verdict = await judge(fixture.id, {
        watch,
        pagesOpened,
        subject: fixture.subject,
        town: fixture.town,
        stage: fixture.stage,
        notes: evidence.notes.slice(0, 6000),
        slots: kept,
        message: composesText ? body : null,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({
      fixture,
      slots: kept,
      pagesRead,
      pagesRefused: evidence.pagesRefused,
      body,
      failures,
      firstDraftViolations,
    });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- passes ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${tag}  ${r.fixture.id.padEnd(32)} slots=${r.slots.length} pages_read=${r.pagesRead.length} refused=${r.pagesRefused}`,
    );
    console.log(`      "${r.body.slice(0, 110)}"`);
    for (const slot of r.slots) {
      console.log(
        `      · ${slot.name} | ${slot.when ?? 'when not posted'} | ${slot.price ?? 'price not posted'} | ${slot.registration ?? 'registration not posted'}`,
      );
    }
    for (const f of r.failures) console.log(`      ! ${f}`);
  }

  const count = (name) => results.filter((r) => r.failures.some((f) => f.startsWith(name))).length;
  console.log('\n--- corpus metrics (0 required each) ---');
  console.log(`identity leaks:            ${count('identity_leak')}`);
  console.log(`ungrounded:                ${count('not_grounded')}`);
  console.log(`fabricated figures:        ${count('fabricated_figure')}  (a price or a date on no page)`);
  console.log(`borrowed figures:          ${count('borrowed_figure')}  (a real number off the wrong page)`);
  console.log(`fabricated pages:          ${count('fabricated_page')}  (a URL the turn never opened)`);
  console.log(`claimed read on refusal:   ${count('claimed_read_on_refusal')}  (the benchmark defect, one layer down)`);
  console.log(`uncited or half slots:     ${count('uncited_or_half_slot')}`);
  console.log(`found nothing:             ${count('no_slots')}  (a real page answered with a shrug)`);
  console.log(`invented slots:            ${count('invented_slots')}  (stretched to fit an age the page does not serve)`);
  console.log(`dropped registration:      ${count('dropped_registration')}  (the fact the page-open paid for)`);
  console.log(`registration not in text:  ${count('registration_not_in_text')}  (it reached the slot and died in the projection)`);
  console.log(`claims verification:       ${count('claims_verification')}`);
  console.log(
    `asks for permission:       ${count('asks_for_permission')}  (an offer is a proposal, and this lane can write no row)`,
  );
  console.log(
    `unread claimed unposted:   ${count('unread_not_unposted')}  (a claim about a page nobody opened today)`,
  );
  console.log(
    `unbacked promise:          ${count('unbacked_promise')}  (a coming-back sentence with no continuation row)`,
  );
  console.log(`silent watch:              ${count('silent_watch')}`);
  console.log(`buried top pick:           ${count('buried_top_pick')}`);
  console.log(`links a URL:               ${count('links_a_url')}`);
  console.log(
    `unsendable:                ${results.filter((r) => r.failures.some((f) => ['empty', 'over_segment_cap'].includes(f))).length}`,
  );
  console.log(`judge below ${JUDGE_MIN}:             ${count('judge')}`);
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
  console.error('activity-deep eval harness error:', err);
  process.exit(2);
});
