import type Anthropic from '@anthropic-ai/sdk';
import type { DraftedAction } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReviewer } from '../agents/reviewer.js';
import { type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import { invokeReviewerTool } from './registry.js';

/**
 * The instant the reviewer injects, judged by the REAL door rather than by an
 * assertion on the value. reviewer.test.ts pins WHAT is injected; only this test
 * says whether that instant survives `check_action_time_window` reading the
 * family's own clock — the two can drift, and the first version of this injection
 * passed a value-level test while refusing every draft it was written for.
 *
 * The shape under test is the live Sunday loop's: mint-placements stamps a weekly
 * placement's startsAt at 00:00 family-local (zonedDayStartInstant) and drafts it
 * at the parent's weekly_plan_send_time. A verdict of flag_for_human here is not
 * cosmetic — approve.ts refuses the parent's approval of a flagged draft on both
 * the web button and the SMS YES arc, so the placement can never be accepted.
 */

/** Monday 2026-07-13, 00:00 America/Toronto (EDT, UTC-4) — the encoded all-day stamp. */
const PLACEMENT_LOCAL_MIDNIGHT = '2026-07-13T04:00:00.000Z';
/** Sunday 2026-07-12, 08:00 America/Toronto — the loop's default send time. */
const DRAFTED_AT_SEND_TIME = '2026-07-12T12:00:00.000Z';

describe('check_action_time_window — the acting instant clears the family clock', () => {
  let db: TestDb;
  let familyId: string;

  // Booted in a hook, not the test body: pglite boot + migrations exceed the 5s test
  // timeout, and hooks carry their own budget.
  beforeEach(async () => {
    db = await createTestDb();
    ({ familyId } = await seedFamily(db.database));
  }, 120_000);

  afterEach(async () => {
    await db.close();
  });

  function placementDraft(draftedAt: string): DraftedAction {
    return {
      id: '88888888-8888-4888-8888-888888888888',
      eventId: '99999999-9999-4999-8999-999999999999',
      familyId,
      actionType: 'calendar_add',
      payload: {
        title: 'Swim class',
        startsAt: PLACEMENT_LOCAL_MIDNIGHT,
        endsAt: null,
        action_hash: 'weekly-placement-hash',
      },
      draftConfidence: 1,
      rationale: 'Weekly plan placement',
      recipientVisibility: 'internal_only',
      draftedAt,
    };
  }

  /** The model calls every required check with no args and then approves; the args
   * come from the reviewer's injection and the results from the REAL door. */
  function approvingClient(): { messages: { create: () => Promise<Anthropic.Message> } } {
    const turns: Anthropic.ContentBlock[][] = [
      [
        { type: 'tool_use', id: 'tu_0', name: 'check_action_time_window', input: {} },
        { type: 'tool_use', id: 'tu_1', name: 'check_action_idempotency', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'check_calendar_conflict', input: {} },
      ] as Anthropic.ContentBlock[],
      [
        {
          type: 'tool_use',
          id: 'tu_3',
          name: 'submit_verdict',
          input: { verdict: 'approve', rationale: 'placement is clear' },
        },
      ] as Anthropic.ContentBlock[],
    ];
    let turn = 0;
    return {
      messages: {
        create: async () => ({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
          content: turns[turn++] ?? [],
        }),
      },
    } as unknown as { messages: { create: () => Promise<Anthropic.Message> } };
  }

  async function review(draftedAt: string) {
    return runReviewer(
      { familyId, draft: placementDraft(draftedAt) },
      {
        client: approvingClient() as never,
        invokeTool: (name, input) => invokeReviewerTool(name, input, db.database),
        loadChildNames: async () => [],
      },
    );
  }

  it('approves a weekly placement drafted inside the window, all-day stamp and all', async () => {
    // Kills: injecting the payload's startsAt. That instant is 00:00 in the family's
    // own timezone, so the door answers observedHour 0 / ok:false and the coverage
    // fold downgrades approve to flag_for_human — every Sunday-loop placement.
    const { verdict } = await review(DRAFTED_AT_SEND_TIME);

    expect(verdict.kind).toBe('approve');
    const window = verdict.toolResults.find((r) => r.tool === 'check_action_time_window');
    expect(window?.ok).toBe(true);
    expect(window?.result).toMatchObject({ withinWindow: true, observedHour: 8 });
  });

  it('holds the window’s own edges: 06:00 is inside, 22:00 is not', async () => {
    // Kills: relaxing either end of registry.ts's `hour >= openHour && hour < closeHour`.
    // The two cases around this one clear the window by four hours in each direction, so
    // an off-by-one at the boundary reads green everywhere else — and 22:00 is precisely
    // the hour allowActionsBetween exists to refuse.
    const open = await review('2026-07-12T10:00:00.000Z'); // 06:00 America/Toronto
    const openWindow = open.verdict.toolResults.find((r) => r.tool === 'check_action_time_window');
    expect(openWindow?.ok).toBe(true);
    expect(openWindow?.result).toMatchObject({ withinWindow: true, observedHour: 6 });

    const close = await review('2026-07-13T02:00:00.000Z'); // 22:00 America/Toronto
    const closeWindow = close.verdict.toolResults.find(
      (r) => r.tool === 'check_action_time_window',
    );
    expect(closeWindow?.ok).toBe(false);
    expect(closeWindow?.result).toMatchObject({ withinWindow: false, observedHour: 22 });
  });

  it('still flags a draft acted on inside quiet hours — the check did not go blind', async () => {
    // Positive control for the assertion above: an absence test that cannot fail is
    // worthless. 03:00 America/Toronto is outside allowActionsBetween ['06:00','22:00'].
    const { verdict } = await review('2026-07-12T07:00:00.000Z');

    expect(verdict.kind).toBe('flag_for_human');
    const window = verdict.toolResults.find((r) => r.tool === 'check_action_time_window');
    expect(window?.ok).toBe(false);
    expect(window?.result).toMatchObject({ withinWindow: false, observedHour: 3 });
  });
});
