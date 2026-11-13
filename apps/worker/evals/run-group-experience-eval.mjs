// VIL-399 group chats · the scene reader and voice, judged (hard rule #8: real cached Claude).
//
// SUBJECTS, in the production request shape:
//   - packages/agent/skills/group-experience-read.md: groupExperienceUserMessage, the read
//     tool schema and the classify lane, parsed by the real parseGroupExperienceReading.
//   - packages/agent/skills/group-experience-voice.md: through the real
//     composeGroupExperienceLine (full draw, then its short retry) with the production
//     validator, the fixture's deny terms standing in for the chat's private terms.
//
// THE HARD ZERO (exit 1): any privacy fixture that fails. A private question not read as
// private_question stays in the group; a group line that carries a secret (found in the
// text, or judged a leak or a hint) is a leak. Quality misses are printed and counted.
//
// CALIBRATION (--broken, deterministic stand-ins, no subject call): a reading that misses
// the moment, a group line that leaks the fixture's secrets, and one canned line with a
// reply keyword for every other moment. It passes (exit 0) only when EVERY stand-in is
// rejected, so the judges are shown to catch a leak and fixed copy, not merely run.
//
//   HALE_SPEND_LEDGER=... node evals/run-group-experience-eval.mjs --live --max-usd 4
//   node evals/run-group-experience-eval.mjs --live --broken --max-usd 4
//   node evals/run-group-experience-eval.mjs --cached-only            # CI
//   node evals/run-group-experience-eval.mjs --cached-only --broken   # CI calibration

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { readCapUsd } from '../../web/lib/testing/spend-cap.mjs';
import {
  FIXED_COPY_LINE,
  GROUP_EXPERIENCE_READ_FIXTURES,
  GROUP_EXPERIENCE_VOICE_FIXTURES,
  leakingLine,
} from './group-experience-fixtures.mjs';
import {
  JUDGE_MIN,
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  evalRunTag,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const HARD_CAP_USD = 4;
const SUITE = 'group-experience';
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const EXPERIENCE = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-experience');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const JUDGE_MAX_TOKENS = 600;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const READ_JUDGE_SYSTEM = judgePrompt('group-experience-read');
const VOICE_JUDGE_SYSTEM = judgePrompt('group-experience-voice');
const PRIVACY_JUDGE_SYSTEM = judgePrompt('group-experience-privacy');

/** The production composer's option clean-up (voice.ts optionLabels): trim, drop repeats. */
function optionLabels(raw) {
  const out = [];
  const seen = new Set();
  for (const value of raw ?? []) {
    const text = String(value).trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

const sameInstant = (a, b) => a !== null && b !== null && Date.parse(a) === Date.parse(b);

function readMisses(fixture, reading) {
  if (!reading) return ['no reading'];
  const misses = [];
  if (!fixture.accept.includes(reading.kind)) {
    misses.push(`kind=${reading.kind}, wanted ${fixture.accept.join('|')}`);
  }
  if (fixture.response && reading.response !== fixture.response) {
    misses.push(`response=${reading.response}, wanted ${fixture.response}`);
  }
  if (fixture.samePlan !== undefined && reading.samePlan !== fixture.samePlan) {
    misses.push(`samePlan=${reading.samePlan}, wanted ${fixture.samePlan}`);
  }
  if (fixture.optionKey && reading.optionKey !== fixture.optionKey) {
    misses.push(`optionKey=${reading.optionKey}, wanted ${fixture.optionKey}`);
  }
  if (fixture.starts) {
    const ok =
      reading.starts.length === fixture.starts.length &&
      fixture.starts.every((want, i) => sameInstant(reading.starts[i] ?? null, want));
    if (!ok) misses.push(`starts=${JSON.stringify(reading.starts)}`);
  }
  return misses;
}

function leakedSecrets(fixture, line) {
  const folded = line.toLowerCase();
  return (fixture.secrets ?? []).filter((secret) => folded.includes(secret.toLowerCase()));
}

async function main() {
  assertRunFlags(['--env-file', '--max-usd', '--broken']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  if (process.argv.includes('--live')) {
    const cap = readCapUsd();
    if (cap === null || cap > HARD_CAP_USD) {
      console.error(`${SUITE}: --live needs --max-usd at most ${HARD_CAP_USD}. nothing run.`);
      process.exit(2);
    }
  }
  installEvalSpendCap();
  const getClient = lazyAnthropic(SUITE);
  const cost = makeCost();

  const agent = await importTs(AGENT_SRC);
  const reading = await importTs(join(EXPERIENCE, 'reading.ts'));
  const voice = await importTs(join(EXPERIENCE, 'voice.ts'));
  const denyTerms = await importTs(join(EXPERIENCE, 'deny-terms.ts'));
  const readSkill = await agent.loadSkill(join(SKILLS, 'group-experience-read.md'));
  const voiceSkill = await agent.loadSkill(join(SKILLS, 'group-experience-voice.md'));
  const readLane = agent.pickLane(readSkill.meta.task);
  const voiceLane = agent.pickLane(voiceSkill.meta.task);
  const judgeOptions = { maxOutputTokens: JUDGE_MAX_TOKENS };
  const judgeModel = await readJudgeModel();
  const privacyJudgeModel = await readJudgeModel('sonnet');
  const readJudge = makeJudge(
    judgeModel,
    READ_JUDGE_SYSTEM,
    `${SUITE}-read`,
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  // The cheap judge passed `none` readings of private questions in calibration: privacy
  // reads are judged by the model that rejects them (cheapest judge that works).
  const privacyReadJudge = makeJudge(
    privacyJudgeModel,
    READ_JUDGE_SYSTEM,
    `${SUITE}-privacy-read`,
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  const voiceJudge = makeJudge(
    judgeModel,
    VOICE_JUDGE_SYSTEM,
    `${SUITE}-voice`,
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  const privacyJudge = makeJudge(
    privacyJudgeModel,
    PRIVACY_JUDGE_SYSTEM,
    `${SUITE}-privacy`,
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );

  console.info(
    `${SUITE} eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | judges=${judgeModel}, privacy=${privacyJudgeModel}`,
  );
  const rows = [];

  for (const fixture of GROUP_EXPERIENCE_READ_FIXTURES) {
    let parsed;
    if (broken) {
      // Stand-in: the moment missed (a private question left in the group, chatter answered).
      const kind = fixture.accept.includes('none') ? 'rsvp_open' : 'none';
      parsed = reading.parseGroupExperienceReading({ kind, confidence: 'high' });
    } else {
      const { value } = await cachedToolCall({
        tag: evalRunTag(`${SUITE}-read:${fixture.id}`),
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
      parsed = reading.parseGroupExperienceReading(value);
    }
    const misses = readMisses(fixture, parsed);
    const verdict = await (fixture.privacy ? privacyReadJudge : readJudge)(fixture.id, {
      situation: fixture.situation,
      message: fixture.input.text,
      live: fixture.input.live,
      clock: fixture.input.clock,
      expected: fixture.accept,
      reading: parsed,
    });
    const failures = [...misses];
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    rows.push({
      label: `read:${fixture.id}`,
      privacy: fixture.privacy === true,
      shown: parsed ? `kind=${parsed.kind}` : 'no reading',
      failures,
      // Calibration reads the judge alone; the field check is reported beside it.
      judgeRejected: verdict.score < JUDGE_MIN,
      checkRejected: misses.length > 0,
    });
  }

  const sentLines = [];
  for (const fixture of GROUP_EXPERIENCE_VOICE_FIXTURES) {
    const input = {
      skill: 'group-experience-voice',
      kind: fixture.kind,
      language: 'en',
      audience: fixture.audience,
      questions: fixture.questions,
      facts: fixture.facts,
    };
    let sent = '';
    let unsent = null;
    if (broken) {
      sent = fixture.privacy ? leakingLine(fixture) : FIXED_COPY_LINE;
    } else {
      const composer = {
        async compose(turn, options) {
          const prompt = options?.prompt ?? 'full';
          const { value } = await cachedToolCall({
            tag: evalRunTag(`${SUITE}-voice:${fixture.id}:${prompt}`),
            lane: voiceLane,
            system: voiceSkill.instructions,
            userMessage: JSON.stringify({ ...turn, retry: prompt === 'short' }),
            toolName: 'send_group_experience_line',
            toolDescription: 'The one message Hale sends, or a decision to stay quiet.',
            toolSchema: voice.GROUP_EXPERIENCE_VOICE_TOOL_SCHEMA,
            maxTokens: prompt === 'short' ? 160 : voice.GROUP_EXPERIENCE_VOICE_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          });
          if (!value.send) throw new Error('group experience voice: send false');
          return { line: String(value.line ?? '').trim(), options: optionLabels(value.options) };
        },
      };
      // The deny terms production would hold for this chat's Hale households: no more.
      const deny = denyTerms.denyTermsFromSlices(fixture.households ?? []);
      const spoken = await voice.composeGroupExperienceLine(input, composer, deny);
      if (spoken.status === 'composed') sent = spoken.line;
      else unsent = spoken.reason;
    }
    sentLines.push({ id: fixture.id, line: sent });
    const failures = [];
    let judgeRejected = false;
    const quality = await voiceJudge(fixture.id, {
      situation: fixture.situation,
      moment: fixture.kind,
      audience: fixture.audience,
      questions: fixture.questions,
      facts: fixture.facts,
      watchFor: fixture.watchFor,
      message: sent,
    });
    if (fixture.privacy) {
      const leaked = leakedSecrets(fixture, sent);
      const privacy = await privacyJudge(fixture.id, {
        groupSaid: fixture.groupSaid,
        secrets: fixture.secrets,
        message: sent,
      });
      if (leaked.length > 0) failures.push(`leaked: ${leaked.join(', ')}`);
      if (privacy.score < JUDGE_MIN)
        failures.push(`privacy judge:${privacy.score} (${privacy.reason})`);
      judgeRejected = privacy.score < JUDGE_MIN;
      rows.push({
        label: `voice:${fixture.id}`,
        privacy: true,
        shown: unsent ? `(quiet: ${unsent})` : `"${sent}"`,
        failures,
        judgeRejected,
        checkRejected: leaked.length > 0,
      });
      // Quality of a privacy line is reported apart: staying quiet keeps the secret.
      if (sent && quality.score < JUDGE_MIN) {
        rows.push({
          label: `voice:${fixture.id}:quality`,
          privacy: false,
          shown: `"${sent}"`,
          failures: [`judge:${quality.score} (${quality.reason})`],
          judgeRejected: true,
        });
      }
      continue;
    }
    if (!sent) failures.push(`unsent: ${unsent}`);
    if (quality.score < JUDGE_MIN) failures.push(`judge:${quality.score} (${quality.reason})`);
    judgeRejected = quality.score < JUDGE_MIN;
    rows.push({
      label: `voice:${fixture.id}`,
      privacy: false,
      shown: unsent ? `(quiet: ${unsent})` : `"${sent}"`,
      failures,
      judgeRejected,
    });
  }

  // Fixed copy: one line reused across different moments is a template, whatever it says.
  const byLine = new Map();
  for (const { id, line } of sentLines) {
    const key = line.trim().toLowerCase();
    if (!key) continue;
    byLine.set(key, [...(byLine.get(key) ?? []), id]);
  }
  for (const ids of byLine.values()) {
    if (ids.length < 2) continue;
    for (const row of rows) {
      if (ids.some((id) => row.label === `voice:${id}`)) {
        row.failures.push(
          `same line as ${ids.filter((id) => row.label !== `voice:${id}`).join(', ')}`,
        );
      }
    }
  }

  for (const row of rows) {
    const tag = row.privacy ? ' [privacy]' : '';
    console.info(
      `${row.failures.length === 0 ? 'PASS' : 'FAIL'}  ${row.label}${tag}  ${row.shown}`,
    );
    for (const failure of row.failures) console.info(`      · ${failure}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.info(
      dryReportLine(SUITE, [
        readJudge.plan,
        privacyReadJudge.plan,
        voiceJudge.plan,
        privacyJudge.plan,
      ]),
    );
    process.exit(0);
  }

  if (broken) {
    // Each signal is reported on its own: a deterministic check never stands in for a judge.
    const accepted = rows.filter((row) => !row.judgeRejected);
    for (const row of accepted)
      console.info(`      ! a judge accepted the broken stand-in: ${row.label}`);
    const checked = rows.filter((row) => row.checkRejected !== undefined);
    const caught = checked.filter((row) => row.checkRejected).length;
    console.info(
      `broken-mode judges: ${rows.length - accepted.length} of ${rows.length} stand-ins rejected | deterministic checks: ${caught} of ${checked.length} caught (reported, not counted for the judges)`,
    );
    const ok = accepted.length === 0;
    console.info(
      `broken-mode calibration (every stand-in must be rejected by its judge): ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
    );
    process.exit(ok ? 0 : 1);
  }
  const privacyFails = rows.filter((row) => row.privacy && row.failures.length > 0);
  const qualityFails = rows.filter((row) => !row.privacy && row.failures.length > 0);
  console.info(
    `privacy (hard gate): ${privacyFails.length} failed of ${rows.filter((row) => row.privacy).length} | quality: ${qualityFails.length} missed of ${rows.filter((row) => !row.privacy).length} (reported, not gated)`,
  );
  console.info(`overall (real): ${privacyFails.length === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(privacyFails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${SUITE} eval harness error:`, err);
  process.exit(2);
});
