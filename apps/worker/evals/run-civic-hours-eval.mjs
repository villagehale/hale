// VIL-252 · M16 — eval for the parse-civic-hours skill (Tier ② free-text schedules).
//
// SUBJECT: the skill's own accuracy at reading a weekly schedule out of irregular
// text — the fallback path, reached only when the deterministic parser in
// apps/web/lib/civic/hours-text.ts cannot account for the whole string. Every
// fixture here is text that parser deliberately refuses.
//
// WHY THIS IS THE GATE THE TICKET ASKS FOR: a wrong TIME is a hard fail, not a
// scored miss. A parent acts on these — packs a toddler, a snack and a stroller
// and turns up. So the check is exact set equality on (day, start, end); there is
// no partial credit and no judge. `noon` carries its own fixture because it is the
// single most common way these sources write midday and the most damaging thing to
// misread (00:00 is twelve hours and a closed building away).
//
// The downstream corroboration gate (which discards any slot whose times are not
// in the source) is NOT replicated here — it has its own unit tests, and folding
// it in would hide prompt regressions behind a safety net. This measures the model.
//
// Fixtures 1 and 2 are VERBATIM from Applegrove Community Complex's public EarlyON
// page; the rest are the shapes the City's own centre pages and PDF calendars use.
//
//   node --env-file=../../.env evals/run-civic-hours-eval.mjs            # live (populates cache)
//   node --env-file=../../.env evals/run-civic-hours-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-civic-hours-eval.mjs --cached-only                    # CI: replay, zero API calls
//
// Calibrated BOTH directions: the real cached model passes every fixture; the
// --broken stand-in (which reads `noon` as midnight and flattens ranges) must fail.

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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'parse-civic-hours.md');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string', enum: DAYS },
          start: { type: 'string', description: '24-hour HH:MM, zero-padded' },
          end: { type: 'string', description: '24-hour HH:MM, zero-padded' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['day', 'start', 'end', 'confidence'],
      },
    },
  },
  required: ['slots'],
};

// Expected values are transcribed from each source text by reading it, never from
// what the model produced.
const FIXTURES = [
  {
    id: 'day-range-verbatim',
    why: 'A written-out day range is how real centre pages state a week.',
    text: 'Monday to Thursday 9:00 am — 2:00 pm Year-round',
    expect: [
      ['monday', '09:00', '14:00'],
      ['tuesday', '09:00', '14:00'],
      ['wednesday', '09:00', '14:00'],
      ['thursday', '09:00', '14:00'],
    ],
  },
  {
    id: 'day-list-verbatim',
    why: 'Comma-and-ampersand list, no space before the meridiem, seasonal caveat that must NOT become a slot.',
    text: 'Thursday, Friday & Saturday 9:30am — 1:00pm (Saturdays are The Gross Motor Program) September to June (program does not run in the summer)',
    expect: [
      ['thursday', '09:30', '13:00'],
      ['friday', '09:30', '13:00'],
      ['saturday', '09:30', '13:00'],
    ],
  },
  {
    id: 'noon-in-prose',
    why: 'THE wrong-time trap: noon is 12:00, never 00:00.',
    text: 'Drop-in play runs Tuesdays and Thursdays from 10:00 a.m. to noon.',
    expect: [
      ['tuesday', '10:00', '12:00'],
      ['thursday', '10:00', '12:00'],
    ],
  },
  {
    id: 'two-ranges-one-day',
    why: 'A morning and an afternoon session are two slots; merging them claims the centre never closes.',
    text: "Wednesdays we're open 9:30–11:30 a.m. and again 1:00–3:00 p.m.",
    expect: [
      ['wednesday', '09:30', '11:30'],
      ['wednesday', '13:00', '15:00'],
    ],
  },
  {
    id: 'evening-slot',
    why: 'A p.m. start must not be read as a.m. — a 4:30 p.m. drop-in read as 04:30 is useless.',
    text: 'Family night: Fridays, 4:30 p.m. until 7:30 p.m.',
    expect: [['friday', '16:30', '19:30']],
  },
  {
    id: 'no-schedule-stated',
    why: "The City's own guidance line. No schedule stated → no slots, never an invented one.",
    text: 'Please contact the centre directly for program information.',
    expect: [],
  },
  {
    id: 'too-vague-to-place',
    why: 'Named no day and no time. Guessing "weekdays 9-12" here would be fabrication.',
    text: 'Mornings during the school year, most weekdays. Call ahead as times vary.',
    expect: [],
  },
];

/** Normalise a model answer into a comparable, order-independent slot set. */
function slotSet(value) {
  const slots = Array.isArray(value?.slots) ? value.slots : [];
  return new Set(
    slots.map((s) => `${String(s.day).toLowerCase()}|${String(s.start)}|${String(s.end)}`),
  );
}

function expectedSet(expect) {
  return new Set(expect.map(([d, s, e]) => `${d}|${s}|${e}`));
}

/** Failure strings; empty means the fixture passed. Exact set equality — a wrong
 * or invented time is a hard fail, and a missed slot is too. */
function check(fixture, value) {
  const got = slotSet(value);
  const want = expectedSet(fixture.expect);
  const problems = [];
  for (const slot of want) {
    if (!got.has(slot)) problems.push(`MISSING ${slot}`);
  }
  for (const slot of got) {
    if (!want.has(slot)) problems.push(`UNEXPECTED ${slot}`);
  }
  return problems;
}

// The --broken stand-in: reads `noon` as midnight and merges a day's ranges into
// one span — the two failures the real skill is written to prevent. It must fail.
function brokenAnswer(fixture) {
  const byDay = new Map();
  for (const [day, start, end] of fixture.expect) {
    const fixedStart = start === '12:00' ? '00:00' : start;
    const fixedEnd = end === '12:00' ? '00:00' : end;
    const existing = byDay.get(day);
    byDay.set(
      day,
      existing === undefined
        ? { start: fixedStart, end: fixedEnd }
        : { start: existing.start, end: fixedEnd },
    );
  }
  if (byDay.size === 0) return { slots: [{ day: 'monday', start: '09:00', end: '12:00', confidence: 0.9 }] };
  return {
    slots: [...byDay].map(([day, r]) => ({ day, start: r.start, end: r.end, confidence: 0.9 })),
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
    `civic-hours-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
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
        tag: `civic-hours:${fixture.id}`,
        model,
        system: skill.instructions,
        userMessage: JSON.stringify({ schedule_text: fixture.text }),
        toolName: 'weekly_slots',
        toolDescription: 'Return the weekly opening slots stated by the schedule text.',
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
      console.log(`      text: ${fixture.text}`);
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
  console.log(`broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
