import { describe, expect, it, vi } from 'vitest';
import { handleApprovedAction, handleIngestedEvent } from './index.js';

// Built by hand from the events.ingested contract (IngestedEventPayload) and
// the literal the web route constructs — not from a live queue.
const validData = {
  family_id: '11111111-1111-4111-8111-111111111111',
  source: 'gmail',
  payload: { messageId: 'abc' },
  received_at: '2026-06-12T10:00:00.000Z',
};

function makeDeps() {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    log: { debug: vi.fn(), error: vi.fn() },
  };
}

describe('handleIngestedEvent', () => {
  it('dispatches a contract-valid payload to the orchestrator', async () => {
    const deps = makeDeps();
    await handleIngestedEvent('job-1', validData, deps);

    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.run).toHaveBeenCalledWith(validData);
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it('drops a malformed payload via the error log instead of dispatching', async () => {
    const deps = makeDeps();
    const { family_id, ...malformed } = validData;

    await handleIngestedEvent('job-2', malformed, deps);

    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledTimes(1);
    const [meta, message] = deps.log.error.mock.calls[0] ?? [];
    expect(meta).toMatchObject({ jobId: 'job-2' });
    expect(message).toContain('contract validation');
  });
});

// Built by hand from the actions.approved contract (ApprovedActionPayload) and
// the literal the web approve route constructs.
const validApproved = {
  action_id: '22222222-2222-4222-8222-222222222222',
  family_id: '11111111-1111-4111-8111-111111111111',
  approved_by: 'parent-a',
  approved_at: '2026-06-12T10:00:00.000Z',
};

describe('handleApprovedAction', () => {
  it('dispatches a contract-valid payload to executeApprovedAction (snake_case → camelCase)', async () => {
    const deps = makeDeps();
    await handleApprovedAction('job-1', validApproved, deps);

    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.run).toHaveBeenCalledWith({
      actionId: validApproved.action_id,
      familyId: validApproved.family_id,
      approvedBy: validApproved.approved_by,
    });
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it('drops a malformed payload via the error log instead of dispatching', async () => {
    const deps = makeDeps();
    const { action_id, ...malformed } = validApproved;

    await handleApprovedAction('job-2', malformed, deps);

    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledTimes(1);
    const [meta, message] = deps.log.error.mock.calls[0] ?? [];
    expect(meta).toMatchObject({ jobId: 'job-2' });
    expect(message).toContain('contract validation');
  });
});
