// School winter-break eval (VIL-685; hard rule #8: no LLM mocking).
//
// SUBJECTS, called the way the runtime calls them:
//   - packages/agent/skills/school-break-read.md through apps/web/lib/care/school-break/
//     read.ts: the real page reader (official-host check, PDF/HTML text, the model's
//     reading, then code's check of every quote, day and year against the page);
//   - the board lookup (lookup.ts) over that reader, so a page with no winter break
//     comes out `not_found: not_published`: the case where Hale asks the parent once;
//   - packages/agent/skills/school-break-reply.md through reply.ts: the parent's answer
//     to that one question, then code's check of it.
// The pages are fixtures on reserved .example hosts, fetched by a scripted port. Nothing here
// is a real school's calendar and no family is in any payload.
//
// Objective metric only, no judge: each case has the exact outcome the spec requires.
//
//   node evals/run-school-break-eval.mjs --cached-only   # CI: replay only
//   node evals/run-school-break-eval.mjs                 # live, through the spend cap

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  REPO_ROOT,
  cachedToolCall,
  evalRunTag,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const BREAK_DIR = join(REPO_ROOT, 'apps', 'web', 'lib', 'care', 'school-break');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const SCHOOL_YEAR = '2026-27';
const BOARD = 'board.example';
const CALENDAR = `https://www.${BOARD}/calendar/2026-2027`;
const NO_DATES = `https://www.${BOARD}/calendar/important-dates`;
const LISTING = 'https://school-holidays.example/ontario-winter-break-2026';

/** A board's own school-year calendar: PA days, the winter break and March break. */
const CALENDAR_PAGE = `<html><head><title>2026-2027 School Year Calendar | Example District School Board</title></head>
<body><h1>Example District School Board</h1>
<h2>2026-2027 School Year Calendar (Elementary and Secondary)</h2>
<table>
<tr><td>First day of classes</td><td>Tuesday, September 1, 2026</td></tr>
<tr><td>PA Day</td><td>Friday, September 25, 2026</td></tr>
<tr><td>PA Day</td><td>Friday, November 13, 2026</td></tr>
<tr><td>Winter Break</td><td>Monday, December 21, 2026 to Friday, January 1, 2027</td></tr>
<tr><td>Classes resume</td><td>Monday, January 4, 2027</td></tr>
<tr><td>PA Day</td><td>Friday, February 5, 2027</td></tr>
<tr><td>Family Day</td><td>Monday, February 15, 2027</td></tr>
<tr><td>March Break</td><td>Monday, March 15, 2027 to Friday, March 19, 2027</td></tr>
<tr><td>Last day of classes</td><td>Friday, June 25, 2027</td></tr>
</table></body></html>`;

/** The same board's page before the year's calendar is posted: no winter break on it. */
const NO_DATES_PAGE = `<html><body><h1>Example District School Board</h1>
<h2>Important Dates</h2>
<p>The 2026-2027 school year calendar is being finalized and will be posted here once it is approved by the Board.</p>
<p>First day of classes: Tuesday, September 1, 2026</p>
<p>PA Day: Friday, September 25, 2026</p>
</body></html>`;

const PAGES = new Map([
  [CALENDAR, CALENDAR_PAGE],
  [NO_DATES, NO_DATES_PAGE],
  [LISTING, CALENDAR_PAGE],
]);

const PAGE_CASES = [
  {
    id: 'official-calendar',
    url: CALENDAR,
    expect: {
      status: 'verified',
      name: 'Winter Break',
      firstDay: '2026-12-21',
      lastDay: '2027-01-01',
    },
  },
  {
    // The same words on a holiday-listing site: never fetched, never read.
    id: 'non-official-page',
    url: LISTING,
    expect: { status: 'not_official', modelCalls: 0 },
  },
  {
    // The board page names no winter break yet: not found, so Hale asks the parent once.
    id: 'no-winter-date',
    url: NO_DATES,
    expect: { status: 'not_published', lookup: 'not_published' },
  },
];

