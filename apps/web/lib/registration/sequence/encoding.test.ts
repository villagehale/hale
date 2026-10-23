import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasEncodingCorruption } from './encoding';

describe('registration copy encoding safety (no repair)', () => {
  it('rejects the actual captured French writer output', () => {
    const recordings = JSON.parse(
      readFileSync(new URL('./__recordings__/localized.json', import.meta.url), 'utf8'),
    ) as Record<string, { response: { content: { type: string; text?: string }[] } }>;
    const messages = Object.values(recordings).flatMap((entry) =>
      entry.response.content.flatMap((block) => {
        if (block.type !== 'text' || !block.text) return [];
        try {
          const value = JSON.parse(block.text);
          return typeof value.message === 'string' ? [value.message] : [];
        } catch {
          return [];
        }
      }),
    );
    const garbled = messages.find((message) => message.includes('dĂ©but'));
    expect(garbled).toBeTruthy();
    if (!garbled) throw new Error('Expected the captured corrupt French draft');
    expect(hasEncodingCorruption(garbled)).toBe(true);
  });
  it.each(['dĂ©but', 'aoĂ»t', 'ĂȘtes', 'd’aprĂšs', 'Inscription en aoÃ»t', 'Broken � text'])(
    'holds corrupt bytes: %s',
    (message) => expect(hasEncodingCorruption(message)).toBe(true),
  );
  it.each([
    'Les inscriptions ouvrent le 12 août à 6 h 30, heure de Toronto.',
    'début août êtes d’après — été, Noël, Zoë',
    'مرحبًا، تفتح التسجيلات في أغسطس.',
    '报名开放时间尚未确定。',
    'Łódź, București, Český Krumlov, Ăngela',
    'Your response deadline is 7:00 AM Toronto time. 🎉',
  ])('leaves valid multilingual text unchanged: %s', (message) => {
    expect(hasEncodingCorruption(message)).toBe(false);
  });
});
