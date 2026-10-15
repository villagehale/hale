import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * What an activity-deep re-record costs after the citation skill change.
 *
 * The skill is in the research and extract keys, so those miss, and the follow-up
 * and the judge take the extract's slots, which are not known until it is
 * re-recorded. Output sizes are the last committed recording. The cartwheels
 * research is cache e550c9ea (4 searches, 2,686 characters of model text,
 * 100,453 characters of tool-result JSON, 23,698 characters of notes).
 */
import { tsImport } from 'tsx/esm/api';
import { DEEP_FIXTURES } from '../activity-deep-fixtures.mjs';
import {
  DEEP_TOOL_SCHEMA,
  EXTRACT_MAX_TOKENS,
  FOLLOWUP_TOOL_SCHEMA,
  JUDGE_SYSTEM,
  RESEARCH_MAX_TOKENS,
  RESEARCH_TOOLS,
  deepExtractMessage,
  deepUserMessage,
  followUpUserMessage,
} from '../run-activity-deep-eval.mjs';
import { notesForTheJudge } from './activity-deep-facts.mjs';
import { JUDGE_SAMPLES_MEDIAN, JUDGE_SCHEMA } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const DEEP_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-deep.md');
const FINDER_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-finder.md');

const LAST_RESEARCH = {
  searchRequests: 4,
  modelTextChars: 2686,
  toolResultChars: 100453,
  notesChars: 23698,
};
const LAST_EXTRACT_OUTPUT = {
  'cartwheels-live-research': 2045,
  'registration-in-plain-sight': 574,
  'registration-opens-later': 946,
  'price-is-on-a-different-page': 421,
  'every-fetch-refused': 319,
  'read-and-empty': 83,
};
const FOLLOWUP_OUTPUT_CHARS = 280;
const JUDGE_OUTPUT_CHARS = 1100;
const FOLLOWUP_MAX_TOKENS = 400;

function queryOf(fixture) {
  return {
    subject: fixture.subject,
    town: fixture.town,
    stage: fixture.stage,
    window: fixture.window,
  };
}

function cartwheelsJudgeNotes() {
  const pages = [
    ['https://www.cartwheelsgymcentre.com/programs.php', 8015],
    ['https://www.cartwheelsgymcentre.com/', 3542],
    ['https://www.cartwheelsgymcentre.com/registration.php', 5259],
    ['https://cartwheelsgymcentre.uplifterinc.com/login/', 3939],
  ];
  return notesForTheJudge({
    notes: 'n'.repeat(LAST_RESEARCH.notesChars),
    pages: pages.map(([url, chars]) => ({ url, text: 'x'.repeat(chars) })),
  });
}

export async function uncachedActivityDeepCalls() {
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const deepSkill = await agent.loadSkill(DEEP_SKILL);
  const finderSkill = await agent.loadSkill(FINDER_SKILL);
  const model = agent.pickModel(deepSkill.meta.task);
  const judgeModel = agent.JUDGE_MODEL;
  const calls = [];
  const shortIds = [];

  const live = DEEP_FIXTURES.find((fixture) => fixture.notes === null);
  calls.push({
    model,
    promptCache: false,
    prefixId: 'activity-deep-research',
    prefix: `${deepSkill.instructions}\n${JSON.stringify(RESEARCH_TOOLS)}`,
    user: `${deepUserMessage(queryOf(live))}${'t'.repeat(LAST_RESEARCH.toolResultChars)}`,
    outputChars: LAST_RESEARCH.modelTextChars,
    maxTokens: RESEARCH_MAX_TOKENS,
    search: true,
    searchMaxUses: 4,
    searchRequests: LAST_RESEARCH.searchRequests,
    group: 'activity-deep',
    fixtureId: live.id,
  });
  shortIds.push(live.id);

  const judgeNotes = cartwheelsJudgeNotes();
  for (const fixture of DEEP_FIXTURES) {
    const query = queryOf(fixture);
    const notes = fixture.notes === null ? 'n'.repeat(LAST_RESEARCH.notesChars) : fixture.notes;
    calls.push({
      model,
      promptCache: true,
      prefixId: 'activity-deep-extract',
      prefix: `${deepSkill.instructions}\n${JSON.stringify(DEEP_TOOL_SCHEMA)}`,
      user: deepExtractMessage(query, notes),
      outputChars: LAST_EXTRACT_OUTPUT[fixture.id],
      maxTokens: EXTRACT_MAX_TOKENS,
      group: 'activity-deep',
      fixtureId: fixture.id,
    });
    if (fixture.notes !== null) shortIds.push(fixture.id);

    const composes = fixture.composesText !== false;
    const pageEvidence = fixture.expectPagesRead === false ? 'no_page_read' : 'page_has_schedule';
    const picks = [
      {
        name: fixture.subject,
        ageFit: fixture.stage,
        when: null,
        price: null,
        registration: null,
        sourceName: fixture.subject,
      },
    ];
    if (composes) {
      calls.push({
        model,
        promptCache: true,
        prefixId: 'activity-deep-followup',
        prefix: `${finderSkill.instructions}\n${JSON.stringify(FOLLOWUP_TOOL_SCHEMA)}`,
        user: followUpUserMessage(fixture.subject, picks, pageEvidence, true),
        outputChars: FOLLOWUP_OUTPUT_CHARS,
        maxTokens: FOLLOWUP_MAX_TOKENS,
        group: 'activity-deep',
        fixtureId: fixture.id,
      });
    }
    const payload = {
      watch: true,
      pageEvidence,
      subject: fixture.subject,
      town: fixture.town,
      stage: fixture.stage,
      notes: fixture.notes === null ? judgeNotes : fixture.notes,
      slots: picks,
      message: composes ? 'm'.repeat(FOLLOWUP_OUTPUT_CHARS) : null,
      watchFor: fixture.watchFor,
    };
    for (let sample = 0; sample < JUDGE_SAMPLES_MEDIAN; sample += 1) {
      calls.push({
        model: judgeModel,
        promptCache: true,
        prefixId: 'activity-deep-judge',
        prefix: `${JUDGE_SYSTEM}\n${JSON.stringify(JUDGE_SCHEMA)}`,
        user: JSON.stringify(payload),
        outputChars: JUDGE_OUTPUT_CHARS,
        maxTokens: 8192,
        group: 'activity-deep',
        fixtureId: fixture.id,
      });
    }
  }

  return { calls, shortIds, searchRequests: LAST_RESEARCH.searchRequests };
}
