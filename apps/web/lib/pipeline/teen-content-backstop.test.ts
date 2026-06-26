import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { ingestEvent } from './ingest';

/**
 * Rule #1 write-site backstop (web pipeline). The classifier's teen_content is a
 * probabilistic signal — a classify miss must NOT leak a 13+ child's raw content.
 * events.teen_content is the stored source of truth for the Langfuse mask and the
 * dashboard surfaces, so ingestEvent must persist
 * `classifierFlag OR (resolved concerns-child is a teen by DOB)`.
 *
 * Here the classifier returns teen_content=false (the miss) but attributes the
 * event to a child whose DOB makes them a teenager → the stored flag must come out
 * true. End-to-end control-flow over a fake Anthropic client + a fake db (rule #8).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TEEN_CHILD_ID = '22222222-2222-4222-8222-222222222222';
const NEWBORN_CHILD_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-06-21T12:00:00Z');
// 14 years before NOW → ~168mo → teenager (boundary 156mo). Newborn is months old.
const TEEN_DOB = '2012-01-01';
const NEWBORN_DOB = '2026-02-01';

interface Capture {
  events: Record<string, unknown>[];
}

/**
 * Fake db. The only chain this test cares about is recordEvent's event insert
 * (captured) and resolveFamilyChild's children read (returns the configured child
 * row so the write-site can derive its stage). Everything downstream routes
 * surface_only, so no draft/review chains are exercised.
 */
function fakeDb(capture: Capture, child: { id: string; dateOfBirth: string } | null) {
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.events) {
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              capture.events.push(row);
              return [{ id: `event-${capture.events.length}` }];
            },
          }),
        }),
      };
    }
    if (table === schema.agentRuns) {
      return { values: () => ({ returning: async () => [{ id: 'run-1' }] }) };
    }
    if (table === schema.auditLog) {
      return { values: async () => undefined };
    }
    throw new Error('unexpected insert target');
  });

  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    const rows = (): unknown[] => {
      // resolveFamilyChild reads the children row (id + dateOfBirth).
      if (keys.includes('id') && keys.includes('dateOfBirth')) {
        return child ? [child] : [];
      }
      return [];
    };
    const node = (): Promise<unknown[]> => {
      const r = rows();
      return Object.assign(Promise.resolve(r), {
        limit: () => Promise.resolve(r),
        orderBy: () => node(),
      });
    };
    return { from: () => ({ where: () => node(), limit: () => Promise.resolve(rows()) }) };
  });

  return { insert, select } as never;
}

/** A classifier turn that routes surface_only, attributes the given child, and
 * MISSES the teen flag (teen_content=false). */
function scriptedClient(concernsChildId: string | null): AgentClient {
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };
  let call = 0;
  const create = vi.fn().mockImplementation(async () => {
    call += 1;
    if (call === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'classification',
            input: {
              event_type: 'school_communication',
              confidence: 0.95,
              rationale: 'note about the student',
              payload: { body: 'Maya is struggling in math class' },
              suggested_action: { kind: 'surface_only' },
              teen_content: false,
              concerns_child_id: concernsChildId,
            },
          },
        ],
        usage,
      };
    }
    return { content: [{ type: 'text', text: 'done' }], usage };
  });
  return { messages: { create } } as unknown as AgentClient;
}

const baseInput = {
  familyId: FAMILY_ID,
  source: 'email',
  subject: 'note from school',
  body: 'Maya is struggling in math class',
};

describe('ingestEvent — teen_content write-site backstop (rule #1)', () => {
  it('persists teen_content=true when the concerns-child is a teen by DOB even if the classifier missed it', async () => {
    const capture: Capture = { events: [] };
    const db = fakeDb(capture, { id: TEEN_CHILD_ID, dateOfBirth: TEEN_DOB });
    const outcome = await ingestEvent(baseInput, db, scriptedClient(TEEN_CHILD_ID), NOW);

    expect(outcome.status).toBe('surfaced_only');
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]?.teenContent).toBe(true);
    expect(capture.events[0]?.childId).toBe(TEEN_CHILD_ID);
  });

  it('leaves teen_content=false when the concerns-child is not a teen', async () => {
    const capture: Capture = { events: [] };
    const db = fakeDb(capture, { id: NEWBORN_CHILD_ID, dateOfBirth: NEWBORN_DOB });
    const outcome = await ingestEvent(baseInput, db, scriptedClient(NEWBORN_CHILD_ID), NOW);

    expect(outcome.status).toBe('surfaced_only');
    expect(capture.events[0]?.teenContent).toBe(false);
  });

  it('leaves teen_content=false when the event is not attributed to any child', async () => {
    const capture: Capture = { events: [] };
    const db = fakeDb(capture, null);
    const outcome = await ingestEvent(baseInput, db, scriptedClient(null), NOW);

    expect(outcome.status).toBe('surfaced_only');
    expect(capture.events[0]?.teenContent).toBe(false);
  });
});
