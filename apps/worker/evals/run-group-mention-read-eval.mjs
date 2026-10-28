// Who should this group reply mention? · classifier eval (VIL-475, hard rule #8).
//
// The subject is the REAL skill (packages/agent/skills/group-mention-read.md) through
// the REAL request: `groupMentionUserMessage` is imported from group-mention-reader.ts,
// not replicated. Scoring is the mentionId, never a word in the reply.
//
//   node evals/run-group-mention-read-eval.mjs --dry
//   node evals/run-group-mention-read-eval.mjs --cached-only
//
// --dry (also --estimate) prices one live recording at max_tokens and exits 0.
// It does not call the API and it does not write a cache file.
// --cached-only replays committed cache. A miss prints that same estimate and
// exits 1. This runner does not call the API.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_MENTION_READ_FIXTURES } from './group-mention-read-fixtures.mjs';
import { PRICE, REPO_ROOT, cacheGet, cacheKey, evalRunTag } from './lib/harness.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-mention-read.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-mention-reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const MAX_TOKENS = 200;
const TOOL_NAME = 'group_mention';
const TOOL_DESCRIPTION = 'Return who this group reply is addressing, if anyone.';
const TOOL_SCHEMA = {
  type: 'object',
  properties: { mentionId: { type: ['string', 'null'] } },
  required: ['mentionId'],
};

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function fixtureUsd(lane, skill, userMessage) {
  const input =
    estimateTokens(skill.instructions) +
    estimateTokens(userMessage) +
    estimateTokens({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      input_schema: TOOL_SCHEMA,
    });
  return priced(lane.model, input, MAX_TOKENS);
}

function estimateLine(worst, fixtureId, model) {
  return `group-mention-read: --dry worst case for one live recording (${fixtureId}, ${model}, max_tokens=${MAX_TOKENS}): $${worst.toFixed(4)} USD. live API calls: 0. nothing written.`;
}

async function main() {
  const dry = process.argv.includes('--dry') || process.argv.includes('--estimate');
  const cachedOnly = process.argv.includes('--cached-only');
  if (dry && cachedOnly) {
    console.error('group-mention-read: pass only one of --dry and --cached-only');
    process.exit(1);
  }
  if (!dry && !cachedOnly) {
    console.error(
      'group-mention-read: pass --dry or --cached-only. This runner does not call the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const { groupMentionUserMessage } = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const model = agent.pickModel(skill.meta.task);

  let worst = { id: GROUP_MENTION_READ_FIXTURES[0]?.id ?? 'none', usd: 0 };
  for (const fixture of GROUP_MENTION_READ_FIXTURES) {
    const usd = fixtureUsd(lane, skill, groupMentionUserMessage(fixture.input));
    if (usd > worst.usd) worst = { id: fixture.id, usd };
  }
  const line = estimateLine(worst.usd, worst.id, model);

  if (dry) {
    console.info(line);
    return;
  }

  for (const fixture of GROUP_MENTION_READ_FIXTURES) {
    const userMessage = groupMentionUserMessage(fixture.input);
    const fields = agent.laneRequestFields(lane);
    const canonical = JSON.stringify({
      fields,
      system: skill.instructions,
      userMessage,
      toolName: TOOL_NAME,
      toolSchema: TOOL_SCHEMA,
      toolChoice: { type: 'tool', name: TOOL_NAME },
      maxTokens: MAX_TOKENS,
    });
    const key = cacheKey(evalRunTag(`group-mention-read:${fixture.id}`), canonical);
    const cached = await cacheGet(key);
    if (!cached) {
      console.error(line);
      console.error(`group-mention-read: cache miss on ${fixture.id}. stopped. nothing recorded.`);
      process.exit(1);
    }
    const mentionId = cached.value?.mentionId ?? null;
    const pass = fixture.accept.some((allowed) => allowed === mentionId);
    console.info(
      `${pass ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(28)} mention=${String(mentionId)} accept=${fixture.accept.map(String).join('|')}`,
    );
    if (!pass) process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'group-mention-read failed');
    process.exit(1);
  });
}
