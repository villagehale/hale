// The alert aside · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/alert-aside.md) run through the
// REAL forced-tool-JSON request shape, with the REAL guard imported rather than
// replicated. `apps/web/lib/channel/voice-pass/guard.ts` is alias-free by construction and
// has a test that keeps it so, precisely so this runner can `tsImport` it — including
// `asideUserMessage`, which is the user turn production sends. So the refusals graded here
// ARE the refusals that ship, and an edit to either re-keys the cache and shows up as a
// miss rather than as silence. `plainText` is the one thing still replicated (below): it
// sits behind the web app's `~/` alias, which the tsx loader here cannot resolve.
//
// WHY THE VARIATION GATE IS THE PRIMARY GATE HERE, and the judge is not. The failure mode
// of a voice pass is invisible to a per-sample judge and has already been measured in this
// repo: packages/agent/src/model.ts records short-copy lanes collapsing to one template on
// a re-tier — "two different reminders produced a byte-identical line and all four intro
// asks opened the same way" — and every one of those messages would have scored well on
// "does this read like a friend". A constant with an API bill is exactly what this feature
// would become, and only a CORPUS measurement can see it.
//
// WHY THE BAR IS LOWER HERE THAN FOR THE FOLLOW-UP ASK. That stage has no fallback: a
// refused body is a message the family never gets, so its unsendable bar is zero. A
// refused aside costs a parent nothing — the reviewed deterministic sentence goes out
// exactly as it does today — so the sendable bar is 80%. The two things that are NOT
// percentages are the door (any clause that invites a reply is a hard zero, always) and
// the restraint arm (the fixtures whose right answer is no clause at all).
//
// WHY THE CORPUS IS LABELLED THREE WAYS AND NOT TWO. On most alerts BOTH answers are
// right: the skill's own first rule is that saying nothing is usually correct, so a label
// that read "a clause is expected here" on every non-restraint fixture would be asserting
// the opposite of the product. `quiet` is the restraint arm and must be silent. `clause`
// is the liveness arm — the shapes the skill itself names as worth a remark, a pile-up
// and a same-day turnaround — and must speak, or the feature is dead and nothing here
// would say so. `either` is the honest majority: graded only if a clause was written.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-alert-aside-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-alert-aside-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-alert-aside-eval.mjs --cached-only                    # CI: replay only

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { skillSampleSentences, variationGate, variationLines } from './lib/variation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'alert-aside.md');
const GUARD_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'voice-pass',
  'guard.ts',
);
const FIXTURES_PATH = join(HERE, 'alert-aside-fixtures.json');

/**
 * THREE, not the helper's seven. The whole output here is a 3-10 word clause, so at the
 * default every skill example and every output sentence is below the line and the parrot
 * half of the gate never runs — a skill that shows one good clause would have it copied
 * straight through, green. See evals/lib/variation.test.mjs, which pins both halves.
 */
const MIN_SAMPLE_WORDS = 3;

/**
 * TWO words at each end, not the helper's three. A clause is three to ten words, so a
 * three-word edge is most of it and two independently-written clauses would score as
 * distinct on their fourth word. Two is where the template lives.
 */
const EDGE_WORDS = 2;

/**
 * Two rates, one number, and they measure different halves of the same 80%.
 *
 * SENDABLE: of the clauses the model actually wrote, this many must survive the guard.
 * Not 100%, and the asymmetry is the point — a refused aside is today's message, which
 * ships either way.
 *
 * SPOKE: of the `clause` fixtures, this many must produce a sendable clause. Without it a
 * model that answered "" to everything would pass every other gate in this file.
 */
const MIN_RATE = 0.8;

/** The three refusals that close the DOOR. Reported on their own line rather than folded
 * into a refusal count, because they are the only failure here with a consequence beyond a
 * bad sentence: an offer-shaped clause invites a bare YES, and a bare YES on these lanes is
 * bound by the open-question resolver to whatever question is newest or sole — which can be
 * an unrelated `email_alert_add` whose handler writes family_events with no reviewer. */
