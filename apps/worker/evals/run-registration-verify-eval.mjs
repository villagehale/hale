// VIL-259 — eval for the verify-registration-window skill (the weekly re-verify sweep).
//
// SUBJECT: the skill's accuracy at reading registration dates for ONE named cycle
// off a municipality's own page. This is the model's whole contribution to the
// sweep; everything downstream (corroboration, the confidence floor, the
// never-auto-change comparison) is deterministic and unit-tested in
// apps/web/lib/registration/verify-window.test.ts.
//
// WHY THIS IS A HARD GATE: a wrong registration DATE is the one error the radar
// cannot make. A parent sets a 6:30 a.m. alarm and tries for a swim spot that
// sells out in four minutes; a date wrong by a week costs them the season. So the
// check is exact equality on every date field — no partial credit, no judge.
//
// AND "COULDN'T VERIFY" IS A FIRST-CLASS ANSWER. Half these fixtures expect
// found=false. A model that guesses a plausible date rather than saying the page
// does not publish one fails here exactly as hard as one that reads a date wrong,
// because in production a guess becomes a founder alert about a date nobody
// published — or worse, a silent confirmation of a stale row.
//
// THE STALE-YEAR TRAP (M1's lesson, VIL-236) has its own fixture: these pages keep
// last season's table up for weeks, and web search returns last year's dates for
// this year's query confidently and unqualified. `stale-prior-year-trap` is the
// real Burlington table with the prior cycle's year — the correct answer is
// "different_cycle_only", never a rolled-forward date.
//
// Page texts are VERBATIM from the municipalities' own pages, fetched 2026-08-02
// and tag-stripped the way the sweep strips them. Expected values are transcribed
// by reading each text, never from what the model produced.
//
//   node --env-file=../../.env evals/run-registration-verify-eval.mjs           # live (populates cache)
//   node --env-file=../../.env evals/run-registration-verify-eval.mjs --broken  # calibration: must FAIL
//   node evals/run-registration-verify-eval.mjs --cached-only                   # CI: replay, zero API calls
//
// Calibrated BOTH directions: the real cached model passes every fixture; the
// --broken stand-in (which rolls a prior year forward, computes the non-resident
// date from the prose rule, and invents times for date-only fields) must fail.

import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import {
  REPO_ROOT,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  readModelIds,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'verify-registration-window.md');

/** Production's floor (MIN_VERIFY_CONFIDENCE). A correct reading below it is
 * DISCARDED in production, so it is not a pass here either. */
const MIN_CONFIDENCE = 0.7;

const REASONS = ['announced_later', 'different_cycle_only', 'no_year_stated', 'not_published'];

const PUBLISHED_DATE = {
  type: ['object', 'null'],
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD' },
    time: {
      type: ['string', 'null'],
      description: '24-hour HH:MM, or null when the page publishes no time',
    },
  },
  required: ['date', 'time'],
};

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    reason: { type: ['string', 'null'], enum: [...REASONS, null] },
    cycle_on_page: { type: ['string', 'null'] },
    year_evidence: {
      type: ['string', 'null'],
      description: 'Verbatim page text stating the YEAR these dates belong to.',
    },
    preview: PUBLISHED_DATE,
    resident_open: PUBLISHED_DATE,
    general_open: PUBLISHED_DATE,
    evidence: { type: ['string', 'null'], description: 'Verbatim page text the dates came from.' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'found',
    'reason',
    'cycle_on_page',
    'year_evidence',
    'preview',
    'resident_open',
    'general_open',
    'evidence',
    'confidence',
  ],
};

// ── the real pages ───────────────────────────────────────────────────────────

/** markham.ca registration page. Lists FOUR 2026 cycles at once — the ordinary
 * case that is also a disambiguation trap. "Preview starting Aug, 3" keeps the
 * source's own comma typo. */
const MARKHAM = [
  '2026 Summer Camps Preview starting Feb. 1 Register starting Feb. 10 at 6:30 AM',
  '2026 Spring Programs and Swim Lessons Preview starting Feb. 1 Register starting Feb. 24 at 6:30 AM',
  '2026 Summer Programs and Swim Lessons Preview starting May 11 Register starting Jun. 2 at 6:30 AM',
  '2026 Fall Programs, Swim Lessons and Winter Break Camps Preview starting Aug, 3 Register starting Aug. 11 at 6:30 AM',
  'You will have 48 hours to decide if you would like to finalize the registration into the program or withdraw yourself from the waitlist. After 48 hours your spot will be passed to the next individual on the waitlist.',
].join(' ');

