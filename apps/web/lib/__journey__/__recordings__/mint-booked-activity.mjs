// Mint `booked-activity.json` from the sentinel eval cache — NO new model call.
//
// WHY A TRANSCODE AND NOT `HALE_RECORD=1`. The triage and extraction turns the booked
// journey replays are the SAME two turns the sentinel eval already runs live against the
// `booking-municipal-rec-receipt` fixture: same skill body, same model tier, same
// forced-tool request, byte-identical user message. Recording them a second time would
// pay twice for one answer and, worse, would let the journey's copy drift away from the
// corpus the gate actually measures. So this script re-keys the eval cache entry into the
// journey recorder's own content address and writes the raw-message envelope around it.
//
// The drift property is unchanged and is the whole point: edit either skill and BOTH keys
// move. The eval goes red on `--cached-only` until it is re-minted live, and the journey
// goes red with "no recording for key" until this script is re-run. A recording can never
// answer a question it was not asked.
//
//   cd apps/worker && node ../web/lib/__journey__/__recordings__/mint-booked-activity.mjs
//
// (from apps/worker, because this resolves `tsx` out of the worker package, exactly as
// the eval runners do.)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const EVAL_CACHE = join(REPO, 'apps', 'worker', 'evals', 'cache');
const OUT = join(HERE, 'booked-activity.json');
const FIXTURE_ID = 'booking-municipal-rec-receipt';

// The two tool schemas, mirrored from run-sentinel-eval.mjs because they are part of the
// canonical request the eval's cache key is computed over.
const TRIAGE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    child_related: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
  },
  required: ['child_related', 'confidence', 'rationale'],
};

const EXTRACT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [
        'cancellation',
        'reschedule',
        'new_event',
        'reminder_only',
        'unclear',
        'booking_confirmation',
      ],
    },
    event: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        child_ref: { type: ['string', 'null'] },
        original_time: { type: ['string', 'null'] },
        new_time: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
      },
      required: ['title'],
    },
    source_confidence: { type: 'number', minimum: 0, maximum: 1 },
    quote_evidence: { type: 'string' },
    teen_content: { type: 'boolean' },
  },
  required: ['kind', 'event', 'source_confidence', 'quote_evidence'],
};

const sha = (value) => createHash('sha256').update(value).digest('hex');
/** apps/worker/evals/lib/harness.mjs — sha256(tag + "\n" + canonical request). */
const evalKey = (tag, canonical) => sha(`${tag}\n${canonical}`);
/** apps/web/lib/testing/recorded-model.ts — sha256(model + "\n" + system + "\n" + user). */
const journeyKey = (model, system, userMessage) => sha(`${model}\n${system}\n${userMessage}`);

function readEvalValue(tag, canonical) {
  const key = evalKey(tag, canonical);
  const path = join(EVAL_CACHE, `${key}.json`);
  if (!existsSync(path)) {
    throw new Error(
      [
        `no sentinel eval cache entry for ${tag} (key ${key}).`,
        'Re-run the sentinel eval live first:',
        '  cd apps/worker && node --env-file=../../.env evals/run-sentinel-eval.mjs',
        'then re-run this script.',
      ].join('\n'),
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')).value;
}

/** The raw-message envelope the journey's client returns. The ANSWER is the model's; only
 * the transport shape around it is rebuilt, because the eval cache stores the parsed tool
 * input rather than the blocks. */
function envelope(toolName, input) {
  return {
    content: [{ type: 'tool_use', id: `transcoded-${toolName}`, name: toolName, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

const agent = await tsImport(join(REPO, 'packages', 'agent', 'src', 'index.ts'), import.meta.url);
const triageSkill = await agent.loadSkill(
  join(REPO, 'packages', 'agent', 'skills', 'triage-child-event.md'),
);
const extractSkill = await agent.loadSkill(
  join(REPO, 'packages', 'agent', 'skills', 'extract-child-event.md'),
);
const { FIXTURES, CHILDREN, RECEIVED_AT, FAMILY_TIMEZONE } = await import(
  join(REPO, 'apps', 'worker', 'evals', 'sentinel-fixtures.mjs')
);

const fixture = FIXTURES.find((f) => f.id === FIXTURE_ID);
if (!fixture) throw new Error(`the sentinel corpus no longer carries ${FIXTURE_ID}`);

// Byte-identical to what apps/web/lib/sentinel/{triage,extract}.ts build. If either
// projection changes, both keys move and both caches miss loudly.
const triageUser = JSON.stringify({
  envelope: fixture.envelope,
  children: CHILDREN.map((c) => c.name),
});
const extractUser = JSON.stringify({
  email: { subject: fixture.envelope.subject, from: fixture.envelope.from, body: fixture.body },
  received_at: RECEIVED_AT,
  family_timezone: FAMILY_TIMEZONE,
  children: CHILDREN.map((c) => ({ id: c.id, name: c.name, ageInMonths: c.ageInMonths })),
});

const triageModel = agent.pickModel(triageSkill.meta.task);
const extractModel = agent.pickModel(extractSkill.meta.task);

const turns = [
  {
    tag: `sentinel:triage:${FIXTURE_ID}`,
    toolName: 'triage',
    model: triageModel,
    system: triageSkill.instructions,
    userMessage: triageUser,
    toolSchema: TRIAGE_TOOL_SCHEMA,
  },
  {
    tag: `sentinel:extract:${FIXTURE_ID}`,
    toolName: 'extraction',
    model: extractModel,
    system: extractSkill.instructions,
    userMessage: extractUser,
    toolSchema: EXTRACT_TOOL_SCHEMA,
  },
];

const recordings = {};
for (const turn of turns) {
  const canonical = JSON.stringify({
    model: turn.model,
    system: turn.system,
    userMessage: turn.userMessage,
    toolName: turn.toolName,
    toolSchema: turn.toolSchema,
  });
  const value = readEvalValue(turn.tag, canonical);
  const key = journeyKey(turn.model, turn.system, turn.userMessage);
  recordings[key] = {
    key,
    recordedAt: new Date().toISOString(),
    request: { model: turn.model, userMessage: turn.userMessage },
    response: envelope(turn.toolName, value),
  };
  console.info(`${turn.tag}  ->  ${key}`);
}

writeFileSync(OUT, `${JSON.stringify(recordings, null, 2)}\n`, 'utf8');
console.info(`wrote ${Object.keys(recordings).length} turn(s) to ${OUT}`);