const DOOR_REFUSALS = ['solicits_reply', 'addresses_the_parent', 'echoes_a_reply_word'];

const ASIDE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    clause: { type: 'string' },
    place: { type: 'string', enum: ['before', 'after'] },
  },
  required: ['clause', 'place'],
};

const MAX_TOKENS = 128;

// ── plainText, replicated from apps/web/lib/channel/coach/reply.ts (behind `~/`) ─────
// The COMPOSER runs this before the guard sees the clause: `*` and `_` are GSM-7 basic
// characters, so a markdown-wrapped clause would otherwise ship its asterisks to a phone.

const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[•·]/g, ''],
];

function plainText(text) {
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

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE short clause Hale added to a text message it was',
  'already going to send a parent. The message itself was written by code from a connected',
  'mailbox or calendar and is going out word for word either way; the clause is bolted on',
  'in front of it or after it, and the only other thing Hale can do is add nothing.',
  'You are given the message, the clause, where it was placed, and watchFor - fixture-',
  'specific notes on what right and wrong look like here. Score 1-5.',
  'A 5 is one true, plain thing a friend who knew the schedule would have said out loud,',
  'in the third person, that the message does not already say. Short. No greeting, no hype.',
  'WHAT THE COUNT MEANS, because a clause that gets this wrong is FALSE however well it',
  'reads: priorAlertsToHousehold24h is how many texts of this same kind Hale has already',
  'sent this HOUSEHOLD in the trailing 24 hours. It is NOT per sender - two different',
  'schools is two - so "their third" or "the third from them" is false. It is NOT a',
  'calendar day - the window rolls across midnight - so "today" or "this morning" is false.',
  'It is NOT about the reader - the household is counted, not the parent holding the phone',
  '- so "you have had three" is false. THE CORRECT FORM IS "Third one in the last day." -',
  '"one" means one of these texts, "in the last day" is the rolling window stated plainly,',
  'and the ordinal is a word because a digit is refused. That sentence is the register the',
  'product decided on; do not mark it down for phrasing, only for being false or unearned.',
  'TWO THINGS THAT ARE BY DESIGN AND ARE NOT FAULTS. (1) When the message ends in an ask,',
  'the clause is placed BEFORE it - that is the only legal placement there, and it is what',
  'keeps the ask last. Never mark a clause down merely for sitting in front of an ask.',
  '(2) The clause is a remark, not information: a plain third-person observation about the',
  'occasion is the whole point. Judge whether it is TRUE and worth the room, not whether it',
  'is actionable.',
  'A LOW score is any of: a clause that leaves the parent something to reply to, or offers',
  'to do anything, or uses the literal words "you" or "your" (a third-person observation is',
  'not an address, however sympathetic); anything false about the count above;',
  'claiming a matched occasion means there is nothing left to do; restating what the',
  'message already says; any invented specific - a name, a time, a day, a place, a number;',
  'padding, hype, exclamation, a second sentence; or a remark so generic it would fit any',
  'alert at all, which is the tic this feature has to avoid.',
  'Reply with ONLY the score tool.',
].join(' ');

/**
 * The calibration stand-in — deterministic, not a poisoned skill.
 *
 * It trips every layer on purpose: a door (`say`, `say the word`), an affirmative echo
 * (`YES`), the second person (`your`), a digit (`2nite`), a character outside GSM-7 basic
 * (the emoji), the character ceiling, and a question the message never asked. It is
 * emitted for EVERY fixture, so the restraint arm collapses with it.
 *
 * WHAT IT CANNOT REACH, stated rather than pretended: the corpus gate measures only the
 * clauses that would SHIP, and nothing here ships, so the pairwise and parrot checks are
 * not exercised by this arm. They are pinned by evals/lib/variation.test.mjs, which is
 * where MIN_SAMPLE_WORDS earns its place — a stand-in that trips the guard can never also
 * be a corpus the guard let through.
 */
