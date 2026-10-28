// Group poll live tally eval (VIL-458 slice 1, hard rule #8: no LLM mocking).
//
// Subject is the REAL skill (group-poll-tally-read.md) through the REAL request builder
// imported from group-poll-tally.ts. The gate is the per-voter label. No word in any
// message is checked.
//
//   node evals/run-group-poll-tally-eval.mjs --dry           # $0, no API: worst-case $
//   node evals/run-group-poll-tally-eval.mjs --broken        # $0 calibration: must FAIL
//   node evals/run-group-poll-tally-eval.mjs --cached-only   # CI: replay only, $0
//   node --env-file=../../.env evals/run-group-poll-tally-eval.mjs --live   # PAID
// Exactly one mode (lib/eval-flags.mjs).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { TALLY_FIXTURES } from './group-poll-tally-fixtures.mjs';
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
const READ_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-poll-tally-read.md');
const SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-poll-tally.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const READ_MAX = 400;

async function main() {
  const mode = parseEvalFlagsOrExit('group-poll-tally');
  const agent = await importTs(AGENT_SRC);
  const src = await importTs(SRC);
  const skill = await agent.loadSkill(READ_SKILL);
  const model = agent.pickModel(skill.meta.task);
  if (mode === 'dry') {
    console.log(`group-poll-tally eval | mode=dry (no API calls) | read=${model}`);
    let worst = 0;
    for (const f of TALLY_FIXTURES) {
      const inTok = estimateTokens(skill.instructions + src.pollTallyUserMessage(f.input));
      const usd = worstCaseUsd(model, inTok, READ_MAX);
      worst += usd;
      console.log(
        `DRY  group-poll-tally:${f.id}  ${model}  ~${inTok} in + ${READ_MAX} max out  worst $${usd.toFixed(5)}`,
      );
    }
    console.log(
      `DRY summary | ${TALLY_FIXTURES.length} calls, all priced as uncached | worst $${worst.toFixed(5)}`,
    );
    console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
    return;
  }
  const broken = mode === 'broken';
  installEvalSpendCap();
  const getClient =
    mode === 'live' ? lazyAnthropic('group-poll-tally') : noClient('group-poll-tally');
  const cost = makeCost();
  console.log(`group-poll-tally eval | mode=${mode} | read=${model}`);
  const results = [];
  for (const f of TALLY_FIXTURES) {
    let reading;
    if (broken) {
      // A naive read: every voter's first native vote stands, text ignored. Must fail.
      reading = new Map(
        f.input.voters.map((v) => {
          const first = f.input.answers.find((a) => a.kind === 'vote' && a.voterId === v.voterId);
          return [v.voterId, first ? first.optionId : null];
        }),
      );
    } else {
      const { value } = await cachedToolCall({
        tag: `group-poll-tally:${f.id}`,
        model,
        lane: agent.pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: src.pollTallyUserMessage(f.input),
        toolName: 'group_poll_tally',
        toolSchema: src.POLL_TALLY_TOOL_SCHEMA,
        toolDescription: 'Return, for each voter key, the option key they now stand on, or null.',
        maxTokens: READ_MAX,
        cachedOnly: mode === 'cached-only',
        getClient,
        cost,
      });
      reading = src.pollReadingFromAnswer(f.input, value);
    }
    const misses = reading
      ? Object.entries(f.accept)
          .filter(([id, ok]) => !ok.includes(reading.get(id) ?? null))
          .map(([id]) => `${id}=${reading.get(id) ?? null}`)
      : ['unmappable answer'];
    results.push({ id: f.id, pass: misses.length === 0, detail: misses.join(' ') });
  }
  for (const r of results)
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(36)} ${r.detail}`);
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('group-poll-tally eval harness error:', err);
  process.exit(2);
});
