import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_KIND_COPY,
  MEMORY_KIND_LINES,
  applyPromotionSignal,
  classifyMemoryWrite,
  deliverMemoryKindCopy,
  familyMemoryKindsCopyLocked,
  familyMemoryKindsEnabled,
  includeInRecommendations,
  isExpiredTemporary,
  memoryKindBodies,
  parseMemoryParentIntent,
  renderMemoryCorrected,
  renderMemoryForgotten,
  renderMemoryGroupSync,
  renderMemoryRecall,
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
  it('keeps every locked sentence ASCII and free of opt-out or booking claims', () => {
    const bodies = memoryKindBodies();
    expect(bodies.length).toBe(28);
    for (const body of bodies) {
      expect(body.includes('TODO-Design')).toBe(false);
      expect([...body].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
      expect(body).not.toMatch(/reply stop|unsubscribe|\b(booked|enrolled|signed up)\b/i);
    }
    expect(MEMORY_KIND_COPY.en.recall).not.toBe(MEMORY_KIND_COPY.fr.recall);
    expect(MEMORY_KIND_COPY.en.recall).toBe(
      'Here\'s what I have for your family:\n{list}\nWrong or old? Text "correct <key>: <value>" or "forget <key>".',
    );
    expect(MEMORY_KIND_COPY.fr.recall).toBe(
      'Voici ce que j\'ai sur la famille :\n{list}\nPour changer : "corrige <cle> : <valeur>" ou "oublie <cle>".',
    );
    expect(MEMORY_KIND_COPY.en.forgotten).toBe('Done, I forgot {key}.');
    expect(MEMORY_KIND_COPY.fr.forgotten).toBe("C'est oublie : {key}.");
    expect(MEMORY_KIND_LINES.en.forgottenMany).toBe('Done, I forgot {n} things.');
    expect(MEMORY_KIND_LINES.fr.forgottenMany).toBe("C'est oublie : {n} elements.");
    expect(MEMORY_KIND_COPY.en.corrected).toBe('Got it. {key} is now {value}.');
    expect(MEMORY_KIND_COPY.fr.corrected).toBe("C'est corrige : {key} est maintenant {value}.");
    expect(MEMORY_KIND_COPY.en.nothing).toBe(
      'I didn\'t find anything to forget there. Text "what do you know" to see what I have, then "forget <key>".',
    );
    expect(MEMORY_KIND_COPY.fr.nothing).toBe(
      'Rien a oublier de ce cote. "que sais-tu" montre ce que j\'ai, puis "oublie <cle>".',
    );
    expect(MEMORY_KIND_COPY.en.refused).toBe(
      'I keep that one, it\'s a record. Text "what do you know" to see what can be changed.',
    );
    expect(MEMORY_KIND_COPY.fr.refused).toBe(
      'Celle-la reste, c\'est un dossier. "que sais-tu" montre ce qui peut changer.',
    );
    expect(MEMORY_KIND_COPY.en.groupSync).toBe('{who} asked me to forget something.');
    expect(MEMORY_KIND_COPY.fr.groupSync).toBe("{who} m'a demande d'oublier quelque chose.");
    expect(MEMORY_KIND_LINES.en.groupSyncCorrect).toBe('{who} corrected something.');
    expect(MEMORY_KIND_LINES.fr.groupSyncCorrect).toBe('{who} a corrige quelque chose.');
    expect(MEMORY_KIND_LINES.en.recallEmpty).toBe(
      "I don't have anything saved about your family yet.",
    );
    expect(MEMORY_KIND_LINES.fr.recallEmpty).toBe("Je n'ai encore rien note sur la famille.");
    expect(MEMORY_KIND_LINES.en.parent).toBe('- {key}: {value} ({term}, you told me)');
    expect(MEMORY_KIND_LINES.fr.parent).toBe('- {key} : {value} ({term}, dit par un parent)');
    expect(MEMORY_KIND_LINES.en.calendar).toBe('- {key}: {value} ({term}, from your calendar)');
    expect(MEMORY_KIND_LINES.fr.calendar).toBe('- {key} : {value} ({term}, vu dans le calendrier)');
    expect(MEMORY_KIND_LINES.en.inferred).toBe('- {key}: I think {value} (for now)');
    expect(MEMORY_KIND_LINES.fr.inferred).toBe("- {key} : je crois que {value} (pour l'instant)");
  });

  it('does not hand copy to the transport unless both gates are exactly true', async () => {
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
    expect(deliverMemoryKindCopy(MEMORY_KIND_COPY.en.nothing, {}).deliver).toBe(false);
  });

  it('refuses a leftover token even when both gates are exactly true', async () => {
    const send = vi.fn(async () => undefined);
    const env = {
      FAMILY_MEMORY_KINDS_ENABLED: 'true',
      FAMILY_MEMORY_KINDS_COPY_LOCKED: 'true',
    };
    for (const body of memoryKindBodies()) {
      if (!body.includes('{')) continue;
      await sendMemoryKindReply(send, body, env);
    }
    expect(send).not.toHaveBeenCalled();
    expect(deliverMemoryKindCopy('Reply STOP to opt out.', env)).toEqual({
      deliver: false,
      skipped: 'unrendered',
    });
  });

  it('delivers a finished sentence only when both gates are exactly true', async () => {
    const send = vi.fn(async () => undefined);
    const env = {
      FAMILY_MEMORY_KINDS_ENABLED: 'true',
      FAMILY_MEMORY_KINDS_COPY_LOCKED: 'true',
    };
    const body = renderMemoryGroupSync('fr', 'forget', 'Sam');
    const result = await sendMemoryKindReply(send, body, env);
    expect(result).toEqual({ sent: true, skipped: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Sam m'a demande d'oublier quelque chose.");
    expect(body).not.toMatch(/\?/);
  });
});

describe('recall bubbles', () => {
  it('pages ten lines, labels inferred facts, and keeps the header and footer at the ends', () => {
    expect(renderMemoryRecall('en', [])).toEqual([
      "I don't have anything saved about your family yet.",
    ]);
    expect(renderMemoryRecall('fr', [])).toEqual(["Je n'ai encore rien note sur la famille."]);
    const one = renderMemoryRecall('en', [
      { key: 'district', value: 'midtown', source: 'parent_message', kind: 'lasting' },
      { key: 'pickup', value: '3pm', source: 'calendar', kind: 'temporary' },
      { key: 'swimming', value: 'saturday', source: 'inferred', kind: 'lasting' },
      { key: 'receipt', value: 'paid', source: 'receipt', kind: 'lasting' },
    ]);
    expect(one).toEqual([
      [
        "Here's what I have for your family:",
        '- district: midtown (lasting, you told me)',
        '- pickup: 3pm (for now, from your calendar)',
        '- swimming: I think saturday (for now)',
        'Wrong or old? Text "correct <key>: <value>" or "forget <key>".',
      ].join('\n'),
    ]);
    expect(one[0]).not.toContain('paid');
    const many = Array.from({ length: 11 }, (_, index) => ({
      key: `k${index}`,
      value: `v${index}`,
      source: 'legacy' as const,
      kind: 'lasting' as const,
    }));
    const bubbles = renderMemoryRecall('en', many);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]?.startsWith("Here's what I have for your family:\n")).toBe(true);
    expect(bubbles[0]).not.toContain('Wrong or old?');
    expect(bubbles[0]?.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(10);
    expect(bubbles[1]?.startsWith("Here's what I have")).toBe(false);
    expect(bubbles[1]?.endsWith('or "forget <key>".')).toBe(true);
    expect(bubbles[1]).toContain('- k10: v10 (lasting, you told me)');
    expect(renderMemoryForgotten('en', ['swimming'])).toBe('Done, I forgot swimming.');
    expect(renderMemoryForgotten('fr', ['a', 'b'])).toBe("C'est oublie : 2 elements.");
    expect(renderMemoryCorrected('en', 'district', 'midtown')).toBe(
      'Got it. district is now midtown.',
    );
    expect(renderMemoryGroupSync('en', 'correct', 'Sam')).toBe('Sam corrected something.');
    expect(renderMemoryGroupSync('en', 'correct', 'Sam')).not.toContain('midtown');
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
