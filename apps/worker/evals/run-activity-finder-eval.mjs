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
//   · half find - a pick missing a name, an age fit, a when or a source. The lane drops
//     these; seeing them here means the skill is producing them.
//   · directory - more than three picks.
//   · off subject - a named-place fixture whose research never mentions the place.
//   · claims verification - the follow-up text says "confirmed"/"verified" about something
//     read off a page. Clause-scoped, so an honest "I'll confirm before you book" passes.
//   · buried top pick - the best find is not named inside the first SMS segment, so the
//     first trim removes it (the RC-I1 shape).
//   · links a URL / unsendable - Hale never texts a link, and the follow-up is two segments.
// Everything else is the judge's bar (JUDGE_MIN): are these real, local, age-fitting things
// a parent could turn up to, and is the message honest about where the facts came from?

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ACTIVITY_FIXTURES } from './activity-finder-fixtures.mjs';
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
const ACTIVITY_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-finder.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

// Mirrors the lane's own constants (activity/lane.ts, activity/followup-note.ts).
const MAX_PICKS = 3;
const MAX_SEARCHES = 3;
const MAX_FOLLOWUP_SEGMENTS = 2;
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
        required: ['name', 'age_fit', 'when', 'source_name'],
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

function followUpUserMessage(subject, picks) {
  return JSON.stringify({
    mode: 'followup_text',
    subject,
    picks: picks.map((pick) => ({
      name: pick.name,
      age_fit: pick.ageFit,
      when: pick.when,
      price: pick.price,
      source_name: pick.sourceName,
      source: 'web',
    })),
  });
}

function countSearchResults(content) {
  let total = 0;
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    total += block.content.length;
  }
  return total;
}

function researchText(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
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
 * VERBATIM. That field is a composite - "Kinderfun (Toddler Program), Halton Hills
 * Gymnastics Centre" - assembled for a structured payload, and no SMS repeats it whole:
 * the message that led with "Halton Hills Gymnastics Centre has a Kinderfun toddler
 * program running Sept 10" was failed by the verbatim check for naming the pick BETTER
 * than the field did. So the test is over the name's PARTS, and only the parts that
 * identify something - a head that says "a toddler program" has named nothing.
 */
function distinctiveNameParts(name) {
  return [name, ...name.split(/[,;(]|\s[-|]\s/)]
    .map((part) => part.replace(/[)]/g, '').trim().toLowerCase())
    .filter((part) => part.length >= 5)
    .filter((part) =>
      part
        .split(/[^a-z0-9]+/)
        .some((word) => word.length >= 4 && !GENERIC_WORDS.has(word)),
    );
}

function topPickLeads(body, picks) {
  const top = picks[0];
  if (!top) return true;
  const head = body.slice(0, FIRST_SEGMENT_CHARS).toLowerCase();
  return distinctiveNameParts(top.name).some((part) => head.includes(part));
}

const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

/** The lane's whole-find rule (lane.ts `toPicks`), so a half-find is SEEN here rather than
 * silently dropped the way production drops it. */
function normalizePicks(raw) {
  const kept = [];
  const dropped = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const pick = {
      name: flatten(item?.name),
      ageFit: flatten(item?.age_fit),
      when: flatten(item?.when),
      price: flatten(item?.price) || null,
      sourceName: flatten(item?.source_name),
    };
    if (pick.name && pick.ageFit && pick.when && pick.sourceName) kept.push(pick);
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
  'place with a day or a session start - plausibly fitting the stage, and at most three of',
  'them. The message leads with the best one by name, says whose information it is ("their',
  'site says", "listed as"), and offers to confirm rather than claiming to have confirmed.',
  'It is one or two short sentences of plain text with no link and exactly one question.',
  'A LOW score is any of: a venue that looks invented or generic ("your local community',
  'centre"); a pick with no day, time or session start; a directory-style list; a pick for a',
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
 * `when` - the fabrication failure. Without the split, `no_picks` and `half_find` would sit
 * at zero in broken mode: gates nobody has ever seen fire.
 */
function brokenPicks(fixture) {
  if (fixture.expectPicks === true) return { picks: [] };
  return {
    picks: [
      { name: 'Sunnyside Tumbling Academy', age_fit: 'toddlers', when: 'ongoing', source_name: 'Sunnyside' },
      { name: 'Riverbend Play Barn', age_fit: '1-4', when: 'daily', price: '$99', source_name: 'Riverbend' },
      { name: 'Maple Grove Movement', age_fit: '2-5', when: 'weekly', source_name: 'Maple Grove' },
      { name: 'Hilltop Kinder Gym', age_fit: '1-3', when: 'mornings', source_name: 'Hilltop' },
      { name: 'Brookvale Tots', age_fit: '1-3', source_name: 'Brookvale' },
    ],
  };
}
const BROKEN_FOLLOWUP = {
  message:
    'I had a look around your area this afternoon and went through a whole pile of listings for you, and there is quite a lot going on for the little ones at the moment across all of the nearby towns, more than I could reasonably fit into one message here. I confirmed Sunnyside Tumbling Academy runs daily - see sunnysidetumbling.ca for the rest of them.',
};

async function cachedGround(opts) {
  const { tag, model, system, userMessage, cachedOnly, getClient, cost } = opts;
  const canonical = JSON.stringify({ model, system, userMessage, tool: 'web_search_20250305' });
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
    tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
    messages: [{ role: 'user', content: userMessage }],
  });
  noteUsage(cost, model, response.usage);
  const value = {
    searchCount: countSearchResults(response.content),
    notes: researchText(response.content),
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
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'activity-finder', cachedOnly, getClient, cost);

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
      ? { searchCount: 0, notes: '', evidence: '' }
      : await cachedGround({
          tag: `activity-ground:${fixture.id}`,
          model,
          system: skill.instructions,
          userMessage: groundUserMessage(query),
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
    const followup = broken
      ? BROKEN_FOLLOWUP
      : (
          await cachedToolCall({
            tag: `activity-followup:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: followUpUserMessage(fixture.subject, kept),
            toolName: 'followup_text',
            toolSchema: FOLLOWUP_TOOL_SCHEMA,
            toolDescription: 'Return the one message to send this parent.',
            maxTokens: 400,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    const body = flatten(followup.message);
    if (body === '') failures.push('empty');
    if (smsSegments(body) > MAX_FOLLOWUP_SEGMENTS) failures.push('over_segment_cap');
    if (LINK_SHAPE.test(body)) failures.push('links_a_url');
    if (claimsVerification(body)) failures.push('claims_verification');
    if (!topPickLeads(body, kept)) failures.push('buried_top_pick');

    // ── the judge (skipped in broken mode; the deterministic layer proves calibration) ──
    if (!broken) {
      const verdict = await judge(fixture.id, {
        subject: fixture.subject,
        town: fixture.town,
        stage: fixture.stage,
        picks: kept,
        message: body,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, picks: kept, body, searchCount: ground.searchCount, failures });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- answers ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(38)} picks=${r.picks.length} searches=${r.searchCount}`);
    console.log(`      "${r.body.slice(0, 100)}"`);
    for (const pick of r.picks) console.log(`      · ${pick.name} | ${pick.when} | ${pick.sourceName}`);
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
    `unsendable:              ${results.filter((r) => r.failures.some((f) => ['empty', 'over_segment_cap'].includes(f))).length}`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${count('judge')}`);

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
