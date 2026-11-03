// The sign-up outcome reply eval (VIL-558 step 0, hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/signup-outcome-reply.md, called the way the runtime calls
// it (apps/web/lib/signup/outcome-reply.ts): the REAL user message
// (`signupOutcomeUserMessage`), the `signup_outcome_reply` schema on the skill's lane sent
// through the production seam (`forceToolJson`, via the harness's `cachedToolCall`), the
// REAL code gate (`signupOutcomeViolations`), and the writer's one retry with the
// violation note. A draft still violating after the retry is what the runtime does not
// send, and fails here.
//
// Two checks, and nothing matches words:
//   - THE GATE, in code: the link exactly when one is given, and no other link.
//   - THE TEXT, by a judge: only the facts given, signed up only when confirmed, pack
//     values only when given, no retry or follow-up promise, the right language and tone.
//
//   node evals/run-signup-outcome-reply-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-outcome-reply-eval.mjs --cached-only      # replay only
//   node evals/run-signup-outcome-reply-eval.mjs --broken           # calibration: must catch all
//   node evals/run-signup-outcome-reply-eval.mjs --dry              # worst-case price, no client

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cacheGet,
  cacheKey,
  cachedToolCall,
  evalRunTag,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import {
  SIGNUP_OUTCOME_REPLY_BROKEN,
  SIGNUP_OUTCOME_REPLY_FIXTURES,
} from './signup-outcome-reply-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-outcome-reply.md');
const WRITER_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'signup', 'outcome-reply.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** The judge's ceiling: makeJudge's default for a Haiku judge. */
const JUDGE_MAX_TOKENS = 4096;
const ATTEMPTS = 2;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent after the parent said yes',
  'to letting Hale try a sign-up for their child. A model wrote the whole text from the',
  'facts; nothing is added around it. You are given the facts (outcome, reason, confirmed,',
  'sessionLabel, link, linkIs, holdMinutes, pack, rush, language), the text and watchFor',
  'notes (audience says who reads it: direct = the one parent, group = the co-parent group).',
  'Score 1-5 on FACTS, PRIVACY and TONE, not wording.',
  'A 5: says what happened and what the parent does next using only the facts; says the',
  'child is signed up only when confirmed is true; carries the link exactly when one is',
  'given; when linkIs is live_browser, says the parent finishes in a browser Hale left open',
  'and gives the minutes left only when holdMinutes is set; lists personal details only when',
  'pack is given; is in facts.language (French: tu when audience is direct, vous when it is',
  'group); short, plain and warm, like a friend.',
  'A LOW score (1-2) is any of: saying signed up, booked, paid or done when confirmed is',
  'false; saying it failed when the reason is unconfirmed; any promise or hint that Hale',
  'will try again, keep watching, follow up or let them know later; on reason',
  'no_provider_session, saying a login was tried or failed; a name, email, phone or postal',
  'code when pack is absent; an invented time, price, place, reason or next step; reason',
  'codes, run ids or system talk; asking the parent to reply with a keyword; advice the facts',
  'do not give; the wrong language; in French, vous to a direct audience or tu to a group;',
  'garbled or broken characters (for example accents rendered as two odd symbols).',
  'Reply with ONLY the score tool.',
].join(' ');

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const rate = PRICE[model];
  if (!rate) throw new Error(`signup-outcome-reply --dry: no price for ${model}`);
  return (input * rate.input + output * rate.output) / 1_000_000;
}

function writerCall(writer, skill, lane, fixture, violation) {
  return {
    lane,
    tag: evalRunTag(`signup-outcome-reply:${fixture.id}${violation ? ':retry' : ''}`),
    system: skill.instructions,
    userMessage: writer.signupOutcomeUserMessage(fixture.facts, violation),
    toolName: writer.SIGNUP_OUTCOME_TOOL,
    toolDescription: writer.SIGNUP_OUTCOME_TOOL_DESCRIPTION,
    toolSchema: writer.SIGNUP_OUTCOME_TOOL_SCHEMA,
    maxTokens: writer.SIGNUP_OUTCOME_MAX_TOKENS,
  };
}

