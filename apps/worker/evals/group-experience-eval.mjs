// VIL-399 group experience · reader + voice eval.
//
// Not named run-*.mjs, so the Monday eval sweep does not pick it up.
// Not in ci.yml. A cached-only miss must not spend.
// Paid runs use ANTHROPIC_API_KEY_TEST only.
//
//   node evals/group-experience-eval.mjs --dry
//   node evals/group-experience-eval.mjs --cached-only
//   node evals/group-experience-eval.mjs --live --max-usd N   # PAID, spend-capped

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  GROUP_EXPERIENCE_READ_FIXTURES,
  GROUP_EXPERIENCE_VOICE_FIXTURES,
} from './group-experience-fixtures.mjs';
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  evalRunTag,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  scoreFirstJudgeSchema,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const READ_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-experience-read.md');
const VOICE_SKILL_PATH = join(
  REPO_ROOT,
  'packages',
  'agent',
  'skills',
  'group-experience-voice.md',
);
const READING_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-experience',
  'reading.ts',
);
const VOICE_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-experience',
  'voice.ts',
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_REASON_MAX_CHARS = 160;
const JUDGE_TOOL_SCHEMA = scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS);
const JUDGE_MAX_TOKENS = 440;
// Reuse the existing group-poll judges until the dedicated VIL-399 judges
// land with the full eval run. Do not add unmanaged judge files.
const READ_JUDGE_SYSTEM = judgePrompt('group-poll-read', {
  reasonMaxChars: JUDGE_REASON_MAX_CHARS,
});
const VOICE_JUDGE_SYSTEM = judgePrompt('group-poll-voice');
const JUDGE_TOOL = {
  name: 'score',
  description: 'Return the score.',
  input_schema: JUDGE_TOOL_SCHEMA,
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

function suiteUsd({ readLane, voiceLane, readSkill, voiceSkill, reading, voice, judgeModel }) {
  let usd = 0;
  for (const fixture of GROUP_EXPERIENCE_READ_FIXTURES) {
    const userMessage = reading.groupExperienceUserMessage(fixture.input);
    const input =
      estimateTokens(readSkill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: 'group_experience_read',
        input_schema: reading.GROUP_EXPERIENCE_READ_TOOL_SCHEMA,
      });
    usd += priced(readLane.model, input, reading.GROUP_EXPERIENCE_READ_MAX_TOKENS);
    usd += priced(
      judgeModel,
      estimateTokens(READ_JUDGE_SYSTEM) +
        estimateTokens({ situation: fixture.situation, reading: { kind: 'none' } }) +
        estimateTokens(JUDGE_TOOL),
      JUDGE_MAX_TOKENS,
    );
  }
  for (const fixture of GROUP_EXPERIENCE_VOICE_FIXTURES) {
    const userMessage = JSON.stringify({
      skill: 'group-experience-voice',
      kind: fixture.kind,
      language: 'en',
      audience: fixture.audience,
      questions: fixture.questions,
      facts: fixture.facts,
    });
    usd += priced(
      voiceLane.model,
      estimateTokens(voiceSkill.instructions) + estimateTokens(userMessage),
      voice.GROUP_EXPERIENCE_VOICE_MAX_TOKENS,
    );
    usd += priced(
      judgeModel,
      estimateTokens(VOICE_JUDGE_SYSTEM) +
        estimateTokens({
          situation: fixture.situation,
          watchFor: fixture.watchFor,
          facts: fixture.facts,
          message: '',
        }) +
        estimateTokens(JUDGE_TOOL) +
        voice.GROUP_EXPERIENCE_VOICE_MAX_TOKENS,
      JUDGE_MAX_TOKENS,
    );
  }
  return usd;
}

