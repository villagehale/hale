import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { classifyChildEventEmail } from './pipeline';
import type { FamilyChildRef, InboxEnvelope } from './types';

/**
 * Pipeline control-flow + the rule-#1 teen-content backstop, end-to-end over a
 * fake Anthropic client (rule #8 — the REAL skills load from disk, only the
 * model responses are scripted). Mirrors apps/web/lib/pipeline's
 * teen-content-backstop.test.ts pattern: prove the deterministic write-site
 * logic, not model quality (that's the eval suite's job).
 */

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };

interface TriageInput {
  child_related: boolean;
  confidence: number;
  rationale: string;
}
interface ExtractionInput {
  kind: string;
  event: { title: string; child_ref?: string | null; original_time?: string | null; new_time?: string | null; location?: string | null };
  source_confidence: number;
  quote_evidence: string;
  teen_content?: boolean;
}

function scriptedClient(triage: TriageInput, extraction?: ExtractionInput): AgentClient {
  const create = vi.fn().mockImplementation(async (params: { tools?: Array<{ name: string }> }) => {
    const toolName = params.tools?.[0]?.name;
    if (toolName === 'triage') {
      return { content: [{ type: 'tool_use', id: 't1', name: 'triage', input: triage }], usage };
    }
    if (toolName === 'extraction') {
      if (!extraction) throw new Error('unexpected extraction call — triage should have short-circuited');
      return { content: [{ type: 'tool_use', id: 'e1', name: 'extraction', input: extraction }], usage };
    }
    throw new Error(`unexpected tool ${String(toolName)}`);
  });
  return { messages: { create } } as unknown as AgentClient;
}

const ENVELOPE: InboxEnvelope = {
  familyId: 'family-1',
  messageId: 'msg-1',
  subject: 'Swim class update',
  from: 'daycare@example.com',
  snippet: "Leo's swim class is cancelled Saturday",
  receivedAt: '2026-07-20T12:00:00Z',
};

const TEEN_CHILD: FamilyChildRef = { id: 'child-teen', name: 'Maya', ageInMonths: 168 };
const YOUNG_CHILD: FamilyChildRef = { id: 'child-young', name: 'Leo', ageInMonths: 60 };

describe('classifyChildEventEmail — routing', () => {
  it('short-circuits on a triage-negative envelope without fetching the body', async () => {
    const fetchBody = vi.fn();
    const client = scriptedClient({ child_related: false, confidence: 0.9, rationale: 'newsletter' });

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [YOUNG_CHILD],
      fetchBody,
      correlationCandidates: [],
    });

    expect(result.status).toBe('triaged_out');
    expect(result.extraction).toBeNull();
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('fetches the body and extracts on a triage-positive envelope', async () => {
    const fetchBody = vi.fn().mockResolvedValue('Swim class is cancelled this Saturday at 2pm.');
    const client = scriptedClient(
      { child_related: true, confidence: 0.9, rationale: 'cancellation notice' },
      {
        kind: 'cancellation',
        event: { title: 'Swim class', original_time: '2026-07-25T14:00:00Z', new_time: null, location: null, child_ref: null },
        source_confidence: 0.9,
        quote_evidence: 'Swim class is cancelled this Saturday at 2pm.',
        teen_content: false,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [YOUNG_CHILD],
      fetchBody,
      correlationCandidates: [],
    });

    expect(fetchBody).toHaveBeenCalledWith('msg-1');
    expect(result.status).toBe('classified');
    expect(result.extraction?.kind).toBe('cancellation');
    expect(result.extraction?.teenContent).toBe(false);
    expect(result.extraction?.quoteEvidence).toBe('Swim class is cancelled this Saturday at 2pm.');
  });

  it('wires the correlation candidates through to a matched_event_ref', async () => {
    const fetchBody = vi.fn().mockResolvedValue('body');
    const client = scriptedClient(
      { child_related: true, confidence: 0.9, rationale: 'x' },
      {
        kind: 'cancellation',
        event: { title: 'Swim lessons', original_time: '2026-08-01T14:00:00Z', new_time: null, location: null, child_ref: null },
        source_confidence: 0.9,
        quote_evidence: 'quote',
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [YOUNG_CHILD],
      fetchBody,
      correlationCandidates: [
        { ref: { table: 'family_events', id: 'fe-9' }, title: 'Swim lessons', startsAt: '2026-08-01T14:00:00Z' },
      ],
    });

    expect(result.extraction?.matchedEventRef).toEqual({ table: 'family_events', id: 'fe-9' });
  });
});

