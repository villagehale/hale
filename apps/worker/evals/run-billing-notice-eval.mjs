// VIL-735 billing-notice eval (hard rule #8: no LLM mocking). Nothing is recorded yet.
//
//   node evals/run-billing-notice-eval.mjs --dry           # $0, no API
//   node evals/run-billing-notice-eval.mjs --cached-only   # the same zero-call check
//
// Both run the real code floor and regex floor on the planted texts, and price a full
// recording of the real writer skill, the real check skill, the judge and the real claim
// reader with real billing rows. `--live` refuses until the recording is approved.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { BILLING_NOTICE_PLANTED, BILLING_NOTICE_WRITER_CASES } from './billing-notice-fixtures.mjs';
import { estimateTokens, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import { REPO_ROOT, readJudgeModel } from './lib/harness.mjs';

const WEB = join(REPO_ROOT, 'apps', 'web');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const RECONCILE = join(WEB, 'lib', 'channel', 'reconcile');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const COMPOSE_SRC = join(WEB, 'lib', 'billing', 'notices', 'compose.ts');

/** A draft the check and the reader are priced on: longer than a real one. */
const DRAFT_FOR_PRICING = "You're on Plus through November 21, 2027. ".repeat(6);
const JUDGE_INPUT_TOKENS = 1500;
const JUDGE_MAX_OUTPUT = 400;
const COST_CEILING_USD = 1;
const NOW = new Date('2026-11-23T18:00:00Z');
const TIME_ZONE = 'America/Toronto';
const FAMILY = 'eval';

register({ tsconfig: join(WEB, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function loadSubject() {
  const agent = await importTs(AGENT_SRC);
  const [writerSkill, checkSkill, readerSkill] = await Promise.all(
    ['billing-notice', 'billing-notice-check', 'claim-read'].map((name) =>
      agent.loadSkill(join(SKILLS, `${name}.md`)),
    ),
  );
  return {
    writerSkill,
    checkSkill,
    readerSkill,
    writerLane: agent.pickLane(writerSkill.meta.task),
    checkLane: agent.pickLane(checkSkill.meta.task),
    readerLane: agent.pickLane(readerSkill.meta.task),
    judgeModel: await readJudgeModel('sonnet'),
    compose: await importTs(COMPOSE_SRC),
    billingText: await importTs(join(RECONCILE, 'billing-text.ts')),
    claims: await importTs(join(RECONCILE, 'claims.ts')),
    rows: await importTs(join(RECONCILE, 'candidate-rows.ts')),
    candidates: await importTs(join(RECONCILE, 'candidates.ts')),
    reader: await importTs(join(RECONCILE, 'claim-reader.ts')),
    sentences: await importTs(join(RECONCILE, 'sentences.ts')),
  };
}

function checkCostUsd(subject, fixture) {
  const { compose, checkSkill, checkLane } = subject;
  const input =
    estimateTokens(checkSkill.instructions) +
    estimateTokens(compose.billingNoticeCheckMessage(fixture.facts, DRAFT_FOR_PRICING)) +
    estimateTokens(JSON.stringify(compose.BILLING_NOTICE_CHECK_JSON_SCHEMA));
  return worstCaseUsd(checkLane.model, input, compose.BILLING_NOTICE_CHECK_MAX_TOKENS);
}

function readerCostUsd(subject, fixture) {
  const { rows, candidates, reader, sentences, readerSkill, readerLane } = subject;
  const set = candidates.buildClaimCandidates(
    FAMILY,
    rows.billingClaimRows(FAMILY, fixture.claimFacts, NOW),
    TIME_ZONE,
  );
  const message = reader.claimReadUserMessage({
    languageHint: fixture.claimFacts.language,
    now: reader.claimReadNow(NOW, TIME_ZONE),
    segments: sentences.segmentSentences(DRAFT_FOR_PRICING, fixture.claimFacts.language),
    candidates: set,
  });
  const input =
    estimateTokens(readerSkill.instructions) +
    estimateTokens(message) +
    estimateTokens(JSON.stringify(reader.CLAIM_READ_JSON_SCHEMA));
  return worstCaseUsd(readerLane.model, input, reader.CLAIM_READ_MAX_TOKENS);
}

function priceFullRecording(subject) {
  const { compose, writerSkill, writerLane, judgeModel } = subject;
  const totals = { writer: 0, check: 0, judge: 0, reader: 0 };
  for (const fixture of BILLING_NOTICE_WRITER_CASES) {
    const input =
      estimateTokens(writerSkill.instructions) +
      estimateTokens(compose.billingNoticeUserMessage(fixture.facts)) +
      estimateTokens(JSON.stringify(compose.BILLING_NOTICE_JSON_SCHEMA));
    totals.writer += worstCaseUsd(writerLane.model, input, compose.BILLING_NOTICE_MAX_TOKENS);
    totals.check += checkCostUsd(subject, fixture);
    totals.judge += worstCaseUsd(judgeModel, JUDGE_INPUT_TOKENS, JUDGE_MAX_OUTPUT);
    totals.reader += readerCostUsd(subject, fixture);
  }
  for (const fixture of BILLING_NOTICE_PLANTED) {
    totals.check += checkCostUsd(subject, fixture);
    totals.reader += readerCostUsd(subject, fixture);
  }
  return totals;
}

/** The floors are code, so these run for real on every replay. */
function runFloors(subject) {
  const { billingText, claims } = subject;
  const refusedBy = {
    code_floor: (text, facts) => billingText.billingTextConflict(text, facts) !== null,
    regex_floor: (text) => claims.claimsNoLedgerCanBack(text).length > 0,
  };
  const lines = [];
  let failed = 0;
  for (const fixture of BILLING_NOTICE_PLANTED) {
    const refuses = refusedBy[fixture.layer];
    if (!refuses) {
      lines.push(`  PEND  ${fixture.id.padEnd(30)} ${fixture.layer} (needs a recording)`);
      continue;
    }
    const caught = refuses(fixture.text, fixture.claimFacts);
    const control = !refuses(fixture.control, fixture.claimFacts);
    const ok = caught && control;
    if (!ok) failed += 1;
    lines.push(
      `  ${ok ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(30)} ${fixture.layer} refused=${caught} control_passed=${control}`,
    );
  }
  return { lines, failed };
}

async function dryRun() {
  const subject = await loadSubject();
  const { lines, failed } = runFloors(subject);
  const totals = priceFullRecording(subject);
  const usd = totals.writer + totals.check + totals.judge + totals.reader;
  console.info(
    [
      `billing-notice | --dry | writer cases=${BILLING_NOTICE_WRITER_CASES.length} planted=${BILLING_NOTICE_PLANTED.length}`,
      `writer=${subject.writerLane.model} check=${subject.checkLane.model} judge=${subject.judgeModel} reader=${subject.readerLane.model}`,
      ...lines,
      `  writer $${totals.writer.toFixed(4)} | check $${totals.check.toFixed(4)} | judge $${totals.judge.toFixed(4)} | reader $${totals.reader.toFixed(4)}`,
      `live API calls: 0 | worst-case cost of a full recording: $${usd.toFixed(4)} USD (ceiling $${COST_CEILING_USD})`,
    ].join('\n'),
  );
  if (usd > COST_CEILING_USD) {
    throw new Error(`billing-notice --dry: $${usd.toFixed(4)} exceeds the ceiling`);
  }
  if (failed > 0) throw new Error(`billing-notice: ${failed} planted text(s) got past a floor`);
}

async function main() {
  const mode = parseEvalFlagsOrExit('billing-notice');
  if (mode !== 'dry' && mode !== 'cached-only') {
    console.error('billing-notice: not recorded yet. Pass --dry or --cached-only. No paid evals.');
    process.exit(2);
  }
  await dryRun();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
