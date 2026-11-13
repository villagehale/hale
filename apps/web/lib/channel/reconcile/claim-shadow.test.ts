import type { Database } from '@hale/db';
import { waitUntil } from '@vercel/functions';
import { describe, expect, it } from 'vitest';
import { buildEvent } from '~/lib/analytics/events';
import { captureServerEvent, hashFamilyId } from '~/lib/analytics/server-capture';
import type { ClaimShadowContext } from './candidate-rows';
import type { ClaimCandidateRow } from './candidates';
import { claimRowLabel } from './claim-label';
import {
  CLAIM_READ_MAX_BUDGET_MS,
  type ClaimReadInput,
  type ClaimReadOutcome,
  type ReadClaim,
} from './claim-reader';
import {
  CLAIM_SHADOW_MAX_IN_FLIGHT,
  type ClaimShadowPorts,
  createClaimShadow,
  defaultClaimShadow,
  defaultClaimShadowPorts,
  regexJudgements,
} from './claim-shadow';
import type { ClaimKind, StateClaim } from './claims';
import { claimReaderMode } from './flag';
import type {
  ClaimResolution,
  ReconcileVerdict,
  ReconcileView,
  RefusalReason,
  RegistrationWatchMint,
} from './reconcile';
import { claimReadLocale, segmentSentences } from './sentences';

/**
 * VIL-581 · the shadow core, with fakes at its ports only (mode, reader, context loader,
 * capture, detach, log). The comparison expectations are worked out by hand from the
 * PR 2 brief §5.5, never read off the function.
 */

const FAM = 'fam-shadow';
const TZ = 'America/Denver';
const NOW = new Date('2026-11-03T12:00:00Z');
const DB = { handle: 'the-database' } as unknown as Database;
const label = (text: string) => claimRowLabel({ from: 'pending', text }, NOW);

const calendar = (what: string, days = 4): ClaimCandidateRow => ({
  familyId: FAM,
  source: 'calendar',
  kind: 'scheduled_event',
  what: label(what),
  startsAt: new Date(NOW.getTime() + days * 86_400_000),
});
const WINDOW: ClaimCandidateRow = {
  familyId: FAM,
  source: 'mintable_window',
  kind: 'registration_watch',
  what: label('Riverford registration'),
  opensForFamilyAt: new Date('2026-12-01T15:00:00Z'),
};
const PAGE: ClaimCandidateRow = {
  familyId: FAM,
  source: 'watched_page',
  kind: 'spot_watch',
  what: label('Saturday swim'),
  host: 'register.example.org',
};

const ready = (rows: ClaimCandidateRow[], language = 'en'): ClaimShadowContext => ({
  status: 'ready',
  rows,
  language,
  timeZone: TZ,
});

const claim = (sentence: string, kind: ClaimKind): StateClaim => ({ sentence, kind, words: [] });
const matched = (sentence: string, kind: ClaimKind): ClaimResolution => ({
  claim: claim(sentence, kind),
  status: 'matched',
  matchedBy: 'open_commitment',
});
const refused = (sentence: string, kind: ClaimKind, reason: RefusalReason): ClaimResolution => ({
  claim: claim(sentence, kind),
  status: 'refused',
  reason,
});
const MINT: RegistrationWatchMint = {
  kind: 'registration_watch',
  summary: 'Riverford registration: a text before it opens.',
  dueAt: new Date('2026-12-01T15:00:00Z'),
};
const minted = (sentence: string): ClaimResolution => ({
  claim: claim(sentence, 'registration_watch'),
  status: 'minted',
  mint: MINT,
});
function verdictOf(...resolutions: ClaimResolution[]): ReconcileVerdict {
  return {
    resolutions,
    refused: resolutions.filter(
      (r): r is Extract<ClaimResolution, { status: 'refused' }> => r.status === 'refused',
    ),
    mints: resolutions.flatMap((r) => (r.status === 'minted' ? [r.mint] : [])),
  };
}

const VIEW: ReconcileView = {
  openKinds: new Set(),
  pendingKinds: new Set(),
  registrationLaddered: false,
  mintableWindow: null,
  scheduledTitles: [],
  statedBookings: [],
};

