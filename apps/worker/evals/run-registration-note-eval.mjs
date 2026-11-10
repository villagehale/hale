// VIL-543 · every registration message that is not the heads-up, the evening or the
// morning-of text: the readiness checklist, the check-in, the waitlist guards, the
// answers to what a parent reported, the course-link ack, the second parent's yes and
// the approval card.
//
// The subject is the REAL skill (packages/agent/skills/registration-note.md) run through
// the REAL request the web composer builds (apps/web/lib/registration/sequence/
// note-compose.ts): its tool, schema, token ceiling, attempts and refusal gate are
// imported live. A change to the skill, the facts or the gate re-keys the cache and shows
// up here as a miss rather than as silence.
//
// What is NOT tested here: which facts code hands (copy.test.ts) and that a null write
// sends nothing (run.test.ts, reply.test.ts, prepare-reply.test.ts, handlers.test.ts).
//
//   node evals/run-registration-note-eval.mjs --dry            # $0: worst case for a live run
//   node evals/run-registration-note-eval.mjs --broken         # $0: gate calibration, must fail
//   node evals/run-registration-note-eval.mjs --cached-only    # $0: replay (misses fail)
//   HALE_SPEND_LEDGER=... node --env-file=../../.env evals/run-registration-note-eval.mjs --live --max-usd 1   # PAID
//
// --live and --cached-only also score the broken drafts: each claims something the facts
// do not, and the judge must score every one 2 or lower, or the run fails.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { parseEvalArgsOrExit } from './lib/eval-flags.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'registration-note.md');
const NOTE_SRC = join(REPO_ROOT, 'apps/web/lib/registration/sequence/note-compose.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** outputJsonSchema in note-compose.ts. */
const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = judgePrompt('registration-note');

// ── fixtures ────────────────────────────────────────────────────────────────
// Generic towns and portals only: this repo is public.

const NOW = { date: 'Monday, September 14, 2026', time: '6:00 p.m.' };
const WINDOW = 'Springfield Fall 2026 swim lessons';
const PORTAL = "Springfield's portal";
const ACCOUNT = 'a Springfield recreation account';
const LINK = 'https://rec.example.org/springfield/fall-2026';

export const NOTE_FIXTURES = [
  {
    id: 'readiness-checklist',
    facts: {
      kind: 'readiness_checklist',
      now: { date: 'Saturday, September 12, 2026', time: '10:00 a.m.' },
      window: WINDOW,
      who: 'Max and Mia',
      opensOn: 'Tuesday, September 15, 2026',
      opensAt: '7:00 a.m.',
      portal: PORTAL,
      account: ACCOUNT,
      language: 'en',
    },
  },
  {
    id: 'check-in-ask-fr',
    facts: {
      kind: 'check_in_ask',
      now: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      window: 'Riverton Fall 2026 recreation programs',
      language: 'fr',
    },
  },
  {
    id: 'waitlist-halfway',
    facts: {
      kind: 'waitlist_halfway',
      now: { date: 'Wednesday, September 16, 2026', time: '5:00 a.m.' },
      town: 'Springfield',
      responseHours: 36,
      clockFrom: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      deadline: { date: 'Wednesday, September 16, 2026', time: '11:00 p.m.' },
      language: 'en',
    },
  },
  {
    id: 'waitlist-final',
    facts: {
      kind: 'waitlist_final',
      now: { date: 'Wednesday, September 16, 2026', time: '9:00 p.m.' },
      town: 'Springfield',
      responseHours: 36,
      clockFrom: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      deadline: { date: 'Wednesday, September 16, 2026', time: '11:00 p.m.' },
      hoursLeft: 2,
      language: 'en',
    },
  },
  {
    id: 'outcome-registered',
    facts: { kind: 'outcome_registered', now: NOW, window: WINDOW, language: 'en' },
  },
  {
    id: 'outcome-missed',
    facts: { kind: 'outcome_missed', now: NOW, town: 'Springfield', language: 'en' },
  },
  {
    id: 'outcome-waitlisted-clock',
    facts: {
      kind: 'outcome_waitlisted',
      now: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      town: 'Springfield',
      position: 12,
      responseHours: 36,
      clockFrom: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      deadline: { date: 'Wednesday, September 16, 2026', time: '11:00 p.m.' },
      language: 'en',
    },
  },
  {
    id: 'outcome-waitlisted-no-clock-fr',
    facts: {
      kind: 'outcome_waitlisted',
      now: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      town: 'Riverton',
      position: null,
      responseHours: null,
      clockFrom: null,
      deadline: null,
      language: 'fr',
    },
  },
  {
    id: 'readiness-answer-yes',
    facts: {
      kind: 'readiness_answer',
      now: NOW,
      ready: true,
      portal: PORTAL,
      account: ACCOUNT,
      who: 'Max',
      language: 'en',
    },
  },
  {
    id: 'readiness-answer-no',
    facts: {
      kind: 'readiness_answer',
      now: NOW,
      ready: false,
      portal: PORTAL,
      account: ACCOUNT,
      who: 'Max and your teen',
      language: 'en',
    },
  },
  { id: 'already-approved', facts: { kind: 'already_approved', language: 'en' } },
  {
    id: 'course-bound-full',
    facts: {
      kind: 'course_bound',
      now: { date: 'Tuesday, September 1, 2026', time: '8:00 a.m.' },
      replaced: false,
      portal: PORTAL,
      course: { name: 'Preschool Sports and Games', day: 'Wednesday', time: '10:30 AM' },
      ageBand: '3 to 5',
      ageFit: 'fits',
      who: 'Maya',
      price: '$280.60 / $290.60 non-resident',
      courseCode: '00028147',
      opensOn: 'Tuesday, September 15, 2026',
      opensAt: '10:30 a.m.',
      clockName: 'public date',
      residentsOn: 'Sep 8',
      haleHad: { date: 'Monday, September 14, 2026', time: '10:30 a.m.' },
      regForm: true,
      prerequisite: false,
      language: 'en',
    },
  },
  {
    id: 'course-bound-replaced-teen',
    facts: {
      kind: 'course_bound',
      now: { date: 'Tuesday, September 1, 2026', time: '8:00 a.m.' },
      replaced: true,
      portal: PORTAL,
      course: { name: null, day: null, time: null },
      ageBand: null,
      ageFit: null,
      who: 'your teen',
      price: null,
      courseCode: null,
      opensOn: 'Tuesday, September 15, 2026',
      opensAt: '7:00 a.m.',
      clockName: 'residents date',
      residentsOn: null,
      haleHad: null,
      regForm: false,
      prerequisite: true,
      language: 'en',
    },
  },
  {
    id: 'approval-card-portal',
    facts: {
      kind: 'approval_card',
      now: { date: 'Tuesday, September 1, 2026', time: '10:00 a.m.' },
      window: WINDOW,
      opensOn: 'Tuesday, September 15, 2026',
      opensAt: '7:00 a.m.',
      link: LINK,
      residentsFirstDays: 7,
      who: 'Max and Mia',
      ageBand: {
        published: true,
        children: [
          { who: 'Max', fit: 'in_band' },
          { who: 'Mia', fit: 'near_band' },
        ],
      },
      texts: [
        { text: 'week_ahead', daysBefore: 7 },
        { text: 'checklist', daysBefore: 3 },
        { text: 'evening_before' },
        { text: 'just_before_open', minutesBefore: 15 },
      ],
      courseLinkTip: true,
      language: 'en',
    },
  },
  {
    id: 'approval-card-unpublished-fr',
    facts: {
      kind: 'approval_card',
      now: { date: 'Tuesday, September 1, 2026', time: '10:00 a.m.' },
      window: 'Riverton Fall 2026 recreation programs',
      opensOn: 'Saturday, September 12, 2026',
      opensAt: '9:00 a.m.',
      link: 'https://rec.example.org/riverton/fall',
      residentsFirstDays: null,
      who: 'Léa',
      ageBand: { published: false },
      texts: [
        { text: 'week_ahead', daysBefore: 7 },
        { text: 'evening_before' },
        { text: 'just_before_open', minutesBefore: 15 },
      ],
      courseLinkTip: false,
      language: 'fr',
    },
  },
];

const BY_ID = Object.fromEntries(NOTE_FIXTURES.map((f) => [f.id, f.facts]));

/** Drafts that claim what the facts do not. The judge must score each 2 or lower. */
export const NOTE_BROKEN = [
  {
    id: 'broken-registered-by-hale',
    facts: BY_ID['outcome-registered'],
    text: 'Done - I registered Max for Springfield fall swim and paid the fee.',
  },
  {
    id: 'broken-card-registers',
    facts: BY_ID['approval-card-portal'],
    text: `Springfield fall swim opens Tuesday, Sept 15 at 7 a.m. Approve and I'll sign Max and Mia up for you that morning. ${LINK}`,
  },
  {
    id: 'broken-course-invented-price',
    facts: BY_ID['course-bound-replaced-teen'],
    text: 'Swapped. That class is $120 and opens Tuesday, Sept 15 at 7 a.m. It lists a prerequisite level - leave time.',
  },
  {
    id: 'broken-waitlist-wrong-time',
    facts: BY_ID['waitlist-final'],
    text: 'About 2 hours left on the Springfield waitlist offer: it runs out tomorrow at 9 a.m. Check your email and the portal.',
  },
  {
    // Scored 5 under the rubric before it judged where the clock starts.
    id: 'broken-waitlisted-clock-unsaid',
    facts: BY_ID['outcome-waitlisted-clock'],
    text: "Got it, you're on the waitlist at spot 12 for Springfield. Springfield gives a 36-hour window to accept an offer, so this one runs out Wednesday, September 16 at 11:00 p.m. I'll remind you before it closes. Keep an eye on your email in case an offer comes through.",
  },
];

/** --broken, offline: the composer's own gate must refuse every planted draft. */
function brokenOffline(note) {
  const card = BY_ID['approval-card-portal'];
  const checkIn = BY_ID['check-in-ask-fr'];
  const refused = [
    note.noteRefusals('   ', checkIn),
    note.noteRefusals("Comment ça s'est passé? https://evil.example/phish", checkIn),
    note.noteRefusals('Opens Tuesday: https://evil.example/phish', card),
  ];
  const kept = [
    note.noteRefusals("Comment ça s'est passé ce matin?", checkIn),
    note.noteRefusals(`Opens Tuesday at 7 a.m. Register here: ${LINK}`, card),
  ];
  return refused.every((r) => r.length > 0) && kept.every((r) => r.length === 0);
}

// ── dry pricing ─────────────────────────────────────────────────────────────

const tokensFor = (value) =>
  Math.ceil((typeof value === 'string' ? value : JSON.stringify(value)).length / 3);

function worst(model, inTokens, maxOut) {
  const rates = PRICE[model];
  if (!rates) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const raw = process.argv.slice(2);
  const modeArgs = raw.filter((a, i) => a !== '--max-usd' && raw[i - 1] !== '--max-usd');
  const knownIds = [...NOTE_FIXTURES, ...NOTE_BROKEN].map((f) => f.id);
  const { mode, only } = parseEvalArgsOrExit('registration-note', knownIds, modeArgs);
  if (only) {
    for (const list of [NOTE_FIXTURES, NOTE_BROKEN]) {
      list.splice(0, list.length, ...list.filter((f) => only.includes(f.id)));
    }
  }
  const cachedOnly = mode === 'cached-only';

  const agent = await importTs(AGENT_SRC);
  const note = await importTs(NOTE_SRC);

  if (mode === 'broken') {
    const ok = brokenOffline(note);
    console.info(`broken-mode calibration (must fail): ${ok ? 'PASS' : 'FAIL'}`);
    console.info('live calls: 0');
    process.exit(ok ? 0 : 1);
  }

  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  // The writer runs on Haiku, so the judge is the other tier: a model grading its own
  // output is not a second opinion.
  const judgeModel = await readJudgeModel('sonnet');
  const judgeMaxOut = judgeModel === agent.HAIKU_MODEL ? 4096 : 8192;

  if (mode === 'dry') {
    let usd = 0;
    let calls = 0;
    for (const f of NOTE_FIXTURES) {
      const msg = JSON.stringify(f.facts);
      usd +=
        note.NOTE_MAX_ATTEMPTS *
        worst(
          lane.model,
          tokensFor(skill.instructions) + tokensFor(msg) + 200,
          note.NOTE_MAX_TOKENS,
        );
      usd += worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 600, judgeMaxOut);
      calls += note.NOTE_MAX_ATTEMPTS + 1;
    }
    for (const b of NOTE_BROKEN) {
      const msg = JSON.stringify({ facts: b.facts, text: b.text });
      usd += worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      calls += 1;
    }
    console.info(
      `DRY registration-note | worst $${usd.toFixed(6)} | ${calls} calls at most | compose=${lane.model} judge=${judgeModel} | live calls: 0`,
    );
    return;
  }

  if (mode === 'live') installEvalSpendCap();
  const cost = makeCost();
  const getClient = lazyAnthropic('registration-note');
  // Three draws, the median verdict: one Sonnet draw on a rubric this wide is noisy.
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'registration-note',
    cachedOnly,
    getClient,
    cost,
    {
      samples: JUDGE_SAMPLES_MEDIAN,
    },
  );

  let failed = 0;
  for (const f of NOTE_FIXTURES) {
    let text = null;
    for (let attempt = 1; attempt <= note.NOTE_MAX_ATTEMPTS && text === null; attempt += 1) {
      const { value } = await cachedToolCall({
        tag: `registration-note:${f.id}#${attempt}`,
        lane,
        system: skill.instructions,
        userMessage: JSON.stringify(f.facts),
        toolName: note.NOTE_TOOL.name,
        toolDescription: note.NOTE_TOOL.description,
        toolSchema: TEXT_SCHEMA,
        maxTokens: note.NOTE_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      const draft = String(value?.text ?? '').trim();
      const refusals = note.noteRefusals(draft, f.facts);
      if (refusals.length === 0) text = draft;
      else console.info(`     refused ${f.id}#${attempt}: ${refusals.join(',')}`);
    }
    if (text === null) {
      failed += 1;
      console.info(`FAIL ${f.id} | nothing sent`);
      continue;
    }
    const verdict = await judge(f.id, { facts: f.facts, text });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'} ${f.id} | judge ${verdict.score} | ${JSON.stringify(text)}`,
    );
    if (!ok) console.info(`     reason: ${verdict.reason}`);
  }

  let caught = 0;
  for (const b of NOTE_BROKEN) {
    const verdict = await judge(b.id, { facts: b.facts, text: b.text });
    const low = verdict.score <= 2;
    if (low) caught += 1;
    console.info(
      `${low ? 'BROKEN-FAILS (good)' : 'BROKEN-PASSED (bad)'} ${b.id} | judge ${verdict.score}`,
    );
  }
  const brokenOk = caught === NOTE_BROKEN.length && brokenOffline(note);
  console.info(`broken-mode calibration (must fail): ${brokenOk ? 'PASS' : 'FAIL'}`);
  console.info(
    `registration-note | ${NOTE_FIXTURES.length - failed} of ${NOTE_FIXTURES.length} passed | live calls: ${cost.liveCalls} | spent $${totalUsd(cost).toFixed(6)}`,
  );
  if (failed > 0 || !brokenOk) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'registration-note eval failed');
    process.exit(1);
  });
}
