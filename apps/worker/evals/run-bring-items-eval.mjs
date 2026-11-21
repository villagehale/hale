// What to bring, read from an email or a flyer · the eval for the bring-items-read skill
// (VIL-720; hard rule #8: no LLM mocking).
//
// SUBJECT: whether the read returns the items the source asks the family to bring for ONE
// event, and nothing else: no item a planted line asks for (VIL-560), no item usual for the
// event but never asked, no item for another event in the same email. Scored after the
// REAL code guards (`keptBringItems`, bring/read.ts), the ones production applies before
// anything is stored, so a reading code would drop is graded as dropped.
//
// THE REQUEST IS PRODUCTION'S. The skill file and its lane (`pickLane`), the user bytes
// (`bringItemsUserMessage`), the tool schema, name, description and max_tokens are imported
// from bring/read.ts, and a flyer rides as the same image block attachmentContentBlock
// builds. Exact, not judged (lib/bring-items-grade.mjs): no judge draw is ever paid.
//
//   node evals/run-bring-items-eval.mjs --dry           # $0, no API: worst-case $ projection
//   node evals/run-bring-items-eval.mjs --broken        # calibration, $0: every case must FAIL
//   node evals/run-bring-items-eval.mjs --cached-only   # replay only, $0 (a miss fails)
//   node --env-file=../../.env evals/run-bring-items-eval.mjs --live   # PAID: needs Barton's yes
// Exactly one mode. Any other flag, none, or two exits 2 before the spend cap or a client
// exists (lib/eval-flags.mjs).
//
// NOT in CI yet: there is no recorded cache, and recording it is a paid run (pending Noah).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { BRING_ITEMS_EMAIL_FIXTURES, BRING_ITEMS_PHOTO_FIXTURES } from './bring-items-fixtures.mjs';
import { brokenBringItems, gradeBringItems } from './lib/bring-items-grade.mjs';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  cacheGet,
  cacheKey,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'bring-items-read.md');
const READ_TS = join(WEB_ROOT, 'lib', 'loop', 'reminders', 'bring', 'read.ts');
const BLOCKS_TS = join(WEB_ROOT, 'lib', 'coach', 'attachment-blocks.ts');
const FIXTURE_ROOT = join(HERE, 'fixtures');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** A page this size is about 1,440 image tokens; priced higher so the projection holds. */
const IMAGE_TOKENS_ESTIMATE = 1600;

/** Every case as the request production sends: the event, the source, the attachments. */
async function cases(read, attachmentContentBlock) {
  const out = [];
  for (const fixture of BRING_ITEMS_EMAIL_FIXTURES) {
    const source = { kind: 'email', ...fixture.email };
    out.push({ fixture, source, input: { event: fixture.event, source }, attachments: [] });
  }
  for (const fixture of BRING_ITEMS_PHOTO_FIXTURES) {
    const bytes = await readFile(join(FIXTURE_ROOT, fixture.dir, fixture.file));
    const block = attachmentContentBlock(bytes, fixture.mime);
    const source = { kind: 'photo', parentWords: fixture.parentWords, attachments: [block] };
    out.push({
      fixture,
      source,
      input: { event: fixture.event, source },
      attachments: read.bringItemsAttachments(source),
    });
  }
  return out;
}

async function load() {
  const agent = await importTs(AGENT_SRC);
  const read = await importTs(READ_TS);
  const { attachmentContentBlock } = await importTs(BLOCKS_TS);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  return { agent, read, skill, lane, all: await cases(read, attachmentContentBlock) };
}

function request(read, skill, lane, c) {
  return {
    tag: `bring-items:${c.fixture.id}`,
    lane,
    system: skill.instructions,
    userMessage: read.bringItemsUserMessage(c.input),
    ...(c.attachments.length > 0 ? { attachments: c.attachments } : {}),
    toolName: read.BRING_ITEMS_TOOL,
    toolDescription: read.BRING_ITEMS_TOOL_DESCRIPTION,
    toolSchema: read.bringItemsJsonSchema,
    maxTokens: read.BRING_ITEMS_MAX_TOKENS,
  };
}

