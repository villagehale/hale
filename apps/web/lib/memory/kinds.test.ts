import { describe, expect, it, vi } from 'vitest';
import { renderMemoryGroupSync } from './group-sync';
import * as kinds from './kinds';
import {
  applyPromotionSignal,
  classifyMemoryWrite,
  deliverMemoryKindCopy,
  familyMemoryKindsEnabled,
  includeInRecommendations,
  isExpiredTemporary,
  sendMemoryKindReply,
  temporaryExpiry,
  toFamilyMemoryExportFact,
} from './kinds';

const NOW = new Date('2026-09-30T15:00:00.000Z');

describe('family memory kind flag', () => {
  it('is on only for the exact string true', () => {
    expect(familyMemoryKindsEnabled({ FAMILY_MEMORY_KINDS_ENABLED: 'true' })).toBe(true);
  });

  it('stays off for TRUE, a trailing newline, and unset', () => {
    for (const value of ['TRUE', 'true\n', 'True', '1', 'on', 'yes', '']) {
      expect(familyMemoryKindsEnabled({ FAMILY_MEMORY_KINDS_ENABLED: value })).toBe(false);
    }
    expect(familyMemoryKindsEnabled({})).toBe(false);
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
      isExpiredTemporary(
        { memoryKind: 'temporary', expiresAt: new Date(NOW.getTime() + 1000) },
        NOW,
      ),
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

describe('no locked memory copy and no phrase reader (VIL-723)', () => {
  it('exports no sentence, template, or regex intent parser for a parent reply', () => {
    const exported = Object.keys(kinds);
    for (const gone of [
      'MEMORY_KIND_COPY',
      'MEMORY_KIND_LINES',
      'memoryKindBodies',
      'renderMemoryRecall',
      'memoryRecallParts',
      'paginateMemoryRecall',
      'renderMemoryForgotten',
      'renderMemoryCorrected',
      'memoryKindCopy',
      'parseMemoryParentIntent',
    ]) {
      expect(exported).not.toContain(gone);
    }
  });
});

describe('copy gate', () => {
  // Shapes only: a leftover `{token}` is a body the model did not finish, never one to send.
  const UNFINISHED = ['{list}', 'Swim is now {value}.', '- {key}: {value}'];

  it('does not hand an unrendered body to the transport, and stays quiet while the kinds flag is off', async () => {
    const send = vi.fn(async () => undefined);
    for (const body of UNFINISHED) {
      await sendMemoryKindReply(send, body, { FAMILY_MEMORY_KINDS_ENABLED: 'true' });
    }
    await sendMemoryKindReply(send, 'Swim is gone from what I keep.', {});
    expect(send).not.toHaveBeenCalled();
    expect(deliverMemoryKindCopy('Swim is gone from what I keep.', {}).deliver).toBe(false);
  });

  it('refuses a leftover token even when the kinds flag is on', async () => {
    const send = vi.fn(async () => undefined);
    const env = {
      FAMILY_MEMORY_KINDS_ENABLED: 'true',
    };
    for (const body of UNFINISHED) {
      await sendMemoryKindReply(send, body, env);
    }
    expect(send).not.toHaveBeenCalled();
    expect(deliverMemoryKindCopy('Reply STOP to opt out.', env)).toEqual({
      deliver: false,
      skipped: 'unrendered',
    });
  });

  it('delivers a finished sentence when the kinds flag is exactly true', async () => {
    const send = vi.fn(async () => undefined);
    const env = {
      FAMILY_MEMORY_KINDS_ENABLED: 'true',
    };
    const body = await renderMemoryGroupSync('fr', 'forget', 'Sam');
    if (!body) throw new Error('spoken line missing');
    const result = await sendMemoryKindReply(send, body, env);
    expect(result).toEqual({ sent: true, skipped: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Sam m'a demande d'oublier quelque chose.");
    expect(body).not.toMatch(/\?/);
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