const REPLY_CASES = [
  {
    id: 'parent-gives-days',
    text: "I think it's dec 18 to jan 4 for us this year",
    expect: { status: 'read', firstDay: '2026-12-18', lastDay: '2027-01-04' },
  },
  {
    // Asked when the kids are back, a parent gives the day back: the last day off is the
    // day before it.
    id: 'parent-gives-day-back',
    text: 'dec 19, and they go back jan 5',
    expect: { status: 'read', firstDay: '2026-12-19', lastDay: '2027-01-04' },
  },
  {
    // A rough time is not a day: nothing is filed, and Hale never names a guessed break.
    id: 'parent-says-around-christmas',
    text: 'not sure, around christmas i think',
    expect: { status: 'nothing_stated' },
  },
  {
    id: 'parent-names-school-only',
    text: 'she goes to Maple Grove PS',
    expect: { status: 'nothing_stated' },
  },
];

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  if (!cachedOnly) installEvalSpendCap();
  const agent = await importTs(AGENT_SRC);
  const read = await importTs(join(BREAK_DIR, 'read.ts'));
  const lookupMod = await importTs(join(BREAK_DIR, 'lookup.ts'));
  const reply = await importTs(join(BREAK_DIR, 'reply.ts'));
  const readSkill = await agent.loadSkill(join(SKILLS, `${read.SCHOOL_BREAK_READ_SKILL}.md`));
  const replySkill = await agent.loadSkill(join(SKILLS, `${reply.SCHOOL_BREAK_REPLY_SKILL}.md`));
  const readLane = agent.pickLane(readSkill.meta.task);
  const replyLane = agent.pickLane(replySkill.meta.task);
  const getClient = lazyAnthropic('school-break');
  const cost = makeCost();

  console.info(
    `school-break eval${cachedOnly ? ' (cached-only)' : ''} | read=${readLane.model} reply=${replyLane.model}`,
  );
  let failed = 0;
  const report = (id, failures, detail) => {
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${id}  ${failures.join('; ')}`);
    console.info(`      ${JSON.stringify(detail)}`);
  };

  for (const fixture of PAGE_CASES) {
    let modelCalls = 0;
    const reader = read.createBreakPageReader({
      fetchBody: async (url) => {
        const page = PAGES.get(url);
        if (page === undefined) throw new Error(`no fixture page for ${url}`);
        return { outcome: 'fetched', body: Buffer.from(page) };
      },
      extract: async (schoolYear, pageText) => {
        modelCalls += 1;
        const { value } = await cachedToolCall({
          tag: evalRunTag(`school-break-read:${fixture.id}`),
          lane: readLane,
          model: readLane.model,
          system: readSkill.instructions,
          userMessage: read.schoolBreakReadInput(schoolYear, pageText),
          toolName: read.SCHOOL_BREAK_READ_TOOL,
          toolDescription: read.SCHOOL_BREAK_READ_DESCRIPTION,
          toolSchema: read.SCHOOL_BREAK_READ_SCHEMA,
          maxTokens: read.SCHOOL_BREAK_READ_MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        });
        return read.schoolBreakReadParse.parse(value);
      },
    });
    const reading = await reader({
      url: fixture.url,
      officialHost: BOARD,
      schoolYear: SCHOOL_YEAR,
    });
    const failures = [];
    const want = fixture.expect;
    if (reading.status !== want.status) failures.push(`status ${reading.status} != ${want.status}`);
    if (want.name !== undefined && reading.name !== want.name)
      failures.push(`name ${reading.name}`);
    if (want.firstDay !== undefined && reading.firstDay?.date !== want.firstDay) {
      failures.push(`first day ${reading.firstDay?.date}`);
    }
    if (want.lastDay !== undefined && reading.lastDay?.date !== want.lastDay) {
      failures.push(`last day ${reading.lastDay?.date}`);
    }
    if (want.modelCalls !== undefined && modelCalls !== want.modelCalls) {
      failures.push(`model asked ${modelCalls} times`);
    }
    if (want.lookup !== undefined) {
      // The lookup over the same reading: what the sweep stores, and why it then asks.
      const lookup = await lookupMod.lookupBoardBreak(
        {
          search: async () => ({ outcome: 'pages', boardName: 'Example DSB', urls: [fixture.url] }),
          read: async () => reading,
        },
        BOARD,
        SCHOOL_YEAR,
      );
      if (lookup.status !== 'not_found' || lookup.reason !== want.lookup) {
        failures.push(`lookup ${lookup.status}:${lookup.reason}`);
      }
    }
    report(fixture.id, failures, reading);
  }

  for (const fixture of REPLY_CASES) {
    const { value } = await cachedToolCall({
      tag: evalRunTag(`school-break-reply:${fixture.id}`),
      lane: replyLane,
      model: replyLane.model,
      system: replySkill.instructions,
      userMessage: reply.schoolBreakReplyUserMessage(fixture.text, '2026-11-12', SCHOOL_YEAR),
      toolName: reply.SCHOOL_BREAK_REPLY_TOOL,
      toolDescription: reply.SCHOOL_BREAK_REPLY_DESCRIPTION,
      toolSchema: reply.SCHOOL_BREAK_REPLY_SCHEMA,
      maxTokens: reply.SCHOOL_BREAK_REPLY_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const reading = reply.toSchoolBreakReplyReading(
      reply.schoolBreakReplyParse.parse(value),
      fixture.text,
      SCHOOL_YEAR,
    );
    const failures = [];
    const want = fixture.expect;
    if (reading.status !== want.status) failures.push(`status ${reading.status} != ${want.status}`);
    if (want.firstDay !== undefined && reading.firstDay !== want.firstDay) {
      failures.push(`first day ${reading.firstDay}`);
    }
    if (want.lastDay !== undefined && reading.lastDay !== want.lastDay) {
      failures.push(`last day ${reading.lastDay}`);
    }
    report(fixture.id, failures, reading);
  }

  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'school-break eval failed');
    process.exit(1);
  });
}
