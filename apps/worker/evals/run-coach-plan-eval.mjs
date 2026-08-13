// Full coaching plans · the plan composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/coach-plan.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/plan/compose.ts builds —
// REPLICATED here rather than imported, for the reason the general-answer and lane evals
// replicate: that module sits behind the web app's `~/` alias, which the tsx loader here
// cannot resolve. Three things ARE imported live and must never be replicated:
//
//   · the SKILL body and the model routing (packages/agent), so a skill edit or a
//     model.ts re-tiering re-keys the cache and shows up as a miss rather than silence;
//   · `smsSegments` (apps/web/lib/channel/sms-segments.ts — a pure module, no aliases),
//     because the GSM-7 segment table is exactly what a replica gets subtly wrong;
//   · `frameworkGuidanceTool` (apps/web/lib/coach/framework-tool.ts — pure), because the
//     grounding the composer receives in production IS that tool's output, and a
//     hand-written fixture of it would let the plan cite content the real tool never
//     returns while this eval called it grounded.
//
// What is NOT tested here: the offer (coach-channel eval gates `offer_full_plan`), the
// handler's claim/send/close logic and the check-in copy (deterministic, covered in
// apps/web/lib/channel/plan/*.test.ts). This eval is only about the messages the model
// writes.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-coach-plan-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-coach-plan-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-coach-plan-eval.mjs --cached-only                    # CI: replay only
//   ... --show                                                          # print each plan
//
// THE HARD ZEROS:
//   · unsendable — a message that fails compose.ts's own sendablePlan() gates (wrong
//     count / over the 3-segment budget / non-GSM-7 / carries a link / names a dose)
//     is never sent AT ALL, because the composer is all-or-nothing. A plan that fails
//     one gate is a parent who said yes and got an apology.
//   · not sequenced — the whole point of the arc. A plan with no named stages is the
//     two-sentence answer again, at length.
//   · not concrete — a stage with a timeframe and no specific is a pamphlet with a
//     calendar on it.
//   · a siren — 811 or 911 on a guidance topic. The parent asked how to do a thing.
//   · markdown — a phone prints the asterisks.
// Everything else is the judge's bar (JUDGE_MIN per fixture): could a parent start
// tonight, is it aimed at THIS age and THIS question, is it warm rather than clinical,
// and is it grounded in the companion content rather than in invented claims.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { COACH_PLAN_FIXTURES } from './coach-plan-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  readModelIds,
  makeJudge,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'coach-plan.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');
const FRAMEWORK_TOOL_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'coach', 'framework-tool.ts');

// ── the composer's request shape, replicated from compose.ts ────────────────

/**
 * Mirrors `planJsonSchema` in compose.ts — three NAMED string fields, not an array.
 *
 * The first live recording of this eval is why. Asked for `messages: string[]`, the
 * model returned a JSON-encoded string of the list; the plan inside was good and
 * production's `z.array(z.string())` would have thrown it away as `model_failed`. A
 * field typed `string` has no second representation to choose between.
 */
const PLAN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    first: { type: 'string', description: 'The first plan message.' },
    second: { type: 'string', description: 'The second plan message.' },
    third: { type: 'string', description: 'The third plan message. Omit for a two-message plan.' },
  },
  required: ['first', 'second'],
};

/** Mirrors `planMessages` in compose.ts. */
function planMessages(value) {
  return [value.first, value.second, ...(value.third === undefined ? [] : [value.third])];
}

/** Mirrors `MAX_TOKENS` in compose.ts. */
const MAX_TOKENS = 2048;
/** Mirrors `MAX_PLAN_SEGMENTS` in compose.ts. */
const MAX_PLAN_SEGMENTS = 3;
/** Mirrors `MIN_PLAN_MESSAGES` / `MAX_PLAN_MESSAGES` in compose.ts. */
const MIN_PLAN_MESSAGES = 2;
const MAX_PLAN_MESSAGES = 3;
/** Mirrors `DOSING_SHAPE` in compose.ts. */
const DOSING_SHAPE = /\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|milligrams?|millilitres?|milliliters?)\b/i;
/** Mirrors `LINK_SHAPE` in compose.ts. */
const LINK_SHAPE = /https?:\/\/|www\./i;
/** Mirrors `reachesForTheHealthLine` in apps/web/lib/channel/off-domain/copy.ts. */
const HEALTH_LINE_SHAPE = /\b(?:811|911)\b/;

