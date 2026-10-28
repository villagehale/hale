// VIL-444 (T24) group clash alert · judged eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL path: calendars become plans and busy time with `clashCalendar`,
// `findGroupClashes` decides whether the group hears anything, `groupConflictLineInput`
// builds what the model sees, the REAL skill (packages/agent/skills/group-conflict-alert.md)
// writes it through the lane its frontmatter names, with the writer's own tool and token
// cap, and `groupConflictTextUsable` is the only code gate on the text. All imported from
// apps/web/lib/channel/linq/group-conflict.ts, not replicated.
//
// Code grades the planner: no alert where the group should hear nothing (two parents
// covering, a clash already sent, a container), and for a real clash what the second item
// is, who is suggested, who is busy, and who may be asked. A private title must never
// reach the model. The judge (median of three) grades the message on facts, privacy and
// tone, never wording, and must also fail a known-bad message for every alert fixture.
//
//   node evals/run-group-conflict-alert-eval.mjs --dry           # $0, no API: checks the planner, prints the worst case
//   node evals/run-group-conflict-alert-eval.mjs --broken        # $0, no API: calibration, must FAIL
//   node evals/run-group-conflict-alert-eval.mjs --cached-only   # replay only, $0
//   HALE_MAX_USD=… HALE_SPEND_LEDGER=… node --env-file=../../.env evals/run-group-conflict-alert-eval.mjs --live   # PAID
// Exactly one mode. Any other flag, none, or two exits 2 before a client exists.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_CONFLICT_ALERT_FIXTURES } from './group-conflict-alert-fixtures.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  PRICE,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-conflict-alert.md');
const CLASH_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-conflict.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const NAME = 'group-conflict-alert';
const MODES = ['--dry', '--broken', '--cached-only', '--live'];

/** makeJudge's Haiku budget. */
const JUDGE_MAX_TOKENS = 4096;
/** forceToolJson on an `auto`-tool lane: the ask, one re-ask after prose, one retry with thinking off. */
const SUBJECT_SENDS = 3;
/** Anthropic's tool-use system prompt, billed as input on every request with a tool. */
const TOOL_OVERHEAD_TOKENS = 500;
/** The longest message a 400-token answer can be, for pricing the judge before it exists. */
const LONGEST_MESSAGE = 'x'.repeat(1600);

const JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE message Hale (a kids' year planner) posts in a family",
  'group chat about two things the family has on that collide. Everyone in the chat reads it.',
  'You get the input code checked (language, kids, the two items, who is suggested, who else is',
  'free, who is busy, who may be asked), the message, and watchFor notes.',
  'Score 1-5 on FACTS, PRIVACY and TONE, not on wording.',
  'Facts: it names both things and when, plainly, with the kid; it gives the fix as one question:',
  'the suggested person by name taking the plan in suggested.takes; with no suggested person it',
  'says nobody looks free on the calendars and asks who can, and may name the couldAsk people;',
  'when both items are the same child it says the child is double-booked and asks which one,',
  'instead of handing a plan to someone.',
  'A LOW score is any of: a missing or wrong fact; anything invented (a time, place, person,',
  'reason, cause, or anyone being free); calling a couldAsk person free; saying what a busy item',
  'is, that its details are hidden, or its own times; more than one question; a list, numbered',
  'options, a keyword to reply with, a poll or a link; the wrong language for input.language;',
  'in French, tu instead of vous; a greeting or sign-off, emoji, exclamation marks, "we"/"us" for',
  'Hale; more than about three short sentences; a corporate or bot register; a spelling, elision',
  'or accent error.',
  'Reply with ONLY the score tool.',
].join(' ');