/** toronto.ca after-school-recreation-care, plus the city-wide non-resident rule
 * that appears alongside it. The rule is PROSE, not a date: a model that does the
 * arithmetic invents a date the city never printed. */
const TORONTO_ARC = [
  'After-School Recreation Care (ARC) Registration starts on June 5, 2026, at 7 a.m.',
  'The program runs September 8, 2026 to June 18, 2027, Monday to Friday, excluding PA Days, school holidays and statutory holidays.',
  'School dismissal to 6 p.m. (5:30 p.m. at some locations).',
  'Non-Toronto residents can register for a recreation activity 10 days after registration starts for that activity.',
].join(' ');

/** toronto.ca how-to-register. The known gap the discovery leg watches: three
 * cycles are open and the one we want is explicitly not announced. */
const TORONTO_REGISTER = [
  '2026/2027 After School: Friday, June 5 - After-School Recreation Care registration is now open.',
  '2026 CampTO registration is now open. 2026 Summer: Registration is now open.',
  'Fall 2026: Registration dates will be announced at a later date.',
  'Non-Toronto residents can register for a recreation activity 10 days after registration starts for that activity.',
  'When a spot opens up from a waitlist you have up to 36 hours to accept or decline the spot before you are removed and staff move on to the next person on the list.',
].join(' ');

/** haltonhills.ca program-registration. The other known gap: a standing policy
 * (a rule with no date) and a banner for a season that is already running. */
const HALTON_HILLS = [
  'Summer Registration On Now!',
  'Please note that registration for people who do not pay taxes, and/or reside in Halton Hills, is delayed 7 days after the registration start date. An additional 20% charge is added to the cost of programs for non-taxpayers.',
  'Programs are displayed in start date order, with the most recent listed first.',
].join(' ');

/** burlington.ca registering-for-a-program. A real four-column table: the row must
 * be picked by name, and the resident/non-resident columns must not be swapped. */
const BURLINGTON_TABLE = [
  'Program offering/season | Program viewable online | Registration date and time (resident) | Registration date and time (non-resident)',
  'Music Lessons 2026-2027 | July 6 | July 6 | July 6',
  'Fall adult programs | Aug. 12 | Aug. 20 7 a.m. | Aug. 28 9 a.m.',
  'Fall and winter youth | Aug. 12 | Aug. 22 9 a.m. | Aug. 28 9 a.m.',
  'Fall swimming lessons | Aug. 12 | Aug. 22 9 a.m. | Aug. 28 9 a.m.',
  'Fall and winter Aquatic Leadership programs | Aug. 12 | Aug. 22 9 a.m. | Aug. 28 9 a.m.',
  'The spot will be held for only 48 hours. If you do not confirm or decline your spot within 48 hours, your spot will be removed and the next person on the waitlist will be contacted.',
].join(' ');

const BURLINGTON = `Fall 2026 and Winter 2027 Registration Schedule ${BURLINGTON_TABLE}`;

/** THE STALE-YEAR TRAP. The same real Burlington table as it stood a year earlier —
 * the state this page is genuinely in for weeks after a season closes. Every date
 * is one year and a few days off the cycle being asked about, which is exactly
 * close enough to look right. */
const BURLINGTON_STALE = [
  'Fall 2025 and Winter 2026 Registration Schedule',
  'Program offering/season | Program viewable online | Registration date and time (resident) | Registration date and time (non-resident)',
  'Fall and winter youth | Aug. 13 | Aug. 23 9 a.m. | Aug. 29 9 a.m.',
  'Fall swimming lessons | Aug. 13 | Aug. 23 9 a.m. | Aug. 29 9 a.m.',
].join(' ');

/** A date with no year anywhere — the shape a town's banner takes when it assumes
 * you know what year it is. Supplying one would be fabrication. */
const NO_YEAR = 'Fall Programs & Winter Camps Registration. View programs August 4 and register August 11.';

// ── fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES = [
  {
    id: 'markham-fall-2026',
    why: 'The ordinary confirm, off a page listing four cycles at once.',
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    pageText: MARKHAM,
    expect: {
      found: true,
      preview: { date: '2026-08-03', time: null },
      resident_open: null,
      general_open: { date: '2026-08-11', time: '06:30' },
    },
  },
  {
    id: 'markham-other-cycle-same-page',
    why: 'The same page read for a DIFFERENT cycle. Picking the wrong row is the single easiest way to report a confident wrong date.',
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: '2026 Spring Programs and Swim Lessons',
    pageText: MARKHAM,
    expect: {
      found: true,
      preview: { date: '2026-02-01', time: null },
      resident_open: null,
      general_open: { date: '2026-02-24', time: '06:30' },
    },
  },
  {
    id: 'toronto-arc-rule-is-not-a-date',
    why: 'The printed date is the RESIDENT one; the non-resident date exists only as a prose rule. Doing that arithmetic invents a date the city never published.',
    municipality: 'toronto',
    programDomain: 'after_school_care',
    cycleLabel: 'After-School Recreation Care (ARC) 2026/2027 school year',
    pageText: TORONTO_ARC,
    expect: {
      found: true,
      preview: null,
      resident_open: { date: '2026-06-05', time: '07:00' },
      general_open: null,
    },
  },
  {
    id: 'burlington-table-row',
    why: 'A four-column table: the right row by name, resident and non-resident not swapped, and a viewable-online date with no time.',
    municipality: 'burlington',
    programDomain: 'swim',
    cycleLabel: 'Fall swimming lessons',
    pageText: BURLINGTON,
    expect: {
      found: true,
      preview: { date: '2026-08-12', time: null },
      resident_open: { date: '2026-08-22', time: '09:00' },
      general_open: { date: '2026-08-28', time: '09:00' },
    },
  },
  {
    id: 'stale-prior-year-trap',
    why: "M1's lesson, made a test: last season's table is still up. A rolled-forward date is the worst possible answer, and it is the one a confident model gives.",
    municipality: 'burlington',
    programDomain: 'swim',
    cycleLabel: 'Fall swimming lessons (Fall 2026)',
    pageText: BURLINGTON_STALE,
    expect: { found: false, reasons: ['different_cycle_only'] },
  },
  {
    id: 'toronto-announced-later',
    why: 'A real known gap. Three other cycles ARE open on this page — the pull to report one of them instead is the whole difficulty.',
    municipality: 'toronto',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    pageText: TORONTO_REGISTER,
    expect: { found: false, reasons: ['announced_later'] },
  },
  {
    id: 'halton-hills-no-table',
    why: 'The other known gap: a standing policy is a rule without a date, and a rule alone cannot make a window.',
    municipality: 'halton_hills',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    pageText: HALTON_HILLS,
    expect: { found: false, reasons: ['not_published', 'different_cycle_only'] },
  },
  {
    id: 'no-year-stated',
    why: 'Dates with no year anywhere on the page. Supplying one from the calendar is fabrication.',
    municipality: 'mississauga',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    pageText: NO_YEAR,
    expect: { found: false, reasons: ['no_year_stated'] },
  },
];

/** `{date,time}` or null → a comparable string. */
function slot(value) {
  if (value === null || value === undefined) return 'null';
  return `${value.date}|${value.time ?? 'no-time'}`;
}

/** Failure strings; empty means the fixture passed. */
function check(fixture, value) {
  const problems = [];
  const want = fixture.expect;
  const found = value?.found === true;

  if (found !== want.found) {
    problems.push(`FOUND expected ${want.found}, got ${found}`);
    // The rest of the comparison is meaningless once this diverges.
    return problems;
  }

  if (!want.found) {
    const reason = value?.reason ?? null;
    if (!want.reasons.includes(reason)) {
      problems.push(`REASON expected one of [${want.reasons.join(', ')}], got ${reason}`);
    }
    for (const field of ['preview', 'resident_open', 'general_open']) {
      if (value?.[field]) problems.push(`NOT-FOUND but ${field} is ${slot(value[field])}`);
    }
    return problems;
  }

  for (const field of ['preview', 'resident_open', 'general_open']) {
    const got = slot(value?.[field]);
    const expected = slot(want[field]);
    if (got !== expected) problems.push(`${field.toUpperCase()} expected ${expected}, got ${got}`);
  }

  // A reading production would discard is not a pass here either.
  const confidence = typeof value?.confidence === 'number' ? value.confidence : 0;
  if (confidence < MIN_CONFIDENCE) {
    problems.push(`CONFIDENCE ${confidence} is below the ${MIN_CONFIDENCE} floor — production discards this`);
  }

  // The corroboration gate discards any reading whose quotes are not in the page,
  // so a correct date with an invented quote still reaches nobody.
  const normalize = (t) => String(t).toLowerCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
  const page = normalize(fixture.pageText);
  for (const field of ['evidence', 'year_evidence']) {
    const quote = value?.[field];
    if (!quote) {
      problems.push(`${field.toUpperCase()} missing — production discards an uncorroborated reading`);
    } else if (!page.includes(normalize(quote))) {
      problems.push(`${field.toUpperCase()} is not in the page text: "${quote}"`);
    }
  }
  return problems;
}

