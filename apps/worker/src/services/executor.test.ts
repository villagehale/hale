import type { ApprovedAction } from '@hale/types';
import { mintApprovedAction } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecutorDeps, resendSend, runExecutor } from './executor.js';

const resendSendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn(() => ({ emails: { send: resendSendMock } })),
}));

/**
 * B9 — outbound idempotency. These tests script the claim table + email
 * provider transports, NOT a live DB. The invariant under test: across a
 * succeeded-send-then-commit-failed plus a pg-boss redelivery, the provider
 * fires EXACTLY ONCE — the second pass's claim insert conflicts and the send
 * is skipped.
 */

const familyId = '11111111-1111-4111-8111-111111111111';
const actionId = '22222222-2222-4222-8222-222222222222';

function approvedEmail(): ApprovedAction {
  return mintApprovedAction(
    {
      id: actionId,
      eventId: '33333333-3333-4333-8333-333333333333',
      familyId,
      actionType: 'send_email',
      payload: { to: 'clinic@example.com', subject: 'hi', body: 'hello' },
      draftConfidence: 0.95,
      rationale: 'ok',
      recipientVisibility: 'public',
      draftedAt: '2026-06-12T10:00:00.000Z',
    },
    {
      kind: 'approve',
      rationale: 'all checks green',
      toolResults: [
        { tool: 'check_pii_leak', ok: true, result: {} },
        { tool: 'check_recipient_allowlist', ok: true, result: {} },
        { tool: 'check_action_idempotency', ok: true, result: {} },
      ],
    },
    () => true,
  );
}

/**
 * A claim store backed by an in-memory Set of action ids. `claim` inserts and
 * returns true; a second claim for the same action id returns false (the unique
 * constraint conflict). Mirrors the outbound_sends claim semantics without SQL.
 */
function makeClaimStore() {
  const claimed = new Set<string>();
  const skips: string[] = [];
  const deps: ExecutorDeps = {
    claimOutboundSend: vi.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
    confirmOutboundSend: vi.fn(async () => {}),
    recordSkippedDuplicate: vi.fn(async (_fam: string, id: string) => {
      skips.push(id);
    }),
    sendEmail: vi.fn(async () => ({ messageId: 'unset' })),
    addToRoutine: vi.fn(async () => 'written' as const),
    addToDigest: vi.fn(async () => 'written' as const),
    calendar: {
      createEvent: vi.fn(async () => ({ providerEventId: 'unset' })),
      updateEvent: vi.fn(async () => ({ providerEventId: 'unset' })),
    },
  };
  return { deps, skips };
}

describe('runExecutor — B9 outbound idempotency claim', () => {
  it('sends exactly once across succeeded-then-commit-failed + redelivery', async () => {
    const provider = vi.fn(async () => ({
      messageId: 'pm-1',
      submittedAt: '2026-06-12T10:01:00Z',
    }));
    const { deps } = makeClaimStore();
    deps.sendEmail = provider;

    // Pass 1: claim succeeds, provider sends. Simulate the worker crashing AFTER
    // the provider call but BEFORE the orchestrator's commit by ignoring the result.
    await runExecutor({ familyId, approved: approvedEmail() }, deps);

    // Pass 2: pg-boss redelivers the same job. The claim insert must conflict.
    const result2 = await runExecutor({ familyId, approved: approvedEmail() }, deps);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(result2.detail.kind).toBe('send_skipped_duplicate');
  });

  it('audits action.send_skipped_duplicate on the redelivery', async () => {
    const provider = vi.fn(async () => ({ messageId: 'pm-1' }));
    const { deps, skips } = makeClaimStore();
    deps.sendEmail = provider;

    await runExecutor({ familyId, approved: approvedEmail() }, deps);
    await runExecutor({ familyId, approved: approvedEmail() }, deps);

    expect(deps.recordSkippedDuplicate).toHaveBeenCalledTimes(1);
    expect(skips).toEqual([actionId]);
  });

  it('writes sent_at via confirmOutboundSend only on the real send', async () => {
    const provider = vi.fn(async () => ({ messageId: 'pm-9' }));
    const { deps } = makeClaimStore();
    deps.sendEmail = provider;

    await runExecutor({ familyId, approved: approvedEmail() }, deps);
    await runExecutor({ familyId, approved: approvedEmail() }, deps);

    expect(deps.confirmOutboundSend).toHaveBeenCalledTimes(1);
    expect(deps.confirmOutboundSend).toHaveBeenCalledWith(actionId, 'pm-9');
  });
});

