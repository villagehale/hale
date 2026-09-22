import { describe, expect, it } from 'vitest';
import { renderMemoryBrief } from './brief';
import { resolveDigestMode } from './digest';
import { aliasesForFactKey, expandTokens, scoreFact, tokenize } from './lexicon';
import { digestWindows, previousLocalDay, zonedMidnight } from './period';

describe('memory lexicon', () => {
  it('expands daycare to childcare and not to an unrelated token', () => {
    const expanded = expandTokens(tokenize('my daycare'));
    expect(expanded.has('childcare')).toBe(true);
    expect(expanded.has('provider')).toBe(true);
    expect(expanded.has('pasta')).toBe(false);
    expect(tokenize('my daycare')).toEqual(['daycare']);
  });

  it('stores lexicon aliases for a key and never for a value', () => {
    const aliases = aliasesForFactKey('childcare_pickup').map((alias) => alias.aliasNorm);
    expect(aliases).toContain('daycare');
    expect(aliases).toContain('pickup');
    expect(aliasesForFactKey('centre').map((alias) => alias.aliasNorm)).toEqual(['centre']);
  });

  it('does not score a typo', () => {
    const expanded = expandTokens(tokenize('pazta'));
    expect(
      scoreFact(expanded, {
        factKey: 'pasta',
        factValue: 'loves pasta',
        confidence: 1,
        validFrom: new Date('2026-09-15T00:00:00Z'),
        validUntil: null,
        aliasHit: false,
      }),
    ).toBeNull();
  });
});

describe('memory periods', () => {
  it('uses the previous local day in America/Toronto', () => {
    const now = new Date('2026-09-22T06:48:00Z');
    expect(previousLocalDay(now, 'America/Toronto')).toBe('2026-09-21');
    const windows = digestWindows(new Date('2026-09-23T06:48:00Z'), 'America/Toronto');
    expect(windows.day.periodStart).toBe('2026-09-22');
    expect(windows.week.periodStart).toBe('2026-09-21');
    expect(windows.day.start.toISOString()).toBe('2026-09-22T04:00:00.000Z');
    expect(windows.week.start.toISOString()).toBe('2026-09-21T04:00:00.000Z');
  });

  it('places midnight after the autumn clock change in standard time', () => {
    expect(zonedMidnight('2026-11-02', 'America/Toronto').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    );
  });
});

describe('digest flag', () => {
  it('stays observe-only unless the flag is exactly true and an allowlist is set', () => {
    expect(resolveDigestMode({}).apply).toBe(false);
    expect(resolveDigestMode({ MEMORY_DIGEST_APPLY: 'true\n' }).apply).toBe(false);
    expect(resolveDigestMode({ MEMORY_DIGEST_APPLY: 'true' }).apply).toBe(false);
    const armed = resolveDigestMode({
      MEMORY_DIGEST_APPLY: 'true',
      MEMORY_DIGEST_FAMILY_ALLOWLIST: ' fam-1 , fam-2 ',
    });
    expect(armed.apply).toBe(true);
    expect(armed.allowlist.has('fam-1')).toBe(true);
    expect(armed.allowlist.has('fam-2')).toBe(true);
  });
});

describe('memory brief rendering', () => {
  const now = new Date('2026-09-23T06:48:00Z');

  it('puts a stated preference in the brief without a search', () => {
    const brief = renderMemoryBrief({
      now,
      timeZone: 'America/Toronto',
      facts: [
        {
          factType: 'preference',
          factKey: 'dining',
          factValue: 'pasta',
          confidence: 1,
          validFrom: new Date('2026-09-15T00:00:00Z'),
          childId: null,
        },
      ],
      teenChildIds: new Set(),
      workstreams: [],
      dayDigest: null,
      weekDigest: null,
      expectedDay: '2026-09-22',
      expectedWeek: '2026-09-21',
    });
    expect(brief.status).toBe('ok');
    expect(brief.text).toContain('preference:dining=pasta');
    expect(brief.text).toContain('digest=unavailable');
    expect(brief.text.length).toBeLessThanOrEqual(1800);
  });

  it('withholds a teen fact and labels a stale digest', () => {
    const brief = renderMemoryBrief({
      now,
      timeZone: 'America/Toronto',
      facts: [
        {
          factType: 'medical',
          factKey: 'teen_note',
          factValue: 'SECRET_TEEN',
          confidence: 1,
          validFrom: now,
          childId: 'teen-1',
        },
      ],
      teenChildIds: new Set(['teen-1']),
      workstreams: [{ kind: 'first_find', topic: null, dueAt: now }],
      dayDigest: {
        grain: 'day',
        periodStart: '2026-09-01',
        generatedAt: new Date('2026-09-01T00:00:00Z'),
        line: 'day 2026-09-01: inbound 1, outbound 0, open 0.',
      },
      weekDigest: null,
      expectedDay: '2026-09-22',
      expectedWeek: '2026-09-21',
    });
    expect(brief.status).toBe('stale');
    expect(brief.text).not.toContain('SECRET_TEEN');
    expect(brief.text).toContain('digest=stale');
    expect(brief.text).toContain('first_find');
  });
});
