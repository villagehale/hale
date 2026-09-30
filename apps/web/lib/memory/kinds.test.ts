import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_KIND_COPY,
  applyPromotionSignal,
  classifyMemoryWrite,
  deliverMemoryKindCopy,
  familyMemoryKindsCopyLocked,
  familyMemoryKindsEnabled,
  includeInRecommendations,
  isExpiredTemporary,
  memoryKindBodies,
  parseMemoryParentIntent,
  sendMemoryKindReply,
  temporaryExpiry,
  toFamilyMemoryExportFact,
} from './kinds';

const NOW = new Date('2026-09-30T15:00:00.000Z');

describe('family memory kind flag', () => {
  it('is on only for the exact string true', () => {
    expect(familyMemoryKindsEnabled({ FAMILY_MEMORY_KINDS_ENABLED: 'true' })).toBe(true);
    expect(familyMemoryKindsCopyLocked({ FAMILY_MEMORY_KINDS_COPY_LOCKED: 'true' })).toBe(true);
  });

  it('stays off for TRUE, a trailing newline, and unset', () => {
    for (const value of ['TRUE', 'true\n', 'True', '1', 'on', 'yes', '']) {
      expect(familyMemoryKindsEnabled({ FAMILY_MEMORY_KINDS_ENABLED: value })).toBe(false);
      expect(familyMemoryKindsCopyLocked({ FAMILY_MEMORY_KINDS_COPY_LOCKED: value })).toBe(false);
    }
    expect(familyMemoryKindsEnabled({})).toBe(false);
    expect(familyMemoryKindsCopyLocked({})).toBe(false);
  });
});

describe('classifyMemoryWrite', () => {
  it('keeps a first inferred preference as one_off', () => {
    expect(
      classifyMemoryWrite({
        factType: 'preference',
        factKey: 'swimming',
        source: 'inferred',
      }),
    ).toEqual({ kind: 'one_off', source: 'inferred', signalCount: 0, expiresAt: null });
  });

  it('promotes an inferred preference on the second signal', () => {
    expect(
      classifyMemoryWrite({
        factType: 'preference',
        factKey: 'swimming',
        source: 'inferred',
        existing: { kind: 'one_off', source: 'inferred', signalCount: 0 },
        signal: 'repeat_ask',
      }),
    ).toEqual({ kind: 'lasting', source: 'inferred', signalCount: 1, expiresAt: null });
  });

  it('does not promote a parent-stated or lasting-key fact from one inference', () => {
    expect(
      classifyMemoryWrite({
        factType: 'preference',
        factKey: 'swimming',
        source: 'parent_message',
      }).kind,
    ).toBe('lasting');
    expect(
      classifyMemoryWrite({
        factType: 'preference',
        factKey: 'district',
        source: 'inferred',
      }).kind,
    ).toBe('lasting');
  });

  it('types a supplied expiry as temporary and a calendar aside as one_off', () => {
    const expiresAt = temporaryExpiry(NOW, 'week');
    expect(
      classifyMemoryWrite({
        factType: 'logistic',
        factKey: 'pickup',
        source: 'calendar',
        expiresAt,
      }),
    ).toMatchObject({ kind: 'temporary', expiresAt });
    expect(
      classifyMemoryWrite({
        factType: 'preference',
        factKey: 'super_bowl',
        source: 'calendar',
      }).kind,
    ).toBe('one_off');
  });
});

describe('applyPromotionSignal', () => {
  it('promotes only an inferred one_off', () => {
    expect(
      applyPromotionSignal({ kind: 'one_off', source: 'inferred', signalCount: 0 }, 'booking'),
    ).toEqual({ kind: 'lasting', signalCount: 1, promoted: true });
    expect(
      applyPromotionSignal(
        { kind: 'one_off', source: 'inferred', signalCount: 0 },
        'positive_feedback',
      ).promoted,
    ).toBe(true);
    expect(
      applyPromotionSignal({ kind: 'lasting', source: 'parent_message', signalCount: 0 }, 'booking')
        .promoted,
    ).toBe(false);
    expect(
      applyPromotionSignal({ kind: 'one_off', source: 'legacy', signalCount: 0 }, 'repeat_ask')
        .promoted,
    ).toBe(false);
  });
});

