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
// Pickup claims: the REAL skill (packages/agent/skills/group-pickup-claim-read.md) reads one
// group message through the reader's lane, tool and token cap, offered the pickups
// `pickupCandidates` builds (apps/web/lib/channel/linq/group-pickup-claim.ts). A reading is
// a label, not prose, so code grades it, as the group-turn-read eval does: through
// `pickupClaimAction` it must take or give back exactly the fixture's pickups, or do
// nothing. Then, with that stored, the real planner must hold each claimed pickup settled on
// the sender, send no alert naming it, and leave an alert coming only where the fixture
// says. A private plan must never be offered. Two $0 controls must fail: a reader that takes
// every pickup it is offered, and a store where nothing the reader decided lands.
//
//   node evals/run-group-conflict-alert-eval.mjs --dry           # $0, no API: checks the planner, prints the worst case
//   node evals/run-group-conflict-alert-eval.mjs --broken        # $0, no API: calibration, must FAIL
//   node evals/run-group-conflict-alert-eval.mjs --cached-only   # replay only, $0
//   HALE_MAX_USD=… HALE_SPEND_LEDGER=… node --env-file=../../.env evals/run-group-conflict-alert-eval.mjs --live   # PAID
// Exactly one mode. Any other flag, none, or two exits 2 before a client exists.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  GROUP_CONFLICT_ALERT_FIXTURES,
  GROUP_PICKUP_CLAIM_FIXTURES,
} from './group-conflict-alert-fixtures.mjs';
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
const SKILLS_DIR = join(REPO_ROOT, 'packages', 'agent', 'skills');
const SKILL_PATH = join(SKILLS_DIR, 'group-conflict-alert.md');
const CLAIM_SKILL_PATH = join(SKILLS_DIR, 'group-pickup-claim-read.md');
const CLASH_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-conflict.ts');
const CLAIM_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-pickup-claim.ts');

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

/** A fixture's calendars and stored who-takes decisions through the real planner. */
function household(clash, fixture, decisions = new Map()) {
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
      ownerSince: row.ownerSince ? new Date(row.ownerSince) : null,
    })),
    decided: (startIso, titleNorm) => decisions.get(`${startIso}|${titleNorm}`) ?? null,
  });
  return {
    plans: calendar.plans,
    busy: calendar.busy,
    people: [
      ...fixture.people,
      ...calendar.named.filter((named) => !fixture.people.some((person) => person.id === named.id)),
    ],
  };
}

/** One alert per sweep: an earlier sweep sent its first clash, and the ledger holds its key. */
function sentKeys(clash, home, sentAt) {
  if (!sentAt) return new Set();
  return new Set(
    clash
      .findGroupClashes({ ...home, now: new Date(sentAt) })
      .slice(0, 1)
      .map((row) => row.dedupeKey),
  );
}

