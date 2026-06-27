import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { draftInlineAction } from './inline-action';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TODDLER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-06-17T12:00:00Z');

// DOBs derived from the spec stage boundaries: teenager ≥ 156 completed months
// (13y), toddler in [12,48) months. Both chosen against NOW, not the code's output.
const TEEN_DOB = '2010-01-01'; // 16y at NOW → teenager
const TODDLER_DOB = '2024-06-17'; // 24mo at NOW → toddler

interface Capture {
  events: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

/**
 * Fakes the Drizzle chains draftInlineAction touches:
 *   select(children).from().where() → child rows (DOB lookup for teen flag)
 *   insert(events).values().onConflictDoNothing().returning() → [{id}]
 *   insert(actions).values().onConflictDoNothing().returning() → [{id}]
 *   insert(auditLog).values() → void
 * Routed by table identity. No real DB.
 */
function fakeDb(capture: Capture, children: { id: string; dateOfBirth: string }[] = []) {
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: async () => children.map((c) => ({ dateOfBirth: c.dateOfBirth })),
    }),
  }));
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.events) {
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              capture.events.push(row);
              return [{ id: 'event-1' }];
            },
          }),
        }),
      };
    }
    if (table === schema.actions) {
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              capture.actions.push(row);
              return [{ id: 'action-1' }];
            },
          }),
        }),
      };
    }
    if (table === schema.auditLog) {
      return {
        values: async (row: Record<string, unknown>) => {
          capture.audit.push(row);
        },
      };
    }
    throw new Error('unexpected insert target');
  });
  return { select, insert } as never;
}

describe('draftInlineAction', () => {
  it('creates an action_draft (NOT an execution) held for approval, with an audit row (rules #4, #6)', async () => {
    const capture: Capture = { events: [], actions: [], audit: [] };
    const db = fakeDb(capture);

    const result = await draftInlineAction(
      {
        familyId: FAMILY_ID,
        actor: ACTOR,
        intentKind: 'find_activities',
        childId: null,
        sourceAnswer: 'want me to find activities near you?',
      },
      db,
      NOW,
    );

    expect(result.actionId).toBe('action-1');

    // Rule #4: the action is held at drafted_for_approval — never executed inline.
    expect(capture.actions).toHaveLength(1);
    const action = capture.actions[0] as Record<string, unknown>;
    expect(action.familyId).toBe(FAMILY_ID);
    expect(action.actionType).toBe('add_to_digest_only');
    expect(action.userVisibleState).toBe('drafted_for_approval');
    expect(action.executedAt).toBeUndefined();

    // The synthetic event records WHO asked (the acting parent) and stays scoped.
    expect(capture.events).toHaveLength(1);
    const event = capture.events[0] as Record<string, unknown>;
    expect(event.familyId).toBe(FAMILY_ID);
    expect(event.source).toBe('ask_hale');

    // Rule #6: one immutable audit row, attributed to the acting parent.
    expect(capture.audit).toHaveLength(1);
    const audit = capture.audit[0] as Record<string, unknown>;
    expect(audit.familyId).toBe(FAMILY_ID);
    expect(audit.actor).toBe(ACTOR);
    expect(audit.actionTaken).toBe('ask_hale.action_drafted');
    expect(audit.targetId).toBe('action-1');
  });

  it('rejects an unknown intent kind rather than drafting an arbitrary action type', async () => {
    const capture: Capture = { events: [], actions: [], audit: [] };
    const db = fakeDb(capture);

    await expect(
      draftInlineAction(
        { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'wire_money', childId: null, sourceAnswer: 'x' },
        db,
        NOW,
      ),
    ).rejects.toThrow(/unknown intent/i);

    expect(capture.actions).toEqual([]);
    expect(capture.audit).toEqual([]);
  });

  it("flags the synthetic event teen_content when the focused child is 13+ (rule #1)", async () => {
    const capture: Capture = { events: [], actions: [], audit: [] };
    const db = fakeDb(capture, [{ id: TEEN_ID, dateOfBirth: TEEN_DOB }]);

    await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'find_activities', childId: TEEN_ID, sourceAnswer: 'x' },
      db,
      NOW,
    );

    expect(capture.events).toHaveLength(1);
    expect((capture.events[0] as Record<string, unknown>).teenContent).toBe(true);
  });

  it('leaves teen_content false for a non-teen focused child', async () => {
    const capture: Capture = { events: [], actions: [], audit: [] };
    const db = fakeDb(capture, [{ id: TODDLER_ID, dateOfBirth: TODDLER_DOB }]);

    await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'find_activities', childId: TODDLER_ID, sourceAnswer: 'x' },
      db,
      NOW,
    );

    expect(capture.events).toHaveLength(1);
    expect((capture.events[0] as Record<string, unknown>).teenContent).toBe(false);
  });

  it('leaves teen_content false for a family-wide draft (null child)', async () => {
    const capture: Capture = { events: [], actions: [], audit: [] };
    const db = fakeDb(capture);

    await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'find_activities', childId: null, sourceAnswer: 'x' },
      db,
      NOW,
    );

    expect(capture.events).toHaveLength(1);
    expect((capture.events[0] as Record<string, unknown>).teenContent).toBe(false);
  });
});
