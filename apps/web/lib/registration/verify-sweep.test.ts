import { describe, expect, it, vi } from 'vitest';
import type { ExtractedWindow, StoredWindow } from './verify-window';
import {
  DISCOVERY_TARGETS,
  MAX_WINDOWS_PER_RUN,
  type RegistrationVerifyDeps,
  formatRegistrationVerifyDigest,
  runRegistrationVerifySweep,
} from './verify-sweep';

/**
 * VIL-259 — the weekly sweep's orchestration.
 *
 * The three properties under test, in the order they matter:
 *   1. A DISCREPANCY NEVER WRITES. Not the date, not even `verified_at` — an
 *      unconfirmed row must keep its old verified_at so it stays visibly stale.
 *   2. ONE MUNICIPALITY'S PAGE CANNOT COST THE OTHERS THEIR SWEEP (rule #8: the
 *      failure is recorded and named, never swallowed into a clean success).
 *   3. THE RUN IS BOUNDED AND IDEMPOTENT PER WEEK — a fetch budget, and a claim
 *      that makes a double-fire a no-op instead of a second round of spend.
 *
 * The model call itself is injected (`extract`), so no test here reaches Anthropic;
 * the skill's own accuracy is the eval's job (evals/run-registration-verify-eval.mjs).
 */

const MARKHAM_PAGE =
  '2026 Fall Programs, Swim Lessons and Winter Break Camps. Preview starting Aug, 3. ' +
  'Register starting Aug. 11 at 6:30 AM.';

function storedWindow(overrides: Partial<StoredWindow> = {}): StoredWindow {
  return {
    id: 'win-markham',
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    previewAt: new Date('2026-08-03T00:00:00-04:00'),
    residentOpenAt: null,
    openAt: new Date('2026-08-11T06:30:00-04:00'),
    sourceUrl: 'https://www.markham.ca/registration',
    verifiedAt: new Date('2026-07-30T00:00:00-04:00'),
    ...overrides,
  };
}

function reading(overrides: Partial<ExtractedWindow> = {}): ExtractedWindow {
  return {
    found: true,
    reason: null,
    cycleOnPage: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    yearEvidence: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    preview: { date: '2026-08-03', time: null },
    residentOpen: null,
    generalOpen: { date: '2026-08-11', time: '06:30' },
    evidence: 'Register starting Aug. 11 at 6:30 AM',
    confidence: 0.95,
    ...overrides,
  };
}

const NOW = new Date('2026-08-03T15:00:00Z');

interface Harness {
  deps: RegistrationVerifyDeps;
  markVerified: ReturnType<typeof vi.fn>;
  fetchPage: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<RegistrationVerifyDeps> = {}): Harness {
  const markVerified = vi.fn(async () => {});
  const fetchPage = vi.fn(async () => MARKHAM_PAGE);
  const send = vi.fn(async () => true);
  const extract = vi.fn(async () => reading());
  const deps: RegistrationVerifyDeps = {
    client: {} as never,
    fetchPage,
    extract,
    loadWindows: async () => [storedWindow()],
    markVerified,
    claimWeek: async () => true,
    sender: { send },
    preflight: async () => ({ proceed: true, health: { ok: true } }),
    // Discovery is off unless a test asks for it, so the verify-leg assertions
    // are not muddied by extra fetches.
    discoveryTargets: [],
    ...overrides,
  };
  return { deps, markVerified, fetchPage, send, extract };
}

