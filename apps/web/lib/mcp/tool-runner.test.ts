import { describe, expect, it, vi } from 'vitest';
import { type McpGrantContext, type McpToolDeps, invokeMcpTool } from './tool-runner';

const GRANT: McpGrantContext = {
  grantId: 'grant-1',
  familyId: 'family-1',
  userId: 'user-1',
  clientId: 'client-1',
  clientName: 'Example assistant',
  scopes: ['week_plan.read', 'events.read', 'village.read', 'actions.propose'],
};

function deps(): McpToolDeps {
  return {
    getWeekPlan: vi.fn().mockResolvedValue({ weekStart: '2026-07-20', items: [] }),
    getUpcomingEvents: vi.fn().mockResolvedValue([
      {
        id: 'event-1',
        title: 'A private calendar item',
        startsAt: '2026-07-25T14:00:00.000Z',
        endsAt: null,
        location: null,
      },
    ]),
    getVillagePicks: vi.fn().mockResolvedValue([
      {
        id: 'pick-1',
        title: 'Private activity for your teen',
        kind: 'activity',
        summary: '',
        teenAttributed: true,
      },
    ]),
    proposeAction: vi.fn().mockResolvedValue({
      actionId: 'action-1',
      status: 'drafted_for_approval',
    }),
    rateLimited: vi.fn().mockResolvedValue(false),
    audit: vi.fn().mockResolvedValue(undefined),
  };
}

describe('invokeMcpTool', () => {
  it('applies the fail-closed per-grant cap before any scope or product work', async () => {
    const d = deps();
    vi.mocked(d.rateLimited).mockResolvedValue(true);
    const result = await invokeMcpTool('get_week_plan', {}, GRANT, d);

    expect(result.isError).toBe(true);
    expect(d.rateLimited).toHaveBeenCalledWith(GRANT.grantId);
    expect(d.getWeekPlan).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'get_week_plan', outcome: 'rate_limited' }),
    );
  });

  it('fails closed before a loader when the grant lacks the exact tool scope and audits the refusal', async () => {
    const d = deps();
    const result = await invokeMcpTool(
      'get_week_plan',
      {},
      { ...GRANT, scopes: ['events.read'] },
      d,
    );

    expect(result.isError).toBe(true);
    expect(d.getWeekPlan).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: GRANT.familyId,
        grantId: GRANT.grantId,
        tool: 'get_week_plan',
        outcome: 'denied_scope',
      }),
    );
  });

  it('returns only the teen-safe event projection and audits without copying content', async () => {
    const d = deps();
    const result = await invokeMcpTool('get_upcoming_events', { days: 14 }, GRANT, d);

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      events: Array<{ title: string; location: string | null }>;
    };
    expect(parsed.events[0]).toEqual(
      expect.objectContaining({ title: 'A private calendar item', location: null }),
    );
    expect(d.audit).toHaveBeenCalledWith({
      familyId: GRANT.familyId,
      userId: GRANT.userId,
      grantId: GRANT.grantId,
      clientId: GRANT.clientId,
      tool: 'get_upcoming_events',
      scope: 'events.read',
      outcome: 'success',
    });
    expect(JSON.stringify(vi.mocked(d.audit).mock.calls)).not.toContain('A private calendar item');
  });

  it('routes the only write to a held proposal and says parent approval is still required', async () => {
    const d = deps();
    const result = await invokeMcpTool(
      'propose_action',
      {
        intentKind: 'set_reminder',
        rationale: 'Remind the family about the appointment.',
      },
      GRANT,
      d,
    );

    expect(d.proposeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: GRANT.familyId,
        actor: GRANT.userId,
        intentKind: 'set_reminder',
      }),
    );
    expect(result.content[0]?.text).toContain('drafted_for_approval');
    expect(result.content[0]?.text).toContain('parent');
  });

  it('audits invalid tool input and never calls the product write seam', async () => {
    const d = deps();
    const result = await invokeMcpTool(
      'propose_action',
      { intentKind: 'wire_money', rationale: 'x' },
      GRANT,
      d,
    );

    expect(result.isError).toBe(true);
    expect(d.proposeAction).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'propose_action', outcome: 'invalid_input' }),
    );
  });
});
