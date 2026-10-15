#!/usr/bin/env node
/**
 * Offline re-record cost for VIL-413, VIL-302, and VIL-434.
 *
 * No network and no model call. Prices are the list rates in harness.mjs.
 * Tokens are characters / 4, the same ratio the expected-cost lines use.
 *
 * What this branch changes that misses a cache:
 *   - coach-channel-sms.md (length is advice; code no longer cuts). The subject
 *     prefix is the skill, so every coach-channel fixture misses.
 *   - onboarding-friend.md (US ZIP as well as a Canadian postal code). Friend
 *     voice loads that skill. There is no separate recorded suite; the live
 *     path pays one compose per onboarding step, estimated below as a single
 *     cold prefix plus one reply.
 *   - Six judge-graded cases (zh, ar, US ZIP, photo, video, crisis) are not
 *     in the coach corpus. The photo case adds image input tokens. The
 *     Chinese autonomy fixture inside the coach corpus is a different call.
 *   - VIL-434 deletes the shorten rewrite. Those calls are not in this total.
 *     The old path spent one extra coach-channel-shorten call when a sentence
 *     did not fit two segments. A re-record does not buy that call.
 *
 * Judge samples follow the coach-channel median of three. A cache hit on an
 * unchanged judge prompt is not assumed: a new subject reply is a new payload.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COACH_CHANNEL_FIXTURES } from '../coach-channel-fixtures.mjs';
import { VIL413_JUDGE_CASES } from '../vil413-judge-fixtures.mjs';
import { PRICE } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SUBJECT = 'claude-sonnet-5-5';
const JUDGE = 'claude-sonnet-5-5';
const JUDGE_SAMPLES = 3;
const SUBJECT_CALLS_PER_FIXTURE = 2;

function tokens(chars) {
  return Math.ceil(chars / 4);
}

function usd(model, inputTokens, outputTokens) {
  const price = PRICE[model];
  if (!price) throw new Error(`vil413-estimate: no price for ${model}`);
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
}

function skillChars(name) {
  return readFileSync(join(REPO, 'packages', 'agent', 'skills', name), 'utf8').length;
}

export function vil413Estimate() {
  const coachSkill = skillChars('coach-channel-sms.md');
  const friendSkill = skillChars('onboarding-friend.md');
  const fixtures = COACH_CHANNEL_FIXTURES.length;
  const userChars = 1_500;
  const answerChars = 600;
  const judgeSystem = 2_000;

  const subjectPrefix = tokens(coachSkill);
  const subjectUser = tokens(userChars);
  const subjectOut = tokens(answerChars);
  // Prefix written once, then read. 1.25× write, 0.1× read, matching recording-price.mjs.
  const subjectCalls = fixtures * SUBJECT_CALLS_PER_FIXTURE;
  const subjectInput =
    subjectPrefix * 1.25 + subjectPrefix * 0.1 * (subjectCalls - 1) + subjectUser * subjectCalls;
  const subjectOutput = subjectOut * subjectCalls;

  const judgePrefix = tokens(judgeSystem);
  const judgeUser = tokens(answerChars + userChars);
  const judgeOut = tokens(400);
  const judgeCalls = fixtures * JUDGE_SAMPLES;
  const judgeInput =
    judgePrefix * 1.25 + judgePrefix * 0.1 * (judgeCalls - 1) + judgeUser * judgeCalls;
  const judgeOutput = judgeOut * judgeCalls;

  const friendPrefix = tokens(friendSkill);
  const friendUser = tokens(800);
  const friendOut = tokens(280);
  const friendInput = friendPrefix * 1.25 + friendUser;
  const friendOutput = friendOut;

  const added = VIL413_JUDGE_CASES.length;
  const addedCalls = added * SUBJECT_CALLS_PER_FIXTURE;
  const addedUser = VIL413_JUDGE_CASES.reduce(
    (sum, item) => sum + tokens(1_200 + (item.imageTokens ?? 0)) * SUBJECT_CALLS_PER_FIXTURE,
    0,
  );
  const addedInput = subjectPrefix * 1.25 + subjectPrefix * 0.1 * (addedCalls - 1) + addedUser;
  const addedOutput = subjectOut * addedCalls;
  const addedJudgeCalls = added * JUDGE_SAMPLES;
  const addedJudgeInput =
    judgePrefix * 1.25 + judgePrefix * 0.1 * (addedJudgeCalls - 1) + judgeUser * addedJudgeCalls;
  const addedJudgeOutput = judgeOut * addedJudgeCalls;

  const lines = [
    {
      suite: 'coach-channel subject',
      why: 'coach-channel-sms.md changed; VIL-434 no longer trims the graded body',
      calls: subjectCalls,
      usd: usd(SUBJECT, subjectInput, subjectOutput),
    },
    {
      suite: 'coach-channel judge',
      why: 'three samples per new reply',
      calls: judgeCalls,
      usd: usd(JUDGE, judgeInput, judgeOutput),
    },
    {
      suite: 'onboarding-friend cold compose',
      why: 'onboarding-friend.md now accepts a US ZIP; one cold step',
      calls: 1,
      usd: usd(SUBJECT, friendInput, friendOutput),
    },
    {
      suite: 'vil413 judge cases subject',
      why: 'zh, ar, US ZIP, photo, video, crisis; photo includes image tokens',
      calls: addedCalls,
      usd: usd(SUBJECT, addedInput, addedOutput),
    },
    {
      suite: 'vil413 judge cases judge',
      why: 'three samples per new case',
      calls: addedJudgeCalls,
      usd: usd(JUDGE, addedJudgeInput, addedJudgeOutput),
    },
  ];
  const total = lines.reduce((sum, line) => sum + line.usd, 0);
  return {
    fixtures,
    subjectModel: SUBJECT,
    judgeModel: JUDGE,
    omitted: 'coach-channel-shorten calls (VIL-434 deleted that rewrite)',
    lines,
    totalUsd: total,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const estimate = vil413Estimate();
  console.info(`vil413-estimate | fixtures=${estimate.fixtures} | no API calls`);
  for (const line of estimate.lines) {
    console.info(
      `${line.suite.padEnd(32)} ${String(line.calls).padStart(4)} calls  $${line.usd.toFixed(2)}  ${line.why}`,
    );
  }
  console.info(`omitted: ${estimate.omitted}`);
  console.info(`total: $${estimate.totalUsd.toFixed(2)} USD`);
}