function parseMode(args) {
  const unknown = args.filter((arg) => !MODES.includes(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown flag(s): ${unknown.join(' ')}. Allowed: ${MODES.join(' ')}`);
  }
  if (args.length !== 1) {
    throw new Error(`pass exactly one mode: ${MODES.join(' | ')} (live needs --live)`);
  }
  return args[0].slice(2);
}

/** Every mode but --live: reaching a model throws. */
function noClient() {
  return () => {
    throw new Error(`${NAME}: a model call was attempted outside --live`);
  };
}

/** Offline input-token estimate (1 token per 3 bytes, deliberately high). */
const estimateTokens = (text) => Math.ceil(text.length / 3);

function worstCaseUsd(model, inTokens, maxOut) {
  const rates = PRICE[model];
  if (!rates) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
}

/** The fixture's calendars through the real planner: the unsent clash, or null. */
function plan(clash, fixture) {
  const calendar = clash.clashCalendar({
    blocks: fixture.blocks.map((row) => ({
      integrationId: `gcal-${row.owner}`,
      eventId: row.eventId,
      userId: row.owner,
      start: new Date(row.start),
      end: new Date(row.end),
      allDay: false,
      kidRelated: row.title !== null,
      title: row.title,
      status: 'confirmed',
    })),
    events: fixture.events.map((row) => ({
      ...row,
      start: new Date(row.start),
      end: row.end ? new Date(row.end) : null,
    })),
    decidedTaker: () => null,
  });
  const people = [
    ...fixture.people,
    ...calendar.named.filter((named) => !fixture.people.some((person) => person.id === named.id)),
  ];
  const at = (iso) => ({
    plans: calendar.plans,
    busy: calendar.busy,
    people,
    now: new Date(iso),
  });
  // One alert per sweep: an earlier sweep sent its first clash, and the ledger holds its key.
  const sent = new Set(
    fixture.alreadySentAt
      ? clash
          .findGroupClashes(at(fixture.alreadySentAt))
          .slice(0, 1)
          .map((row) => row.dedupeKey)
      : [],
  );
  const found = clash.findGroupClashes(at(fixture.now)).find((row) => !sent.has(row.dedupeKey));
  if (!found) return null;
  return clash.groupConflictLineInput(found, {
    people,
    kids: fixture.kids,
    timeZone: fixture.timeZone,
    language: fixture.language,
  });
}

/** The --broken planner: every overlap is a clash, covered or not, sent or not. */
function brokenPlanAlerts(fixture) {
  const spans = [...fixture.blocks, ...fixture.events].map((row) => ({
    start: Date.parse(row.start),
    end: Date.parse(row.end),
  }));
  return spans.some((a, i) => spans.some((b, j) => i !== j && a.start < b.end && b.start < a.end));
}

/** A message that breaks the bar: hype, a link, two questions, every title said, private ones too. */
function brokenMessage(fixture) {
  const titles = [
    ...fixture.blocks.map((row) => row.title),
    ...fixture.events.map((row) => row.title),
  ]
    .filter(Boolean)
    .join(' and ');
  return `Heads up!! ${titles} collide. Who takes it? Or skip one? Vote at https://hale.example/fix`;
}

function plannerFailures(fixture, line) {
  if (fixture.expect === null) return line ? ['alerted where the group should hear nothing'] : [];
  if (!line) return ['no alert for a real clash'];
  const failures = [];
  const got = {
    second: line.items[1]?.kind,
    suggested: line.suggested?.name ?? null,
    busy: line.busy,
    couldAsk: line.couldAsk,
  };
  for (const [field, want] of Object.entries(fixture.expect)) {
    if (JSON.stringify(got[field]) !== JSON.stringify(want)) {
      failures.push(
        `${field}: got ${JSON.stringify(got[field])}, expected ${JSON.stringify(want)}`,
      );
    }
  }
  const seen = JSON.stringify(line).toLowerCase();
  for (const word of fixture.mustNotLeak ?? []) {
    if (seen.includes(word)) failures.push(`private "${word}" reached the model`);
  }
  return failures;
}

function textFailures(clash, fixture, text) {
  const failures = [];
  if (clash.groupConflictTextUsable(text) === null) {
    failures.push('unusable: empty, a link, or more than one question');
  }
  for (const word of fixture.mustNotLeak ?? []) {
    if (text.toLowerCase().includes(word)) failures.push(`private "${word}" in the message`);
  }
  return failures;
}

async function main() {
  let mode;
  try {
    mode = parseMode(process.argv.slice(2));
  } catch (err) {
    console.error(`${NAME} eval: ${err.message}`);
    process.exit(2);
  }
  if (mode === 'live' && installEvalSpendCap() === null) {
    console.error(`${NAME} eval: --live needs a spend cap (HALE_MAX_USD) and HALE_SPEND_LEDGER`);
    process.exit(2);
  }
  const clash = await importTs(CLASH_SRC);
  const agent = await importTs(AGENT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  console.info(`${NAME} eval | mode=${mode} | compose=${model} judge=${judgeModel}`);
  if (mode === 'dry') return dryRun(clash, skill, model, judgeModel);
  if (mode === 'broken') return brokenRun(clash);

  const cachedOnly = mode === 'cached-only';
  const getClient = mode === 'live' ? lazyAnthropic(NAME) : noClient();
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, NAME, cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });
  const results = [];
  for (const fixture of GROUP_CONFLICT_ALERT_FIXTURES) {
    const line = plan(clash, fixture);
    const failures = plannerFailures(fixture, line);
    if (!line || failures.length > 0) {
      results.push({ fixture, text: line ? '(not written)' : '(no alert)', failures });
      continue;
    }
    const value = (
      await cachedToolCall({
        tag: `${NAME}:${fixture.id}`,
        model,
        lane,
        system: skill.instructions,
        userMessage: clash.groupConflictUserMessage(line),
        toolName: clash.GROUP_CONFLICT_TOOL.name,
        toolDescription: clash.GROUP_CONFLICT_TOOL.description,
        toolSchema: clash.GROUP_CONFLICT_TOOL.inputSchema,
        maxTokens: clash.GROUP_CONFLICT_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      })
    ).value;
    const text = typeof value?.text === 'string' ? value.text.trim() : '';
    failures.push(...textFailures(clash, fixture, text));
    const verdict = await judge(fixture.id, {
      input: line,
      message: text,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} of ${verdict.samples?.join('/')} (${verdict.reason})`);
    }
    const control = await judge(`${fixture.id}:broken-control`, {
      input: line,
      message: brokenMessage(fixture),
      watchFor: fixture.watchFor,
    });
    if (control.score >= JUDGE_MIN) {
      failures.push(
        `judge passed the broken control at ${control.score}: the rubric is not biting`,
      );
    }
    results.push({ fixture, text, failures, score: verdict.score, control: control.score });
  }

  for (const r of results) {
    const scores = r.score === undefined ? '' : ` judge:${r.score} control:${r.control}`;
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)}${scores} "${r.text}"`,
    );
    for (const failure of r.failures) console.info(`      · ${failure}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

/** $0: no spend cap, no client. Grades the planner, then prices one recording as uncached. */
function dryRun(clash, skill, model, judgeModel) {
  let worst = 0;
  let calls = 0;
  let planFailures = 0;
  const toolTokens =
    estimateTokens(JSON.stringify(clash.GROUP_CONFLICT_TOOL)) + TOOL_OVERHEAD_TOKENS;
  for (const fixture of GROUP_CONFLICT_ALERT_FIXTURES) {
    const line = plan(clash, fixture);
    const failures = plannerFailures(fixture, line);
    planFailures += failures.length > 0 ? 1 : 0;
    if (!line || failures.length > 0) {
      console.info(
        `DRY  ${NAME}:${fixture.id}  planner ${failures.length === 0 ? 'PASS' : 'FAIL'} (no model call)`,
      );
      for (const failure of failures) console.info(`      · ${failure}`);
      continue;
    }
    const subjectIn =
      estimateTokens(skill.instructions + clash.groupConflictUserMessage(line)) + toolTokens;
    const subject = SUBJECT_SENDS * worstCaseUsd(model, subjectIn, clash.GROUP_CONFLICT_MAX_TOKENS);
    const judgeIn = (message) =>
      estimateTokens(
        JUDGE_SYSTEM + JSON.stringify({ input: line, message, watchFor: fixture.watchFor }),
      ) + TOOL_OVERHEAD_TOKENS;
    const judged =
      JUDGE_SAMPLES_MEDIAN *
      (worstCaseUsd(judgeModel, judgeIn(LONGEST_MESSAGE), JUDGE_MAX_TOKENS) +
        worstCaseUsd(judgeModel, judgeIn(brokenMessage(fixture)), JUDGE_MAX_TOKENS));
    worst += subject + judged;
    calls += SUBJECT_SENDS + 2 * JUDGE_SAMPLES_MEDIAN;
    console.info(
      `DRY  ${NAME}:${fixture.id}  planner PASS  compose ~${subjectIn} in x${SUBJECT_SENDS} $${subject.toFixed(5)} + judge ${2 * JUDGE_SAMPLES_MEDIAN} draws $${judged.toFixed(5)}`,
    );
  }
  console.info(
    `DRY summary | ${GROUP_CONFLICT_ALERT_FIXTURES.length} fixtures, up to ${calls} calls for one recording, all priced as uncached at list price with every output cap spent | worst $${worst.toFixed(5)}`,
  );
  console.info('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
  if (planFailures > 0) process.exit(1);
}

/** $0: a planner that alerts on every overlap and a message that breaks the bar. Every fixture must FAIL. */
function brokenRun(clash) {
  const results = GROUP_CONFLICT_ALERT_FIXTURES.map((fixture) => {
    const alerts = brokenPlanAlerts(fixture);
    const failures = [];
    if (fixture.expect === null && alerts)
      failures.push('alerted where the group should hear nothing');
    if (fixture.expect !== null && !alerts) failures.push('no alert for a real clash');
    if (alerts) failures.push(...textFailures(clash, fixture, brokenMessage(fixture)));
    return { fixture, failures };
  });
  for (const r of results) {
    console.info(`${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id}`);
    for (const failure of r.failures) console.info(`      · ${failure}`);
  }
  console.info('live API calls this run: 0');
  const everyFixtureFailed = results.every((r) => r.failures.length > 0);
  console.info(`broken-mode calibration (must fail): ${everyFixtureFailed ? 'PASS' : 'FAIL'}`);
  process.exit(everyFixtureFailed ? 0 : 1);
}

main().catch((err) => {
  console.error(`${NAME} eval harness error:`, err);
  process.exit(2);
});
