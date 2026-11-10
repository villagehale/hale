// Dry cost for one VIL-445 live run. No API. Worst-case = max_tokens on every
// attempt the production reader and voice will make, plus one judge draw.
//
// Judge is the harness default (Haiku 5.5). This suite does not opt into the
// median-of-three samples. Opus is priced only as a comparison line.

import { CARPOOL_JUDGE_CASES } from './carpool-judge-fixtures.mjs';
import { PRICE } from './lib/harness.mjs';

export const READ_ATTEMPTS = 2;
export const VOICE_ATTEMPTS = 2;
export const JUDGE_DRAWS = 1;
export const READ_MAX_TOKENS = 300;
export const VOICE_MAX_TOKENS = [200, 120];
export const JUDGE_MAX_TOKENS = 440;
export const JUDGE_REASON_MAX_CHARS = 160;

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

export function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function row(caseId, role, model, attempt, input, output) {
  return {
    caseId,
    role,
    model,
    attempt,
    input,
    output,
    usd: priced(model, input, output),
  };
}

export function suiteBreakdown(input) {
  const rows = [];
  for (const fixture of CARPOOL_JUDGE_CASES) {
    const userMessage = JSON.stringify({ situation: fixture.situation });
    const readInput =
      estimateTokens(input.readingInstructions) +
      estimateTokens(userMessage) +
      estimateTokens(input.readingTool ?? '');
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      rows.push(row(fixture.id, 'reader', input.readModel, attempt, readInput, READ_MAX_TOKENS));
    }
    const voiceInput = estimateTokens(input.voiceInstructions) + estimateTokens(userMessage);
    for (let attempt = 1; attempt <= VOICE_ATTEMPTS; attempt += 1) {
      rows.push(
        row(
          fixture.id,
          'voice',
          input.voiceModel,
          attempt,
          voiceInput,
          VOICE_MAX_TOKENS[attempt - 1],
        ),
      );
    }
    const judgeInput =
      estimateTokens(input.judgeSystem) +
      estimateTokens({
        situation: fixture.situation,
        rubric: fixture.rubric,
        observation: fixture.situation,
      }) +
      estimateTokens(input.judgeSchema);
    for (let draw = 1; draw <= JUDGE_DRAWS; draw += 1) {
      rows.push(row(fixture.id, 'judge', input.judgeModel, draw, judgeInput, JUDGE_MAX_TOKENS));
    }
  }
  const usd = rows.reduce((sum, item) => sum + item.usd, 0);
  const byRole = {};
  for (const item of rows) {
    byRole[item.role] ??= { calls: 0, usd: 0, model: item.model };
    byRole[item.role].calls += 1;
    byRole[item.role].usd += item.usd;
  }
  return { rows, usd, byRole };
}

export function formatEstimate(breakdown) {
  const lines = [
    `carpool: dry worst-case for one live run of ${CARPOOL_JUDGE_CASES.length} cases (reader + voice retries + one judge draw), priced at max_tokens. live API calls: 0. nothing written.`,
    ...breakdown.rows.map(
      (item) =>
        `  ${item.caseId}  ${item.role}  ${item.model}  attempt ${item.attempt}  in=${item.input} out=${item.output}  $${item.usd.toFixed(6)}`,
    ),
    `  by role  reader $${breakdown.byRole.reader.usd.toFixed(4)} (${breakdown.byRole.reader.calls}× ${breakdown.byRole.reader.model})  voice $${breakdown.byRole.voice.usd.toFixed(4)} (${breakdown.byRole.voice.calls}× ${breakdown.byRole.voice.model})  judge $${breakdown.byRole.judge.usd.toFixed(4)} (${breakdown.byRole.judge.calls}× ${breakdown.byRole.judge.model})`,
    `  total  ${breakdown.rows.length} calls  $${breakdown.usd.toFixed(4)} USD`,
  ];
  return lines.join('\n');
}
