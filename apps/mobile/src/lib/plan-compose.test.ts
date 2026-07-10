import { describe, expect, it } from 'vitest';
import { composeCreatePlan } from './plan-compose';

describe('composeCreatePlan — native AddPlan transform', () => {
  it('rejects an empty / whitespace-only title', () => {
    expect(composeCreatePlan({ title: '   ', notes: '', scheduledFor: '', childId: null })).toEqual({
      ok: false,
      error: 'title_required',
    });
  });

  it('trims the title and builds an undated, family-wide, note-less create body', () => {
    const result = composeCreatePlan({
      title: '  swim registration  ',
      notes: '   ',
      scheduledFor: '',
      childId: null,
    });
    expect(result).toEqual({
      ok: true,
      body: {
        action: 'create',
        title: 'swim registration',
        notes: null,
        scheduledFor: null,
        childId: null,
      },
    });
  });

  it('encodes the picked date at UTC-midnight and keeps trimmed notes + child scope', () => {
    const result = composeCreatePlan({
      title: 'dentist',
      notes: '  ask about sealants ',
      scheduledFor: '2026-07-10',
      childId: 'child-1',
    });
    expect(result).toEqual({
      ok: true,
      body: {
        action: 'create',
        title: 'dentist',
        notes: 'ask about sealants',
        scheduledFor: '2026-07-10T00:00:00.000Z',
        childId: 'child-1',
      },
    });
  });

  it('reports date_invalid for an unparseable date string', () => {
    expect(
      composeCreatePlan({ title: 'x', notes: '', scheduledFor: 'not-a-date', childId: null }),
    ).toEqual({ ok: false, error: 'date_invalid' });
  });
});