describe('runRegistrationVerifySweep — confirmed', () => {
  it('bumps verified_at for a row the page confirms, and sends no digest', async () => {
    const h = harness();
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(h.markVerified).toHaveBeenCalledTimes(1);
    expect(h.markVerified).toHaveBeenCalledWith({}, 'win-markham', NOW);
    expect(summary.confirmed).toBe(1);
    expect(summary.discrepancies).toBe(0);
    // Nothing to act on — the quiet operator says nothing.
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('runRegistrationVerifySweep — a discrepancy NEVER writes', () => {
  it('does not touch the row, not even verified_at, and raises a digest line', async () => {
    const h = harness({
      extract: vi.fn(async () =>
        reading({
          generalOpen: { date: '2026-08-18', time: '06:30' },
          evidence: 'Register starting Aug. 11 at 6:30 AM',
        }),
      ),
    });
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    // THE invariant. A row we could not confirm keeps its old verified_at, so it
    // stays visibly stale rather than looking freshly checked.
    expect(h.markVerified).not.toHaveBeenCalled();
    expect(summary.discrepancies).toBe(1);
    expect(summary.confirmed).toBe(0);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(String(h.send.mock.calls[0]?.[1])).toContain('2026-08-18');
  });
});

describe('runRegistrationVerifySweep — per-row isolation (rule #8)', () => {
  it('records a failing page as unverified and still sweeps the rest', async () => {
    const other = storedWindow({
      id: 'win-vaughan',
      municipality: 'vaughan',
      sourceUrl: 'https://www.vaughan.ca/recreation-programs',
    });
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValueOnce(MARKHAM_PAGE);
    const h = harness({
      fetchPage,
      loadWindows: async () => [storedWindow(), other],
    });

    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.checked).toBe(2);
    expect(summary.rows[0]?.outcome).toEqual({ kind: 'unverified', reason: 'fetch_failed' });
    expect(summary.rows[0]?.detail).toBe('HTTP 503');
    // The second municipality still got its sweep.
    expect(summary.rows[1]?.outcome).toEqual({ kind: 'confirmed', fields: ['previewAt', 'openAt'] });
    expect(h.markVerified).toHaveBeenCalledTimes(1);
    expect(h.markVerified).toHaveBeenCalledWith({}, 'win-vaughan', NOW);
  });

  it('records a model failure as unverified rather than losing the row', async () => {
    const h = harness({
      extract: vi.fn(async () => {
        throw new Error('overloaded');
      }),
    });
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.rows[0]?.outcome).toEqual({ kind: 'unverified', reason: 'extract_failed' });
    expect(h.markVerified).not.toHaveBeenCalled();
  });

  it('drops an uncorroborated reading instead of believing it', async () => {
    // The model quotes text the page does not contain. Nothing about that reading
    // is usable — not as a confirmation and not as an alarm.
    const h = harness({
      extract: vi.fn(async () =>
        reading({
          generalOpen: { date: '2026-09-08', time: '06:30' },
          evidence: 'Register starting Sep. 8 at 6:30 AM',
        }),
      ),
    });
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.rows[0]?.outcome).toEqual({ kind: 'unverified', reason: 'uncorroborated' });
    expect(summary.discrepancies).toBe(0);
    expect(h.markVerified).not.toHaveBeenCalled();
  });
});

describe('runRegistrationVerifySweep — bounded and idempotent', () => {
  it('checks no more than the per-run budget of windows', async () => {
    const many = Array.from({ length: MAX_WINDOWS_PER_RUN + 5 }, (_, i) =>
      storedWindow({ id: `win-${i}`, sourceUrl: `https://example.test/${i}` }),
    );
    const h = harness({ loadWindows: async (_db, _now, limit) => many.slice(0, limit) });

    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.checked).toBe(MAX_WINDOWS_PER_RUN);
    expect(h.fetchPage).toHaveBeenCalledTimes(MAX_WINDOWS_PER_RUN);
  });

  it('fetches a shared page ONCE however many cycles sit on it', async () => {
    // Burlington puts four cycles in one table and Markham three on one page.
    // Re-reading that page per row would lean four times as hard on a public
    // body's server for identical bytes.
    const h = harness({
      loadWindows: async () => [
        storedWindow({ id: 'win-a', programDomain: 'rec_program' }),
        storedWindow({ id: 'win-b', programDomain: 'swim' }),
        storedWindow({ id: 'win-c', programDomain: 'camp' }),
      ],
    });

    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.checked).toBe(3);
    expect(h.fetchPage).toHaveBeenCalledTimes(1);
    // Each cycle still gets its own read — one page, three questions.
    expect(h.extract).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when this week is already claimed', async () => {
    const h = harness({ claimWeek: async () => false });
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.skipped).toBe('already_ran_this_week');
    expect(summary.checked).toBe(0);
    // A double-fire costs nothing: no page fetch, no model call, no email.
    expect(h.fetchPage).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does nothing at all when there is no model client', async () => {
    const h = harness({ client: null });
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.skipped).toBe('no_model_client');
    // Reading a page IS the job — without a model there is no reason to fetch,
    // and certainly no reason to email the founder about our own misconfiguration.
    expect(h.fetchPage).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('aborts before spending anything when the provider is down', async () => {
    const h = harness({
      preflight: async () => ({
        proceed: false,
        abort: { failure: 'billing', detail: 'credit balance too low', alerted: true },
      }),
    });
    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.aborted).toEqual({
      failure: 'billing',
      detail: 'credit balance too low',
      alerted: true,
    });
    expect(h.fetchPage).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not claim the week when the provider aborted, so a retry can still run', async () => {
    const claimWeek = vi.fn(async () => true);
    const h = harness({
      claimWeek,
      preflight: async () => ({
        proceed: false,
        abort: { failure: 'auth', detail: 'bad key', alerted: true },
      }),
    });
    await runRegistrationVerifySweep({} as never, h.deps, NOW);
    expect(claimWeek).not.toHaveBeenCalled();
  });
});

