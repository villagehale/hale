// VIL-687 · shared lists with owners in a multi-family group (hard rule #8: no LLM mocking).
//
// The subject is the REAL shared-group-list-turn skill, called through the REAL request
// shape, inside the REAL readSharedListTurn / applySharedListTurn over the REAL DDL (pglite,
// every migration through shared_group_list_items). So the list the model is handed comes
// from the same audience filter production uses, and the writes are production's writes.
// Checks per case:
//   1. CODE: whether it was a list turn, every seeded item's owner afterwards, how many new
//      items the speaker owns (or are open), whether the gift is kept from the child's
//      family (calibrated both ways), that a secret gift never reached the model when the
//      child's family reads the chat, and that a doubled claim or an ask got a line.
//   2. JUDGE: facts, secrecy, tone and language of the line (judges/shared-group-list-turn).
//
//   node evals/run-shared-group-list-turn-eval.mjs                 # live, then caches
//   node evals/run-shared-group-list-turn-eval.mjs --broken        # judge must FAIL each
//   node evals/run-shared-group-list-turn-eval.mjs --cached-only   # CI: replay only
//   --only=<id>[,<id>]                                             # affected cases only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { knownMissState } from './coach-channel-known-miss.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import {
  SHARED_GROUP_LIST_TURN_BROKEN,
  SHARED_GROUP_LIST_TURN_FIXTURES,
} from './shared-group-list-turn-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'shared-group-list-turn.md');
const LISTS_SRC = join(WEB_ROOT, 'lib', 'channel', 'lists', 'shared-group-lists.ts');
const PGLITE_SRC = join(WEB_ROOT, 'lib', 'testing', 'pglite.ts');
const DB_SRC = join(REPO_ROOT, 'packages', 'db', 'src', 'index.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const CHAT = 'eval-shared-group-chat';
const NOW = new Date('2026-11-20T15:00:00.000Z');
const JUDGE_SYSTEM = judgePrompt('shared-group-list-turn');
/** Shared judge settings (#914): Sonnet, thinking off via the output cap, lowest of 3. */
const JUDGE_SAMPLES = 3;
const JUDGE_MAX_OUTPUT_TOKENS = 512;

function onlyIds() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  return arg ? new Set(arg.slice('--only='.length).split(',')) : null;
}