/** Mirrors `planUserMessage` in compose.ts — the exact payload the model is handed. */
function planUserMessage(grounding) {
  return JSON.stringify({
    topic: grounding.topic,
    question: grounding.question,
    child: grounding.child,
    guidance: grounding.guidance,
    facts: grounding.facts,
  });
}

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so
 * replicated). The composer flattens before it gates, so the gates below must see the
 * same body the parent would. */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[•·]/g, ''],
];

function flatten(text) {
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

// ── the gates that are this eval's own ──────────────────────────────────────

/**
 * A STAGE LABEL — the thing that makes a plan a plan rather than paragraphs.
 *
 * Matched on the RAW message rather than a token count, because "night" appearing three
 * times is not a sequence and "Nights 1-3" is. The alternation covers the three units
 * the skill names plus the open-ended closer it allows ("After that", "By week 4").
 */
const STAGE_LABEL =
  /\b(?:nights?|days?|weeks?)\s*\d|\bby\s+(?:night|day|week)\s*\d|\bafter\s+(?:that|the\s+first)\b|\bfrom\s+(?:night|day|week)\s*\d/i;

/** How many messages must carry a stage label for the plan to BE sequenced. Two, not
 * all: the closing message is allowed to be "after that / how to tell it is working",
 * which the alternation above accepts but need not. */
const MIN_LABELLED_STAGES = 2;

/**
 * Whether a message carries a CONCRETE specific — a quantity that is not part of its own
 * stage label.
 *
 * The label is stripped first, which is the whole trick: "Nights 1-3" contains digits and
 * says nothing about what to do, so a naive digit check would pass a plan made entirely
 * of headings. What survives is the minutes, the counts, the intervals.
 *
 * Spelled numbers count, because the closing stage legitimately reads "if she is still
 * waking hourly after two weeks" — a real specific written the way a person writes it,
 * and a gate that demanded a numeral there would be teaching the skill to write badly.
 */
const SPELLED_NUMBER =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half|twice|once|couple)\b/i;

function hasSpecific(body) {
  const withoutLabels = body.replace(/\b(?:nights?|days?|weeks?)\s*\d+(?:\s*-\s*\d+)?/gi, ' ');
  return /\d/.test(withoutLabels) || SPELLED_NUMBER.test(withoutLabels);
}

/** Someone to call. The skill allows the doctor clause ONCE, in the last message; a plan
 * that hedges to a clinician in every stage is a plan that does not believe itself. */
const CLINICIAN_SHAPE = /\b(?:doctor|paediatrician|pediatrician|gp|nurse|clinic)\b/i;

