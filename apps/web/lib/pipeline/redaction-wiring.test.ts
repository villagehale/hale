import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { dedupHashFor } from './record';
import { ingestEvent } from './ingest';

/**
 * Rule #1 at the ingest boundary (web pipeline). Connector/inbound PII must be
 * redacted BEFORE it reaches the classifier — a child's name in the payload is a
 * PLACEHOLDER in the model input. The dedup hash is computed on the UN-redacted
 * original so a signal that arrives twice still dedups (redaction must not shift
 * the content key). End-to-end control-flow over a fake Anthropic client + fake db.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_NAME = 'Maya';
const NOW = new Date('2026-06-21T12:00:00Z');
const NEWBORN_DOB = '2026-02-01';

interface Capture {
  events: Record<string, unknown>[];
  /** The raw_content the model actually saw, extracted from the classify turn. */
  modelRawContent: string | null;
}

function fakeDb(capture: Capture) {
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
      // The child-names read for redaction (id + name).
      if (keys.includes('id') && keys.includes('name')) {
        return [{ id: CHILD_ID, name: CHILD_NAME }];
      }
      // resolveFamilyChild reads the children row (id + dateOfBirth).
      if (keys.includes('id') && keys.includes('dateOfBirth')) {
        return [{ id: CHILD_ID, dateOfBirth: NEWBORN_DOB }];
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

/** A classifier turn that routes surface_only. Captures the raw_content the model
 * saw from the user message of the first (classify) create call. */
function scriptedClient(capture: Capture): AgentClient {
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };
  let call = 0;
  const create = vi.fn().mockImplementation(async (args: { messages: { content: string }[] }) => {
    call += 1;
    if (call === 1) {
      const userMessage = args.messages[0]?.content ?? '';
      const parsed = JSON.parse(userMessage) as { signal?: { raw_content?: string } };
      capture.modelRawContent = parsed.signal?.raw_content ?? null;
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
              payload: { body: `${CHILD_NAME} note` },
              suggested_action: { kind: 'surface_only' },
              teen_content: false,
              concerns_child_id: null,
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
  body: `${CHILD_NAME} was picked up at 4pm`,
};

describe('ingestEvent — redaction at the ingest boundary (rule #1)', () => {
  it('redacts the child name in what the classifier receives', async () => {
    const capture: Capture = { events: [], modelRawContent: null };
    const db = fakeDb(capture);
    await ingestEvent(baseInput, db, scriptedClient(capture), NOW);

    expect(capture.modelRawContent).not.toBeNull();
    expect(capture.modelRawContent).not.toContain(CHILD_NAME);
    expect(capture.modelRawContent).toContain('[CHILD]');
  });

  it('computes the dedup hash on the UN-redacted original content', async () => {
    const capture: Capture = { events: [], modelRawContent: null };
    const db = fakeDb(capture);
    await ingestEvent(baseInput, db, scriptedClient(capture), NOW);

    const originalRaw = JSON.stringify({ subject: baseInput.subject, body: baseInput.body });
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]?.dedupHash).toBe(dedupHashFor(FAMILY_ID, baseInput.source, originalRaw));
    // Sanity: the redacted content hashes differently — the stored key is NOT
    // derived from what the classifier saw.
    expect(capture.events[0]?.dedupHash).not.toBe(
      dedupHashFor(FAMILY_ID, baseInput.source, capture.modelRawContent ?? ''),
    );
  });
});