describe('classifyChildEventEmail — teen-content backstop (rule #1)', () => {
  it('keeps the LLM teen_content=true verbatim', async () => {
    const client = scriptedClient(
      { child_related: true, confidence: 0.9, rationale: 'x' },
      {
        kind: 'reminder_only',
        event: { title: "Maya's counselling session", child_ref: TEEN_CHILD.id, original_time: '2026-07-25T14:00:00Z' },
        source_confidence: 0.9,
        quote_evidence: 'Maya mentioned feeling anxious about the session.',
        teen_content: true,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [TEEN_CHILD],
      fetchBody: vi.fn().mockResolvedValue('body'),
      correlationCandidates: [],
    });

    expect(result.extraction?.teenContent).toBe(true);
    expect(result.extraction?.quoteEvidence).toBeNull();
    expect(result.extraction?.event.title).not.toContain('Maya');
  });

  it('forces teenContent=true when the extraction is unclear and attributed to a teen (LLM missed it)', async () => {
    const client = scriptedClient(
      { child_related: true, confidence: 0.8, rationale: 'x' },
      {
        kind: 'unclear',
        event: { title: 'About Maya', child_ref: TEEN_CHILD.id },
        source_confidence: 0.9,
        quote_evidence: 'something about Maya',
        teen_content: false,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [TEEN_CHILD],
      fetchBody: vi.fn().mockResolvedValue('body'),
      correlationCandidates: [],
    });

    expect(result.extraction?.teenContent).toBe(true);
  });

  it('forces teenContent=true when the extraction is low-confidence and attributed to a teen (LLM missed it)', async () => {
    const client = scriptedClient(
      { child_related: true, confidence: 0.8, rationale: 'x' },
      {
        kind: 'cancellation',
        event: { title: "Maya's class", child_ref: TEEN_CHILD.id, original_time: '2026-07-25T14:00:00Z' },
        source_confidence: 0.5,
        quote_evidence: 'quote',
        teen_content: false,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [TEEN_CHILD],
      fetchBody: vi.fn().mockResolvedValue('body'),
      correlationCandidates: [],
    });

    expect(result.extraction?.teenContent).toBe(true);
  });

  it('does NOT force teenContent for a confident, clearly-logistics extraction about a teen (school/logistics carve-out)', async () => {
    const client = scriptedClient(
      { child_related: true, confidence: 0.9, rationale: 'x' },
      {
        kind: 'cancellation',
        event: { title: "Maya's swim class", child_ref: TEEN_CHILD.id, original_time: '2026-07-25T14:00:00Z' },
        source_confidence: 0.95,
        quote_evidence: 'Swim class cancelled Saturday due to pool maintenance.',
        teen_content: false,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [TEEN_CHILD],
      fetchBody: vi.fn().mockResolvedValue('body'),
      correlationCandidates: [],
    });

    expect(result.extraction?.teenContent).toBe(false);
    expect(result.extraction?.quoteEvidence).toBe('Swim class cancelled Saturday due to pool maintenance.');
  });

  it('never forces teenContent for a non-teen child_ref', async () => {
    const client = scriptedClient(
      { child_related: true, confidence: 0.9, rationale: 'x' },
      {
        kind: 'unclear',
        event: { title: 'About Leo', child_ref: YOUNG_CHILD.id },
        source_confidence: 0.4,
        quote_evidence: 'quote',
        teen_content: false,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [YOUNG_CHILD],
      fetchBody: vi.fn().mockResolvedValue('body'),
      correlationCandidates: [],
    });

    expect(result.extraction?.teenContent).toBe(false);
  });

  it('never forces teenContent when child_ref is null', async () => {
    const client = scriptedClient(
      { child_related: true, confidence: 0.9, rationale: 'x' },
      {
        kind: 'unclear',
        event: { title: 'A family note', child_ref: null },
        source_confidence: 0.3,
        quote_evidence: 'quote',
        teen_content: false,
      },
    );

    const result = await classifyChildEventEmail(ENVELOPE, {
      client,
      children: [TEEN_CHILD],
      fetchBody: vi.fn().mockResolvedValue('body'),
      correlationCandidates: [],
    });

    expect(result.extraction?.teenContent).toBe(false);
  });
});
