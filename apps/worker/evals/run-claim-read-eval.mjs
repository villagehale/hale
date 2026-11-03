// Claim-read eval · VIL-581 (hard rule #8: no LLM mocking; a HARD CI gate).
//
// The subject is the REAL skill (packages/agent/skills/claim-read.md) through the REAL
// request and the REAL verifier: segmentSentences, buildClaimCandidates,
// claimReadUserMessage, the output schema and tool constants, acceptClaimRead and
// verifyClaimRead are all imported from apps/web/lib/channel/reconcile/*.ts, so a
// recording is the production request and the score is what production would refuse.
// No regex floor (D1): the reader alone must reach the bars.
//
// Bars (lib/claim-read-score.mjs): per language, 100% of false claims caught, >= 95% of
// true replies passed, recall >= 0.95, precision >= 0.90, backing accuracy >= 0.95; per
// kind (languages pooled) recall >= 0.95. Labels are gold refs, never aliases.
//
//   node evals/run-claim-read-eval.mjs --dry           # $0, no API: worst-case $ projection
//   node evals/run-claim-read-eval.mjs --broken        # $0: every degenerate reader must FAIL
//   node evals/run-claim-read-eval.mjs --cached-only   # CI: replay only, $0
//   hale-live <slug> <cap> -- node evals/run-claim-read-eval.mjs --live   # PAID
// Exactly one mode (lib/eval-flags.mjs).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { CLAIM_READ_FIXTURES } from './claim-read-fixtures.mjs';
import {
  DEGENERATE_READERS,
  GOLD_READER,
  failedBars,
  scoreClaimRead,
  scoreLines,
} from './lib/claim-read-score.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'claim-read.md');
const RECONCILE = join(WEB_ROOT, 'lib', 'channel', 'reconcile');
const LANGUAGE_SRC = join(WEB_ROOT, 'lib', 'channel', 'language.ts');
const FAMILY = 'eval';

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function loadSubject() {
  const agent = await importTs(AGENT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  return {
    agent,
    skill,
    lane: agent.pickLane(skill.meta.task),
    model: agent.pickModel(skill.meta.task),
    sentences: await importTs(join(RECONCILE, 'sentences.ts')),
    candidates: await importTs(join(RECONCILE, 'candidates.ts')),
    reader: await importTs(join(RECONCILE, 'claim-reader.ts')),
    verdict: await importTs(join(RECONCILE, 'claim-verdict.ts')),
    language: await importTs(LANGUAGE_SRC),
  };
}

/** The production inputs for one fixture, and the alias <-> ref maps for its labels. */
function prepare(subject, fixture) {
  const rows = fixture.candidates.map(({ ref, startsAt, opensAt, opensForFamilyAt, ...row }) => ({
    familyId: FAMILY,
    ...row,
    ...(startsAt ? { startsAt: new Date(startsAt) } : {}),
    ...(row.source === 'live_sequence' ? { opensAt: opensAt ? new Date(opensAt) : null } : {}),
    ...(opensForFamilyAt ? { opensForFamilyAt: new Date(opensForFamilyAt) } : {}),
  }));
  const refOfRow = new Map(rows.map((row, i) => [row, fixture.candidates[i].ref]));
  const set = subject.candidates.buildClaimCandidates(FAMILY, rows, fixture.timeZone);
  const refOfAlias = new Map([...set.byAlias].map(([alias, row]) => [alias, refOfRow.get(row)]));
  const aliasOfRef = new Map([...refOfAlias].map(([alias, ref]) => [ref, alias]));
  const locale = subject.sentences.claimReadLocale(fixture.language);
  const segments = subject.sentences.segmentSentences(fixture.body, locale);
  const userMessage = subject.reader.claimReadUserMessage({
    languageHint: subject.language.certainLanguageHint(fixture.language),
    now: subject.reader.claimReadNow(new Date(fixture.now), fixture.timeZone),
    ...(fixture.inbound ? { inbound: fixture.inbound } : {}),
    segments,
    candidates: set,
  });
  return { set, refOfAlias, aliasOfRef, locale, segments, userMessage };
}

/** Score one read (production claims: segment index + alias) against the gold labels. */
function scored(subject, fixture, prepared, claims, latencyMs) {
  const { set, refOfAlias, locale, segments } = prepared;
  const verdict = subject.verdict.verifyClaimRead(
    { status: 'read', segments, claims, usage: { input: 0, output: 0 }, latencyMs, attempts: 1 },
    { candidates: set, locale, timeZone: fixture.timeZone },
  );
  const refOf = (alias) => (alias === 'none' ? 'none' : (refOfAlias.get(alias) ?? `?${alias}`));
  return {
    id: fixture.id,
    language: fixture.language,
    category: fixture.category,
    ...(fixture.residual ? { residual: fixture.residual } : {}),
    bodyLength: fixture.body.length,
    latencyMs,
    gold: fixture.expect,
    got: {
      claims: claims.map((c) => ({
        sentence: segments[c.segment].text,
        kind: c.kind,
        row: refOf(c.row),
      })),
      refused: verdict.resolutions
        .filter((r) => r.status === 'refused')
        .map((r) => ({ sentence: segments[r.claim.segment].text, reason: r.reason })),
      minted: verdict.mints.map((w) =>
        refOfAlias.get([...set.byAlias].find(([, row]) => row === w)[0]),
      ),
    },
  };
}

/** A degenerate reader answers in gold space (sentence text, ref); map it to production. */
function degenerateClaims(reader, fixture, prepared) {
  return reader.read(fixture).map((c) => ({
    segment: prepared.segments.findIndex((s) => s.text === c.sentence),
    kind: c.kind,
    row: c.row === 'none' ? 'none' : prepared.aliasOfRef.get(c.row),
  }));
}

function fixtureHeld(r) {
  if (r.gold.refused.length > 0) {
    return r.gold.refused.every((g) =>
      r.got.refused.some((x) => x.sentence === g.sentence && (!g.reason || x.reason === g.reason)),
    );
  }
  return r.got.refused.length === 0;
}

const percentile = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];

