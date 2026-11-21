// Memory-reply eval (VIL-723). Hard rule #8: no LLM mocking; real responses, cached.
//
// SUBJECT: packages/agent/skills/memory-reply.md, called the way the runtime calls it
// (apps/web/lib/channel/reply-copy/compose.ts through store.ts handleParentMemory): the
// skill's instructions as the system prompt, the composer's context as the one user turn,
// on the skill's lane, at the output budget the runtime gives that purpose.
//
// Gates, no judge: the answer parses to `{ text }`; the production validator
// (validateReplyCopy, the path that runs while MODEL_READ_SWEEP_ENABLED is off) accepts it;
// a list keeps every remembered value as written (an honest list); a reply in a group
// carries no sealed value; a Chinese reply is written in Chinese. Nothing here matches a
// phrase of the parent's: the model writes every word.
//
// Usage (from apps/worker):
//   node evals/run-memory-reply-eval.mjs --preflight
//   HALE_SPEND_LEDGER=... node evals/run-memory-reply-eval.mjs --dry
//   node evals/run-memory-reply-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  REPO_ROOT,
  cachedTextCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { MEMORY_REPLY_FIXTURES } from './memory-reply-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'memory-reply.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const VALIDATE_SRC = join(WEB_ROOT, 'lib', 'channel', 'reply-copy', 'validate.ts');

// The runtime's budgets (store.ts MEMORY_LIST_MAX_TOKENS; compose.ts MAX_TOKENS).
const LIST_MAX_TOKENS = 1600;
const LINE_MAX_TOKENS = 320;
// Sonnet list price per million tokens, for the preflight only.
const SONNET_IN = 3;
const SONNET_OUT = 15;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** The composer's own context, key for key (compose.ts), as runAgent sends it. */
function userMessage(context) {
  return JSON.stringify({
    language: context.language,
    audience: context.audience,
    shape: 'prose',
    questionAllowed: context.questionAllowed,
    facts: context.facts,
    ...(context.purpose ? { purpose: context.purpose } : {}),
  });
}

function maxTokensFor(context) {
  return context.purpose === 'memory_list' ? LIST_MAX_TOKENS : LINE_MAX_TOKENS;
}

/** The first balanced `{...}` in the answer, then its `text` (compose.ts parseAnswer). */
function parsedText(answer) {
  const start = answer.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < answer.length; i += 1) {
    if (answer[i] === '{') depth += 1;
    else if (answer[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(answer.slice(start, i + 1));
          return typeof value?.text === 'string' ? value.text.trim() : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function grade(text, fixture, validate) {
  const problems = [];
  if (!text) return ['unparsed'];
  const failure = validate.validateReplyCopy(text, {
    language: fixture.context.language,
    facts: fixture.context.facts,
    audience: fixture.context.audience,
    sealedValues: fixture.sealedValues,
    questionAllowed: fixture.context.questionAllowed,
    role: 'prose',
  });
  if (failure) problems.push(`validator:${failure}`);
  for (const value of fixture.mustKeep ?? []) {
    if (!text.includes(value)) problems.push(`dropped:${value}`);
  }
  if (fixture.mustKeepAny && !fixture.mustKeepAny.some((value) => text.includes(value))) {
    problems.push(`names_none_of:${fixture.mustKeepAny.join('|')}`);
  }
  // Hale's own output, checked for its script: a Chinese parent reads Chinese.
  if (fixture.script === 'han' && !/\p{Script=Han}/u.test(text)) problems.push('not_chinese');
  return problems;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = MEMORY_REPLY_FIXTURES;

  if (preflight) {
    let worst = 0;
    for (const fixture of fixtures) {
      const inputTokens = Math.ceil(
        (skill.instructions.length + userMessage(fixture.context).length) / 4,
      );
      worst += (inputTokens / 1e6) * SONNET_IN + (maxTokensFor(fixture.context) / 1e6) * SONNET_OUT;
    }
    console.info(
      `memory-reply preflight | fixtures=${fixtures.length} model=${lane.model} | worst $${worst.toFixed(6)} | judges=0`,
    );
    return;
  }

  installEvalSpendCap();
  const validate = await importTs(VALIDATE_SRC);
  const getClient = lazyAnthropic('memory-reply');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const call = await cachedTextCall({
      tag: `memory-reply:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: userMessage(fixture.context),
      maxTokens: maxTokensFor(fixture.context),
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const problems = grade(parsedText(call.text), fixture, validate);
    if (problems.length > 0) failures.push(fixture.id);
    console.info(
      `${problems.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}${problems.length ? `  ${problems.join(', ')}` : ''}`,
    );
  }
  if (dry) {
    console.info(dryReportLine('memory-reply'));
    return;
  }
  console.info(
    `memory-reply | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
