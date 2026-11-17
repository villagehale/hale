// VIL-706 join and caregiver door lines.
//
// SUBJECT: packages/agent/skills/spoken-line.md, called with the same tool,
// schema, token ceiling and request shape apps/web/lib/channel/spoken-line.ts
// (and door-line.ts) use. The model writes the whole parent-visible line. A
// line that names STOP, HELP, ARRET or AIDE, or that drops a verbatim link,
// is a miss. JOIN_DOOR_MODEL_COPY_ENABLED is pinned on: dark, production
// sends nothing, so these fixtures only mean something while the flag is lit.
//
//   node evals/run-join-door-eval.mjs --dry
//   HALE_SPEND_LEDGER=... node evals/run-join-door-eval.mjs --live --max-usd 1
//   node evals/run-join-door-eval.mjs --cached-only

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { JOIN_DOOR_FIXTURES } from './join-door-fixtures.mjs';
import {
  PRICE,
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'spoken-line.md');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SPOKEN_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'spoken-line.ts');
const MAX_TOKENS = 400;
const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const FORBIDDEN = /\b(STOP|HELP|ARRET|ARRÊT|AIDE)\b/i;

register({ tsconfig: join(REPO_ROOT, 'apps', 'web', 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

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
  if (!rate) throw new Error(`join-door --dry: no price for ${model}`);
  return (input * rate.input + output * rate.output) / 1_000_000;
}

function userMessage(request) {
  return JSON.stringify({
    purpose: request.purpose,
    language: request.language,
    facts: request.facts ?? {},
    verbatim: request.verbatim ?? [],
  });
}

async function dryRun() {
  const agent = await importTs(AGENT_SRC);
  const raw = await readFile(SKILL, 'utf8');
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const smaller =
    lane.model === agent.HAIKU_MODEL
      ? lane
      : { model: agent.HAIKU_MODEL, thinking: 'adaptive', effort: 'medium' };
  const tool = {
    name: 'spoken_line',
    description: 'Write the one text Hale will send.',
    input_schema: TOOL_SCHEMA,
  };
  let usd = 0;
  const lines = [];
  for (const fixture of JOIN_DOOR_FIXTURES) {
    const user = userMessage(fixture.request);
    const input = estimateTokens(skill.instructions) + estimateTokens(user) + estimateTokens(tool);
    const first = priced(lane.model, input, MAX_TOKENS);
    const second = priced(smaller.model, input, MAX_TOKENS);
    const row = first + second;
    usd += row;
    lines.push(`  ${fixture.id.padEnd(28)} $${row.toFixed(4)}`);
  }
  return [
    `join-door | --dry | compose + one retry, output at max_tokens | fixtures=${JOIN_DOOR_FIXTURES.length}`,
    `compose=${lane.model} retry=${smaller.model}`,
    ...lines,
    `live API calls: 0 | worst-case cost of a full live run: $${usd.toFixed(4)} USD`,
    `skill bytes: ${raw.length}`,
  ].join('\n');
}

async function liveOrCached(cachedOnly) {
  process.env.JOIN_DOOR_MODEL_COPY_ENABLED = 'true';
  if (!cachedOnly) installEvalSpendCap();
  const getClient = lazyAnthropic('join-door');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const spoken = await importTs(SPOKEN_SRC);
  const skill = await agent.loadSkill(SKILL);
  const firstLane = agent.pickLane(skill.meta.task);
  const retryLane = spoken.smallerLane(firstLane);

  console.info(
    `join-door | ${cachedOnly ? 'cached-only' : 'live'} | flag on | compose=${firstLane.model} retry=${retryLane.model} | fixtures=${JOIN_DOOR_FIXTURES.length}`,
  );

  const results = [];
  for (const fixture of JOIN_DOOR_FIXTURES) {
    const message = userMessage(fixture.request);
    const draw = (lane, tag) =>
      cachedToolCall({
        tag,
        lane,
        system: skill.instructions,
        userMessage: message,
        toolName: 'spoken_line',
        toolDescription: 'Write the one text Hale will send.',
        toolSchema: TOOL_SCHEMA,
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
    const firstText = (await draw(firstLane, `join-door:${fixture.id}`)).value?.text ?? '';
    let body = spoken.acceptSpokenLine(firstText, fixture.request.verbatim);
    let retried = false;
    if (!body) {
      retried = true;
      const retryText = (await draw(retryLane, `join-door:${fixture.id}:retry`)).value?.text ?? '';
      body = spoken.acceptSpokenLine(retryText, fixture.request.verbatim);
    }
    const failures = [];
    if (!body) failures.push('unwritten');
    else {
      if (FORBIDDEN.test(body)) failures.push(`teaches_opt_out:${body.match(FORBIDDEN)?.[0]}`);
      for (const piece of fixture.request.verbatim ?? []) {
        if (piece && !body.includes(piece)) failures.push('missing_verbatim');
      }
    }
    results.push({ fixture, body: body ?? '', retried, failures });
  }

  for (const r of results) {
    const preview = r.body ? `"${r.body.slice(0, 140)}"` : '(unwritten)';
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} ${r.retried ? 'retry ' : ''}${preview}`,
    );
    for (const f of r.failures) console.info(`      · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  console.info(`overall: ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(allPass ? 0 : 1);
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.includes('--dry')) {
    console.info(await dryRun());
    return;
  }
  assertRunFlags(['--max-usd'], raw);
  const cachedOnly = raw.includes('--cached-only');
  await liveOrCached(cachedOnly);
}

main().catch((err) => {
  console.error('join-door eval harness error:', err);
  process.exit(2);
});
