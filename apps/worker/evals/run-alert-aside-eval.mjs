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
// THE COUNT, AND WHY IT IS NARROW RATHER THAN BANNED. The count the outbound gate hands
// over (priorAlertsToHousehold24h) is the one specific fact this stage has that the message
// does not, and it is what founder decision 1(a) bought with a required field on the shared
// outbound-gate type. An earlier cut of this corpus banned it outright after live records
// showed the composer writing it on EVERY count fixture and inventing false forms when
// handed the rule - "Third cancellation in the last day." twice byte-identically, "in as
// many days" for a window that rolls. Banning it is option (b), which the brief says should
// be cut rather than shipped, so the fix is the precondition the brief already states
// instead: the number supports an ordinal ONLY at two, where this message genuinely makes
// three, which is at most one send in three. That is ONE fixture in this corpus
// (email-cancellation-two-senders), so a byte-identical pair of count clauses cannot arise
// here at all, and the false forms are graded rather than assumed - the two-senders fixture
// is labelled `clause` precisely so the count path has liveness, and the judge scores a
// sender-anchored, day-anchored or reader-anchored ordinal a 1, as it does any ordinal
// written below two.
//
// AND THE PRIMARY GATE'S SAMPLE IS SMALL, WHICH IS THE PRODUCT RATHER THAN AN OVERSIGHT.
// The pairwise and edge checks measure only the clauses that SHIP, and this composer's
// first instruction is that saying nothing is usually right, so a green run leaves two or
// three bodies to compare. Two things follow, and a reader should hold both: a template
// across two bodies is still a template and this gate still sees it, but an absence of one
// across two bodies is weak evidence. The corpus cannot be widened by labelling more
// fixtures `clause` - that would be asking the model to chirp, which is the failure the
// restraint arm exists to catch. The real widening is more ALERT SHAPES that genuinely
// license a remark, and there are two of them today.
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
 * SPOKE: EVERY SHAPE THE SKILL NAMES AS WORTH A REMARK MUST REACH A PARENT AT LEAST ONCE.
 * Without a liveness arm a composer that answered "" to everything would pass every other
 * gate in this file, so the arm is not optional. What changed is what it counts.
 *
 * It was a RATE over the `clause` fixtures at 80%, which over three fixtures means all
 * three, every draw. Nine live records say that is a coin flip rather than a bar: this
 * composer's first instruction is that saying nothing is usually right, and it declines a
 * licensed same-day move in about half of them. Worse, the cache is content-addressed on
 * the request, so the same skill always replays the same draw - the rate never re-draws in
 * CI, and the only way to "re-roll" a red one is to perturb the skill, which is fitting the
 * instructions to a coin. A gate whose remedy is a cosmetic edit teaches nobody anything.
 *
 * So the arm counts SHAPES instead, which is what the sentence above always meant: each
 * distinct `shape` among the `clause` fixtures must produce at least one sendable clause.
 * Two fixtures both declining is a real signal about that shape; one of them declining is
 * the product working as documented. This is stricter than the rate in the direction that
 * matters - a shape with several fixtures can no longer be carried by the other shape's
 * fixtures - and it cannot be satisfied by silence anywhere.
 */

/**
 * AND THE REFUSALS ARE COUNTED, NOT RATED. An earlier cut gated the guard's refusals as a
 * share of the clauses the model wrote, which sounds like the same thing and is not: the
 * denominator is the model's own decision, so as the skill got more restrained the same
 * ONE refused clause went from a fifth of the corpus to a third of it and failed a suite
 * that had improved. A refusal costs a parent nothing here - the reviewed sentence ships
 * either way - so what is worth gating is the absolute number, and one in twenty-four is
 * the model reaching on a shape the skill told it to leave alone, which is the guard doing
 * its job rather than a defect. A corpus full of them would be a different report.
 */
const MAX_REFUSED_CLAUSES = 1;

