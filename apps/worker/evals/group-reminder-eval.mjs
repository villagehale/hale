// "Remind me ..." from anyone in the family group (VIL-448 · T26) — a judged eval (hard
// rule #8: no LLM mocking).
//
// The subjects are the REAL skills (packages/agent/skills/group-reminder-read.md and
// group-reminder-voice.md) over the REAL inputs: the reader's payload, the planner, the fact
// builders, the fire decision and the refusals are imported from
// apps/web/lib/loop/reminders/group, not replicated. Code gates only structure — the
// reading's fields, the plan the runtime derives from it (where each reminder goes, quiet
// hours, a non-customer never 1:1), the STOP drop, the refusals and fixed copy. Whether a
// text carries its facts, in the right language and register, is the judge's call.
//
//   node evals/group-reminder-eval.mjs --dry                    # offline: gates + worst case
//   node evals/group-reminder-eval.mjs --broken --dry           # offline calibration: must FAIL
//   node evals/group-reminder-eval.mjs --max-usd 0.40           # live, records (HALE_SPEND_LEDGER)
//   node evals/group-reminder-eval.mjs --broken --max-usd 0.40  # records the broken verdicts
//   node evals/group-reminder-eval.mjs --cached-only            # replay a recording
//   node evals/group-reminder-eval.mjs --broken --cached-only   # replay calibration: must FAIL
//
// --broken swaps in a policy that texts every asker 1:1 (customer or not) through quiet
// hours, and a voice that writes one fixed line. Its reads are the real arm's (same cache
// keys), so one recording is the real arm plus the broken arm's judge verdicts.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { assertLiveSpendGuard, worstCaseUsd } from '../../web/lib/testing/spend-cap.mjs';
import {
  GROUP_REMINDER_FIXTURES,
  GROUP_REMINDER_HOUSEHOLDS,
  GROUP_REMINDER_NOW,
} from './group-reminder-fixtures.mjs';
import {
  JUDGE_REASON_MAX_CHARS,
  READ_ATTEMPTS,
  brokenPlan,
  brokenText,
  fixedCopyFailures,
  planFailures,
  priceCall,
  readingFailures,
} from './lib/group-reminder-gates.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  judgeLaneFor,
  lazyAnthropic,
  loadAgent,
  makeCost,
  makeJudge,
  priceRates,
  readJudgeModel,
  scoreFirstJudgeSchema,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const GROUP = join(WEB_ROOT, 'lib', 'loop', 'reminders', 'group');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');

const JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE text that Hale, a planner for a family's kids that",
  'lives in their group text, wrote about a reminder.',
  'You get `kind`, `facts` (everything Hale was told, and the only true facts), `text` (what',
  'Hale wrote) and `mustSay` (what this text has to get across, described, not quoted).',
  'Score 1-5 on whether the text gets the facts across and reads right, NOT on its wording:',
  'any phrasing a person would read as saying the same thing counts.',
  '5: every mustSay item comes across, in the language facts.language names, plainly and',
  'kindly, with nothing added that is not in facts. 4: the same with one small slip of style.',
  '3: the facts are right but clarity or tone has a real flaw.',
  'LOW (1-2) is any of: a mustSay item missing or wrong; a wrong time, day or person; saying',
  'it will come as a private text when facts say it arrives here, or the reverse; anything',
  'invented (a time, place, person, child, reason or feature); the wrong language; in French,',
  'tu where vous is due; telling anyone to reply with a keyword, a code or STOP; a link or',
  'phone number; emoji or exclamation marks; "we" or "us" for Hale; more than three short',
  'sentences; a form-letter or robotic register.',
  'A day and time is right when it matches facts the way a person would say it from',
  'facts.now ("tomorrow at 9", "Thursday at 9 AM", "tonight at 8:45").',
  'Reply with ONLY the score tool.',
].join(' ');

const JUDGE_SCHEMA = scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS);

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function loadRuntime() {
  const [read, voice, plan, facts, policy, language] = await Promise.all([
    importTs(join(GROUP, 'read.ts')),
    importTs(join(GROUP, 'voice.ts')),
    importTs(join(GROUP, 'plan.ts')),
    importTs(join(GROUP, 'facts.ts')),
    importTs(join(GROUP, 'policy.ts')),
    importTs(join(WEB_ROOT, 'lib', 'channel', 'language.ts')),
  ]);
  return { ...read, ...voice, ...plan, ...facts, ...policy, ...language };
}