function approvedInternal(
  actionType: 'add_to_routine' | 'add_to_digest_only',
  payload: Record<string, unknown> = { title: 'Baby & Me Yoga', summary: 'Tuesdays 10am' },
): ApprovedAction {
  return mintApprovedAction(
    {
      id: actionId,
      eventId: '33333333-3333-4333-8333-333333333333',
      familyId,
      actionType,
      payload,
      draftConfidence: 0.95,
      rationale: 'accepted village item',
      recipientVisibility: 'internal_only',
      draftedAt: '2026-06-12T10:00:00.000Z',
    },
    {
      kind: 'approve',
      rationale: 'idempotency check green',
      toolResults: [{ tool: 'check_action_idempotency', ok: true, result: {} }],
    },
    () => true,
  );
}

describe('runExecutor — add_to_routine writes the week plan', () => {
  it('calls addToRoutine with the accepted item and returns the outcome', async () => {
    const { deps } = makeClaimStore();
    const result = await runExecutor(
      { familyId, approved: approvedInternal('add_to_routine') },
      deps,
    );

    expect(deps.addToRoutine).toHaveBeenCalledWith({
      familyId,
      actionId,
      eventId: '33333333-3333-4333-8333-333333333333',
      title: 'Baby & Me Yoga',
      notes: 'Tuesdays 10am',
    });
    expect(deps.addToDigest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, detail: { kind: 'routine_pin', outcome: 'written' } });
  });

  it('surfaces the already_written outcome on a re-drain (idempotent, no false new-write)', async () => {
    const { deps } = makeClaimStore();
    deps.addToRoutine = vi.fn(async () => 'already_written' as const);

    const result = await runExecutor(
      { familyId, approved: approvedInternal('add_to_routine') },
      deps,
    );
    expect(result.detail).toEqual({ kind: 'routine_pin', outcome: 'already_written' });
  });

  it('throws when the write fails — never a false ok (rule #8)', async () => {
    const { deps } = makeClaimStore();
    deps.addToRoutine = vi.fn(async () => {
      throw new Error('family_plans insert failed');
    });

    await expect(
      runExecutor({ familyId, approved: approvedInternal('add_to_routine') }, deps),
    ).rejects.toThrow('family_plans insert failed');
  });

  it('throws when the payload has no title (nothing to pin)', async () => {
    const { deps } = makeClaimStore();
    await expect(
      runExecutor(
        { familyId, approved: approvedInternal('add_to_routine', { summary: 'x' }) },
        deps,
      ),
    ).rejects.toThrow(/missing required field \(title\)/);
    expect(deps.addToRoutine).not.toHaveBeenCalled();
  });
});

describe('runExecutor — add_to_digest_only flags the digest note', () => {
  it('calls addToDigest with the accepted item and returns the outcome', async () => {
    const { deps } = makeClaimStore();
    const result = await runExecutor(
      { familyId, approved: approvedInternal('add_to_digest_only') },
      deps,
    );

    expect(deps.addToDigest).toHaveBeenCalledWith({
      familyId,
      actionId,
      eventId: '33333333-3333-4333-8333-333333333333',
      title: 'Baby & Me Yoga',
      notes: 'Tuesdays 10am',
    });
    expect(deps.addToRoutine).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, detail: { kind: 'digest_note', outcome: 'written' } });
  });

  it('throws when the write fails — never a false ok (rule #8)', async () => {
    const { deps } = makeClaimStore();
    deps.addToDigest = vi.fn(async () => {
      throw new Error('family_plans insert failed');
    });
    await expect(
      runExecutor({ familyId, approved: approvedInternal('add_to_digest_only') }, deps),
    ).rejects.toThrow('family_plans insert failed');
  });
});