async function main() {
  const mode = parseEvalFlagsOrExit('bring-items');
  if (mode === 'dry') return dryRun();
  const broken = mode === 'broken';
  const cachedOnly = mode === 'cached-only';
  installEvalSpendCap();
  // Only --live ever gets a real client.
  const getClient = mode === 'live' ? lazyAnthropic('bring-items') : noClient('bring-items');
  const cost = makeCost();
  const { read, skill, lane, all } = await load();
  console.log(
    `bring-items eval | mode=${mode} | model=${lane.model} | ${all.length} cases (${BRING_ITEMS_EMAIL_FIXTURES.length} email, ${BRING_ITEMS_PHOTO_FIXTURES.length} flyer)`,
  );

  const results = [];
  for (const c of all) {
    let raw;
    if (broken) {
      raw = brokenBringItems(c.fixture);
    } else {
      const { value } = await cachedToolCall({
        ...request(read, skill, lane, c),
        cachedOnly,
        getClient,
        cost,
      });
      const parsed = read.bringItemsSchema.safeParse(value);
      if (!parsed.success) {
        results.push({ c, raw: [], kept: [], failures: ['UNREADABLE (nothing is kept)'] });
        continue;
      }
      raw = parsed.data.items;
    }
    const { items: kept } = read.keptBringItems(raw, c.source);
    results.push({ c, raw, kept, failures: gradeBringItems(c.fixture, raw, kept) });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.c.fixture.id.padEnd(24)} kept=${JSON.stringify(r.kept)}${r.raw.length !== r.kept.length ? ` raw=${JSON.stringify(r.raw)}` : ''}`,
    );
    for (const failure of r.failures) console.log(`      · ${failure}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (!broken) process.exit(failed === 0 ? 0 : 1);
  const calibrated = failed === results.length;
  console.log(
    `broken-mode calibration (every case must fail): ${calibrated ? 'PASS' : `FAIL (${results.length - failed} passed)`}`,
  );
  process.exit(calibrated ? 0 : 1);
}

/** $0: no spend cap, no client. Keys each case as cachedToolCall does; prices each miss. */
async function dryRun() {
  const { read, skill, lane, all } = await load();
  console.log(`bring-items eval | mode=dry (no API calls) | model=${lane.model}`);
  let worst = 0;
  let cached = 0;
  for (const c of all) {
    const req = request(read, skill, lane, c);
    const key = cacheKey(
      req.tag,
      JSON.stringify({
        model: lane.model,
        system: req.system,
        userMessage: req.userMessage,
        ...(req.attachments ? { attachments: req.attachments } : {}),
        toolName: req.toolName,
        toolSchema: req.toolSchema,
        lane,
      }),
    );
    if (await cacheGet(key)) {
      cached += 1;
      console.log(`DRY  cached    ${req.tag}`);
      continue;
    }
    const inTokens =
      estimateTokens(req.system + req.userMessage + JSON.stringify(req.toolSchema)) +
      c.attachments.length * IMAGE_TOKENS_ESTIMATE;
    const usd = worstCaseUsd(lane.model, inTokens, req.maxTokens);
    worst += usd;
    console.log(
      `DRY  uncached  ${req.tag}  ~${inTokens} in + ${req.maxTokens} max out  worst $${usd.toFixed(5)}`,
    );
  }
  console.log(
    `DRY summary | ${all.length} calls (cached ${cached}, uncached ${all.length - cached}) | no judge draws | worst $${worst.toFixed(5)}`,
  );
  console.log(
    'DRY: input tokens are an offline estimate (1 per 3 bytes, images ~1600); live calls: 0',
  );
}

main().catch((err) => {
  console.error('bring-items eval harness error:', err);
  process.exit(2);
});