/** A correct reading of the case, for --dry: the planner and fact builders run on it. */
function expectedReading(expect) {
  return {
    request: expect.request,
    set: (expect.set ?? []).map(({ where, ...ask }) => ({ ...ask, where: where[0] })),
    cancel: expect.cancel ?? [],
    language: expect.language ?? 'en',
  };
}

function usd(n) {
  return `$${n.toFixed(4)}`;
}

async function main() {
  const argv = process.argv;
  const dry = argv.includes('--dry');
  const broken = argv.includes('--broken');
  const cachedOnly = argv.includes('--cached-only');
  const live = !dry && !cachedOnly;
  if (!dry) installEvalSpendCap();
  if (live) assertLiveSpendGuard();

  const web = await loadRuntime();
  const agent = await loadAgent();
  const readSkill = await agent.loadSkill(join(SKILLS, `${web.GROUP_REMINDER_READ_SKILL}.md`));
  const voiceSkill = await agent.loadSkill(join(SKILLS, `${web.GROUP_REMINDER_VOICE_SKILL}.md`));
  const readLane = agent.pickLane(readSkill.meta.task);
  const voiceLane = agent.pickLane(voiceSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const judgeLane = await judgeLaneFor(judgeModel);
  const judgeMaxTokens = judgeModel === agent.HAIKU_MODEL ? 4096 : 8192;
  const getClient = lazyAnthropic('group-reminder');
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'group-reminder', cachedOnly, getClient, cost, {
    schema: JUDGE_SCHEMA,
  });

  /** Every call one recording makes, priced offline. Filled in on every run, printed by --dry. */
  const planned = [];
  const price = (entry, request, lane, attempts) => {
    planned.push({
      ...entry,
      ...priceCall({ request, lane, attempts, rates: priceRates, worstCaseUsd }),
    });
  };
  const readRequest = (userMessage) =>
    agent.structuredRequest({
      lane: readLane,
      maxTokens: web.GROUP_REMINDER_READ_MAX_TOKENS,
      system: readSkill.instructions,
      userMessage,
      toolName: web.GROUP_REMINDER_READ_TOOL,
      toolDescription: web.GROUP_REMINDER_READ_TOOL_DESCRIPTION,
      inputJsonSchema: web.GROUP_REMINDER_READ_SCHEMA,
    });
  const voiceRequest = (userMessage) =>
    agent.structuredRequest({
      lane: voiceLane,
      maxTokens: web.GROUP_REMINDER_VOICE_MAX_TOKENS,
      system: voiceSkill.instructions,
      userMessage,
      toolName: web.GROUP_REMINDER_VOICE_TOOL,
      toolDescription: web.GROUP_REMINDER_VOICE_TOOL_DESCRIPTION,
      inputJsonSchema: web.GROUP_REMINDER_VOICE_SCHEMA,
    });
  const judgeRequest = (payload) =>
    agent.structuredRequest({
      lane: judgeLane,
      maxTokens: judgeMaxTokens,
      system: JUDGE_SYSTEM,
      userMessage: JSON.stringify(payload),
      toolName: 'score',
      toolDescription: 'Return the score.',
      inputJsonSchema: JUDGE_SCHEMA,
    });

  /** The runtime reader: up to READ_ATTEMPTS reads, the first that parses wins (read.ts). */
  async function read(id, userMessage, notes) {
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      try {
        const { value } = await cachedToolCall({
          tag: `group-reminder:${id}:read${attempt === 1 ? '' : `#${attempt}`}`,
          lane: readLane,
          system: readSkill.instructions,
          userMessage,
          toolName: web.GROUP_REMINDER_READ_TOOL,
          toolSchema: web.GROUP_REMINDER_READ_SCHEMA,
          toolDescription: web.GROUP_REMINDER_READ_TOOL_DESCRIPTION,
          maxTokens: web.GROUP_REMINDER_READ_MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        });
        const parsed = web.groupReminderReadingSchema.safeParse(value);
        if (parsed.success) return parsed.data;
        notes.push(`read attempt ${attempt}: not a reading`);
      } catch (err) {
        notes.push(`read attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return null;
  }

  /** The runtime voice: up to GROUP_REMINDER_MAX_ATTEMPTS, the first unrefused text wins. */
  async function write(tag, userMessage, notes) {
    for (let attempt = 1; attempt <= web.GROUP_REMINDER_MAX_ATTEMPTS; attempt += 1) {
      try {
        const { value } = await cachedToolCall({
          tag: `${tag}${attempt === 1 ? '' : `#${attempt}`}`,
          lane: voiceLane,
          system: voiceSkill.instructions,
          userMessage,
          toolName: web.GROUP_REMINDER_VOICE_TOOL,
          toolSchema: web.GROUP_REMINDER_VOICE_SCHEMA,
          toolDescription: web.GROUP_REMINDER_VOICE_TOOL_DESCRIPTION,
          maxTokens: web.GROUP_REMINDER_VOICE_MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        });
        const text = typeof value?.text === 'string' ? value.text.trim() : '';
        const refusals = web.groupReminderRefusals(text);
        if (refusals.length === 0) return text;
        notes.push(`write attempt ${attempt} refused: ${refusals.join(', ')}`);
      } catch (err) {
        notes.push(`write attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return null;
  }

  async function runCase(arm, fixture) {
    const household = GROUP_REMINDER_HOUSEHOLDS[fixture.household];
    const now = new Date(GROUP_REMINDER_NOW);
    const timeZone = household.timeZone;
    const asker = household.seats.find((seat) => seat.firstName === fixture.sender);
    const seats = household.seats.map(({ userId, phoneHash, firstName }) => ({
      userId,
      phoneHash,
      firstName,
    }));
    const open = fixture.open ?? [];
    const result = { arm, fixture, failures: [], notes: [], texts: [] };
    const isReal = arm === 'real';

    const readUser = web.groupReminderReadUserMessage({
      message: fixture.message,
      sender: asker.firstName,
      people: seats.filter((seat) => seat.phoneHash !== asker.phoneHash).map((s) => s.firstName),
      recent: (fixture.recent ?? []).slice(-web.GROUP_REMINDER_RECENT_LINES),
      now: web.readerNow(now, timeZone),
      open: open.map((row) => ({
        ref: row.ref,
        for: row.for,
        what: row.what,
        when: web.whenFact(new Date(row.deliverAt), timeZone),
      })),
    });
    if (isReal)
      price({ arm, id: fixture.id, kind: 'read' }, readRequest(readUser), readLane, READ_ATTEMPTS);
    const reading = dry
      ? expectedReading(fixture.expect)
      : await read(fixture.id, readUser, result.notes);
    result.failures.push(
      ...readingFailures(fixture.expect, reading, {
        instantOf: (ask) => web.askedInstant(ask, now, timeZone),
        sameName: web.sameFirstName,
      }),
    );
    // Not a reminder turn: it goes on to the coach as today, and this path sends nothing.
    if (!reading || reading.request !== 'reminders') return result;

    const wantsDirect = reading.set.some((ask) => ask.for === 'sender' && ask.where !== 'group');
    const reachable = wantsDirect && asker.haleCustomer ? asker.directReachable === true : false;
    const groupQuiet = { timeZone, windows: household.groupQuiet };
    const directQuiet = reachable ? { timeZone, windows: asker.directQuiet } : null;
    const realPlan = web.planReminderTurn({
      reading,
      now,
      timeZone,
      asker: {
        userId: asker.userId,
        phoneHash: asker.phoneHash,
        firstName: asker.firstName,
        haleCustomer: asker.haleCustomer,
        directReachable: reachable,
      },
      seats,
      groupQuiet,
      directQuiet,
      openRefs: new Map(open.map((row) => [row.ref, row.rowId])),
    });
    const plan = isReal ? realPlan : brokenPlan(realPlan);
    const quietFor = (item) => (item.delivery === 'direct' && directQuiet) || groupQuiet;
    result.failures.push(
      ...planFailures(fixture.expect, plan, {
        askerIsCustomer: asker.haleCustomer,
        quietAt: (item) => {
          const quiet = quietFor(item);
          return web.inQuiet(item.deliverAt, quiet.timeZone, quiet.windows);
        },
      }),
    );

    const language = web.acceptReplyLanguage(reading.language) ?? household.language;
    const confirm = web.confirmFacts({
      language,
      asker: asker.firstName,
      memberWords: fixture.message,
      now,
      timeZone,
      plan,
      cancelled: open
        .filter((row) => plan.cancelIds.includes(row.rowId))
        .map((row) => ({ what: row.what, deliverAt: new Date(row.deliverAt) })),
    });
    // An unwritten confirmation cancels the turn and nothing reaches the group (capture.ts).
    if (!(await text(result, 'confirm', confirm, fixture.confirmMustSay))) return result;

    const item = plan.set[0];
    if (!item) return result;
    const fire = fixture.fire ?? { askerSeated: true };
    const quiet = quietFor(item);
    const decision = web.fireDecision(
      { deliverAt: item.deliverAt, delivery: item.delivery },
      {
        now: item.deliverAt,
        groupHeld: true,
        askerSeated: fire.askerSeated,
        recipientSeated: item.forPhoneHash ? true : null,
        audienceAllowed: true,
        quietNow: web.inQuiet(item.deliverAt, quiet.timeZone, quiet.windows),
        directReachable: item.delivery === 'direct' ? reachable : true,
      },
    );
    const dropped = decision.kind === 'drop' ? decision.reason : null;
    const wantDropped = fire.expectDrop ?? null;
    if (dropped !== wantDropped) {
      result.failures.push(
        `when due: ${dropped ? `dropped (${dropped})` : 'sent'}, want ${wantDropped ? `dropped (${wantDropped})` : 'sent'}`,
      );
    }
    if (dropped) return result;
    const reminder = web.reminderFacts({
      reminder: {
        forKind: item.forKind,
        delivery: item.delivery,
        language,
        what: item.what,
        askedForAt: item.askedFor,
        deliverAt: item.deliverAt,
      },
      askerName: asker.firstName,
      recipientName: item.forName,
      now: item.deliverAt,
      timeZone,
    });
    await text(result, 'reminder', reminder, fixture.reminderMustSay);
    return result;
  }

  /** Writes, gates and judges one text. False when nothing could be written. */
  async function text(result, kind, facts, mustSay) {
    const { arm, fixture } = result;
    const userMessage = web.groupReminderVoiceUserMessage(facts);
    const entry = { arm, id: fixture.id, kind };
    let body = null;
    if (arm === 'broken') {
      body = brokenText(facts);
    } else {
      price(entry, voiceRequest(userMessage), voiceLane, web.GROUP_REMINDER_MAX_ATTEMPTS);
      if (!dry)
        body = await write(`group-reminder:${fixture.id}:${kind}`, userMessage, result.notes);
    }
    if (!dry && body === null) {
      result.failures.push(`${kind}: not written, so nothing would be sent`);
      return false;
    }
    if (body !== null)
      result.texts.push({ id: fixture.id, kind, factsKey: userMessage, text: body });
    if (!mustSay) {
      result.failures.push(`${kind}: this case should not produce one`);
      return true;
    }
    // --dry judges nothing; it prices the judge on the longest text the refusals let through.
    const payload = {
      kind,
      facts,
      text: body ?? 'x'.repeat(web.GROUP_REMINDER_MAX_CHARS),
      mustSay,
    };
    price({ ...entry, kind: `judge ${kind}` }, judgeRequest(payload), judgeLane, 1);
    if (dry) return true;
    const verdict = await judge(`${arm}:${fixture.id}:${kind}`, payload);
    result.verdicts = [...(result.verdicts ?? []), `${kind} ${verdict.score}`];
    if (verdict.score < JUDGE_MIN) {
      result.failures.push(`judge ${kind}: ${verdict.score} (${verdict.reason})`);
    }
    return true;
  }

  const arm = broken ? 'broken' : 'real';
  console.info(
    `group-reminder eval | arm=${arm}${dry ? ' (dry: no network)' : cachedOnly ? ' (cached-only)' : ' (live)'} | read=${readLane.model} voice=${voiceLane.model} judge=${judgeModel}`,
  );
  // --dry runs the other arm as well, unprinted, so the projection covers one recording.
  const arms = dry ? [arm, broken ? 'real' : 'broken'] : [arm];
  const results = { real: [], broken: [] };
  for (const name of arms) {
    for (const fixture of GROUP_REMINDER_FIXTURES) results[name].push(await runCase(name, fixture));
    const copies = fixedCopyFailures(results[name].flatMap((r) => r.texts));
    for (const r of results[name]) {
      for (const kind of ['confirm', 'reminder']) {
        const failure = copies.get(`${r.fixture.id}:${kind}`);
        if (failure) r.failures.push(failure);
      }
    }
  }

  for (const r of results[arm]) {
    const verdicts = r.verdicts ? ` [judge ${r.verdicts.join(', ')}]` : '';
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(20)}${verdicts}`,
    );
    for (const t of r.texts) console.info(`      ${t.kind}: "${t.text}"`);
    for (const f of r.failures) console.info(`      · ${f}`);
    for (const n of r.notes) console.info(`      (${n})`);
  }
  if (dry) printProjection(planned);
  else {
    console.info(
      `live API calls this run: ${cost.liveCalls} | estimated cost: ${usd(totalUsd(cost))} USD`,
    );
  }
  const allPass = results[arm].every((r) => r.failures.length === 0);
  if (dry && !broken)
    console.info('dry: deterministic gates only; the texts are judged on a recording');
  if (!broken) process.exit(allPass ? 0 : 1);
  console.info(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

/**
 * The worst case for one recording: the real arm (reads, texts, judge) and the broken arm's
 * judge draws (its reads replay the real arm's). The longest-path line prices a misread: a
 * case that writes fewer texts than the most a case can (a confirmation and its reminder,
 * each judged) is charged for the rest at the dearest of that kind.
 */
function printProjection(planned) {
  const kinds = ['read', 'confirm', 'reminder', 'judge confirm', 'judge reminder'];
  console.info('DRY one recording = real arm + broken arm, every call uncached, no network');
  let perSend = 0;
  let ceiling = 0;
  for (const arm of ['real', 'broken']) {
    for (const kind of kinds) {
      const rows = planned.filter((p) => p.arm === arm && p.kind === kind);
      if (rows.length === 0) continue;
      const sendSum = rows.reduce((sum, p) => sum + p.perSend, 0);
      const ceilSum = rows.reduce((sum, p) => sum + p.ceiling, 0);
      perSend += sendSum;
      ceiling += ceilSum;
      console.info(
        `DRY   ${arm.padEnd(6)} ${kind.padEnd(14)} ${String(rows.length).padStart(3)} calls | one send each ${usd(sendSum)} | every attempt and re-ask ${usd(ceilSum)}`,
      );
    }
  }
  let allowance = 0;
  for (const arm of ['real', 'broken']) {
    const armKinds = arm === 'real' ? kinds.filter((k) => k !== 'read') : kinds.slice(3);
    const ids = [
      ...new Set(planned.filter((p) => p.arm === 'real' && p.kind === 'read').map((p) => p.id)),
    ];
    for (const kind of armKinds) {
      const dearest = Math.max(
        0,
        ...planned.filter((p) => p.arm === arm && p.kind === kind).map((p) => p.ceiling),
      );
      const missing = ids.filter(
        (id) => !planned.some((p) => p.arm === arm && p.kind === kind && p.id === id),
      );
      allowance += dearest * missing.length;
    }
  }
  console.info(`DRY expected path, one send per call: ${usd(perSend)}`);
  console.info(`DRY expected path, every attempt and re-ask firing: ${usd(ceiling)}`);
  console.info(
    `DRY longest-path allowance (every case writes and judges both texts): ${usd(allowance)}`,
  );
  console.info(`DRY worst case for one recording: ${usd(ceiling + allowance)}`);
}

main().catch((err) => {
  console.error('group-reminder eval harness error:', err);
  process.exit(2);
});