function approvedCalendar(
  actionType: 'create_calendar_event' | 'update_calendar_event',
  payload: Record<string, unknown> = {
    title: 'Checkup',
    starts_at: '2026-07-10T14:00:00Z',
    ends_at: '2026-07-10T14:30:00Z',
  },
): ApprovedAction {
  return mintApprovedAction(
    {
      id: actionId,
      eventId: '33333333-3333-4333-8333-333333333333',
      familyId,
      actionType,
      payload,
      draftConfidence: 0.95,
      rationale: 'calendar',
      recipientVisibility: 'internal_only',
      draftedAt: '2026-06-12T10:00:00.000Z',
    },
    {
      kind: 'approve',
      rationale: 'checks green',
      toolResults: [
        { tool: 'check_action_time_window', ok: true, result: {} },
        { tool: 'check_action_idempotency', ok: true, result: {} },
      ],
    },
    () => true,
  );
}

describe('runExecutor — calendar via the CalendarClient interface', () => {
  it('create_calendar_event calls the injected client createEvent and returns its id', async () => {
    const { deps } = makeClaimStore();
    deps.calendar = {
      createEvent: vi.fn(async () => ({ providerEventId: 'evt-1' })),
      updateEvent: vi.fn(async () => ({ providerEventId: 'unused' })),
    };

    const result = await runExecutor(
      { familyId, approved: approvedCalendar('create_calendar_event') },
      deps,
    );

    expect(deps.calendar.createEvent).toHaveBeenCalledWith({
      familyId,
      title: 'Checkup',
      startsAt: '2026-07-10T14:00:00Z',
      endsAt: '2026-07-10T14:30:00Z',
      description: undefined,
      providerEventId: undefined,
    });
    expect(result).toMatchObject({
      ok: true,
      detail: { kind: 'calendar_created', providerEventId: 'evt-1' },
      reversalHandle: 'evt-1',
    });
  });

  it('the default (real) client throws HALE_NOT_CONFIGURED until OAuth exists', async () => {
    // No deps override → defaultDeps().calendar is the real, unbuilt client.
    await expect(
      runExecutor({ familyId, approved: approvedCalendar('create_calendar_event') }),
    ).rejects.toThrow('HALE_NOT_CONFIGURED: Google Calendar not connected');
  });
});

describe('resendSend — Resend transport', () => {
  beforeEach(() => {
    resendSendMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws HALE_NOT_CONFIGURED when RESEND_API_KEY is absent (fail loud)', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    await expect(resendSend({ to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrow(
      'HALE_NOT_CONFIGURED',
    );
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('sends via Resend and returns the provider message id', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'hello@villagehale.com');
    resendSendMock.mockResolvedValue({ data: { id: 'resend-abc' }, error: null });

    const result = await resendSend({
      to: 'clinic@example.com',
      cc: ['cc@example.com'],
      subject: 'hi',
      body: 'hello',
    });

    expect(result).toEqual({ messageId: 'resend-abc' });
    expect(resendSendMock).toHaveBeenCalledWith({
      from: 'hello@villagehale.com',
      to: 'clinic@example.com',
      cc: ['cc@example.com'],
      subject: 'hi',
      text: 'hello',
    });
  });

  it('throws when Resend returns an error (never silently no-ops)', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    resendSendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'bad sender' },
    });

    await expect(resendSend({ to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrow(
      'Resend send failed (validation_error): bad sender',
    );
  });
});