/** Markdown a phone prints literally. */
const MARKDOWN_SHAPE = /[*_#`]|^\s*[-•]/m;

/** The reasons compose.ts's sendablePlan() would refuse this plan, in its own
 * vocabulary — so a failure here names the branch that would have fired in production. */
function sendFailures(messages, smsSegments) {
  const failures = [];
  if (messages.length < MIN_PLAN_MESSAGES || messages.length > MAX_PLAN_MESSAGES) {
    failures.push(`wrong_shape:${messages.length} messages`);
  }
  for (const [index, body] of messages.entries()) {
    if (body === '') failures.push(`empty:${index}`);
    if (smsSegments(body) > MAX_PLAN_SEGMENTS) {
      failures.push(`over_budget:${index} (${smsSegments(body)} segments)`);
    }
    if (LINK_SHAPE.test(body)) failures.push(`carries_link:${index}`);
    if (DOSING_SHAPE.test(body)) failures.push(`carries_dosing:${index}`);
    if (HEALTH_LINE_SHAPE.test(body)) failures.push(`reaches_for_the_health_line:${index}`);
  }
  return failures;
}

/** The structural properties that make it a PLAN, checked across the whole sequence. */
function planFailures(messages, raw) {
  const failures = [];

  const labelled = messages.filter((body) => STAGE_LABEL.test(body)).length;
  if (labelled < MIN_LABELLED_STAGES) {
    failures.push(`not_sequenced (${labelled} of ${messages.length} messages carry a stage label)`);
  }
  // EVERY DOING STAGE, not merely one of them — the skill's own rule ("every stage
  // needs at least one number or one specific action"). `some` would pass a plan of
  // three pamphlet paragraphs with a single interval buried in the first.
  //
  // The LAST message is exempt, and that is the skill's structure rather than a
  // concession: it carries how to tell it is working and when to change course, which
  // is a description of signals, not an instruction with a count in it. Demanding a
  // number there would teach the skill to bolt one on.
  const doingStages = messages.slice(0, -1);
  const vague = doingStages
    .map((body, index) => (hasSpecific(body) ? null : index))
    .filter((index) => index !== null);
  if (vague.length > 0) {
    failures.push(`not_concrete (stages ${vague.join(', ')} carry no specific of their own)`);
  }
  const clinician = messages.filter((body) => CLINICIAN_SHAPE.test(body)).length;
  if (clinician > 1) {
    failures.push(`hedges_to_a_clinician (${clinician} messages)`);
  }
  // Checked on the RAW output, before flattening: the flattener would strip the very
  // asterisks this gate exists to catch, so a markdown check on the flattened body
  // could never fail.
  if (raw.some((body) => MARKDOWN_SHAPE.test(body))) failures.push('markdown');
  return failures;
}

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring a COMPLETE coaching plan Hale has just texted a',
  'parent as two or three messages. The parent asked a raising-kids question, got a',
  'two-sentence answer, was offered the whole plan, and said yes. This is what arrived.',
  'You are given the question, the child age in months, the companion guidance Hale was',
  'grounded in, the plan messages in order, and watchFor - fixture-specific notes on',
  'what right and wrong look like for THIS question. Score 1-5.',
  'A 5 is a plan a parent could start TONIGHT without deciding anything else first:',
  'every stage says what to DO in the imperative with the specifics that make it',
  'actionable (how long, how many, how often), says what to EXPECT so a hard second',
  'night reads as the plan working, and ends with how to tell it is working and when to',
  'change course. It is aimed at the age given and at the question actually asked. It',
  'sounds like a seasoned friend who has read the research - warm, plain, first person.',
  'A LOW score is any of: advice so general it would fit any age or any family',
  '("be consistent", "establish a routine") - this is the single most common failure and',
  'it should score 2 or below; a plan that answers a DIFFERENT question than the one',
  'asked; milestones or capabilities wrong for the age given; claims that contradict or',
  'wander far from the companion guidance provided; guaranteeing an outcome or a',
  'timeline; clinical or lecturing register; naming a medicine, a dose, or a diagnosis;',
  'a phone number or a service; scolding the parent or implying they caused it.',
  'Do NOT reward length. Three long messages of generalities score worse than two short',
  'concrete ones.',
  'Reply with ONLY the score tool.',
].join(' ');

/**
 * The broken stand-in: a plan of pure generalities, in the RIGHT SHAPE.
 *
 * Two messages rather than one, deliberately. A single message would trip `wrong_shape`
 * and every later gate would be reached but unproven — a calibration that fails for the
 * cheapest possible reason proves only that the cheapest gate works. This one is a
 * legally-shaped plan that is bad in every way that matters, so `--broken` exercises the
 * sequence gate, the concreteness gate (the first stage has no quantity at all), the
 * markdown gate, the dosing gate, the siren gate, the link gate, and both fixture lists.
 *
 * `wrong_shape` is left to the unit test instead (compose.test.ts, red-proven), which is
 * the right home for a refusal the composer makes before a message ever exists.
 */