function estimateLine(usd) {
  return `group-experience: one estimate to record ${GROUP_EXPERIENCE_READ_FIXTURES.length} reader fixtures and ${GROUP_EXPERIENCE_VOICE_FIXTURES.length} voice fixtures (subject + judge), priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

function maxUsdArg(argv) {
  const i = argv.findIndex((arg) => arg === '--max-usd' || arg.startsWith('--max-usd='));
  if (i < 0) return Number.NaN;
  return Number(argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1]);
}

async function main() {
  const dry = process.argv.includes('--dry') || process.argv.includes('--estimate');
  const cachedOnly = process.argv.includes('--cached-only');
  const live = process.argv.includes('--live');
  if ([dry, cachedOnly, live].filter(Boolean).length !== 1) {
    console.error('group-experience: pass exactly one of --dry, --cached-only, --live --max-usd N');
    process.exit(2);
  }
  if (live) {
    const testKey = process.env.ANTHROPIC_API_KEY_TEST?.trim();
    if (!testKey) {
      console.error('group-experience: --live uses ANTHROPIC_API_KEY_TEST only');
      process.exit(2);
    }
    process.env.ANTHROPIC_API_KEY = testKey;
  }

  const agent = await importTs(AGENT_SRC);
  const reading = await importTs(READING_SRC);
  const voice = await importTs(VOICE_SRC);
  const readSkill = await agent.loadSkill(READ_SKILL_PATH);
  const voiceSkill = await agent.loadSkill(VOICE_SKILL_PATH);
  const readLane = agent.pickLane(readSkill.meta.task);
  const voiceLane = agent.pickLane(voiceSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = suiteUsd({
    readLane,
    voiceLane,
    readSkill,
    voiceSkill,
    reading,
    voice,
    judgeModel,
  });

  if (dry) {
    console.info(estimateLine(usd));
    return;
  }
  if (live) {
    const maxUsd = maxUsdArg(process.argv);
    if (!(maxUsd > 0)) {
      console.error('group-experience: --live needs --max-usd N');
      process.exit(2);
    }
    if (usd > maxUsd) {
      console.error(estimateLine(usd));
      console.error(
        `group-experience: estimate is above --max-usd $${maxUsd}. stopped. nothing recorded.`,
      );
      process.exit(1);
    }
    installEvalSpendCap();
  }
  console.info(estimateLine(usd));

  const getClient = lazyAnthropic('group-experience');
  const cost = makeCost();
  const judgeOptions = { toolSchema: JUDGE_TOOL_SCHEMA, maxOutputTokens: JUDGE_MAX_TOKENS };
  const readJudge = makeJudge(
    judgeModel,
    READ_JUDGE_SYSTEM,
    'group-experience-read',
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  const voiceJudge = makeJudge(
    judgeModel,
    VOICE_JUDGE_SYSTEM,
    'group-experience-voice',
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  let allPass = true;

  for (const fixture of GROUP_EXPERIENCE_READ_FIXTURES) {
    const { value } = await cachedToolCall({
      tag: evalRunTag(`group-experience-read:${fixture.id}`),
      lane: readLane,
      system: readSkill.instructions,
      userMessage: reading.groupExperienceUserMessage(fixture.input),
      toolName: 'group_experience_read',
      toolDescription: 'Name the moment this group message is, or none.',
      toolSchema: reading.GROUP_EXPERIENCE_READ_TOOL_SCHEMA,
      maxTokens: reading.GROUP_EXPERIENCE_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const verdict = await readJudge(fixture.id, { situation: fixture.situation, reading: value });
    const ok = verdict.score >= JUDGE_MIN && fixture.accept.includes(value.kind);
    if (!ok) allPass = false;
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  read:${fixture.id}  kind=${value.kind} judge:${verdict.score}`,
    );
    if (!ok) console.info(`      · ${verdict.reason}`);
  }

  for (const fixture of GROUP_EXPERIENCE_VOICE_FIXTURES) {
    const input = {
      skill: 'group-experience-voice',
      kind: fixture.kind,
      language: 'en',
      audience: fixture.audience,
      questions: fixture.questions,
      facts: fixture.facts,
    };
    const { value } = await cachedToolCall({
      tag: evalRunTag(`group-experience-voice:${fixture.id}`),
      lane: voiceLane,
      system: voiceSkill.instructions,
      userMessage: JSON.stringify(input),
      toolName: 'send_group_experience_line',
      toolDescription: 'The one message Hale sends, or a decision to stay quiet.',
      toolSchema: voice.GROUP_EXPERIENCE_VOICE_TOOL_SCHEMA,
      maxTokens: voice.GROUP_EXPERIENCE_VOICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const line = String(value.line ?? '').trim();
    const usable = value.send === true && line.length > 0;
    const verdict = await voiceJudge(fixture.id, {
      situation: fixture.situation,
      watchFor: fixture.watchFor,
      facts: input.facts,
      message: line,
    });
    const ok = usable && verdict.score >= JUDGE_MIN;
    if (!ok) allPass = false;
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  voice:${fixture.id}  judge:${verdict.score}${usable ? '' : ' unusable'}  "${line}"`,
    );
    if (!ok) console.info(`      · ${verdict.reason}`);
  }

  console.info(
    `live API calls this run: ${cost.liveCalls} | actual cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (!allPass) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'group-experience failed');
    process.exit(1);
  });
}

export { estimateLine, main, suiteUsd };
