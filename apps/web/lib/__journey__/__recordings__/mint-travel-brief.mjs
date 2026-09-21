// Mint `travel-brief.json` from the eval caches — NO new model call.
//
// WHY A TRANSCODE AND NOT `HALE_RECORD=1`, which is the `mint-booked-activity.mjs`
// argument applied to a second journey. The three turns this journey replays are turns two
// eval suites already run live:
//
//   · the EXTRACTION is `travel-extract:airline-named-child` — the same skill body, the
//     same lane, the same forced-tool request, and (this is the part that had to be made
//     true) a byte-identical user message, which is why the journey's envelope carries the
//     corpus's `from`, its `received_at` and its two child first names rather than a
//     hand-typed set.
//
//   · the FINDER's two turns are `activity-ground:travel-visit-new-york` and
//     `activity-picks:travel-visit-new-york` — the fixture that exists precisely because
//     `TRAVEL_SUBJECT` + a destination in `town` + a no-year window is the only new model
//     behaviour in the find leg, and a hand-scripted model can never fail on it.
//
// Recording them a second time would pay twice for one answer and let the journey's copy
// drift away from the corpus the gate measures. The drift property is the whole point:
// edit the skill, the subject, the window or the fixture body and BOTH keys move — the
// eval goes red on `--cached-only` until it is re-minted live, and the journey goes red
// with "no recording for key" until this script is re-run.
//
//   cd apps/worker && node ../web/lib/__journey__/__recordings__/mint-travel-brief.mjs
//
// (from apps/worker, because this resolves `tsx` out of the worker package, exactly as the
// eval runners do.)
//
// THE GROUND TURN IS THE ONE REBUILT SHAPE, and it is worth being plain about. The eval
// cache stores what `readEvidence` made of that turn — the write-up, the search count and
// the title/url pairs — not the raw blocks. So this script rebuilds a response whose text
// block IS the recorded write-up and whose `web_search_tool_result` carries the recorded
// results, which is enough for the lane's own `readEvidence` to reproduce the same notes
// and a non-zero count. The model's WORDS are the model's; only the envelope is rebuilt.
// The proof that the rebuild is faithful is the NEXT key: the compose turn's cache address
// is computed over those very notes, so a rebuild that produced anything else would make
// the picks lookup below miss.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const EVAL_CACHE = join(REPO, 'apps', 'worker', 'evals', 'cache');
const OUT = join(HERE, 'travel-brief.json');
const EXTRACT_FIXTURE_ID = 'airline-named-child';
const FINDER_FIXTURE_ID = 'travel-visit-new-york';

const MINT_EXTRACT =
  '  cd apps/worker && node --env-file=../../.env evals/run-travel-extract-eval.mjs';
const MINT_FINDER =
  '  cd apps/worker && node --env-file=../../.env evals/run-activity-finder-eval.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
/** apps/worker/evals/lib/harness.mjs — sha256(tag + "\n" + canonical request). */
const evalKey = (tag, canonical) => sha(`${tag}\n${canonical}`);
/** apps/web/lib/testing/recorded-model.ts — sha256(model + "\n" + system + "\n" + user). */
const journeyKey = (model, system, userMessage) => sha(`${model}\n${system}\n${userMessage}`);