const BROKEN_PLAN = [
  '**Sleep plan:** Every child is different, so be consistent and establish a routine. ' +
    'It depends on your child and on what works for your family.',
  'If it is not working, give 5ml and call 811. More at https://example.com.',
];

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const show = process.argv.includes('--show');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsSegments } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const { frameworkGuidanceTool } = await tsImport(FRAMEWORK_TOOL_SRC, import.meta.url);

  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  // A Sonnet judge, not the harness default. The coach-channel eval's note applies with
  // more force here: Haiku flapped on replies that differed by a comma, and these are
  // three-paragraph plans whose failure mode is a shade of generality. The run is
  // cached, so the tier costs once.
  const judgeModel = (await readModelIds()).sonnet;
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'coach-plan', cachedOnly, getClient, cost);

  // The REAL companion tool, exactly as the handler calls it (plan/reply.ts
  // loadPlanGuidance) — so the plan is graded against content that actually exists.
  const guidanceTool = frameworkGuidanceTool();
  const groundingFor = async (fixture) => ({
    topic: fixture.topic,
    question: fixture.question,
    child: fixture.child,
    guidance: await guidanceTool.handler(
      { stage: fixture.child.stage, ageMonths: fixture.child.ageMonths },
      { familyId: 'fixture-family', actor: 'fixture-parent' },
    ),
    facts: [],
  });

  console.log(
    `coach-plan eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${COACH_PLAN_FIXTURES.length} plans\n`);

  const results = [];
  for (const fixture of COACH_PLAN_FIXTURES) {
    const grounding = await groundingFor(fixture);
    const raw = broken
      ? BROKEN_PLAN
      : planMessages(
          (
            await cachedToolCall({
              tag: `coach-plan:${fixture.id}`,
              model,
              system: skill.instructions,
              userMessage: planUserMessage(grounding),
              toolName: 'plan',
              toolSchema: PLAN_TOOL_SCHEMA,
              toolDescription:
                'Return the plan as two or three text messages, in order: first, second, and third only if the plan needs a third stage.',
              maxTokens: MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value,
        );

    const messages = raw.map(flatten).filter((body) => body !== '');
    const failures = [
      ...sendFailures(messages, smsSegments),
      ...planFailures(messages, raw),
    ];
    for (const token of fixture.expect.mustMention ?? []) {
      if (!messages.join(' ').toLowerCase().includes(token.toLowerCase())) {
        failures.push(`never mentions "${token}"`);
      }
    }
    for (const token of fixture.expect.forbidden ?? []) {
      if (messages.join(' ').toLowerCase().includes(token.toLowerCase())) {
        failures.push(`says "${token}", which is a hedge or a line the skill draws`);
      }
    }

    // The judge is skipped in broken mode: the stand-in has already tripped six
    // structural gates, and scoring it would spend a live call to be told what the
    // gates just said.
    const verdict = broken
      ? null
      : await judge(fixture.id, {
          question: fixture.question,
          ageMonths: fixture.child.ageMonths,
          guidance: grounding.guidance,
          plan: messages,
          watchFor: fixture.expect.watchFor,
        });
    if (verdict && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, messages, failures, score: verdict?.score ?? null });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- plans ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    const segments = r.messages.map((body) => smsSegments(body)).join('/');
    console.log(
      `${tag}  ${r.fixture.id.padEnd(20)} msgs=${r.messages.length} seg=${segments} score=${r.score ?? '-'}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
    if (show) for (const body of r.messages) console.log(`      > ${body}`);
  }

  const unsendable = results.filter((r) =>
    r.failures.some((f) =>
      /^(wrong_shape|empty|over_budget|carries_link|carries_dosing|reaches_for_the_health_line)/.test(
        f,
      ),
    ),
  );
  const unsequenced = results.filter((r) => r.failures.some((f) => f.startsWith('not_sequenced')));
  const vague = results.filter((r) => r.failures.some((f) => f.startsWith('not_concrete')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const scores = results.map((r) => r.score).filter((s) => typeof s === 'number');
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNSENDABLE PLANS:        ${unsendable.length}  (0 required - the composer is all-or-nothing, so the parent got an apology instead)`,
  );
  console.log(`not sequenced:           ${unsequenced.length}  (0 required)`);
  console.log(`not concrete:            ${vague.length}  (0 required)`);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(`mean plan score:         ${meanScore.toFixed(2)}  (of 5)`);

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
  console.error('coach-plan eval harness error:', err);
  process.exit(2);
});