const readOf =
  (claims: ReadClaim[]) =>
  async (input: ClaimReadInput): Promise<ClaimReadOutcome> => ({
    status: 'read',
    segments: segmentSentences(input.body, claimReadLocale(input.language)),
    claims,
    usage: { input: 120, output: 30 },
    latencyMs: 1_400,
    attempts: 1,
  });

interface Harness {
  ports: ClaimShadowPorts;
  shadow: ReturnType<typeof createClaimShadow>;
  settle: () => Promise<void>;
  tasks: Promise<void>[];
  reads: ClaimReadInput[];
  contexts: Array<[Database, unknown]>;
  captures: Array<{ event: string; distinctId: string; props: Record<string, unknown> }>;
  logs: unknown[][];
  props: () => Record<string, unknown>;
}

function harness(
  over: Partial<{
    mode: ReturnType<ClaimShadowPorts['mode']>;
    read: (input: ClaimReadInput) => Promise<ClaimReadOutcome>;
    context: ClaimShadowContext | (() => Promise<ClaimShadowContext>);
    capture: ClaimShadowPorts['capture'];
  }> = {},
): Harness {
  const tasks: Promise<void>[] = [];
  const reads: ClaimReadInput[] = [];
  const contexts: Array<[Database, unknown]> = [];
  const captures: Harness['captures'] = [];
  const logs: unknown[][] = [];
  const context = over.context ?? ready([calendar('Swim lesson')]);
  const ports: ClaimShadowPorts = {
    mode: () => over.mode ?? 'shadow',
    reader: {
      read: async (input) => {
        reads.push(input);
        return (over.read ?? readOf([]))(input);
      },
    },
    loadContext: async (database, input) => {
      contexts.push([database, input]);
      return typeof context === 'function' ? context() : context;
    },
    capture:
      over.capture ??
      (async (event, distinctId, props) => {
        captures.push({ event, distinctId, props });
        return 'sent';
      }),
    detach: (task) => {
      tasks.push(task);
    },
    log: {
      info: (...args: unknown[]) => {
        logs.push(args);
      },
      error: (...args: unknown[]) => {
        logs.push(args);
      },
    },
  };
  const shadow = createClaimShadow(ports);
  return {
    ports,
    shadow,
    tasks,
    reads,
    contexts,
    captures,
    logs,
    settle: async () => {
      await Promise.all(tasks);
    },
    props: () => {
      const last = captures.at(-1);
      if (!last) throw new Error('no capture');
      return last.props;
    },
  };
}

type SweepInput = Parameters<ReturnType<typeof createClaimShadow>['sweep']>[1];
const sweepInput = (over: Partial<SweepInput>): SweepInput => ({
  lane: 'followup_ask',
  familyId: FAM,
  parentUserId: 'parent-1',
  body: 'Swim is booked.',
  now: NOW,
  verdict: null,
  view: null,
  ...over,
});

/** Every count on the event that is not named in `nonZero` must be 0. */
function onlyThese(props: Record<string, unknown>, nonZero: Record<string, number>) {
  const counts = Object.entries(props).filter(
    ([key]) =>
      /^(regex|reader|agree|reader_only|regex_only)_(n|reason)_/.test(key) ||
      /^(agree|reader_only|regex_only)_n_/.test(key) ||
      key === 'regex_mints' ||
      key === 'reader_mints',
  );
  expect(counts.length).toBeGreaterThan(40);
  for (const [key, value] of counts) {
    expect([key, value]).toEqual([key, nonZero[key] ?? 0]);
  }
}

// ── S1 · mode ───────────────────────────────────────────────────────────────────

