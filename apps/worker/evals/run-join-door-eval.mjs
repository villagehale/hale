// VIL-706 · the join and caregiver doors, the caregiver reminder, and the door's consent
// asks with JOIN_DOOR_MODEL_COPY_ENABLED lit.
//
// SUBJECTS, called the way production calls them, through the real skill loader:
//   door lines         packages/agent/skills/spoken-line.md + door-line.md (system extra)
//                      apps/web/lib/channel/door-line.ts -> spoken-line.ts
//   caregiver reminder packages/agent/skills/spoken-line.md + caregiver-reminder.md
//                      apps/web/lib/loop/templates/caregiver/compose.ts -> spoken-line.ts
//   consent asks       packages/agent/skills/consent-ask.md + consent-ask-no-keyword.md
//                      apps/web/lib/channel/consent-ask.ts (the four stranger kinds, lit)
//
// The model writes the whole text. A text is a miss when production would refuse it
// (empty, a missing verbatim piece or link slot, a stray link or number, an opt-out
// keyword) or when one of the friend-voice judge's checks that read the text alone
// refuses it (false privacy, a banned phrase, compliance, a registration claim). Nothing
// here reads a flag: each request is built as the lit path builds it.
//
// RECORDING PENDING. The addenda moved these requests' bytes (VIL-706 moved the door
// guidance out of spoken-line.md so the calendar-kid-notice and common-time recordings
// keep their keys), so nothing here is recorded yet. While RECORDING_PENDING is true,
// --cached-only runs the --dry projection: it scores every case that IS recorded, lists
// the ones that are not, and exits 0 unless a recorded case fails (the convention of
// run-team-schedule-eval.mjs). After the one paid record run, set it to false and commit
// the cache: --cached-only then replays, and a miss fails the sweep.
//
//   node evals/run-join-door-eval.mjs --dry
//   HALE_SPEND_LEDGER=... node evals/run-join-door-eval.mjs --live --max-usd 1
//   node evals/run-join-door-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  CAREGIVER_REMINDER_FIXTURES,
  CONSENT_KEYWORDLESS_FIXTURES,
  JOIN_DOOR_FIXTURES,
  doorLineMisses,
} from './join-door-fixtures.mjs';
import {
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const RECORDING_PENDING = true;

const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const WEB = join(REPO_ROOT, 'apps', 'web', 'lib');
const SPOKEN_SRC = join(WEB, 'channel', 'spoken-line.ts');
const CONSENT_SRC = join(WEB, 'channel', 'consent-ask.ts');
const CAREGIVER_SRC = join(WEB, 'loop', 'templates', 'caregiver', 'compose.ts');
const VOICE_SRC = join(WEB, 'channel', 'intake', 'friend-voice.ts');

/** The spoken-line writer's tool, ceiling and description (spoken-line.ts). */
const SPOKEN = {
  toolName: 'spoken_line',
  toolDescription: 'Write the one text Hale will send.',
  toolSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  maxTokens: 400,
};

register({ tsconfig: join(REPO_ROOT, 'apps', 'web', 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function loadSubjects() {
  const agent = await importTs(AGENT_SRC);
  const [spoken, consent, caregiver, voice] = await Promise.all([
    importTs(SPOKEN_SRC),
    importTs(CONSENT_SRC),
    importTs(CAREGIVER_SRC),
    importTs(VOICE_SRC),
  ]);
  const skill = (name) => agent.loadSkill(join(SKILLS, `${name}.md`));
  const [spokenLine, doorLine, caregiverReminder, consentAsk, noKeyword] = await Promise.all([
    skill('spoken-line'),
    skill('door-line'),
    skill('caregiver-reminder'),
    skill('consent-ask'),
    skill('consent-ask-no-keyword'),
  ]);
  const spokenLane = agent.pickLane(spokenLine.meta.task);
  return {
    agent,
    spoken,
    consent,
    caregiver,
    voice,
    skills: { spokenLine, doorLine, caregiverReminder, consentAsk, noKeyword },
    lanes: {
      spoken: spokenLane,
      spokenRetry: spoken.smallerLane(spokenLane),
      consent: agent.pickLane(consentAsk.meta.task),
    },
  };
}

/** Every case as one draw plan: how to call it, and how production accepts the answer. */
function cases(s) {
  const spokenCase = (id, request, addendum, watchFor) => ({
    id,
    watchFor,
    attempts: [
      { lane: s.lanes.spoken, tag: `join-door:${id}` },
      { lane: s.lanes.spokenRetry, tag: `join-door:${id}:retry` },
    ],
    call: {
      system: s.skills.spokenLine.instructions,
      systemExtras: [addendum.instructions],
      cacheTtl: s.agent.SPARSE_CACHE_TTL,
      userMessage: s.spoken.spokenLineUserMessage(request),
      ...SPOKEN,
    },
    accept: (value) => s.spoken.acceptSpokenRequest(String(value?.text ?? ''), request),
  });
  return [
    ...JOIN_DOOR_FIXTURES.map((f) =>
      spokenCase(f.id, { ...f.request, addendum: 'door-line' }, s.skills.doorLine, f.watchFor),
    ),
    ...CAREGIVER_REMINDER_FIXTURES.map((f) =>
      spokenCase(
        f.id,
        s.caregiver.caregiverReminderRequest({
          ...f.input,
          now: new Date(f.input.now),
          events: f.input.events.map((e) => ({
            ...e,
            startsAt: new Date(e.startsAt),
            endsAt: e.endsAt ? new Date(e.endsAt) : null,
          })),
        }),
        s.skills.caregiverReminder,
        f.watchFor,
      ),
    ),
    ...CONSENT_KEYWORDLESS_FIXTURES.map((f) => ({
      id: f.id,
      watchFor: f.watchFor,
      // consent-ask.ts makes one attempt; a refused draft is unwritten.
      attempts: [{ lane: s.lanes.consent, tag: `join-door:${f.id}` }],
      call: {
        system: s.skills.consentAsk.instructions,
        systemExtras: [s.skills.noKeyword.instructions],
        userMessage: s.consent.consentAskUserMessage(f.ask),
        toolName: s.consent.CONSENT_ASK_TOOL,
        toolDescription: 'Write the one text this person will see.',
        toolSchema: s.consent.CONSENT_ASK_TOOL_SCHEMA,
        maxTokens: s.consent.CONSENT_ASK_MAX_TOKENS,
      },
      accept: (value) => {
        const text = s.consent.toConsentAskText(value ?? {});
        return text ? s.consent.acceptConsentAsk(text, { refuseOptOutKeyword: true }) : null;
      },
    })),
  ];
}

async function run(mode) {
  const live = mode === 'live';
  if (live) installEvalSpendCap();
  // Pending recordings: --cached-only is the --dry projection (see the header).
  if (mode === 'dry') process.env.HALE_EVAL_DRY = '1';
  const getClient = lazyAnthropic('join-door');
  const cost = makeCost();
  const s = await loadSubjects();
  const all = cases(s);
  console.info(
    `join-door | ${mode}${RECORDING_PENDING ? ' | recording pending' : ''} | spoken=${s.lanes.spoken.model} retry=${s.lanes.spokenRetry.model} consent=${s.lanes.consent.model} | cases=${all.length}`,
  );

  const results = [];
  for (const c of all) {
    let body = null;
    let unrecorded = false;
    let retried = false;
    for (const [i, attempt] of c.attempts.entries()) {
      const answer = await cachedToolCall({
        ...c.call,
        tag: attempt.tag,
        lane: attempt.lane,
        cachedOnly: mode === 'cached-only',
        getClient,
        cost,
      });
      if (answer.dry) {
        unrecorded = true;
        break;
      }
      retried = i > 0;
      body = c.accept(answer.value);
      if (body) break;
    }
    const failures = [];
    if (!unrecorded) {
      if (!body) failures.push('unwritten');
      else failures.push(...doorLineMisses(body, s.voice));
    }
    results.push({ c, body, unrecorded, retried, failures });
  }

  for (const r of results) {
    const state = r.unrecorded ? 'UNRECORDED' : r.failures.length === 0 ? 'PASS' : 'FAIL';
    const preview = r.unrecorded ? '' : r.body ? `"${r.body.slice(0, 160)}"` : '(unwritten)';
    console.info(`${state.padEnd(10)} ${r.c.id.padEnd(44)} ${r.retried ? 'retry ' : ''}${preview}`);
    for (const f of r.failures) console.info(`           · ${f}`);
  }
  const unrecorded = results.filter((r) => r.unrecorded).length;
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (mode === 'dry') console.info(dryReportLine('join-door'));
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD | unrecorded ${unrecorded} | failed ${failed}`,
  );
  const ok = failed === 0 && (live || mode === 'dry' || unrecorded === 0);
  console.info(`overall: ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(ok ? 0 : 1);
}

async function main() {
  const raw = process.argv.slice(2);
  assertRunFlags(['--max-usd'], raw);
  if (raw.includes('--live')) return run('live');
  if (raw.includes('--dry') || (raw.includes('--cached-only') && RECORDING_PENDING)) {
    return run('dry');
  }
  return run('cached-only');
}

main().catch((err) => {
  console.error('join-door eval harness error:', err);
  process.exit(2);
});
