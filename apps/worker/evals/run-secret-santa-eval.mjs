// VIL-686 · Secret Santa in a multi-family group (hard rule #8: no LLM mocking).
//
// Subjects, all REAL and through the REAL request shapes:
//   1. the secret-santa-turn skill, inside the REAL readSecretSantaTurn / applySecretSantaTurn
//      over the REAL DDL (pglite), so the writes and the line gate are production's;
//   2. the secret-santa-line skill for every purpose (giver draw, done, refusal, organizer note);
//   3. CROSS-DOOR: the real group-plan-rsvp reader on Secret Santa start asks, with and
//      without a live plan. It must not take the turn (a red result blocks merge).
// Checks per case:
//   CODE: the turn's intent and outcome, the name kept (the ZH join included), a giver's
//   draft carrying its receiver verbatim and no other participant's name, no group line
//   naming anyone after the draw, the RSVP reader leaving Santa starts alone, and the turn
//   read's token budget from the recordings' usage.
//   JUDGE: Kat-short, right language, warm, no reveal; a first 1:1 says it is Hale and how
//   to stop (judges/secret-santa).
// --broken swaps in known-bad lines; every one must FAIL (a code check or the judge).
//
//   node evals/run-secret-santa-eval.mjs                 # live, then caches
//   node evals/run-secret-santa-eval.mjs --broken        # every bad line must fail
//   node evals/run-secret-santa-eval.mjs --cached-only   # CI: replay only
//   --only=<id>[,<id>]                                   # affected cases only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
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
  SECRET_SANTA_BROKEN,
  SECRET_SANTA_CROSS_DOOR_FIXTURES,
  SECRET_SANTA_LINE_FIXTURES,
  SECRET_SANTA_PEOPLE,
  SECRET_SANTA_TURN_FIXTURES,
} from './secret-santa-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const LINQ = join(WEB_ROOT, 'lib', 'channel', 'linq');
const PGLITE_SRC = join(WEB_ROOT, 'lib', 'testing', 'pglite.ts');
const DB_SRC = join(REPO_ROOT, 'packages', 'db', 'src', 'index.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
// The draw encrypts its pointers; an eval-only key (never a deployed one) for the pglite run.
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const CHAT = 'eval-secret-santa-chat';
const NOW = new Date('2026-11-20T15:00:00.000Z');
const JUDGE_SYSTEM = judgePrompt('secret-santa');
/** Shared judge settings (#914): Sonnet, thinking off via the output cap, lowest of 3. */
const JUDGE_SAMPLES = 3;
const JUDGE_MAX_OUTPUT_TOKENS = 512;
/** The turn read runs on every group message: its budget (brief §2). */
const TURN_MEAN_INPUT_MAX = 1800;
const TURN_OUTPUT_MAX = 300;

function onlyIds() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  return arg ? new Set(arg.slice('--only='.length).split(',')) : null;
}

async function seed(dbm, crypto, database, fixture) {
  const { schema } = dbm;
  const families = new Map();
  const users = new Map();
  for (const [index, p] of SECRET_SANTA_PEOPLE.entries()) {
    if (!p.family) continue;
    if (!families.has(p.family)) {
      const [row] = await database
        .insert(schema.families)
        .values({ displayName: `Family ${p.family}`, provinceOrState: 'ON' })
        .returning({ id: schema.families.id });
      families.set(p.family, row.id);
    }
    const [user] = await database
      .insert(schema.users)
      .values({ externalAuthId: `eval:secret-santa:${index}` })
      .returning({ id: schema.users.id });
    users.set(index, user.id);
    // A Hale family's parent texts Hale on a verified channel: only guests wait on a text.
    await database.insert(schema.parentChannels).values({
      userId: user.id,
      familyId: families.get(p.family),
      kind: 'sms',
      phoneE164Encrypted: crypto.encryptString(`eval-santa-number-${index}`),
      phoneE164Hash: `eval-santa-person-${index}`,
      verifiedAt: NOW,
    });
  }
  const people = [];
  for (const [index, p] of SECRET_SANTA_PEOPLE.entries()) {
    const [row] = await database
      .insert(schema.linqSharedGroupPeople)
      .values({
        chatId: CHAT,
        phoneE164Hash: `eval-santa-person-${index}`,
        familyId: p.family ? families.get(p.family) : null,
        userId: users.get(index) ?? null,
        seatedAt: new Date(NOW.getTime() - 3_600_000 + index),
      })
      .returning();
    people.push(row);
  }
  if (fixture.state) {
    const organizer = fixture.state.organizer;
    const [draw] = await database
      .insert(schema.secretSantaDraws)
      .values({
        chatId: CHAT,
        organizerPersonId: people[organizer].id,
        organizerFamilyId: people[organizer].familyId,
        organizerUserId: people[organizer].userId,
        status: fixture.state.status,
        language: fixture.language,
        startedAt: new Date(NOW.getTime() - 86_400_000),
        drawnAt: fixture.state.status === 'drawn' ? new Date(NOW.getTime() - 3_600_000) : null,
      })
      .returning();
    for (const [i, p] of fixture.state.participants.entries()) {
      await database.insert(dbm.schema.secretSantaParticipants).values({
        drawId: draw.id,
        personId: people[p.person].id,
        called: p.called,
        joinedAt: new Date(NOW.getTime() - 60_000 + i),
      });
    }
  }
  return people;
}

