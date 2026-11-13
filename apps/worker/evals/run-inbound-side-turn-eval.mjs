// The inbound side-turn eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/inbound-side-turn.md) run through
// the REAL forced-tool-JSON request shape apps/web/lib/channel/router/side-turn-reader.ts
// builds - REPLICATED here, as the burst eval replicates burst-reader.ts, because that
// module sits behind the web app's `~/` alias. The SKILL body and the model routing ARE
// imported live, so a skill edit or a re-tiering re-keys the cache and shows up as a miss.
//
// WHAT IS AT STAKE. A text answered beside a running turn that belonged to it ("actually
// make it Sunday", a "yes", an ask to add something) is a correction or a decision Hale
// heard and did nothing with. A quick fact handed back only waits, as today. So a wrong
// `answer` is the costly miss and a wrong `hand_back` the cheap one; both fail here.
//
// Usage (from apps/worker):
//   node evals/run-inbound-side-turn-eval.mjs --live                 # live, then caches
//   node evals/run-inbound-side-turn-eval.mjs --broken --cached-only # calibration: must FAIL
//   node evals/run-inbound-side-turn-eval.mjs --cached-only          # CI: replay only
//
// The metric is objective: the verdict must be the fixture's, and an answer about the
// family must say what the fixture names, a child's age exactly as the fixture's family
// gives it. No judge.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { INBOUND_SIDE_TURN_FIXTURES } from './inbound-side-turn-fixtures.mjs';
import {
  assertRunFlags,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'inbound-side-turn.md');

// ── the reader's request shape, replicated (side-turn-reader.ts) ─────────────

/** Mirrors MAX_TOKENS in side-turn-reader.ts. */
const MAX_TOKENS = 1_024;

const READING_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    verdict: { type: 'string', enum: ['answer', 'hand_back'] },
    reply: { type: 'string' },
  },
  required: ['reasoning', 'verdict', 'reply'],
};

/** Mirrors `sideTurnUserMessage` in side-turn-reader.ts. */
function sideTurnUserMessage(input) {
  const { family } = input;
  return JSON.stringify({
    text: input.text,
    workingOn: input.workingOn,
    waitingOn: input.waitingOn,
    thread: family.thread,
    family: { children: family.children, city: family.city, memory: family.memory },
    localNow: family.localNow,
  });
}

/**
 * A child's age, said exactly: every number in the reply is the child's years, the months
 * past them, or the months in all, and the years are among them. A half is six months.
 * The fact comes from the fixture's own family, never from the reply.
 */
function ageFailures(reply, child) {
  const { years, months: past } = child.age;
  const months = years * 12 + past;
  const exact = `${years}y ${past}m`;
  const said = [...reply.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
  const failures = [];
  if (!said.includes(years)) failures.push(`reply never says ${years} (${child.name} is ${exact})`);
  const wrong = said.filter((n) => n !== years && n !== past && n !== months);
  if (wrong.length > 0) failures.push(`reply says ${wrong.join(', ')} (${child.name} is ${exact})`);
  if (/\bhalf\b|½|\bdemi/i.test(reply) && past !== 6) {
    failures.push(`reply says a half (${child.name} is ${exact})`);
  }
  return failures;
}

function failuresFor(fixture, value) {
  const failures = [];
  if (value.verdict !== fixture.expect) {
    failures.push(`verdict ${value.verdict}, expected ${fixture.expect}`);
    return failures;
  }
  if (fixture.expect !== 'answer') return failures;
  const reply = typeof value.reply === 'string' ? value.reply.trim() : '';
  if (/https?:\/\//i.test(reply)) failures.push('reply carries a link');
  if (fixture.replyMayBeEmpty) return failures;
  if (reply === '') {
    failures.push('answered with no words');
    return failures;
  }
  if (fixture.ageOf) {
    const child = fixture.input.family.children.find((c) => c.name === fixture.ageOf);
    failures.push(...ageFailures(reply, child));
    return failures;
  }
  const lower = reply.toLowerCase();
  if (!fixture.mentions.some((m) => lower.includes(m.toLowerCase()))) {
    failures.push(`reply names none of ${JSON.stringify(fixture.mentions)}`);
  }
  return failures;
}

async function main() {
  assertRunFlags(['--broken', '--env-file', '--max-usd']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('inbound-side-turn');
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);

  console.log(
    `inbound-side-turn eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | reader=${model}`,
  );
  console.log(`corpus: ${INBOUND_SIDE_TURN_FIXTURES.length} texts\n`);

  const results = [];
  for (const fixture of INBOUND_SIDE_TURN_FIXTURES) {
    // --broken: a reader that answers everything. It must fail the corpus.
    const value = broken
      ? { reasoning: 'answer everything', verdict: 'answer', reply: '' }
      : (
          await cachedToolCall({
            tag: `inbound-side-turn:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: sideTurnUserMessage(fixture.input),
            toolName: 'side_turn',
            toolSchema: READING_TOOL_SCHEMA,
            toolDescription:
              'Say whether this text can be answered now, on its own, and write the answer.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    results.push({ fixture, value, failures: failuresFor(fixture, value) });
  }

  console.log('--- verdicts ---');
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} ${r.value.verdict}  ${JSON.stringify(r.value.reply ?? '')}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
    if (r.failures.length > 0 && r.value.reasoning)
      console.log(`      reasoning: ${r.value.reasoning}`);
  }

  const passed = results.filter((r) => r.failures.length === 0).length;
  console.log('\n--- corpus metrics ---');
  console.log(`correct: ${passed}/${results.length}  (all required)`);
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = passed === results.length;
  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one fixture): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('inbound-side-turn eval harness error:', err);
  process.exit(2);
});