function readEvalEntry(tag, canonical, howToMint) {
  const key = evalKey(tag, canonical);
  const path = join(EVAL_CACHE, `${key}.json`);
  if (!existsSync(path)) {
    throw new Error(
      [
        `no eval cache entry for ${tag} (key ${key}).`,
        'Run the suite live once to populate it:',
        howToMint,
        'then re-run this script.',
      ].join('\n'),
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The forced-tool envelope the journey's client returns. The ANSWER is the model's; only
 * the transport shape is rebuilt, because the eval cache stores the parsed tool input. */
function toolEnvelope(toolName, input) {
  return {
    content: [{ type: 'tool_use', id: `transcoded-${toolName}`, name: toolName, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** `searchEvidence` in run-activity-finder-eval.mjs flattens every result to its title
 * then its url, in order, so the pairs read straight back out. */
function searchResultsFrom(evidence) {
  const lines = String(evidence ?? '')
    .split('\n')
    .filter((line) => line !== '');
  const results = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    results.push({
      type: 'web_search_result',
      url: lines[i + 1],
      title: lines[i],
      encrypted_content: '',
      page_age: null,
    });
  }
  return results;
}

function record(model, system, userMessage, response) {
  const key = journeyKey(model, system, userMessage);
  return [
    key,
    { key, recordedAt: new Date().toISOString(), request: { model, userMessage }, response },
  ];
}

const agent = await tsImport(join(REPO, 'packages', 'agent', 'src', 'index.ts'), import.meta.url);
const finderSkill = await agent.loadSkill(
  join(REPO, 'packages', 'agent', 'skills', 'activity-finder.md'),
);
const extractSkill = await agent.loadSkill(
  join(REPO, 'packages', 'agent', 'skills', 'extract-travel-booking.md'),
);
const { ACTIVITY_FIXTURES } = await import(
  join(REPO, 'apps', 'worker', 'evals', 'activity-finder-fixtures.mjs')
);
const { TRAVEL_EXTRACT_FIXTURES } = await import(
  join(REPO, 'apps', 'worker', 'evals', 'travel-extract-fixtures.mjs')
);
const { readModelIds } = await import(join(REPO, 'apps', 'worker', 'evals', 'lib', 'harness.mjs'));

const recordings = Object.fromEntries([]);

// ── 1. THE EXTRACTION ────────────────────────────────────────────────────────
//
// The tool schema and the two lane fields are mirrored from run-travel-extract-eval.mjs,
// because they are part of the canonical request its key is computed over. A drift is a
// miss with the key printed, never a quiet substitution.
const booking = TRAVEL_EXTRACT_FIXTURES.find((f) => f.id === EXTRACT_FIXTURE_ID);
if (!booking) throw new Error(`the travel corpus no longer carries ${EXTRACT_FIXTURE_ID}`);

const extractSchema = {
  type: 'object',
  properties: {
    destination_city: {
      type: ['string', 'null'],
      description: 'The municipality travelled TO. Never a street, a property or a district.',
    },
    destination_region: {
      type: ['string', 'null'],
      description: 'The province, state or country, when the email states it plainly.',
    },
    start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD departure / check-in.' },
    end_date: {
      type: ['string', 'null'],
      description: 'YYYY-MM-DD return / check-out, or null.',
    },
    child_evidence: {
      type: 'string',
      enum: ['named_traveller', 'child_fare', 'none'],
      description: "Why the booking's own text says a child is travelling, or 'none'.",
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['destination_city', 'start_date', 'child_evidence', 'confidence'],
};

// The runtime's ceiling, read out of the module the way the eval reads it.
const extractSrc = readFileSync(join(REPO, 'apps', 'web', 'lib', 'travel', 'extract.ts'), 'utf8');
const maxTokensMatch = /const MAX_TOKENS = (\d+);/.exec(extractSrc);
if (!maxTokensMatch) throw new Error('could not parse MAX_TOKENS from lib/travel/extract.ts');
const extractMaxTokens = Number(maxTokensMatch[1]);

const evalModels = await readModelIds();
const extractLaneModel = agent.laneRequestFields(agent.pickLane(extractSkill.meta.task)).model;
if (extractLaneModel !== evalModels.sonnet5) {
  throw new Error(
    `the extract lane sends ${extractLaneModel} and the eval keyed on ${evalModels.sonnet5}; re-mint the eval before transcoding.`,
  );
}

// Byte-identical to what apps/web/lib/travel/extract.ts builds.
const extractUser = JSON.stringify({
  email: { subject: booking.subject, from: booking.from, body: booking.body },
  received_at: booking.receivedAt,
  household_child_first_names: booking.childFirstNames,
});

const extractEntry = readEvalEntry(
  `travel-extract:${EXTRACT_FIXTURE_ID}`,
  JSON.stringify({
    model: evalModels.sonnet5,
    system: extractSkill.instructions,
    userMessage: extractUser,
    schema: extractSchema,
    thinking: { type: 'adaptive' },
    outputConfig: { effort: 'high' },
    maxTokens: extractMaxTokens,
  }),
  MINT_EXTRACT,
);

const [extractKey, extractRecording] = record(
  extractLaneModel,
  extractSkill.instructions,
  extractUser,
  toolEnvelope('travel_booking', extractEntry.value),
);
recordings[extractKey] = extractRecording;
console.info(`travel-extract:${EXTRACT_FIXTURE_ID}  ->  ${extractKey}`);

// ── 2 & 3. THE FINDER'S TWO TURNS ────────────────────────────────────────────
const fixture = ACTIVITY_FIXTURES.find((f) => f.id === FINDER_FIXTURE_ID);
if (!fixture) throw new Error(`the activity corpus no longer carries ${FINDER_FIXTURE_ID}`);

const finderModel = agent.pickModel(finderSkill.meta.task);
const composeModel = agent.laneRequestFields(agent.pickLane(finderSkill.meta.task)).model;
if (composeModel !== finderModel) {
  throw new Error(
    `the lane grounds on ${finderModel} and composes on ${composeModel}; the eval keyed both on ${finderModel}.`,
  );
}

// `groundUserMessage` / `composeUserMessage` (activity/lane.ts), field for field.
const groundUser = JSON.stringify({
  subject: fixture.subject,
  ...(fixture.town ? { town: fixture.town } : {}),
  ...(fixture.stage ? { stage: fixture.stage } : {}),
  ...(fixture.window ? { window: fixture.window } : {}),
});

// A travel subject names no venue, so the lane hands the grounding turn search only —
// `groundTools`/`namesAVenue`, mirrored by the eval and asserted here rather than assumed.
if (/\b[A-Z][A-Za-z0-9'-]{2,}/.test(fixture.subject)) {
  throw new Error(
    `${FINDER_FIXTURE_ID}: the subject now names a place, so the lane would hand it web_fetch too and the tool list in the eval key has changed.`,
  );
}
const groundTools = [{ name: 'web_search', type: 'web_search_20250305', max_uses: 3 }];

const ground = readEvalEntry(
  `activity-ground:${FINDER_FIXTURE_ID}`,
  JSON.stringify({
    model: finderModel,
    system: finderSkill.instructions,
    userMessage: groundUser,
    tools: groundTools,
  }),
  MINT_FINDER,
);
if (!ground.notes || ground.notes.trim() === '') {
  throw new Error(
    `${FINDER_FIXTURE_ID}: the cached grounding turn wrote nothing down (empty_research); the lane would refuse it. Re-draw it in the eval first.`,
  );
}
const searchResults = searchResultsFrom(ground.evidence);
if (searchResults.length === 0) {
  throw new Error(`${FINDER_FIXTURE_ID}: the cached grounding turn carries no search results.`);
}

const [groundKey, groundRecording] = record(finderModel, finderSkill.instructions, groundUser, {
  content: [
    { type: 'text', text: ground.notes },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtu_transcoded',
      content: searchResults,
    },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 0, output_tokens: 0 },
});
recordings[groundKey] = groundRecording;
console.info(`activity-ground:${FINDER_FIXTURE_ID}  ->  ${groundKey}`);

// Mirrored from run-activity-finder-eval.mjs `PICKS_TOOL_SCHEMA`, which mirrors the lane's
// `composeJsonSchema`. It is in the eval's key, so it is in this lookup.
const picksSchema = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          price: { type: 'string' },
          source_name: { type: 'string' },
        },
        required: ['name', 'age_fit', 'source_name'],
      },
    },
  },
  required: ['picks'],
};

const composeUser = JSON.stringify({ ...JSON.parse(groundUser), research_notes: ground.notes });
const picks = readEvalEntry(
  `activity-picks:${FINDER_FIXTURE_ID}`,
  JSON.stringify({
    model: finderModel,
    system: finderSkill.instructions,
    userMessage: composeUser,
    toolName: 'activity_picks',
    toolSchema: picksSchema,
  }),
  MINT_FINDER,
);

const [picksKey, picksRecording] = record(
  composeModel,
  finderSkill.instructions,
  composeUser,
  toolEnvelope('activity_picks', picks.value),
);
recordings[picksKey] = picksRecording;
console.info(`activity-picks:${FINDER_FIXTURE_ID}  ->  ${picksKey}`);

writeFileSync(OUT, `${JSON.stringify(recordings, null, 2)}\n`, 'utf8');
console.info(`wrote ${Object.keys(recordings).length} turn(s) to ${OUT}`);