async function seed(dbm, database, fixture) {
  const { schema } = dbm;
  const families = new Map();
  for (const label of new Set(fixture.people.map((p) => p.family).filter(Boolean))) {
    const [row] = await database
      .insert(schema.families)
      .values({ displayName: `Family ${label}`, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    families.set(label, row.id);
  }
  for (const p of fixture.people) {
    for (const name of p.haleKids ?? []) {
      await database
        .insert(schema.children)
        .values({ familyId: families.get(p.family), name, dateOfBirth: '2020-03-01' });
    }
  }
  const people = [];
  for (const [index, p] of fixture.people.entries()) {
    const [row] = await database
      .insert(schema.linqSharedGroupPeople)
      .values({
        chatId: CHAT,
        phoneE164Hash: `eval-person-${index}`,
        familyId: p.family ? families.get(p.family) : null,
        firstName: p.name,
        inferredKidName: p.kid,
        seatedAt: new Date(NOW.getTime() - 3_600_000 + index),
      })
      .returning();
    people.push(row);
  }
  const fold = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [index, item] of fixture.items.entries()) {
    const hiddenFrom = item.hidden?.from.map((i) => people[i]) ?? [];
    await database.insert(schema.sharedGroupListItems).values({
      chatId: CHAT,
      listName: item.list,
      listKey: fold(item.list),
      text: item.text,
      textKey: fold(item.text),
      addedByPersonId: people[item.owner ?? 0].id,
      ownerPersonId: item.owner === null ? null : people[item.owner].id,
      claimedAt: item.owner === null ? null : NOW,
      hiddenForKid: item.hidden?.forKid ?? null,
      hiddenFromPersonIds: hiddenFrom.map((p) => p.id),
      hiddenFromFamilyIds: hiddenFrom.flatMap((p) => (p.familyId ? [p.familyId] : [])),
      // Everyone else was in the chat when it was hidden and has stayed.
      hiddenClearedPhoneHashes: item.hidden
        ? people.filter((p) => !hiddenFrom.includes(p)).map((p) => p.phoneE164Hash)
        : [],
      addedAt: new Date(NOW.getTime() - 60_000 + index),
    });
  }
  return people;
}

async function listState(dbm, database, people) {
  const rows = await database.select().from(dbm.schema.sharedGroupListItems);
  const nameOf = (id) => {
    if (!id) return null;
    const p = people.find((row) => row.id === id);
    return p?.firstName ?? 'someone';
  };
  return rows.map((row) => ({
    list: row.listName,
    text: row.text,
    owner: nameOf(row.ownerPersonId),
    secret:
      row.hiddenForKid !== null ||
      row.hiddenFromPersonIds.length > 0 ||
      row.hiddenFromFamilyIds.length > 0,
    forKid: row.hiddenForKid,
    ownerPersonId: row.ownerPersonId,
  }));
}

function judgeFacts(fixture, before, after) {
  const strip = (rows) => rows.map(({ ownerPersonId, ...rest }) => rest);
  return {
    speaker: fixture.people[fixture.speaker].name ?? 'a parent with no name in the chat',
    people: fixture.people.map((p) => ({ firstName: p.name, parentOf: p.kid })),
    before: strip(before),
    after: strip(after),
  };
}

function codeChecks(fixture, people, beforeRows, afterRows, read, result, seen) {
  const failures = [];
  const { expect: want } = fixture;
  const listTurn = read.kind === 'list';
  if (read.kind === 'unread' || read.kind === 'failed') failures.push(`read:${read.kind}`);
  if (listTurn !== want.listTurn) failures.push(`listTurn: got ${listTurn} want ${want.listTurn}`);
  const speaker = people[fixture.speaker].id;
  for (const [text, owner] of Object.entries(want.owners ?? {})) {
    const row = afterRows.find((r) => r.text === text);
    const got = row?.ownerPersonId ? people.findIndex((p) => p.id === row.ownerPersonId) : null;
    if (got !== owner) failures.push(`owner(${text}): got ${got} want ${owner}`);
  }
  const seeded = new Set(fixture.items.map((i) => i.text));
  const fresh = afterRows.filter((r) => !seeded.has(r.text));
  const newOwned = fresh.filter((r) => r.ownerPersonId === speaker).length;
  if (want.newOwned !== undefined && newOwned !== want.newOwned)
    failures.push(`newOwned: got ${newOwned} want ${want.newOwned}`);
  const newOpen = fresh.filter((r) => r.ownerPersonId === null).length;
  if (want.newOpen !== undefined && newOpen !== want.newOpen)
    failures.push(`newOpen: got ${newOpen} want ${want.newOpen}`);
  if (want.hide !== undefined) {
    const ownedBefore = new Set(
      beforeRows.filter((r) => r.ownerPersonId === speaker).map((r) => r.text),
    );
    const taken = afterRows.filter((r) => r.ownerPersonId === speaker && !ownedBefore.has(r.text));
    if (taken.length === 0) failures.push('hide: the speaker took nothing');
    for (const row of taken) {
      if (row.secret !== want.hide)
        failures.push(`hide(${row.text}): got ${row.secret} want ${want.hide}`);
    }
  }
  if (want.reply === 'required' && !(result.handled && result.line))
    failures.push(`no line (${result.handled ? result.lineWhy : result.why})`);
  if (want.hiddenNeverShown) {
    const shown = seen.some((input) => input.items.some((i) => i.text === want.hiddenNeverShown));
    if (shown) failures.push("a secret gift reached the model for its child's family");
  }
  return failures;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const only = onlyIds();
  installEvalSpendCap();
  const getClient = lazyAnthropic('shared-group-list-turn');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const dbm = await importTs(DB_SRC);
  const lists = await importTs(LISTS_SRC);
  const pglite = await importTs(PGLITE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = agent.SONNET_MODEL;
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'shared-group-list-turn',
    cachedOnly,
    getClient,
    cost,
    {
      samples: JUDGE_SAMPLES,
      aggregate: 'min',
      logCost: true,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    },
  );

  console.info(
    `shared-group-list-turn eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | subject=${lane.model} judge=${judgeModel}`,
  );
  const byId = new Map(SHARED_GROUP_LIST_TURN_FIXTURES.map((f) => [f.id, f]));
  const runs = broken
    ? SHARED_GROUP_LIST_TURN_BROKEN.map((c) => ({
        id: c.id,
        fixture: byId.get(c.fixture),
        brokenCase: c,
      }))
    : SHARED_GROUP_LIST_TURN_FIXTURES.map((f) => ({ id: f.id, fixture: f, brokenCase: null }));
  const results = [];
  for (const { id, fixture, brokenCase } of runs) {
    if (only && !only.has(id)) continue;
    const testDb = await pglite.createTestDb();
    try {
      const people = await seed(dbm, testDb.database, fixture);
      const before = await listState(dbm, testDb.database, people);
      let reply = null;
      let failures = [];
      let after;
      if (brokenCase) {
        reply = brokenCase.reply;
        // The state a correct turn leaves: the fixture's expected owners, nothing new.
        after = before.map((row) => {
          const owner = fixture.expect.owners?.[row.text];
          if (owner === undefined) return row;
          return {
            ...row,
            owner: owner === null ? null : (people[owner].firstName ?? 'someone'),
          };
        });
      } else {
        const seen = [];
        const model = {
          async decide(input) {
            seen.push(input);
            const call = await cachedToolCall({
              tag: `shared-group-list-turn:${fixture.id}`,
              lane,
              system: skill.instructions,
              userMessage: lists.sharedListTurnUserMessage(input),
              toolName: lists.SHARED_LIST_TURN_TOOL,
              toolSchema: lists.sharedListTurnJsonSchema,
              toolDescription: lists.SHARED_LIST_TURN_TOOL_DESCRIPTION,
              maxTokens: lists.SHARED_LIST_TURN_MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            });
            return call.value;
          },
        };
        const context = {
          chatId: CHAT,
          text: fixture.text,
          language: null,
          speaker: people[fixture.speaker],
          // The fixture's people are the whole chat: all seated before this turn, all reading.
          ...lists.sharedListAudience(people, new Set(people.map((p) => p.id)), async () =>
            people.map((p) => p.phoneE164Hash),
          ),
        };
        const read = await lists.readSharedListTurn(testDb.database, context, model);
        const result = await lists.applySharedListTurn(testDb.database, context, read, {
          model,
          now: NOW,
          deny: async () => [],
        });
        after = await listState(dbm, testDb.database, people);
        failures = codeChecks(fixture, people, before, after, read, result, seen);
        reply = result.handled ? result.line : null;
      }
      let score = null;
      let reason = '';
      if (reply) {
        const verdict = await judge(id, {
          groupMessage: `${fixture.people[fixture.speaker].name ?? 'A parent'}: ${fixture.text}`,
          reply,
          language: fixture.language,
          facts: judgeFacts(fixture, before, after),
          secrets: fixture.secrets,
          watchFor: fixture.watchFor,
        });
        score = verdict.score;
        reason = verdict.reason;
        if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
      } else if (brokenCase) {
        failures.push('broken case has no reply');
      }
      results.push({ id, fixture, reply, failures, score, reason });
    } finally {
      await testDb.close();
    }
  }

  for (const r of results) {
    const miss = broken ? 'none' : knownMissState(r.fixture, r.failures);
    const label = r.failures.length === 0 ? 'PASS' : miss === 'covered' ? 'MISS' : 'FAIL';
    console.info(
      `${label}  ${r.id.padEnd(28)} judge=${r.score ?? '-'} "${(r.reply ?? '(no line)').replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.info(`      · ${f}`);
    if (r.failures.length === 0 && r.reason) console.info(`      · judge reason: ${r.reason}`);
    if (miss === 'covered')
      console.info(`      · KNOWN MISS (${r.fixture.expect.knownMiss.ticket}), kept as recorded`);
    if (miss === 'stale')
      console.info('      · KNOWN MISS NOW PASSES: remove its knownMiss marker');
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (!broken) {
    // A recorded first-draw miss stays a finding, never re-drawn: it covers its fixture only
    // while that is the fixture's one failure, and a fixed one must drop its marker.
    const ok = results.every((r) => {
      const miss = knownMissState(r.fixture, r.failures);
      return miss === 'covered' || (miss === 'none' && r.failures.length === 0);
    });
    process.exit(results.length > 0 && ok ? 0 : 1);
  }
  // Every broken case has to fail on its own, not just one of them.
  const leaked = results.filter((r) => r.failures.length === 0).map((r) => r.id);
  const calibrated = results.length > 0 && leaked.length === 0;
  console.info(
    `broken-mode calibration (every case must fail): ${calibrated ? 'PASS' : `FAIL (passed: ${leaked.join(', ')})`}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('shared-group-list-turn eval harness error:', err);
  process.exit(2);
});