/**
 * SIX OF TWENTY-FOUR — the founder's restraint bar, as a property of the CORPUS rather
 * than of one run. `chirped === 0` below grades the fixtures labelled `quiet`, and against
 * a corpus that labelled none it would be zero out of zero, green, forever. The first
 * spelling of this pin read a field no fixture carries (`expectClause`), counted all 24
 * and could not fail; this one counts the label the corpus actually has.
 */
const MIN_QUIET_FIXTURES = 6;

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
  'THE COUNT HAS EXACTLY ONE TRUE SHAPE, and every other shape of it is a 1 however well it',
  'reads. priorAlertsToHousehold24h is how many texts of this same kind Hale already sent',
  'this HOUSEHOLD in the trailing 24 hours, not counting this one. At TWO - this message',
  'makes three - an ordinal over HALE\'S OWN TEXTS OF THIS KIND ACROSS THE LAST DAY is true,',
  'and it is the one specific thing this stage holds that the message does not carry.',
  'A BARE ORDINAL WITH A PLACEHOLDER NOUN IS THAT WORDING - third one, in or over the last',
  'day - and it scores on its merits like any other remark. The window may be named in any',
  'plain words that mean the last day; the preposition is not the point and neither is the',
  'exact phrasing. What makes an ordinal false is NAMING something the count did not count:',
  'the club, the class, or the occasion ("third cancellation from them" - a run that never',
  'happened, because the number counts every sender). Also false, also a 1: a CALENDAR day',
  'word for a window that rolls across midnight ("today", "this morning", "in as many',
  'days"), a digit ("in the last 24 hours" - refused by the guard in any case), and any',
  'count aimed at the reader ("you have had three"). BELOW TWO there is no ordinal',
  'to write at all, so a count clause on a message whose count is one or absent is a 1 as',
  'well. Live records earned every line of this: each false form above was written by a',
  'composer that had just been told not to.',
  'TWO THINGS THAT ARE BY DESIGN AND ARE NOT FAULTS. (1) When the message ends in an ask,',
  'the clause is placed BEFORE it - that is the only legal placement there, and it is what',
  'keeps the ask last. Never mark a clause down merely for sitting in front of an ask.',
  '(2) The clause is a remark, not information: a plain third-person observation about the',
  'occasion is the whole point. Judge whether it is TRUE and worth the room, not whether it',
  'is actionable. (3) When a time MOVES INSIDE ONE DAY, naming which part of that day now',
  'changes hands - the evening it opens, the morning it gives back - is a shape the skill',
  'names as worth saying, and it is not a fault for being short or for being a sentence that',
  'would also fit another same-day move. Mark it down only if it is false, or if it is the',
  'measurement the message already states said again in fewer words. Do NOT ask for the',
  'SIZE of the shift: the message carries both instants, so an arithmetic magnitude is a',
  'restatement, and a digit is refused outright before you ever see the clause.',
  'AND THE SAME-DAY SHAPE HAS A PRECONDITION. It is licensed only when the old time and the',
  'new time fall on the SAME DATE. When a thing MOVED TO A DIFFERENT DATE, the message',
  'already spells out both dates, so naming either of them - the day it left, the day it',
  'landed - is that restatement in fewer words and is a 1, however neatly it reads.',
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

/**
 * THE PARROT GATE CANNOT SEE A QUOTED RUN THAT WRAPS, and nothing else would ever say so.
 *
 * `skillSampleSentences` harvests double-quoted runs with `/"([^"\n]+)"/g`, which cannot
 * cross a newline. When this skill's examples were wrapped by the 90-column house margin,
 * three of the four false-ordinal traps were invisible to the gate, the ready-to-ship
 * ordinal it exists to catch was invisible too, and the fragment BETWEEN two half-quotes
 * was harvested as a sample instead. The suite was green by a formatting accident.
 *
 * So the runner refuses to grade a skill whose quoted examples it cannot read. Keep each
 * quoted example on one line, however long the line gets.
 */