/** The fixture's calendars through the real planner: the unsent clash, or null. */
function plan(clash, fixture) {
  const home = household(clash, fixture);
  const sent = sentKeys(clash, home, fixture.alreadySentAt);
  const found = clash
    .findGroupClashes({ ...home, now: new Date(fixture.now) })
    .find((row) => !sent.has(row.dedupeKey));
  if (!found) return null;
  return clash.groupConflictLineInput(found, {
    people: home.people,
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

/** The key a who-takes decision is stored under, the one `clashCalendar` looks up. */
function decisionId(claim, row) {
  const key = claim.pickupDecisionKey(row);
  return `${key.startIso}|${key.titleNorm}`;
}

/** What the reader is offered for one claim fixture, built by the real candidate code. */
function claimSetup(clash, claim, fixture) {
  const decisions = new Map(
    (fixture.decisions ?? []).map((row) => [
      decisionId(claim, { start: new Date(row.start), title: row.title }),
      { takerId: row.takerId, at: new Date(row.at), claim: row.claim },
    ]),
  );
  const home = household(clash, fixture, decisions);
  const now = new Date(fixture.now);
  const sent = sentKeys(clash, home, fixture.alertSentAt);
  const before = clash.findGroupClashes({ ...home, now });
  const candidates = claim.pickupCandidates({
    plans: home.plans,
    sent: before.filter((row) => sent.has(row.dedupeKey)),
    people: home.people,
    now,
    timeZone: fixture.timeZone,
    language: fixture.language,
  });
  return {
    decisions,
    sent,
    before,
    candidates,
    input: {
      text: fixture.text,
      senderName: home.people.find((person) => person.id === fixture.sender)?.name || null,
      pickups: candidates.map((row) => row.offer),
      recent: fixture.recent,
    },
  };
}

/** The reading the fixture expects, by ref: checks the planner side without a model. */
function expectedReading(fixture, setup) {
  const { action, pickups = [] } = fixture.expect;
  const intents = { claim: 'claim_pickup', drop: 'drop_pickup' };
  return {
    intent: intents[action] ?? 'chatter',
    pickupRefs: setup.candidates
      .filter((row) => pickups.includes(row.offer.title))
      .map((row) => row.offer.ref),
    confidence: 'high',
  };
}

/** The --broken reader: every message takes every pickup it is offered, for certain. */
function brokenReading(setup) {
  return {
    intent: 'claim_pickup',
    pickupRefs: setup.candidates.map((row) => row.offer.ref),
    confidence: 'high',
  };
}

/** The model's answer as the runtime reader's schema takes it, or null (nothing changes). */
function asReading(claim, value) {
  const fits =
    claim.GROUP_PICKUP_CLAIM_INTENTS.includes(value?.intent) &&
    Array.isArray(value?.pickupRefs) &&
    value.pickupRefs.every((ref) => typeof ref === 'string') &&
    (value?.confidence === 'high' || value?.confidence === 'low');
  if (!fits) return null;
  return { intent: value.intent, pickupRefs: value.pickupRefs, confidence: value.confidence };
}

/**
 * The decisions once an action is stored, as takeGroupPickupClaim writes them (its PGlite
 * tests run the real writes): a claim makes the sender the taker unless they already took
 * it, and a drop closes only the sender's own decision.
 */
function storedAfter(claim, fixture, setup, action) {
  const decisions = new Map(setup.decisions);
  for (const row of action?.plans ?? []) {
    const id = decisionId(claim, row);
    if (action.kind === 'drop') {
      if (decisions.get(id)?.takerId === fixture.sender) decisions.delete(id);
    } else if (!(row.claimed && row.takerId === fixture.sender)) {
      decisions.set(id, { takerId: fixture.sender, at: new Date(fixture.now), claim: true });
    }
  }
  return decisions;
}

const names = (found, title) =>
  found.first.title === title || ('plan' in found.second && found.second.plan.title === title);

/**
 * Code grades a reading: what it did, then what the group hears with that stored.
 * `lands: false` is the --broken store, where nothing the reader decided is kept.
 */
function claimFailures(clash, claim, fixture, setup, reading, { lands = true } = {}) {
  const failures = [];
  const { action: wantKind, pickups = [], alertAfter } = fixture.expect;
  const action = claim.pickupClaimAction(reading, setup.candidates);
  const did = action
    ? `${action.kind} ${JSON.stringify(action.plans.map((row) => row.title).sort())}`
    : 'nothing';
  const want = wantKind ? `${wantKind} ${JSON.stringify([...pickups].sort())}` : 'nothing';
  if (did !== want) failures.push(`read: did ${did}, expected ${want}`);
  const home = household(
    clash,
    fixture,
    lands ? storedAfter(claim, fixture, setup, action) : setup.decisions,
  );
  const left = clash
    .findGroupClashes({ ...home, now: new Date(fixture.now) })
    .filter((row) => !setup.sent.has(row.dedupeKey));
  for (const title of pickups) {
    const after = home.plans.find((row) => row.title === title);
    const onSender = after?.takerId === fixture.sender;
    if (wantKind === 'claim' && !(after?.claimed && onSender)) {
      failures.push(`"${title}" is not settled on ${fixture.sender}`);
    }
    if (wantKind === 'claim' && left.some((row) => names(row, title))) {
      failures.push(`an alert still names "${title}"`);
    }
    if (wantKind === 'drop' && onSender) {
      failures.push(`"${title}" still rests on ${fixture.sender}`);
    }
  }
  const alertLeft = left.length > 0;
  if (alertLeft !== alertAfter) {
    failures.push(
      alertAfter ? 'no alert left for a clash nobody took' : 'an alert still goes after it',
    );
  }
  return failures;
}

/** The fixture checked by code before a model reads it: it tests what it says it tests. */
function claimSetupFailures(clash, claim, fixture, setup) {
  const failures = [];
  const { action, pickups = [] } = fixture.expect;
  const offered = setup.candidates.map((row) => row.offer);
  const sender = setup.input.senderName;
  if (!sender) failures.push(`${fixture.sender} is not in the group`);
  if (offered.length < 2) failures.push('fewer than two pickups offered');
  if (action && pickups.length >= offered.length) {
    failures.push('every pickup offered is expected: a reader that takes everything would pass');
  }
  for (const title of pickups) {
    const offer = offered.find((row) => row.title === title);
    if (!offer) failures.push(`"${title}" is not offered`);
    if (action === 'claim' && !setup.before.some((row) => names(row, title))) {
      failures.push(`"${title}" is in no clash: taking it settles nothing`);
    }
    if (action === 'drop' && offer && offer.has !== sender) {
      failures.push(`"${title}" is not the sender's to give back`);
    }
  }
  if (fixture.alertSentAt && setup.sent.size === 0) {
    failures.push('no alert was sent before the message');
  }
  const seen = JSON.stringify(setup.input.pickups).toLowerCase();
  for (const word of fixture.mustNotLeak ?? []) {
    if (seen.includes(word)) failures.push(`private "${word}" offered to the reader`);
  }
  failures.push(...claimFailures(clash, claim, fixture, setup, expectedReading(fixture, setup)));
  return failures;
}

const describeReading = (reading) =>
  reading
    ? `${reading.intent}/${reading.confidence} ${JSON.stringify(reading.pickupRefs)}`
    : 'unread';

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
  const claim = await importTs(CLAIM_SRC);
  const agent = await importTs(AGENT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const claimSkill = await agent.loadSkill(CLAIM_SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const claimModel = agent.pickModel(claimSkill.meta.task);
  const claimLane = agent.pickLane(claimSkill.meta.task);
  const judgeModel = await readJudgeModel();
  console.info(
    `${NAME} eval | mode=${mode} | compose=${model} claim=${claimModel} judge=${judgeModel}`,
  );
  if (mode === 'dry') {
    return dryRun({ clash, claim, skill, claimSkill, model, claimModel, judgeModel });
  }
  if (mode === 'broken') return brokenRun(clash, claim);

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
      results.push({
        id: fixture.id,
        detail: line ? '"(not written)"' : '"(no alert)"',
        failures,
      });
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
    results.push({
      id: fixture.id,
      detail: `judge:${verdict.score} control:${control.score} "${text}"`,
      failures,
    });
  }

  for (const fixture of GROUP_PICKUP_CLAIM_FIXTURES) {
    const id = `claim:${fixture.id}`;
    const setup = claimSetup(clash, claim, fixture);
    const failures = claimSetupFailures(clash, claim, fixture, setup);
    if (failures.length > 0) {
      results.push({ id, detail: '(not read)', failures });
      continue;
    }
    const value = (
      await cachedToolCall({
        tag: `${NAME}:${id}`,
        model: claimModel,
        lane: claimLane,
        system: claimSkill.instructions,
        userMessage: claim.groupPickupClaimUserMessage(setup.input),
        toolName: claim.GROUP_PICKUP_CLAIM_TOOL.name,
        toolDescription: claim.GROUP_PICKUP_CLAIM_TOOL.description,
        toolSchema: claim.GROUP_PICKUP_CLAIM_TOOL.inputSchema,
        maxTokens: claim.GROUP_PICKUP_CLAIM_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      })
    ).value;
    const reading = asReading(claim, value);
    failures.push(...claimFailures(clash, claim, fixture, setup, reading));
    if (claimFailures(clash, claim, fixture, setup, brokenReading(setup)).length === 0) {
      failures.push('a reader that takes every pickup passed: the grading is not biting');
    }
    results.push({ id, detail: `${describeReading(reading)} "${fixture.text}"`, failures });
  }

  for (const r of results) {
    console.info(`${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.id.padEnd(34)} ${r.detail}`);
    for (const failure of r.failures) console.info(`      · ${failure}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

/** $0: no spend cap, no client. Grades the planner, then prices one recording as uncached. */
function dryRun({ clash, claim, skill, claimSkill, model, claimModel, judgeModel }) {
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
  let claimFailed = 0;
  const readTokens =
    estimateTokens(JSON.stringify(claim.GROUP_PICKUP_CLAIM_TOOL)) + TOOL_OVERHEAD_TOKENS;
  for (const fixture of GROUP_PICKUP_CLAIM_FIXTURES) {
    const setup = claimSetup(clash, claim, fixture);
    const failures = claimSetupFailures(clash, claim, fixture, setup);
    if (failures.length > 0) {
      claimFailed += 1;
      console.info(`DRY  ${NAME}:claim:${fixture.id}  claim FAIL (no model call)`);
      for (const failure of failures) console.info(`      · ${failure}`);
      continue;
    }
    const readIn =
      estimateTokens(claimSkill.instructions + claim.groupPickupClaimUserMessage(setup.input)) +
      readTokens;
    const read =
      SUBJECT_SENDS * worstCaseUsd(claimModel, readIn, claim.GROUP_PICKUP_CLAIM_MAX_TOKENS);
    worst += read;
    calls += SUBJECT_SENDS;
    console.info(
      `DRY  ${NAME}:claim:${fixture.id}  claim PASS  read ~${readIn} in x${SUBJECT_SENDS} $${read.toFixed(5)} (graded by code)`,
    );
  }
  console.info(
    `DRY summary | ${GROUP_CONFLICT_ALERT_FIXTURES.length} alert and ${GROUP_PICKUP_CLAIM_FIXTURES.length} claim fixtures, up to ${calls} calls for one recording, all priced as uncached at list price with every output cap spent | worst $${worst.toFixed(5)}`,
  );
  console.info('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
  if (planFailures > 0 || claimFailed > 0) process.exit(1);
}

/**
 * $0, every result must FAIL: a planner that alerts on every overlap and a message that
 * breaks the bar (alert fixtures), a reader that takes every pickup it is offered
 * (`claim:`), and the right reading with nothing stored (`store:`).
 */
function brokenRun(clash, claim) {
  const results = GROUP_CONFLICT_ALERT_FIXTURES.map((fixture) => {
    const alerts = brokenPlanAlerts(fixture);
    const failures = [];
    if (fixture.expect === null && alerts)
      failures.push('alerted where the group should hear nothing');
    if (fixture.expect !== null && !alerts) failures.push('no alert for a real clash');
    if (alerts) failures.push(...textFailures(clash, fixture, brokenMessage(fixture)));
    return { id: fixture.id, failures };
  });
  for (const fixture of GROUP_PICKUP_CLAIM_FIXTURES) {
    const setup = claimSetup(clash, claim, fixture);
    results.push({
      id: `claim:${fixture.id}`,
      failures: claimFailures(clash, claim, fixture, setup, brokenReading(setup)),
    });
    if (fixture.expect.action) {
      results.push({
        id: `store:${fixture.id}`,
        failures: claimFailures(clash, claim, fixture, setup, expectedReading(fixture, setup), {
          lands: false,
        }),
      });
    }
  }
  for (const r of results) {
    console.info(`${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.id}`);
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