const BROKEN_ASIDE =
  "Just say YES and I'll put it on your week 2nite \u{1F642} Third one in the last day.";

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const guard = await tsImport(GUARD_SRC, import.meta.url);
  const { fixtures } = JSON.parse(await readFile(FIXTURES_PATH, 'utf8'));
  const skill = await agent.loadSkill(SKILL_PATH);
  const samples = await skillSampleSentences(SKILL_PATH, { minSampleWords: MIN_SAMPLE_WORDS });
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'alert-aside', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });

  console.log(
    `alert-aside eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(
    `corpus: ${fixtures.length} alerts (${fixtures.filter((f) => !f.expectClause).length} whose right answer is no clause)\n`,
  );

  const results = [];
  for (const fixture of fixtures) {
    const context = {
      core: fixture.core,
      lane: fixture.lane,
      priorAlertsToHousehold24h: fixture.priorAlertsToHousehold24h,
      matchedAKnownOccasion: fixture.matchedAKnownOccasion,
      ctaSuffix: fixture.ctaSuffix,
    };
    const userMessage = guard.asideUserMessage(context);

    let raw;
    if (broken) {
      raw = { clause: BROKEN_ASIDE, place: 'after' };
    } else {
      const { value } = await cachedToolCall({
        tag: `alert-aside:${fixture.id}`,
        model,
        system: skill.instructions,
        userMessage,
        toolName: 'aside',
        toolSchema: ASIDE_TOOL_SCHEMA,
        toolDescription: 'Return the one short clause, or an empty clause to add nothing.',
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      raw = value;
    }

    const clause = plainText(typeof raw?.clause === 'string' ? raw.clause : '');
    const place = raw?.place === 'after' ? 'after' : 'before';
    const refusals = guard.asideViolations({ clause, place }, context);
    const failures = refusals.map((refusal) => `refused:${refusal}`);

    // The restraint arm. A clause where the right answer was silence is a failure even
    // when it is a perfectly good clause — this is the gate that stops the aside becoming
    // a tic, and it is the founder's bar: decline at least a quarter of the time.
    if (fixture.expect === 'quiet' && clause !== '') failures.push('should_have_said_nothing');
    const shipped = clause !== '' && refusals.length === 0;

    // An aside the guard already threw away is never judged: it is not what a parent
    // reads, and paying a judge to score a discarded clause measures nothing. Nor is an
    // empty one, which has no words to score.
    const verdict = shipped
      ? await judge(fixture.id, {
          message: fixture.core,
          clause,
          place,
          lane: fixture.lane,
          priorAlertsToHousehold24h: fixture.priorAlertsToHousehold24h,
          matchedAKnownOccasion: fixture.matchedAKnownOccasion,
          watchFor: fixture.watchFor,
        })
      : null;
    if (verdict !== null && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, clause, place, refusals, failures, shipped, verdict });
  }

  // ── variation, over the clauses that would SHIP ───────────────────────────
  // An empty clause is not copy anybody reads and a refused one never left the building,
  // so neither may stand in for variety.
  const shippedResults = results.filter((r) => r.shipped);
  // AND NEITHER MAY A SECOND COPY OF ONE FACT. `countsTowardVariance: false` is
  // run-intro-voice-eval's own device, for its own reason: a fixture whose wording is
  // decided by the FIXTURE rather than by the model measures the fixture. Four alerts
  // carrying priorAlertsToHousehold24h: 2 license exactly one true sentence between them
  // - every sender-anchored, day-anchored and reader-anchored ordinal is false - so a
  // corpus that scored all four would be measuring an arithmetic fact, not a composer.
  // One of them counts and the rest are excluded by name in the fixture file.
  //
  // THAT EXCLUSION IS ITSELF A FINDING, and it is printed below rather than buried: a
  // clause with one true form is a CONSTANT, and a constant does not need a model.
  const measured = shippedResults.filter((r) => r.fixture.countsTowardVariance !== false);
  // HALF THE CORPUS SHOWING A DIFFERENT OPENING, which is intake-voice's bar and its
  // reasoning: a low bar a skill offering a real range clears easily and a skill offering
  // one shape cannot. Computed rather than a literal, because how many clauses ship is the
  // model's decision here (the restraint arm is a feature) and a fixed floor would get
  // easier every time the model declined one more.
  //
  // BOTH ENDS AT THE SAME FLOOR. Gating one end only ever moves the template to the other:
  // fixing intake's 8/8 identical opener produced 6/8 identical endings on the next draw.
  //
  // NEVER BELOW TWO, however few clauses ship. The restraint arm is a feature, so this
  // corpus is SMALL by design - and half of two is one, which is a floor a pair of
  // byte-identical clauses would clear. Two is the smallest floor that can still fail.
  const edgeFloor = Math.max(2, Math.ceil(measured.length / 2));
  const variation = variationGate({
    items: measured.map((r) => ({ id: r.fixture.id, text: r.clause })),
    samples,
    minSampleWords: MIN_SAMPLE_WORDS,
    minDistinctOpeners: edgeFloor,
    minDistinctClosers: edgeFloor,
    edgeWords: EDGE_WORDS,
  });
  for (const result of measured) {
    result.failures.push(...(variation.failuresById[result.fixture.id] ?? []));
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log('--- asides ---');
  for (const r of results) {
    const label = r.failures.length === 0 ? (r.clause === '' ? 'QUIET' : 'PASS ') : 'FAIL ';
    console.log(
      `${label} ${r.fixture.id.padEnd(32)} [${r.place}] "${r.clause}"`,
    );
    for (const f of r.failures) console.log(`        · ${f}`);
  }

  const doors = results.filter((r) => r.refusals.some((x) => DOOR_REFUSALS.includes(x)));
  const otherRefused = results.filter(
    (r) => r.refusals.length > 0 && !r.refusals.some((x) => DOOR_REFUSALS.includes(x)),
  );
  const written = results.filter((r) => r.clause !== '');
  const mustSpeak = results.filter((r) => r.fixture.expect === 'clause');
  const spoke = mustSpeak.filter((r) => r.shipped);
  const mustBeQuiet = results.filter((r) => r.fixture.expect === 'quiet');
  const chirped = mustBeQuiet.filter((r) => r.clause !== '');
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const sendableRate = written.length === 0 ? 0 : shippedResults.length / written.length;
  const spokeRate = mustSpeak.length === 0 ? 1 : spoke.length / mustSpeak.length;
  const quiet = results.length - written.length;

  console.log('\n--- corpus metrics ---');
  console.log(
    `DOORS:                   ${doors.length}  (0 required, always - an offer-shaped clause is a bare YES against someone else's question)`,
  );
  console.log(
    `chirped where quiet:     ${chirped.length}/${mustBeQuiet.length}  (0 required - the aside becoming a tic is how this feature fails slowly)`,
  );
  console.log(
    `spoke where a hook is:   ${spoke.length}/${mustSpeak.length} = ${(spokeRate * 100).toFixed(0)}%  (>= ${MIN_RATE * 100}% required - a composer that answers "" to everything passes every other gate here)`,
  );
  console.log(
    `declined altogether:     ${quiet}/${results.length}  (the founder's restraint bar is at least ${mustBeQuiet.length})`,
  );
  console.log(
    `other refusals:          ${otherRefused.length}  (each one costs today's message nothing - it ships as written)`,
  );
  console.log(
    `sendable once written:   ${shippedResults.length}/${written.length} = ${(sendableRate * 100).toFixed(0)}%  (>= ${MIN_RATE * 100}% required)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `held out of variance:    ${shippedResults.length - measured.length}  (a second copy of one true ordinal - see the runner; a clause with one true form is a constant, and a constant does not need a model)`,
  );
  for (const line of variationLines(variation)) console.log(line);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    doors.length === 0 &&
    chirped.length === 0 &&
    judgeFails.length === 0 &&
    spokeRate >= MIN_RATE &&
    sendableRate >= MIN_RATE &&
    variation.passed;

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
  console.error('alert-aside eval harness error:', err);
  process.exit(2);
});