function latencyLines(results) {
  const ms = (rows) => rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const all = ms(results);
  const lines = [
    `latency all     n=${all.length} p50=${percentile(all, 0.5)}ms p95=${percentile(all, 0.95)}ms`,
  ];
  const bySize = [...results].sort((a, b) => a.bodyLength - b.bodyLength);
  const third = Math.ceil(bySize.length / 3);
  ['short', 'middle', 'long'].forEach((name, i) => {
    const rows = bySize.slice(i * third, (i + 1) * third);
    if (rows.length === 0) return;
    const sorted = ms(rows);
    lines.push(
      `latency ${name.padEnd(7)} n=${rows.length} chars<=${rows.at(-1).bodyLength} p50=${percentile(sorted, 0.5)}ms p95=${percentile(sorted, 0.95)}ms`,
    );
  });
  return lines;
}

async function main() {
  const mode = parseEvalFlagsOrExit('claim-read');
  const subject = await loadSubject();
  if (mode === 'dry') return dryRun(subject);
  if (mode === 'broken') return brokenRun(subject);
  const cachedOnly = mode === 'cached-only';
  installEvalSpendCap();
  const getClient = mode === 'live' ? lazyAnthropic('claim-read') : noClient('claim-read');
  const cost = makeCost();
  const { reader } = subject;
  console.log(
    `claim-read eval | mode=${mode} | model=${subject.model} | fixtures=${CLAIM_READ_FIXTURES.length}`,
  );

  const results = [];
  const unread = [];
  for (const fixture of CLAIM_READ_FIXTURES) {
    const prepared = prepare(subject, fixture);
    const out = await cachedToolCall({
      tag: `claim-read:${fixture.id}`,
      model: subject.model,
      lane: subject.lane,
      system: subject.skill.instructions,
      userMessage: prepared.userMessage,
      toolName: reader.CLAIM_READ_TOOL_NAME,
      toolDescription: reader.CLAIM_READ_TOOL_DESCRIPTION,
      toolSchema: reader.CLAIM_READ_JSON_SCHEMA,
      maxTokens: reader.CLAIM_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const accepted = reader.acceptClaimRead(out.value, prepared.segments.length);
    if (!accepted.ok) {
      unread.push(fixture.id);
      console.log(`FAIL  ${fixture.id.padEnd(30)} unparseable read (would be failed/unparseable)`);
      continue;
    }
    const r = scored(subject, fixture, prepared, accepted.claims, out.latencyMs);
    results.push(r);
    if (!fixtureHeld(r)) {
      console.log(
        `FAIL  ${r.id.padEnd(30)} ${r.gold.refused.length > 0 ? 'false claim passed' : 'true reply refused'}`,
      );
      console.log(`      body:   ${JSON.stringify(fixture.body)}`);
      console.log(`      gold:   ${JSON.stringify(r.gold.claims.map((c) => [c.kind, c.row]))}`);
      console.log(
        `      got:    ${JSON.stringify(r.got.claims.map((c) => [c.kind, c.row]))} refused=${JSON.stringify(r.got.refused.map((x) => x.reason))}`,
      );
      // The reason field is printed only here, for synthetic fixtures; production never reads it.
      console.log(`      reason: ${JSON.stringify(out.value.reason)}`);
    }
  }

  const score = scoreClaimRead(results);
  for (const line of scoreLines(score)) console.log(line);
  for (const line of latencyLines(results)) console.log(line);
  const failed = failedBars(score);
  for (const f of failed) console.log(`BAR FAIL  ${f.scope} ${f.bar} ${f.hit}/${f.n}`);
  if (unread.length > 0) console.log(`BAR FAIL  unparseable reads: ${unread.join(', ')}`);
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const pass = failed.length === 0 && unread.length === 0;
  console.log(`claim-read gate: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

/** $0: every degenerate reader must fail the bar it names, and the gold reader must pass
 * (the positive control: the fixtures are satisfiable by the production verifier). */
function brokenRun(subject) {
  const runWith = (reader) =>
    CLAIM_READ_FIXTURES.map((fixture) => {
      const prepared = prepare(subject, fixture);
      return scored(subject, fixture, prepared, degenerateClaims(reader, fixture, prepared), 0);
    });
  console.log('claim-read eval | mode=broken (no API calls)');
  const goldFailed = failedBars(scoreClaimRead(runWith(GOLD_READER)));
  const goldOk = goldFailed.length === 0;
  console.log(
    `${goldOk ? 'PASS' : 'FAIL'}  gold reader passes every bar${goldOk ? '' : `: ${goldFailed.map((f) => `${f.scope}/${f.bar} ${f.hit}/${f.n}`).join(', ')}`}`,
  );
  let allFailed = true;
  for (const [name, reader] of Object.entries(DEGENERATE_READERS)) {
    const failed = failedBars(scoreClaimRead(runWith(reader)));
    const hit = failed.filter((f) => f.bar === reader.mustFail);
    const ok = hit.length > 0;
    if (!ok) allFailed = false;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} must fail ${reader.mustFail}: ${ok ? hit.map((f) => `${f.scope} ${f.hit}/${f.n}`).join(', ') : 'it passed'}`,
    );
  }
  const pass = goldOk && allFailed;
  console.log(`broken-mode calibration: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

/** $0: no spend cap, no client. Prices every fixture as uncached (an upper bound per send;
 * forceToolJson can send up to three times, shown as the worst case). */
function dryRun(subject) {
  const { reader } = subject;
  console.log(`claim-read eval | mode=dry (no API calls) | model=${subject.model}`);
  let expected = 0;
  let worst = 0;
  for (const fixture of CLAIM_READ_FIXTURES) {
    const { userMessage } = prepare(subject, fixture);
    const inTokens = estimateTokens(subject.skill.instructions + userMessage);
    const usd = worstCaseUsd(subject.model, inTokens, reader.CLAIM_READ_MAX_TOKENS);
    worst += usd;
    expected += worstCaseUsd(subject.model, inTokens, 0);
    console.log(
      `DRY  claim-read:${fixture.id}  ~${inTokens} in + ${reader.CLAIM_READ_MAX_TOKENS} max out  worst $${usd.toFixed(5)}`,
    );
  }
  console.log(
    `DRY summary | ${CLAIM_READ_FIXTURES.length} calls, all priced as uncached | input-only $${expected.toFixed(4)} | worst (max_tokens every call) $${worst.toFixed(4)} | worst with 3 sends $${(worst * 3).toFixed(4)}`,
  );
  console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
}

main().catch((err) => {
  console.error('claim-read eval harness error:', err);
  process.exit(2);
});
