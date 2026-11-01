// Group plan calendar consent · reader + voice estimate (VIL-503).
//
// Subjects, when a live run is allowed later:
//   packages/agent/skills/group-plan-rsvp-calendar-read.md + calendarConsentUserMessage
//   packages/agent/skills/group-plan-rsvp-calendar-voice.md + groupPlanCalendarLineInput
//
// This file is not named run-*.mjs and is not in package.json, so CI does not
// pick it up. No cache is committed. Do not pass --live until the spend batch
// says so: this script refuses --live.
//
//   node evals/group-plan-rsvp-calendar-eval.mjs --estimate

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICE } from './lib/harness.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const READ_FIXTURES = 4;
const VOICE_FIXTURES = 2;
const READ_MAX = 200;
const VOICE_MAX = 400;
const JUDGE_MAX = 440;
const READ_MODEL = 'claude-sonnet-5';
const VOICE_MODEL = 'claude-haiku-4-5';
const JUDGE_MODEL = 'claude-sonnet-5';

function usd(model, outputTokens, calls) {
  const price = PRICE[model];
  if (!price) throw new Error(`unpriced model ${model}`);
  const inputTokens = 800;
  return ((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * calls;
}

function estimate() {
  const read = usd(READ_MODEL, READ_MAX, READ_FIXTURES);
  const voice = usd(VOICE_MODEL, VOICE_MAX, VOICE_FIXTURES);
  const judge = usd(JUDGE_MODEL, JUDGE_MAX, READ_FIXTURES + VOICE_FIXTURES);
  return read + voice + judge;
}

const mode = process.argv.find((arg) => arg === '--estimate' || arg === '--live' || arg === '--cached-only');
if (mode === '--live') {
  console.error(
    'group-plan-rsvp-calendar: --live is refused in this change. No API call. Record on the spend batch.',
  );
  process.exit(2);
}
if (mode === '--cached-only') {
  console.error(
    'group-plan-rsvp-calendar: no cache committed (not in CI). Re-run is a live recording, which this change does not do.',
  );
  process.exit(1);
}
if (mode !== '--estimate') {
  console.error('group-plan-rsvp-calendar: pass --estimate');
  process.exit(2);
}

const readSkill = readFileSync(
  join(REPO_ROOT, 'packages/agent/skills/group-plan-rsvp-calendar-read.md'),
  'utf8',
);
const voiceSkill = readFileSync(
  join(REPO_ROOT, 'packages/agent/skills/group-plan-rsvp-calendar-voice.md'),
  'utf8',
);
if (!readSkill.includes('name: group-plan-rsvp-calendar-read')) {
  throw new Error('read skill missing');
}
if (!voiceSkill.includes('name: group-plan-rsvp-calendar-voice')) {
  throw new Error('voice skill missing');
}

const total = estimate();
console.log(
  `group-plan-rsvp-calendar: one estimate to record ${READ_FIXTURES} reader fixtures and ${VOICE_FIXTURES} voice fixtures (subject + judge), priced at max_tokens. live API calls: 0. nothing written. $${total.toFixed(4)} USD`,
);