/** The key `cachedToolCall` reads for a lane call, so a miss is listed instead of exiting. */
function writerKey(call) {
  return cacheKey(
    call.tag,
    JSON.stringify({
      model: call.lane.model,
      system: call.system,
      userMessage: call.userMessage,
      toolName: call.toolName,
      toolSchema: call.toolSchema,
      lane: call.lane,
    }),
  );
}

function judgeKey(judgeModel, tag, payload) {
  return cacheKey(
    `signup-outcome-reply:judge:${tag}`,
    `${judgeModel}\n${JUDGE_SYSTEM}\n${JSON.stringify(payload)}`,
  );
}

function fixtureFor(id) {
  const fixture = SIGNUP_OUTCOME_REPLY_FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`signup-outcome-reply: no fixture ${id}`);
  return fixture;
}

// --- --dry: the worst case, every call a miss, every draft retried, output at max_tokens --

async function dryRun({ lane, skill, writer, judgeModel }) {
  const tool = {
    name: writer.SIGNUP_OUTCOME_TOOL,
    description: writer.SIGNUP_OUTCOME_TOOL_DESCRIPTION,
    input_schema: writer.SIGNUP_OUTCOME_TOOL_SCHEMA,
  };
  const judgeTool = { name: 'score', description: 'Return the score.' };
  const longestText = 'x'.repeat(writer.SIGNUP_OUTCOME_MAX_TOKENS * 4);
  let usd = 0;
  let writerCalls = 0;
  let writerHits = 0;
  let judgeCalls = 0;
  const lines = [];
  for (const fixture of SIGNUP_OUTCOME_REPLY_FIXTURES) {
    const first = writerCall(writer, skill, lane, fixture, null);
    const hit = (await cacheGet(writerKey(first))) !== undefined;
    let row = 0;
    if (hit) writerHits += 1;
    else {
      const input =
        estimateTokens(skill.instructions) +
        estimateTokens(first.userMessage) +
        estimateTokens(tool) +
        40;
      // A miss may need the retry too: price both attempts.
      row += ATTEMPTS * priced(lane.model, input, writer.SIGNUP_OUTCOME_MAX_TOKENS);
      writerCalls += ATTEMPTS;
    }
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens({ facts: fixture.facts, text: longestText, watchFor: fixture.watchFor }) +
      estimateTokens(judgeTool) +
      200;
    row += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
    judgeCalls += 1;
    usd += row;
    lines.push(
      `  ${fixture.id.padEnd(40)} writer ${hit ? 'hit ' : 'miss'} + judge  $${row.toFixed(4)}`,
    );
  }
  for (const broken of SIGNUP_OUTCOME_REPLY_BROKEN) {
    const fixture = fixtureFor(broken.fixtureId);
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens({ facts: fixture.facts, text: broken.text, watchFor: fixture.watchFor }) +
      estimateTokens(judgeTool) +
      200;
    const row = priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
    judgeCalls += 1;
    usd += row;
    lines.push(`  ${`broken:${broken.id}`.padEnd(40)} --broken judge  $${row.toFixed(4)}`);
  }
  return [
    `signup-outcome-reply | --dry | every miss retried, output at max_tokens | writer=${lane.model} judge=${judgeModel} | fixtures=${SIGNUP_OUTCOME_REPLY_FIXTURES.length}`,
    ...lines,
    `writer cache: ${writerHits} hit | calls if run live (worst case): writer ${writerCalls}, judge ${judgeCalls}`,
    `writer output priced at ${writer.SIGNUP_OUTCOME_MAX_TOKENS} tokens, judge at ${JUDGE_MAX_TOKENS}; input ≈ 4 Latin chars/token, other chars 1 token each.`,
    `live API calls: 0 | worst-case cost of a full live run incl. --broken: $${usd.toFixed(4)} USD`,
  ].join('\n');
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = process.argv.includes('--dry');
  if (dry && (broken || cachedOnly)) {
    console.error('signup-outcome-reply: --dry runs alone');
    process.exit(2);
  }
  const agent = await importTs(AGENT_SRC);
  const writer = await importTs(WRITER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  if (dry) {
    console.info(await dryRun({ lane, skill, writer, judgeModel }));
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-outcome-reply');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'signup-outcome-reply',
    cachedOnly,
    getClient,
    cost,
  );

  console.info(
    `signup-outcome-reply | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | writer=${lane.model} judge=${judgeModel} | fixtures=${SIGNUP_OUTCOME_REPLY_FIXTURES.length}`,
  );

  if (broken) {
    let caught = true;
    for (const item of SIGNUP_OUTCOME_REPLY_BROKEN) {
      const fixture = fixtureFor(item.fixtureId);
      const violations = writer.signupOutcomeViolations(item.text, fixture.facts);
      if (violations.length > 0) {
        console.info(`CAUGHT  ${item.id.padEnd(30)} code gate (${violations.join('; ')})`);
        continue;
      }
      const payload = { facts: fixture.facts, text: item.text, watchFor: fixture.watchFor };
      const tag = `broken:${item.id}`;
      if (cachedOnly && (await cacheGet(judgeKey(judgeModel, tag, payload))) === undefined) {
        caught = false;
        console.info(`UNRECORDED  ${item.id.padEnd(30)} judge not recorded yet`);
        continue;
      }
      const verdict = await judge(tag, payload);
      const failed = verdict.score < JUDGE_MIN;
      if (!failed) caught = false;
      console.info(
        `${failed ? 'CAUGHT' : 'MISSED'}  ${item.id.padEnd(30)} judge:${verdict.score} (${verdict.reason}) breaks: ${item.breaks}`,
      );
    }
    console.info(
      `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
    );
    console.info(
      `broken-mode calibration (every broken text must be caught): ${caught ? 'PASS' : 'FAIL'}`,
    );
    process.exit(caught ? 0 : 1);
  }

  const misses = [];
  const results = [];
  for (const fixture of SIGNUP_OUTCOME_REPLY_FIXTURES) {
    let violation = null;
    let text = null;
    let missed = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const opts = writerCall(writer, skill, lane, fixture, violation);
      if (cachedOnly && (await cacheGet(writerKey(opts))) === undefined) {
        misses.push(`${fixture.id}${violation ? ' (retry)' : ''}  ${writerKey(opts)}`);
        missed = true;
        break;
      }
      const call = await cachedToolCall({ ...opts, cachedOnly, getClient, cost });
      const draft = writer.signupOutcomeSchema.safeParse(call.value);
      const raw = draft.success ? draft.data.text : '';
      const violations = writer.signupOutcomeViolations(raw, fixture.facts);
      if (violations.length === 0) {
        text = raw.replace(/\s+/g, ' ').trim();
        break;
      }
      violation = violations.join('; ');
    }
    if (missed) continue;
    const failures = [];
    if (text === null) failures.push(`unsendable after retry: ${violation}`);
    else {
      const verdict = await judge(fixture.id, {
        facts: fixture.facts,
        text,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, text, failures });
  }

  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(40)} ${r.text === null ? '(nothing sent)' : `"${r.text}"`}`,
    );
    for (const f of r.failures) console.info(`        · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (misses.length > 0) {
    console.error(
      `cache miss in --cached-only mode for ${misses.length} writer call(s). Record live with --max-usd, then commit the cache:\n  ${misses.join('\n  ')}`,
    );
    process.exit(1);
  }
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('signup-outcome-reply eval harness error:', err);
  process.exit(2);
});
