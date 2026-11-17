// VIL-706 join and caregiver door lines. Dry by default — no paid calls.
//
//   node evals/run-join-door-eval.mjs --dry
//   node evals/run-join-door-eval.mjs --cached-only
//
// Prices one spoken-line compose per fixture at max_tokens, plus the one retry
// the writer takes when the first draft is refused. Nothing is recorded.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { JOIN_DOOR_FIXTURES } from './join-door-fixtures.mjs';
import { PRICE, REPO_ROOT } from './lib/harness.mjs';

const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'spoken-line.md');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const MAX_TOKENS = 400;

register({ tsconfig: join(REPO_ROOT, 'apps', 'web', 'tsconfig.json') });

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

async function dryRun() {
  const agent = await import(pathToFileURL(AGENT_SRC).href);
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
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  };
  let usd = 0;
  const lines = [];
  for (const fixture of JOIN_DOOR_FIXTURES) {
    const user = JSON.stringify(fixture.request);
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

async function main() {
  const dry = process.argv.includes('--dry') || process.argv.includes('--cached-only');
  if (!dry) {
    console.error('join-door: dry runs only. Pass --dry or --cached-only. No paid evals.');
    process.exit(2);
  }
  console.info(await dryRun());
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
