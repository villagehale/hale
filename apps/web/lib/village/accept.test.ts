import { describe, expect, it, vi } from 'vitest';
import { type AcceptQueue, acceptVillageCandidate } from './accept.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';

interface CandidateRow {
  id: string;
  familyId: string;
  title: string;
  kind: string;
  summary: string;
  sourceUrl: string | null;
  coverageNote: string | null;
}

/** Fakes the single select(...).from(...).where(...).limit(1) chain the
 * precondition lookup runs. Returns whatever `rows` is given — no real db. */
function fakeDb(rows: CandidateRow[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as never;
}

function fakeQueue(): AcceptQueue & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue('job-1') };
}

function candidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: CANDIDATE_ID,
    familyId: FAMILY_ID,
    title: 'Infant swim drop-in',
    kind: 'drop_in',
    summary: 'Saturday parent-and-baby swim at the community centre.',
    sourceUrl: 'https://example.org/swim',
    coverageNote: 'serves your area',
    ...overrides,
  };
}

describe('acceptVillageCandidate', () => {
  it('enqueues events.ingested as activity_signup_open carrying the activity, returns 202', async () => {
    const db = fakeDb([candidate()]);
    const queue = fakeQueue();

    const result = await acceptVillageCandidate(db, queue, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
    });

    expect(result.status).toBe(202);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(
      'events.ingested',
      expect.objectContaining({
        family_id: FAMILY_ID,
        source: 'village',
        received_at: expect.any(String),
        payload: expect.objectContaining({
          event_type: 'activity_signup_open',
          candidate_id: CANDIDATE_ID,
          title: 'Infant swim drop-in',
          kind: 'drop_in',
          summary: 'Saturday parent-and-baby swim at the community centre.',
          source_url: 'https://example.org/swim',
          coverage_note: 'serves your area',
        }),
      }),
    );
    const payload = queue.send.mock.calls[0]?.[1];
    expect(Number.isNaN(Date.parse(payload?.received_at ?? ''))).toBe(false);
  });

  it('returns 403 and does NOT enqueue when the candidate belongs to another family', async () => {
    const db = fakeDb([candidate({ familyId: OTHER_FAMILY })]);
    const queue = fakeQueue();

    const result = await acceptVillageCandidate(db, queue, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
    });

    expect(result.status).toBe(403);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('returns 404 and does NOT enqueue when no candidate matches the id', async () => {
    const db = fakeDb([]);
    const queue = fakeQueue();

    const result = await acceptVillageCandidate(db, queue, {
      candidateId: CANDIDATE_ID,
      familyId: FAMILY_ID,
    });

    expect(result.status).toBe(404);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
