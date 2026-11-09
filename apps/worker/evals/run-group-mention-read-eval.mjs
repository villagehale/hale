// Who should this group reply mention? · classifier eval (VIL-475, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-mention-read.md) through the REAL
// request: `groupMentionUserMessage` is imported from group-mention-reader.ts, not replicated,
// and the tool schema below mirrors its `outputJsonSchema`. The skill body and the model
// routing are imported live, so a skill edit re-keys the cache and shows up as a miss.
//
// The gate is the mentionId: a reading outside the fixture's `accept` set notifies the wrong
// person, or nobody. No word in the reply is checked.
//
//   node evals/run-group-mention-read-eval.mjs --dry           # $0, no API: worst-case $ projection
//   node evals/run-group-mention-read-eval.mjs --broken        # calibration, $0: must FAIL
//   node evals/run-group-mention-read-eval.mjs --cached-only   # CI: replay only, $0
//   node --env-file=../../.env evals/run-group-mention-read-eval.mjs --live   # live, PAID
// Exactly one mode. Any other flag, none, or two exits 2 before the spend cap or a client
// exists (lib/eval-flags.mjs).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_MENTION_READ_FIXTURES } from './group-mention-read-fixtures.mjs';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-mention-read.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-mention-reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors createGroupMentionReader in group-mention-reader.ts. */
const MAX_TOKENS = 200;
const TOOL_SCHEMA = {
  type: 'object',
  properties: { mentionId: { type: ['string', 'null'] } },
  required: ['mentionId'],
};

async function main() {
  const mode = parseEvalFlagsOrExit('group-mention-read');
  if (mode === 'dry') return dryRun();
  const broken = mode === 'broken';
  const cachedOnly = mode === 'cached-only';
  installEvalSpendCap();
  // Only --live ever gets a real client.
  const getClient =
    mode === 'live' ? lazyAnthropic('group-mention-read') : noClient('group-mention-read');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { groupMentionUserMessage } = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);

  console.log(
    `group-mention-read eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  const results = [];
  for (const fixture of GROUP_MENTION_READ_FIXTURES) {
    // Broken: always mention the first member, which is wrong for most fixtures.
    const mentionId = broken
      ? (fixture.input.members[0]?.id ?? null)
      : (
          await cachedToolCall({
            tag: `group-mention-read:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: groupMentionUserMessage(fixture.input),
            toolName: 'group_mention',
            toolSchema: TOOL_SCHEMA,
            toolDescription: 'Return who this group reply is addressing, if anyone.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.mentionId;
    results.push({ fixture, mentionId, pass: fixture.accept.includes(mentionId) });
  }
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} mention=${String(r.mentionId)} accept=${r.fixture.accept.map(String).join('|')}  "${r.fixture.input.text}"`,
    );
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

/** $0: no spend cap, no client. Prices every fixture as uncached (an upper bound). */
async function dryRun() {
  const agent = await importTs(AGENT_SRC);
  const { groupMentionUserMessage } = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  console.log(`group-mention-read eval | mode=dry (no API calls) | model=${model}`);
  let worst = 0;
  for (const fixture of GROUP_MENTION_READ_FIXTURES) {
    const inTokens = estimateTokens(skill.instructions + groupMentionUserMessage(fixture.input));
    const usd = worstCaseUsd(model, inTokens, MAX_TOKENS);
    worst += usd;
    console.log(
      `DRY  group-mention-read:${fixture.id}  ~${inTokens} in + ${MAX_TOKENS} max out  worst $${usd.toFixed(5)}`,
    );
  }
  console.log(
    `DRY summary | ${GROUP_MENTION_READ_FIXTURES.length} calls, all priced as uncached | worst $${worst.toFixed(5)}`,
  );
  console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
}

main().catch((err) => {
  console.error('group-mention-read eval harness error:', err);
  process.exit(2);
});