describe('runRegistrationVerifySweep — the discovery leg', () => {
  const TORONTO_GAP = DISCOVERY_TARGETS.find((t) => t.municipality === 'toronto');

  it('reports a newly published window as an ADD suggestion, never as a row', async () => {
    if (!TORONTO_GAP) throw new Error('expected a Toronto discovery target');
    const h = harness({
      loadWindows: async () => [],
      discoveryTargets: [TORONTO_GAP],
      fetchPage: vi.fn(async () => 'Fall 2026 registration starts Wednesday, August 12 at 7 a.m.'),
      extract: vi.fn(async () =>
        reading({
          cycleOnPage: 'Fall 2026',
          yearEvidence: 'Fall 2026 registration starts Wednesday, August 12 at 7 a.m.',
          preview: null,
          generalOpen: { date: '2026-08-12', time: '07:00' },
          evidence: 'Fall 2026 registration starts Wednesday, August 12 at 7 a.m.',
        }),
      ),
    });

    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.discoveries).toHaveLength(1);
    expect(summary.discoveries[0]?.published).toBe(true);
    // A discovery is a SUGGESTION. Nothing is inserted — the dataset stays
    // hand-verified (M1's rule: no row beats a guessed row).
    expect(h.markVerified).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(String(h.send.mock.calls[0]?.[1])).toContain('new window published');
  });

  it('stays silent while the known gap is still a gap', async () => {
    if (!TORONTO_GAP) throw new Error('expected a Toronto discovery target');
    const h = harness({
      loadWindows: async () => [],
      discoveryTargets: [TORONTO_GAP],
      fetchPage: vi.fn(async () => 'Registration dates will be announced at a later date.'),
      extract: vi.fn(async () =>
        reading({
          found: false,
          reason: 'announced_later',
          cycleOnPage: null,
          yearEvidence: null,
          preview: null,
          generalOpen: null,
          evidence: null,
        }),
      ),
    });

    const summary = await runRegistrationVerifySweep({} as never, h.deps, NOW);

    expect(summary.discoveries[0]?.published).toBe(false);
    // Nothing changed this week. Saying so every Monday would train the founder
    // to ignore the email.
    expect(h.send).not.toHaveBeenCalled();
  });

  it('covers both known gaps: Toronto seasonal and Halton Hills', () => {
    expect(DISCOVERY_TARGETS.map((t) => t.municipality)).toContain('toronto');
    expect(DISCOVERY_TARGETS.map((t) => t.municipality)).toContain('halton_hills');
    for (const target of DISCOVERY_TARGETS) {
      expect(target.sourceUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('formatRegistrationVerifyDigest', () => {
  it('states both instants, the source and the quote for a discrepancy', () => {
    const text = formatRegistrationVerifyDigest(
      {
        checked: 1,
        confirmed: 0,
        discrepancies: 1,
        unverified: 0,
        rows: [
          {
            windowId: 'win-markham',
            municipality: 'markham',
            programDomain: 'rec_program',
            cycleLabel: '2026 Fall Programs',
            sourceUrl: 'https://www.markham.ca/registration',
            outcome: {
              kind: 'discrepancy',
              diffs: [
                {
                  field: 'openAt',
                  stored: new Date('2026-08-11T06:30:00-04:00'),
                  published: new Date('2026-08-18T06:30:00-04:00'),
                },
              ],
              evidence: 'Register starting Aug. 18 at 6:30 AM',
            },
          },
        ],
        discoveries: [],
      },
      NOW,
    );

    expect(text).toContain('DISCREPANCY');
    expect(text).toContain('markham');
    expect(text).toContain('open_at');
    // Both sides, in readable local time, so the founder can act without a query.
    expect(text).toContain('2026-08-11 06:30');
    expect(text).toContain('2026-08-18 06:30');
    expect(text).toContain('https://www.markham.ca/registration');
    expect(text).toContain('Register starting Aug. 18 at 6:30 AM');
    // The standing promise, restated where the decision gets made.
    expect(text).toContain('Nothing was changed');
  });

  it('groups the couldn-t-verify rows under a needs-human-look heading', () => {
    const text = formatRegistrationVerifyDigest(
      {
        checked: 1,
        confirmed: 0,
        discrepancies: 0,
        unverified: 1,
        rows: [
          {
            windowId: 'win-rh',
            municipality: 'richmond_hill',
            programDomain: 'rec_program',
            cycleLabel: 'Fall 2026',
            sourceUrl: 'https://www.richmondhill.ca/guide',
            outcome: { kind: 'unverified', reason: 'different_cycle_only' },
            detail: undefined,
          },
        ],
        discoveries: [],
      },
      NOW,
    );

    expect(text).toContain('needs a human look');
    expect(text).toContain('richmond_hill');
    expect(text).toContain('different_cycle_only');
  });

  it('never lists a confirmed row — silence is what confirmation looks like', () => {
    const text = formatRegistrationVerifyDigest(
      {
        checked: 2,
        confirmed: 2,
        discrepancies: 1,
        unverified: 0,
        rows: [
          {
            windowId: 'win-ok',
            municipality: 'burlington',
            programDomain: 'swim',
            cycleLabel: 'Fall swimming lessons',
            sourceUrl: 'https://www.burlington.ca/register',
            outcome: { kind: 'confirmed', fields: ['openAt'] },
          },
          {
            windowId: 'win-bad',
            municipality: 'markham',
            programDomain: 'rec_program',
            cycleLabel: '2026 Fall Programs',
            sourceUrl: 'https://www.markham.ca/registration',
            outcome: {
              kind: 'discrepancy',
              diffs: [
                {
                  field: 'openAt',
                  stored: new Date('2026-08-11T06:30:00-04:00'),
                  published: new Date('2026-08-18T06:30:00-04:00'),
                },
              ],
              evidence: 'Register starting Aug. 18 at 6:30 AM',
            },
          },
        ],
        discoveries: [],
      },
      NOW,
    );

    expect(text).not.toContain('burlington');
    // The count still appears, so "we checked and they were fine" is legible.
    expect(text).toContain('2 confirmed');
  });
});