async function assertQuotedExamplesAreHarvestable() {
  const source = (await readFile(SKILL_PATH, 'utf8')).replace(/```[\s\S]*?```/g, '\n');
  const wrapped = source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => (line.match(/"/g) ?? []).length % 2 === 1);
  if (wrapped.length === 0) return;
  console.error(
    'alert-aside eval: these lines of the skill open a double quote they do not close, so',
  );
  console.error('the parrot half of the variation gate cannot see the example on them:');
  for (const { line, number } of wrapped) console.error(`  ${number}: ${line}`);
  process.exit(2);
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  await assertQuotedExamplesAreHarvestable();

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
  const mustBeQuietCount = fixtures.filter((f) => f.expect === 'quiet').length;
  console.log(
    `corpus: ${fixtures.length} alerts (${mustBeQuietCount} whose right answer is no clause)\n`,
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
  // AND EVERY ONE OF THEM IS MEASURED. An earlier cut of this runner excluded three of its
  // four count fixtures by a `countsTowardVariance: false` flag in the corpus, added after
  // this gate caught the model writing one sentence for all four. A gate whose inputs may
  // be dropped when it fails is not a gate. (intro-voice's use of that flag is a different
  // thing: there the FIXTURE hands the model the sentence to react to, so the wording was
  // never the model's to choose.)
  //
  // THE CORPUS WAS THE DEFECT, NOT THE GATE. "Two prior alerts of this kind in the last 24
  // hours" has exactly one answer, so asking it on four fixtures measured one arithmetic
  // fact four times and asked a composer for four different ways to say a thing with one
  // true form. Two live records showed both halves of that: with a ready-made ordinal in
  // the skill the model returned it verbatim four times, and with the ordinal described
  // rather than quoted it wrote two byte-identical clauses and hung a third on the
  // sender's event. The corpus now asks the count ONCE - on the two-senders fixture, the
  // one where getting it wrong is a judge zero no regex could see - and spends the other
  // three on a count of one, where the right answer is silence.
  const measured = shippedResults;
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
  const shapes = [...new Set(mustSpeak.map((r) => r.fixture.shape))].sort();
  const silentShapes = shapes.filter(
    (shape) => !spoke.some((r) => r.fixture.shape === shape),
  );
  const quiet = results.length - written.length;

  console.log('\n--- corpus metrics ---');
  console.log(
    `DOORS:                   ${doors.length}  (0 required, always - an offer-shaped clause is a bare YES against someone else's question)`,
  );
  console.log(
    `chirped where quiet:     ${chirped.length}/${mustBeQuiet.length}  (0 required - the aside becoming a tic is how this feature fails slowly)`,
  );
  console.log(
    `shapes that spoke:       ${shapes.length - silentShapes.length}/${shapes.length} (${shapes.join(', ')})  (every one required${silentShapes.length === 0 ? '' : ` - SILENT: ${silentShapes.join(', ')}`} - a composer that answers "" to everything passes every other gate here)`,
  );
  console.log(
    `clauses on those:        ${spoke.length}/${mustSpeak.length}  (reported, not gated - one fixture of a shape declining is the product working as documented)`,
  );
  console.log(
    `declined altogether:     ${quiet}/${results.length}  (the founder's restraint bar is at least ${mustBeQuiet.length})`,
  );
  console.log(
    `restraint fixtures:      ${mustBeQuiet.length}/${results.length}  (>= ${MIN_QUIET_FIXTURES} required - the bar is a property of the corpus, not of one run)`,
  );
  console.log(
    `other refusals:          ${otherRefused.length}  (each one costs today's message nothing - it ships as written)`,
  );
  console.log(
    `refused by the guard:    ${written.length - shippedResults.length}  (<= ${MAX_REFUSED_CLAUSES} required; sendable ${shippedResults.length}/${written.length} = ${(sendableRate * 100).toFixed(0)}%, reported not gated)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  for (const line of variationLines(variation)) console.log(line);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    doors.length === 0 &&
    mustBeQuiet.length >= MIN_QUIET_FIXTURES &&
    chirped.length === 0 &&
    judgeFails.length === 0 &&
    silentShapes.length === 0 &&
    written.length - shippedResults.length <= MAX_REFUSED_CLAUSES &&
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