/**
 * The --broken stand-in: the three failure modes this skill is written to prevent.
 * It rolls a prior-year table forward onto the asked-for cycle, computes the
 * non-resident date from the prose rule, and invents 09:00 for date-only fields.
 * It must fail.
 */
function brokenAnswer(fixture) {
  const want = fixture.expect;
  const withTime = (value) => (value ? { date: value.date, time: value.time ?? '09:00' } : null);

  if (!want.found) {
    // Confidently answers anyway — the exact failure the "couldn't verify" fixtures exist to catch.
    return {
      found: true,
      reason: null,
      cycle_on_page: fixture.cycleLabel,
      year_evidence: fixture.cycleLabel,
      preview: { date: '2026-08-13', time: null },
      resident_open: { date: '2026-08-23', time: '09:00' },
      general_open: { date: '2026-08-29', time: '09:00' },
      evidence: 'Fall swimming lessons | Aug. 13 | Aug. 23 9 a.m. | Aug. 29 9 a.m.',
      confidence: 0.95,
    };
  }

  const resident = withTime(want.resident_open);
  // Applies the prose rule instead of leaving the unprinted date null.
  const derived =
    want.general_open === null && resident
      ? { date: `${resident.date.slice(0, 8)}${String(Number(resident.date.slice(8)) + 10).padStart(2, '0')}`, time: resident.time }
      : withTime(want.general_open);

  return {
    found: true,
    reason: null,
    cycle_on_page: fixture.cycleLabel,
    year_evidence: fixture.cycleLabel,
    preview: withTime(want.preview),
    resident_open: resident,
    general_open: derived,
    evidence: 'Registration starts',
    confidence: 0.95,
  };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const models = await readModelIds();
  // The skill declares task: extract → Sonnet 5. Read from model.ts, never hardcoded.
  const model = models.sonnet5;

  const getClient = lazyAnthropic();
  const cost = makeCost();

  console.log(
    `registration-verify-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  console.log(`skill=${skill.meta.name} task=${skill.meta.task}\n`);

  let failed = 0;
  let live = 0;

  for (const fixture of FIXTURES) {
    let value;
    if (broken) {
      value = brokenAnswer(fixture);
    } else {
      const result = await cachedToolCall({
        tag: `registration-verify:${fixture.id}`,
        model,
        system: skill.instructions,
        userMessage: JSON.stringify({
          municipality: fixture.municipality,
          program_domain: fixture.programDomain,
          cycle_label: fixture.cycleLabel,
          page_text: fixture.pageText,
        }),
        toolName: 'published_registration_window',
        toolDescription: 'Return the registration dates this page publishes for the named cycle.',
        toolSchema: TOOL_SCHEMA,
        maxTokens: 1024,
        cachedOnly,
        getClient,
        cost,
      });
      value = result.value;
      if (!result.cached) live += 1;
    }

    const problems = check(fixture, value);
    if (problems.length === 0) {
      console.log(`PASS  ${fixture.id}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${fixture.id} — ${fixture.why}`);
      for (const problem of problems) console.log(`      ${problem}`);
    }
  }

  console.log(`\nlive calls: ${live} | est. cost: $${totalUsd(cost).toFixed(4)}`);
  console.log('--- gate ---');

  if (!broken) {
    const ok = failed === 0;
    console.log(`${FIXTURES.length - failed}/${FIXTURES.length} fixtures exact`);
    console.log(`real-mode gate (all fixtures must pass): ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(ok ? 0 : 1);
  }

  const calibrated = failed > 0;
  console.log(
    `broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