describe('temporary expiry', () => {
  it('drops a temporary row at its expiry and keeps a future one', () => {
    expect(isExpiredTemporary({ memoryKind: 'temporary', expiresAt: NOW }, NOW)).toBe(true);
    expect(
      isExpiredTemporary({ memoryKind: 'temporary', expiresAt: new Date(NOW.getTime() + 1000) }, NOW),
    ).toBe(false);
    expect(isExpiredTemporary({ memoryKind: 'temporary', expiresAt: null }, NOW)).toBe(true);
    expect(isExpiredTemporary({ memoryKind: 'lasting', expiresAt: null }, NOW)).toBe(false);
  });

  it('leaves recommendation input unchanged while the flag is off', () => {
    const expired = { memoryKind: 'temporary', expiresAt: new Date(NOW.getTime() - 1000) };
    const aside = { memoryKind: 'one_off', expiresAt: null };
    expect(includeInRecommendations(expired, NOW, false)).toBe(true);
    expect(includeInRecommendations(aside, NOW, false)).toBe(true);
    expect(includeInRecommendations(expired, NOW, true)).toBe(false);
    expect(includeInRecommendations(aside, NOW, true)).toBe(false);
    expect(includeInRecommendations({ memoryKind: 'lasting', expiresAt: null }, NOW, true)).toBe(
      true,
    );
    expect(
      includeInRecommendations(
        { memoryKind: 'temporary', expiresAt: new Date(NOW.getTime() + 1000) },
        NOW,
        true,
      ),
    ).toBe(true);
  });
});

describe('parent intent', () => {
  it('reads the recall, forget, and correct shapes and nothing else', () => {
    expect(parseMemoryParentIntent('what do you know about us?')?.kind).toBe('recall');
    expect(parseMemoryParentIntent('que sais-tu de nous')?.kind).toBe('recall');
    expect(parseMemoryParentIntent('forget that')?.needle).toBeNull();
    expect(parseMemoryParentIntent('oublie ca')?.needle).toBeNull();
    expect(parseMemoryParentIntent('forget swimming')?.needle).toBe('swimming');
    expect(parseMemoryParentIntent('correct district: midtown')).toMatchObject({
      kind: 'correct',
      factKey: 'district',
      value: 'midtown',
    });
    expect(parseMemoryParentIntent('corrige language a francais')).toMatchObject({
      factKey: 'language',
      value: 'francais',
    });
    expect(parseMemoryParentIntent('what do you know about the pool')).toBeNull();
    expect(parseMemoryParentIntent('yes')).toBeNull();
  });
});

describe('copy gate', () => {
  it('keeps every placeholder ASCII and marked for Sloane', () => {
    const bodies = memoryKindBodies();
    expect(bodies.length).toBe(12);
    for (const body of bodies) {
      expect(body.startsWith('TODO-Design:')).toBe(true);
      expect([...body].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
    }
    expect(MEMORY_KIND_COPY.en.recall).not.toBe(MEMORY_KIND_COPY.fr.recall);
  });

  it('does not hand a placeholder to the transport unless both gates are exactly true', async () => {
    const send = vi.fn(async () => undefined);
    for (const body of memoryKindBodies()) {
      await sendMemoryKindReply(send, body, { FAMILY_MEMORY_KINDS_ENABLED: 'true' });
      await sendMemoryKindReply(send, body, {
        FAMILY_MEMORY_KINDS_ENABLED: 'true',
        FAMILY_MEMORY_KINDS_COPY_LOCKED: 'TRUE',
      });
      await sendMemoryKindReply(send, body, {
        FAMILY_MEMORY_KINDS_ENABLED: 'true',
        FAMILY_MEMORY_KINDS_COPY_LOCKED: 'true\n',
      });
      await sendMemoryKindReply(send, body, { FAMILY_MEMORY_KINDS_COPY_LOCKED: 'true' });
    }
    expect(send).not.toHaveBeenCalled();
    expect(deliverMemoryKindCopy(MEMORY_KIND_COPY.en.forgotten, {}).deliver).toBe(false);
  });

  it('delivers the placeholder only when both gates are exactly true', async () => {
    const send = vi.fn(async () => undefined);
    const env = {
      FAMILY_MEMORY_KINDS_ENABLED: 'true',
      FAMILY_MEMORY_KINDS_COPY_LOCKED: 'true',
    };
    const result = await sendMemoryKindReply(send, MEMORY_KIND_COPY.fr.groupSync, env);
    expect(result).toEqual({ sent: true, skipped: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(MEMORY_KIND_COPY.fr.groupSync);
  });
});

describe('VIL-388 export hook', () => {
  it('carries kind and source on the fact shape', () => {
    expect(
      toFamilyMemoryExportFact({
        id: 'fact-1',
        factType: 'preference',
        factKey: 'swimming',
        memoryKind: 'one_off',
        memorySource: 'inferred',
        sourcedAt: NOW,
        expiresAt: null,
        validUntil: null,
      }),
    ).toEqual({
      id: 'fact-1',
      factType: 'preference',
      factKey: 'swimming',
      kind: 'one_off',
      source: 'inferred',
      sourcedAt: NOW.toISOString(),
      expiresAt: null,
      invalidatedAt: null,
    });
  });
});
