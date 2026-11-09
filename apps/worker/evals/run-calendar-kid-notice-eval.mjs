// The 1:1 kid calendar notice · writer eval (VIL-570; hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/spoken-line.md, purpose
// `calendar_kid_change`) through the REAL forced-tool-JSON request shape
// apps/web/lib/channel/spoken-line.ts builds — REPLICATED here because that module sits
// behind the web app's `~/` alias (`userMessage`, the tool name and schema, MAX_TOKENS).
// The skill body and model routing are imported live, so a skill edit re-keys the cache.
//
// Recorded; CI replays it --cached-only:
//   node --env-file=../../.env evals/run-calendar-kid-notice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-calendar-kid-notice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-calendar-kid-notice-eval.mjs --cached-only                    # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  CALENDAR_KID_NOTICE_FIXTURES,
  CALENDAR_KID_NOTICE_HOSTILE_FIXTURES,
} from './calendar-kid-notice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'spoken-line.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const NOTICE_TITLE = join(WEB_ROOT, 'lib', 'integrations', 'calendar-notice-title.ts');
const CONTACT_SHAPE = join(WEB_ROOT, 'lib', 'format', 'contact-shape.ts');

/** Mirrors `outputJsonSchema` and MAX_TOKENS in spoken-line.ts. */
const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const MAX_TOKENS = 400;

/** Mirrors the userMessage spoken-line.ts sends. */
function userMessage(request) {
  return JSON.stringify({
    purpose: request.purpose,
    language: request.language,
    facts: request.facts ?? {},
    verbatim: request.verbatim ?? [],
  });
}

const JUDGE_SYSTEM = judgePrompt('calendar-kid-notice');

const BROKEN = 'Sorry!! cancelled bc of the weather 😢 want me to find a make-up class at 3pm?';

/** Every number in the text must come from the facts; a 24-hour clock may be said in 12. */
function inventedNumber(body, facts) {
  const handed = new Set(
    (Object.values(facts).join(' ').match(/\d+/g) ?? []).map((n) => String(Number(n))),
  );
  for (const n of [...handed]) {
    const hour = Number(n);
    if (hour > 12 && hour < 24) handed.add(String(hour - 12));
  }
  return (body.match(/\d+/g) ?? []).some((n) => !handed.has(String(Number(n))));
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('calendar-kid-notice');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'calendar-kid-notice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `calendar-kid-notice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | write=${model} judge=${judgeModel}`,
  );
  // VIL-633 · the REAL title cleaner and the REAL contact check acceptSpokenLine applies.
  const { noticeTitleFor } = await tsImport(NOTICE_TITLE, import.meta.url);
  const { contactsOutside } = await tsImport(CONTACT_SHAPE, import.meta.url);
  const fixtures = [
    ...CALENDAR_KID_NOTICE_FIXTURES,
    ...CALENDAR_KID_NOTICE_HOSTILE_FIXTURES.map((fixture) => {
      const event = noticeTitleFor(fixture.standing, fixture.rawTitle);
      // In kidNoticeFacts' order: change, day, event, then the rest.
      const { change, day, ...rest } = fixture.request.facts;
      const facts = { change, day, ...(event === '' ? {} : { event }), ...rest };
      return { ...fixture, request: { ...fixture.request, facts } };
    }),
  ];
  const results = [];
  for (const fixture of fixtures) {
    const message = userMessage(fixture.request);
    const raw = broken
      ? BROKEN
      : (
          await cachedToolCall({
            tag: `calendar-kid-notice:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: message,
            toolName: 'spoken_line',
            toolSchema: TOOL_SCHEMA,
            toolDescription: 'Write the one text Hale will send.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.text;
    const body = raw.replace(/\s+/g, ' ').trim();
    const failures = [];
    if (body === '') failures.push('empty');
    for (const pattern of fixture.mustMention) {
      if (!pattern.test(body)) failures.push(`missing:${pattern.source}`);
    }
    for (const pattern of fixture.forbiddenPatterns) {
      if (pattern.test(body)) failures.push(`forbidden:${pattern.source}`);
    }
    if (inventedNumber(body, fixture.request.facts)) failures.push('invented_number');
    const contacts = contactsOutside(body, fixture.request.verbatim ?? []);
    if (contacts.length > 0) failures.push(`gate_refused:${contacts.join('+')}`);
    const verdict = await judge(fixture.id, {
      request: message,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(20)} "${r.body.slice(0, 110)}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('calendar-kid-notice', [judge.plan]));
    process.exit(0);
  }
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('calendar-kid-notice eval harness error:', err);
  process.exit(2);
});