describe('mode', () => {
  it('off: nothing is loaded, read or captured', async () => {
    const h = harness({ mode: 'off' });
    expect(h.shadow.sweep(DB, sweepInput({}))).toBe('off');
    await h.settle();
    expect([h.contexts.length, h.reads.length, h.captures.length, h.tasks.length]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('shadow: one load, one read, one capture (control); the database is the caller’s', async () => {
    const h = harness();
    expect(h.shadow.sweep(DB, sweepInput({}))).toBe('started');
    await h.settle();
    expect([h.contexts.length, h.reads.length, h.captures.length]).toEqual([1, 1, 1]);
    expect(h.contexts[0]?.[0]).toBe(DB);
    expect(h.props().mode).toBe('shadow');
  });

  it('enforce is not built: it runs as shadow and the event says which was set', async () => {
    const h = harness({ mode: 'enforce' });
    expect(h.shadow.sweep(DB, sweepInput({}))).toBe('started');
    await h.settle();
    expect(h.props().mode).toBe('enforce');
  });

  it('the reader gets its own never-aborting signal and the max budget', async () => {
    const h = harness();
    const turnDeadline = new AbortController();
    h.shadow.coachTurn(DB, {
      familyId: FAM,
      parentUserId: 'parent-1',
      now: NOW,
      inbound: 'Is swim booked?',
      view: VIEW,
      attempts: [
        {
          reply: 'Swim is booked.',
          activityPromise: null,
          spotWatch: null,
          verdict: verdictOf(),
        },
      ],
    });
    turnDeadline.abort();
    await h.settle();
    expect(h.reads[0]?.budgetMs).toBe(CLAIM_READ_MAX_BUDGET_MS);
    expect(h.reads[0]?.signal.aborted).toBe(false);
    expect(h.props().reader_outcome).toBe('read');
  });
});

// ── S2-S7 · the comparison ──────────────────────────────────────────────────────

describe('the comparison', () => {
  const SWIM = 'Swim is booked.';
  const WATCH = "I'll text you when registration opens.";
  const TWO = `${SWIM} ${WATCH}`;

  it('same: both refuse the watch and both back the booking', async () => {
    const h = harness({
      read: readOf([
        { segment: 0, kind: 'scheduled_event', row: 'e1' },
        { segment: 1, kind: 'registration_watch', row: 'none' },
      ]),
    });
    h.shadow.sweep(
      DB,
      sweepInput({
        body: TWO,
        verdict: verdictOf(
          matched(SWIM, 'scheduled_event'),
          refused(WATCH, 'registration_watch', 'no_registration_watch'),
        ),
      }),
    );
    await h.settle();
    const p = h.props();
    expect(p.verdict).toBe('same');
    expect(p.segments_n).toBe(2);
    onlyThese(p, {
      regex_n_scheduled_event: 1,
      regex_n_registration_watch: 1,
      reader_n_scheduled_event: 1,
      reader_n_registration_watch: 1,
      agree_n_scheduled_event: 1,
      agree_n_registration_watch: 1,
      regex_reason_no_registration_watch: 1,
      reader_reason_no_registration_watch: 1,
    });
  });

  it('reader_stricter: a fr booking the English gate cannot see', async () => {
    const h = harness({
      context: ready([calendar('Swim lesson')], 'fr'),
      read: readOf([{ segment: 0, kind: 'scheduled_event', row: 'none' }]),
    });
    h.shadow.sweep(DB, sweepInput({ body: 'Ta visite est réservée.', verdict: null }));
    await h.settle();
    const p = h.props();
    expect([p.verdict, p.language]).toEqual(['reader_stricter', 'fr']);
    onlyThese(p, {
      reader_n_scheduled_event: 1,
      reader_only_n_scheduled_event: 1,
      reader_reason_no_scheduled_row: 1,
    });
  });

  it('regex_stricter: the regex refuses what the reader backs; detection still agrees', async () => {
    const h = harness({ read: readOf([{ segment: 0, kind: 'scheduled_event', row: 'e1' }]) });
    h.shadow.sweep(
      DB,
      sweepInput({
        body: SWIM,
        verdict: verdictOf(refused(SWIM, 'scheduled_event', 'no_scheduled_row')),
      }),
    );
    await h.settle();
    const p = h.props();
    expect(p.verdict).toBe('regex_stricter');
    expect(p.agree_n_scheduled_event).toBe(1);
  });

  it('both_refuse_differently: each side refuses the other sentence', async () => {
    const DENTIST = 'Dentist is booked.';
    const h = harness({
      context: ready([calendar('Swim lesson'), calendar('Dentist', 5)]),
      read: readOf([
        { segment: 0, kind: 'scheduled_event', row: 'none' },
        { segment: 1, kind: 'scheduled_event', row: 'e2' },
      ]),
    });
    h.shadow.sweep(
      DB,
      sweepInput({
        body: `${SWIM} ${DENTIST}`,
        verdict: verdictOf(
          matched(SWIM, 'scheduled_event'),
          refused(DENTIST, 'scheduled_event', 'no_scheduled_row'),
        ),
      }),
    );
    await h.settle();
    expect(h.props().verdict).toBe('both_refuse_differently');
  });

  it('a reader spot_watch agrees with a regex registration_watch (main has no spot kind)', async () => {
    const SPOT = "I'll text you when a spot opens.";
    const h = harness({
      context: ready([PAGE]),
      read: readOf([{ segment: 0, kind: 'spot_watch', row: 'g1' }]),
    });
    h.shadow.sweep(
      DB,
      sweepInput({
        lane: 'spot_open',
        body: SPOT,
        verdict: verdictOf(matched(SPOT, 'registration_watch')),
      }),
    );
    await h.settle();
    const p = h.props();
    expect([p.agree_n_spot_watch, p.regex_only_n_registration_watch, p.verdict]).toEqual([
      1,
      0,
      'same',
    ]);
  });

  it('a repeated claim maps to its own sentence, not the first copy (Devin)', async () => {
    const h = harness({
      read: readOf([
        { segment: 0, kind: 'scheduled_event', row: 'e1' },
        { segment: 1, kind: 'scheduled_event', row: 'e1' },
      ]),
    });
    h.shadow.sweep(
      DB,
      sweepInput({
        body: `${SWIM} ${SWIM}`,
        verdict: verdictOf(matched(SWIM, 'scheduled_event'), matched(SWIM, 'scheduled_event')),
      }),
    );
    await h.settle();
    const p = h.props();
    expect(p.segments_n).toBe(2);
    onlyThese(p, {
      regex_n_scheduled_event: 2,
      reader_n_scheduled_event: 2,
      agree_n_scheduled_event: 2,
    });
  });
});

describe('lane semantics: a mint is sendable on the coach only', () => {
  const ARM = "I'll text you before Riverford registration opens.";
  const mintRead = readOf([{ segment: 0, kind: 'registration_watch', row: 'w1' }]);

  it('a sweep: both mints are unsendable, so the sides agree, and the regex mint is a mint', async () => {
    const h = harness({ context: ready([WINDOW]), read: mintRead });
    h.shadow.sweep(
      DB,
      sweepInput({ lane: 'spot_open', body: ARM, verdict: verdictOf(minted(ARM)) }),
    );
    await h.settle();
    const p = h.props();
    expect([p.verdict, p.regex_mints, p.reader_mints]).toEqual(['same', 1, 1]);
    for (const [key, value] of Object.entries(p)) {
      if (key.startsWith('regex_reason_')) expect([key, value]).toEqual([key, 0]);
    }
  });

  it('dispatch: no ledger writer, so a reader mint is stricter than an empty regex side', async () => {
    const h = harness({ context: ready([WINDOW]), read: mintRead });
    h.shadow.dispatch(DB, {
      familyId: FAM,
      parentUserId: 'parent-1',
      body: ARM,
      now: NOW,
      claims: [],
    });
    await h.settle();
    expect([h.props().lane, h.props().verdict]).toEqual(['dispatch', 'reader_stricter']);
  });

  it('the coach writes the row, so the same mints are sendable there (control)', async () => {
    const h = harness({ context: ready([WINDOW]), read: mintRead });
    h.shadow.coachTurn(DB, {
      familyId: FAM,
      parentUserId: 'parent-1',
      now: NOW,
      inbound: 'Can you watch it?',
      view: VIEW,
      attempts: [
        { reply: ARM, activityPromise: null, spotWatch: null, verdict: verdictOf(minted(ARM)) },
      ],
    });
    await h.settle();
    const p = h.props();
    expect([p.lane, p.verdict, p.regex_mints]).toEqual(['coach', 'same', 1]);
  });

  it('regexJudgements: no claim is nothing; a no-ledger invite is no_coparent_invite', () => {
    expect(regexJudgements({ kind: 'verdict', verdict: null }, 'spot_open')).toEqual([]);
    expect(
      regexJudgements(
        { kind: 'no_ledger', claims: [claim("I'll send an invite.", 'co_parent_invite')] },
        'dispatch',
      ),
    ).toEqual([
      {
        sentence: "I'll send an invite.",
        kind: 'co_parent_invite',
        decision: 'no_coparent_invite',
      },
    ]);
    expect(
      regexJudgements({ kind: 'verdict', verdict: verdictOf(minted(ARM)) }, 'followup_ask'),
    ).toEqual([{ sentence: ARM, kind: 'registration_watch', decision: 'unrecorded_promise' }]);
    expect(regexJudgements({ kind: 'verdict', verdict: verdictOf(minted(ARM)) }, 'coach')).toEqual([
      { sentence: ARM, kind: 'registration_watch', decision: 'sendable' },
    ]);
  });

  it('coach scope: a claim in the card title counts only as outside the reply', async () => {
    const h = harness({ read: readOf([{ segment: 1, kind: 'scheduled_event', row: 'none' }]) });
    h.shadow.coachTurn(DB, {
      familyId: FAM,
      parentUserId: 'parent-1',
      now: NOW,
      inbound: 'Anything for Saturday?',
      view: VIEW,
      attempts: [
        {
          reply: 'Here is one.',
          experienceCard: { title: 'Swim is booked.' },
          activityPromise: null,
          spotWatch: null,
          verdict: verdictOf(),
        },
      ],
    });
    await h.settle();
    const p = h.props();
    expect([p.outside_reply_claims_n, p.reader_only_n_scheduled_event, p.verdict]).toEqual([
      1,
      0,
      'same',
    ]);
    expect(h.reads[0]?.body).toBe('Here is one.\n\nSwim is booked.');
  });

  it('the same claim inside the reply is counted (control)', async () => {
    const h = harness({ read: readOf([{ segment: 0, kind: 'scheduled_event', row: 'none' }]) });
    h.shadow.coachTurn(DB, {
      familyId: FAM,
      parentUserId: 'parent-1',
      now: NOW,
      inbound: 'Anything for Saturday?',
      view: VIEW,
      attempts: [
        { reply: 'Swim is booked.', activityPromise: null, spotWatch: null, verdict: verdictOf() },
      ],
    });
    await h.settle();
    expect([h.props().outside_reply_claims_n, h.props().reader_only_n_scheduled_event]).toEqual([
      0, 1,
    ]);
  });
});

// ── S8-S11 · failures and the bound ─────────────────────────────────────────────

describe('a failure is named, never a refusal', () => {
  it('a failed read: its reason, our deadline flag, not_compared, no reader counts', async () => {
    const h = harness({
      read: async () => ({
        status: 'failed',
        reason: 'unreachable',
        attempts: 1,
        latencyMs: 15_000,
        deadline: true,
      }),
    });
    h.shadow.sweep(DB, sweepInput({}));
    await h.settle();
    const p = h.props();
    expect([p.reader_outcome, p.read_deadline, p.verdict, p.read_ms]).toEqual([
      'unreachable',
      true,
      'not_compared',
      15_000,
    ]);
    expect(h.captures).toHaveLength(1);
    onlyThese(p, {});
  });

  it('no time zone is its own outcome', async () => {
    const h = harness({ context: { status: 'skipped', reason: 'no_time_zone' } });
    h.shadow.sweep(DB, sweepInput({}));
    await h.settle();
    expect([h.props().reader_outcome, h.props().verdict, h.reads.length]).toEqual([
      'no_time_zone',
      'not_compared',
      0,
    ]);
  });

  it('a throw inside the task is shadow_error, logged by class only; the task resolves', async () => {
    const h = harness({
      context: async () => {
        throw new Error('ZQXJ-SENTINEL');
      },
    });
    h.shadow.sweep(DB, sweepInput({}));
    await expect(h.settle()).resolves.toBeUndefined();
    expect(h.props().reader_outcome).toBe('shadow_error');
    expect(h.captures).toHaveLength(1);
    const failed = h.logs.find(
      ([meta]) => (meta as { event?: string }).event === 'claim_shadow_failed',
    );
    expect(failed?.[0]).toEqual({
      event: 'claim_shadow_failed',
      lane: 'followup_ask',
      err: 'Error',
    });
    expect(JSON.stringify(h.logs)).not.toContain('ZQXJ-SENTINEL');
  });

  it('a capture that rejects is logged and the task still resolves', async () => {
    const h = harness({
      capture: async () => {
        throw new TypeError('posthog down');
      },
    });
    h.shadow.sweep(DB, sweepInput({}));
    await expect(h.settle()).resolves.toBeUndefined();
    expect(
      h.logs.some(([meta]) => (meta as { event?: string }).event === 'claim_shadow_capture_failed'),
    ).toBe(true);
  });

  it(`past ${CLAIM_SHADOW_MAX_IN_FLIGHT} reads in flight, a start is busy and says so`, async () => {
    const pending: Array<(o: ClaimReadOutcome) => void> = [];
    const h = harness({
      read: (input) =>
        new Promise((resolve) => {
          pending.push((o) => resolve(o));
          void input;
        }),
    });
    expect(CLAIM_SHADOW_MAX_IN_FLIGHT).toBe(2);
    expect([
      h.shadow.sweep(DB, sweepInput({})),
      h.shadow.sweep(DB, sweepInput({})),
      h.shadow.sweep(DB, sweepInput({})),
    ]).toEqual(['started', 'started', 'busy']);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads).toHaveLength(2);
    await h.tasks[2];
    expect(h.captures.map((c) => c.props.reader_outcome)).toEqual(['shadow_busy']);
    const done = await readOf([])(h.reads[0] as ClaimReadInput);
    pending[0]?.(done);
    await h.tasks[0];
    expect(h.shadow.sweep(DB, sweepInput({}))).toBe('started');
    pending[1]?.(done);
    await new Promise((r) => setTimeout(r, 0));
    pending[2]?.(done);
    await h.settle();
  });
});

// ── S12-S15 · the event ─────────────────────────────────────────────────────────

const KINDS = [
  'scheduled_event',
  'registration_watch',
  'spot_watch',
  'activity_followup',
  'co_parent_invite',
  'self_referential',
  'registration_done',
  'send_done',
  'send_received',
  'cancelled',
];
const REASONS = [
  'self_referential',
  'no_registration_watch',
  'spot_watch_unshaped',
  'no_activity_promise',
  'no_scheduled_row',
  'no_coparent_invite',
  'no_registration_record',
  'no_send_record',
  'no_delivery_record',
  'no_cancel_record',
];
const EVENT_KEYS = [
  'mode',
  'lane',
  'language',
  'attempt',
  'reader_outcome',
  'verdict',
  'read_ms',
  'read_attempts',
  'read_deadline',
  'usage_in',
  'usage_out',
  'segments_n',
  'candidates_capped',
  'pending_uncited',
  'regex_unmapped',
  'outside_reply_claims_n',
  'family_hash',
  ...KINDS.flatMap((k) => [
    `regex_n_${k}`,
    `reader_n_${k}`,
    `agree_n_${k}`,
    `reader_only_n_${k}`,
    `regex_only_n_${k}`,
  ]),
  ...REASONS.flatMap((r) => [`regex_reason_${r}`, `reader_reason_${r}`]),
  'regex_mints',
  'reader_mints',
];

describe('agent_claim_shadow', () => {
  async function oneEvent() {
    const h = harness({ read: readOf([{ segment: 0, kind: 'scheduled_event', row: 'e1' }]) });
    h.shadow.sweep(
      DB,
      sweepInput({
        body: 'Swim is booked.',
        verdict: verdictOf(matched('Swim is booked.', 'scheduled_event')),
      }),
    );
    await h.settle();
    return h;
  }

  it('carries exactly the 89 keys, every one present', async () => {
    const h = await oneEvent();
    expect(EVENT_KEYS).toHaveLength(89);
    expect(Object.keys(h.props()).sort()).toEqual([...EVENT_KEYS].sort());
  });

  it('every key survives buildEvent (the positive control for its silent drop)', async () => {
    const props = (await oneEvent()).props();
    expect(buildEvent('agent_claim_shadow', props).properties).toEqual(props);
    // The gate does drop a key the design would have used:
    expect(buildEvent('agent_claim_shadow', { latency_ms: 1 }).properties).toEqual({});
  });

  it('values are numbers, booleans or enum tokens; the family is a hash', async () => {
    const h = await oneEvent();
    const props = h.props();
    for (const [key, value] of Object.entries(props)) {
      if (key === 'family_hash') continue;
      if (typeof value === 'string')
        expect([key, value]).toEqual([key, expect.stringMatching(/^[a-z][a-z0-9_]{0,39}$/)]);
      else expect(['number', 'boolean']).toContain(typeof value);
    }
    expect(props.family_hash).toBe(hashFamilyId(FAM));
    expect(props.family_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(h.captures[0]).toMatchObject({
      event: 'agent_claim_shadow',
      distinctId: hashFamilyId(FAM),
    });
  });

  it('carries no body, label or inbound; the reader did receive all three (positive control)', async () => {
    const h = harness({
      context: ready([calendar('ZQXJ-LABEL lesson')]),
      read: readOf([{ segment: 0, kind: 'scheduled_event', row: 'e1' }]),
    });
    h.shadow.coachTurn(DB, {
      familyId: FAM,
      parentUserId: 'parent-1',
      now: NOW,
      inbound: 'ZQXJ-IN is it on?',
      view: VIEW,
      attempts: [
        {
          reply: 'ZQXJ-BODY is booked.',
          activityPromise: null,
          spotWatch: null,
          verdict: verdictOf(),
        },
      ],
    });
    await h.settle();
    const out = JSON.stringify([h.captures, h.logs]);
    for (const sentinel of ['ZQXJ-BODY', 'ZQXJ-LABEL', 'ZQXJ-IN'])
      expect(out).not.toContain(sentinel);
    const received = h.reads[0] as ClaimReadInput;
    expect(received.body).toContain('ZQXJ-BODY');
    expect(JSON.stringify(received.candidates.projected)).toContain('ZQXJ-LABEL');
    expect(received.inbound).toContain('ZQXJ-IN');
  });

  it('pending_uncited counts an offered pending row no claim cites', async () => {
    const P1: ClaimCandidateRow = {
      familyId: FAM,
      source: 'pending',
      kind: 'activity_followup',
      what: label('Toddler classes'),
    };
    const run = async (claims: ReadClaim[]) => {
      const h = harness({ context: ready([P1]), read: readOf(claims) });
      h.shadow.coachTurn(DB, {
        familyId: FAM,
        parentUserId: 'parent-1',
        now: NOW,
        inbound: 'Find us something?',
        view: VIEW,
        attempts: [
          {
            reply: "I'll look for toddler classes.",
            activityPromise: { subject: 'Toddler classes' },
            spotWatch: null,
            verdict: verdictOf(),
          },
        ],
      });
      await h.settle();
      return { pending: h.props().pending_uncited, loaded: h.contexts[0]?.[1] };
    };
    const uncited = await run([]);
    expect(uncited.pending).toBe(1);
    expect(uncited.loaded).toMatchObject({
      pending: { activityFollowup: 'Toddler classes', spotWatch: null },
    });
    expect((await run([{ segment: 0, kind: 'activity_followup', row: 'p1' }])).pending).toBe(0);
  });

  it('a regex sentence missing from the body is regex_unmapped', async () => {
    const run = async (sentence: string) => {
      const h = harness({ read: readOf([{ segment: 0, kind: 'scheduled_event', row: 'e1' }]) });
      h.shadow.sweep(
        DB,
        sweepInput({
          body: 'Swim is booked.',
          verdict: verdictOf(matched(sentence, 'scheduled_event')),
        }),
      );
      await h.settle();
      return h.props().regex_unmapped;
    };
    expect(await run('Dentist is booked.')).toBe(1);
    expect(await run('Swim is booked.')).toBe(0);
  });
});

// ── S16 · production wiring ─────────────────────────────────────────────────────

describe('production wiring', () => {
  it('one process-wide shadow over the real capture, flag and waitUntil', () => {
    expect(defaultClaimShadow()).toBe(defaultClaimShadow());
    const ports = defaultClaimShadowPorts();
    expect(ports.capture).toBe(captureServerEvent);
    expect(ports.mode).toBe(claimReaderMode);
    expect(ports.detach).toBe(waitUntil);
  });
});