function turnChecks(fixture, read, result, people, rows) {
  const failures = [];
  const want = fixture.expect;
  if (read.kind === 'unread' || read.kind === 'failed') failures.push(`read:${read.kind}`);
  const isSanta = read.kind === 'santa';
  if (isSanta !== want.santaTurn) failures.push(`santaTurn: got ${isSanta} want ${want.santaTurn}`);
  if (want.outcome) {
    const outcomes = result.handled ? result.outcomes : [];
    if (!outcomes.includes(want.outcome)) {
      failures.push(`outcome: got [${outcomes.join(',')}] want ${want.outcome}`);
    }
  }
  if ('called' in want) {
    const mine = rows.find((r) => r.personId === people[fixture.speaker].id);
    if (!mine) failures.push('speaker not in the draw');
    else if (mine.called !== want.called) {
      failures.push(`called: got ${JSON.stringify(mine.called)} want ${JSON.stringify(want.called)}`);
    }
  }
  return failures;
}

function lineChecks(santa, send, fixture, line) {
  const failures = [];
  const { request, names } = fixture;
  if (request.purpose === 'giver_draw') {
    if (!send.giverDraftUsable(line, names)) {
      failures.push('giver draft: receiver missing, a contact, or another participant named');
    }
  } else if (request.purpose === 'organizer_note') {
    const allowed = new Set(names.allowed.map(santa.foldName));
    const others = names.everyone.filter(
      (name) => !allowed.has(santa.foldName(name)) && santa.nameAppears(line, name),
    );
    if (others.length > 0) failures.push(`note names someone not waiting: ${others.join(', ')}`);
  } else if (!santa.santaGroupLineUsable(line, { participants: names.everyone, allowed: [] })) {
    failures.push('group line names a participant or carries a contact');
  }
  return failures;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const only = onlyIds();
  installEvalSpendCap();
  const getClient = lazyAnthropic('secret-santa');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const dbm = await importTs(DB_SRC);
  const santa = await importTs(join(LINQ, 'secret-santa.ts'));
  const send = await importTs(join(LINQ, 'secret-santa-send.ts'));
  const rsvp = await importTs(join(LINQ, 'group-plan-rsvp', 'reading.ts'));
  const pglite = await importTs(PGLITE_SRC);
  const crypto = await importTs(join(WEB_ROOT, 'lib', 'crypto', 'string-cipher.ts'));
  const turnSkill = await agent.loadSkill(join(SKILLS, 'secret-santa-turn.md'));
  const lineSkill = await agent.loadSkill(join(SKILLS, 'secret-santa-line.md'));
  const rsvpSkill = await agent.loadSkill(join(SKILLS, 'group-plan-rsvp-read.md'));
  const rsvpSantaSkill = await agent.loadSkill(join(SKILLS, `${rsvp.GROUP_PLAN_RSVP_SECRET_SANTA_SKILL}.md`));
  const turnLane = agent.pickLane(turnSkill.meta.task);
  const lineLane = agent.pickLane(lineSkill.meta.task);
  const rsvpLane = agent.pickLane(rsvpSkill.meta.task);
  const judge = makeJudge(agent.SONNET_MODEL, JUDGE_SYSTEM, 'secret-santa', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES,
    aggregate: 'min',
    logCost: true,
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
  });
  console.info(
    `secret-santa eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | turn=${turnLane.model} line=${lineLane.model} judge=${agent.SONNET_MODEL}`,
  );

  /** The facts each written line was given, so the judge scores it against those. */
  const lastLineRequest = new Map();
  const writerFor = (id) => ({
    async write(request) {
      lastLineRequest.set(id, request);
      const call = await cachedToolCall({
        tag: `secret-santa-line:${id}:${request.purpose}`,
        lane: lineLane,
        system: lineSkill.instructions,
        userMessage: santa.secretSantaLineUserMessage(request),
        toolName: santa.SECRET_SANTA_LINE_TOOL,
        toolSchema: santa.secretSantaLineJsonSchema,
        toolDescription: santa.SECRET_SANTA_LINE_TOOL_DESCRIPTION,
        maxTokens: santa.SECRET_SANTA_LINE_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      return typeof call.value?.text === 'string' ? call.value.text.trim() || null : null;
    },
  });

  const results = [];
  const turnUsage = [];
  const lineById = new Map(SECRET_SANTA_LINE_FIXTURES.map((f) => [f.id, f]));

  if (broken) {
    for (const bad of SECRET_SANTA_BROKEN) {
      if (only && !only.has(bad.id)) continue;
      const fixture = lineById.get(bad.fixture);
      const failures = lineChecks(santa, send, fixture, bad.reply);
      const verdict = await judge(bad.id, {
        purpose: fixture.request.purpose,
        message: null,
        reply: bad.reply,
        language: fixture.language,
        facts: fixture.request.facts,
        secrets: ['who any participant drew'],
        watchFor: fixture.watchFor ?? null,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
      results.push({ id: bad.id, reply: bad.reply, failures, score: verdict.score });
    }
  } else {
    for (const fixture of SECRET_SANTA_TURN_FIXTURES) {
      if (only && !only.has(fixture.id)) continue;
      const testDb = await pglite.createTestDb();
      try {
        const people = await seed(dbm, crypto, testDb.database, fixture);
        const speaker = people[fixture.speaker];
        const model = {
          async decide(input) {
            const call = await cachedToolCall({
              tag: `secret-santa-turn:${fixture.id}`,
              lane: turnLane,
              system: turnSkill.instructions,
              userMessage: santa.secretSantaTurnUserMessage(input),
              toolName: santa.SECRET_SANTA_TURN_TOOL,
              toolSchema: santa.secretSantaTurnJsonSchema,
              toolDescription: santa.SECRET_SANTA_TURN_TOOL_DESCRIPTION,
              maxTokens: santa.SECRET_SANTA_TURN_MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            });
            if (call.usage) turnUsage.push({ id: fixture.id, ...call.usage });
            else turnUsage.push({ id: fixture.id, missing: true });
            return call.value;
          },
        };
        const context = {
          chatId: CHAT,
          text: fixture.text,
          language: null,
          providerMessageId: `eval-${fixture.id}`,
          speaker,
          customer:
            speaker.familyId && speaker.userId
              ? { familyId: speaker.familyId, userId: speaker.userId }
              : null,
          people,
        };
        const read = await santa.readSecretSantaTurn(testDb.database, context, model);
        const result = await santa.applySecretSantaTurn(testDb.database, context, read, {
          now: NOW,
          writer: writerFor(fixture.id),
        });
        // Join order, so the judge's facts never depend on how Postgres returns rows.
        const rows = (await testDb.database.select().from(dbm.schema.secretSantaParticipants)).sort(
          (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
        );
        const failures = turnChecks(fixture, read, result, people, rows);
        const line = result.handled && result.line ? result.line.text : null;
        if (line && fixture.expect.noNames) {
          const named = SECRET_SANTA_PEOPLE.map((p) => p.name).filter((n) =>
            santa.nameAppears(line, n),
          );
          if (named.length > 0) failures.push(`group line after the draw names ${named.join(', ')}`);
        }
        let score = null;
        if (line) {
          // The judge scores the line against what Hale knew when it was written: the
          // line writer's own facts for a done or refusal line, else the draw as it stands
          // after this message.
          const written = result.line.templateKey === 'linq:secret_santa_turn' ? null : lastLineRequest.get(fixture.id);
          const after = rows.map((r) => ({
            name: r.called,
            speaker: r.personId === speaker.id,
          }));
          const verdict = await judge(fixture.id, {
            purpose: written ? written.purpose : 'group_turn',
            message: `${SECRET_SANTA_PEOPLE[fixture.speaker].name}: ${fixture.text}`,
            reply: line,
            language: fixture.language,
            facts: written
              ? { line: written.facts, inAfterThisMessage: after }
              : { inAfterThisMessage: after, minimum: 4, outcomes: result.outcomes },
            secrets: fixture.secrets ?? ['who any participant drew'],
            watchFor: fixture.watchFor ?? null,
          });
          score = verdict.score;
          if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
        }
        results.push({ id: fixture.id, reply: line, failures, score });
      } finally {
        await testDb.close();
      }
    }

    for (const fixture of SECRET_SANTA_LINE_FIXTURES) {
      if (only && !only.has(fixture.id)) continue;
      const line = await writerFor(fixture.id).write(fixture.request);
      const failures = line ? lineChecks(santa, send, fixture, line) : ['no line written'];
      let score = null;
      if (line) {
        const verdict = await judge(fixture.id, {
          purpose: fixture.request.purpose,
          message: null,
          reply: line,
          language: fixture.language,
          facts: fixture.request.facts,
          secrets: ['who any participant drew'],
          watchFor: fixture.watchFor ?? null,
        });
        score = verdict.score;
        if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
      results.push({ id: fixture.id, reply: line, failures, score });
    }

    for (const fixture of SECRET_SANTA_CROSS_DOOR_FIXTURES) {
      if (only && !only.has(fixture.id)) continue;
      const call = await cachedToolCall({
        tag: `secret-santa-cross-door:${fixture.id}`,
        lane: rsvpLane,
        system: rsvpSkill.instructions,
        systemExtras: [rsvpSantaSkill.instructions],
        userMessage: rsvp.groupPlanRsvpUserMessage({
          text: fixture.text,
          tapback: null,
          senderName: 'Priya',
          // The production read shows the open plans by key (newest first).
          plans: fixture.plan
            ? [
                {
                  key: 'p1',
                  title: fixture.plan.title,
                  startsAt: null,
                  deadline: fixture.plan.deadline,
                  yesNames: fixture.plan.yesNames,
                  waitingNames: fixture.plan.waitingNames,
                },
              ]
            : [],
          recent: [],
          // Production sends it wherever Secret Santa runs (secretSantaRunsInChat).
          secretSanta: true,
        }),
        toolName: 'group_plan_rsvp',
        toolDescription: 'Return what this group message meant for a shared plan.',
        toolSchema: rsvp.GROUP_PLAN_RSVP_READ_TOOL_SCHEMA,
        maxTokens: rsvp.GROUP_PLAN_RSVP_READ_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      const reading = call.value;
      const takes =
        reading?.confidence === 'high' && !['chatter', 'unclear'].includes(reading?.intent);
      results.push({
        id: fixture.id,
        reply: `rsvp intent=${reading?.intent} confidence=${reading?.confidence}`,
        failures:
          takes === fixture.takes
            ? []
            : [
                fixture.takes
                  ? `the RSVP reader missed a real plan ask (${reading?.intent})`
                  : `the RSVP reader takes a Secret Santa ask (${reading?.intent})`,
              ],
        score: null,
      });
    }
  }

  for (const r of results) {
    const label = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.info(
      `${label}  ${r.id.padEnd(28)} judge=${r.score ?? '-'} "${(r.reply ?? '(no line)').replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.info(`      · ${f}`);
  }

  let budgetOk = true;
  if (!broken && turnUsage.length > 0) {
    const missing = turnUsage.filter((u) => u.missing).map((u) => u.id);
    const known = turnUsage.filter((u) => !u.missing);
    const inputOf = (u) =>
      u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const meanInput = known.length
      ? known.reduce((sum, u) => sum + inputOf(u), 0) / known.length
      : 0;
    const overOutput = known.filter((u) => u.output_tokens > TURN_OUTPUT_MAX).map((u) => u.id);
    budgetOk = missing.length === 0 && meanInput <= TURN_MEAN_INPUT_MAX && overOutput.length === 0;
    console.info(
      `turn-read budget: mean input ${meanInput.toFixed(0)} (max ${TURN_MEAN_INPUT_MAX}), outputs over ${TURN_OUTPUT_MAX}: ${overOutput.join(', ') || 'none'}, recordings without usage: ${missing.join(', ') || 'none'} => ${budgetOk ? 'PASS' : 'FAIL'}`,
    );
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (!broken) {
    process.exit(results.length > 0 && results.every((r) => r.failures.length === 0) && budgetOk ? 0 : 1);
  }
  const leaked = results.filter((r) => r.failures.length === 0).map((r) => r.id);
  const calibrated = results.length > 0 && leaked.length === 0;
  console.info(
    `broken-mode calibration (every case must fail): ${calibrated ? 'PASS' : `FAIL (passed: ${leaked.join(', ')})`}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('secret-santa eval harness error:', err);
  process.exit(2);
});
