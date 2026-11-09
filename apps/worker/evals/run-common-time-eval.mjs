// Find a common time across families · composer eval (VIL-459, hard rule #8: no LLM mocking).
//
// Subject: the REAL spoken-line skill with the REAL request shape of
// apps/web/lib/channel/spoken-line.ts (purpose/language/facts/verbatim, tool spoken_line),
// over facts built by the REAL code: calendars -> freeBusyOnly (household-calendar.ts) ->
// findCommonTimes + commonTimeFacts (common-time.ts). The judge grades facts, safety,
// privacy and tone against the fixture's private titles. No word is matched.
//
//   HALE_ESTIMATE=1 node evals/run-common-time-eval.mjs --max-usd 1.50   # free price
//   node evals/run-common-time-eval.mjs --max-usd 1.50                   # live, then caches
//   node evals/run-common-time-eval.mjs --broken                         # must FAIL
//   node evals/run-common-time-eval.mjs --cached-only                    # CI replay

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { BROKEN_REPLY, COMMON_TIME_FIXTURES } from './common-time-fixtures.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  readModelIds,
  scoreFirstJudgeSchema,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'spoken-line.md');
const LINQ = join(WEB_ROOT, 'lib', 'channel', 'linq');
const MAX_TOKENS = 400; // MAX_TOKENS in spoken-line.ts
const NOW = new Date('2026-10-26T13:00:00.000Z');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (p) => import(pathToFileURL(p).href);

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = judgePrompt('common-time');

async function loadSkill() {
  const raw = await readFile(SKILL, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('spoken-line.md: no frontmatter');
  return { task: m[1].match(/^task:\s*(\S+)/m)?.[1], instructions: m[2].trim() };
}

function toInput(fixture, freeBusyOnly) {
  return {
    families: fixture.families.map((f) => ({
      label: f.label,
      timeZone: f.timeZone,
      busy:
        f.calendar === null
          ? null
          : freeBusyOnly(
              f.calendar.map((e, i) => ({
                integrationId: 'fx',
                userId: f.label,
                eventId: `${f.label}-${i}`,
                start: new Date(e.start),
                end: new Date(e.end),
                allDay: false,
                kidRelated: false,
                title: e.title,
                status: 'confirmed',
                announced: false,
                followupSent: false,
                recurringEventId: null,
              })),
            ),
    })),
    blocked: fixture.blocked.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
    now: NOW,
  };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const { freeBusyOnly } = await importTs(join(LINQ, 'household-calendar.ts'));
  const { findCommonTimes, commonTimeFacts } = await importTs(join(LINQ, 'common-time.ts'));
  const agent = await importTs(AGENT_SRC);
  const skill = await loadSkill();
  const lane = agent.pickLane(skill.task);
  const ids = await readModelIds();
  const getClient = lazyAnthropic('common-time');
  const cost = makeCost();
  const judgeModel = await readJudgeModel('haiku');
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'common-time', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
    toolSchema: scoreFirstJudgeSchema(400),
    keepTruncatedScore: true,
  });
  console.info(
    `common-time eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | writer=${lane.model ?? ids.haiku} judge=${judgeModel}`,
  );
  let failed = 0;
  for (const fixture of COMMON_TIME_FIXTURES) {
    const input = toInput(fixture, freeBusyOnly);
    const slots = findCommonTimes(input);
    const facts = commonTimeFacts(input, slots, fixture.language);
    let text = BROKEN_REPLY;
    if (!broken) {
      const out = await cachedToolCall({
        tag: `common-time:${fixture.id}`,
        model: lane.model,
        lane,
        system: skill.instructions,
        userMessage: JSON.stringify({
          purpose: 'group_common_time',
          language: fixture.language,
          facts,
          verbatim: [],
        }),
        toolName: 'spoken_line',
        toolDescription: 'Write the one text Hale will send.',
        toolSchema: TOOL_SCHEMA,
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      text = (out?.value?.text ?? '').trim();
    }
    if (!text) {
      failed += 1;
      console.info(`FAIL  ${fixture.id}  empty line (nothing would be sent)`);
      continue;
    }
    const verdict = await judge(fixture.id, {
      ask: fixture.ask,
      language: fixture.language,
      facts,
      message: text,
      secrets: fixture.secrets,
      watchFor: fixture.watchFor,
    });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(18)} judge:${verdict.score}  ${JSON.stringify(text)}`,
    );
    if (!ok) console.info(`      judge: ${verdict.reason ?? ''}`);
  }
  console.info(
    `live API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (!broken) process.exit(failed === 0 ? 0 : 1);
  console.info(`broken-mode calibration (must fail): ${failed > 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('common-time eval harness error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
