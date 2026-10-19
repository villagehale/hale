import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordedModel } from '~/lib/testing/recorded-model';
import {
  registrationAcceptanceCases,
  registrationAcceptanceInput,
} from '~/lib/testing/registration-acceptance';
import { registrationDate } from '../read';
import { composeRegistrationReminder } from './compose';
import { composeRegistrationLinkReply } from './link-reply';
import { openingFact, verifyMessageDates } from './message-dates';

const recordingPath = join(import.meta.dirname, '__recordings__', 'localized.json');
const model = recordedModel(recordingPath, () => {
  throw new Error('Use the approved capped acceptance runner to record; tests only replay.');
});

// Historical failures remain controls, not answers to a changed writer prompt.
function historicalMessage(key: string): string {
  const recordings = JSON.parse(readFileSync(recordingPath, 'utf8')) as Record<
    string,
    { response: { content: Array<{ type: string; text?: string }> } }
  >;
  const text = recordings[key]?.response.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error(`Missing historical writer response: ${key}`);
  return (JSON.parse(text) as { message: string }).message;
}

describe('actual localized registration writer → independent date parser (recorded Claude)', () => {
  beforeEach(() => {
    model.misses.length = 0;
  });
  it.each(registrationAcceptanceCases)('%s %s reminder', async (state, language) => {
    const input = registrationAcceptanceInput(state, language);
    const message = await composeRegistrationReminder(input, model.client());
    expect(model.misses).toEqual([]);
    expect(message).toBeTruthy();
    expect(message).toContain(input.reading.sourceUrl);
  });
  it('holds historical corrupted French text whose parser quote is not in the actual message', async () => {
    const input = registrationAcceptanceInput('closing-soon', 'fr-CA');
    expect(
      await verifyMessageDates(
        historicalMessage('7955e39a49b474a8979e267f1f5f465e9045a122ec92505bd5a616e32cd3e058'),
        input.copy.now,
        openingFact(registrationDate(input.reading, false), input.reading.timeZone),
        [],
        model.client(),
      ),
    ).toBe(false);
    expect(model.misses).toEqual([]);
  });
  it.each([
    ['en', 'When does registration open? [link]'],
    ['fr-CA', 'Préviens-moi quand les inscriptions ouvrent. [link]'],
    ['ar', 'ذكرني عندما يبدأ التسجيل [link]'],
  ])('%s link reply', async (language, parentWords) => {
    const { reading } = registrationAcceptanceInput('open', language);
    const message = await composeRegistrationLinkReply(
      {
        outcome: 'registration_reminder_proposed',
        language,
        parentWords,
        reading,
        sourceUrl: reading.sourceUrl,
      },
      model.client(),
    );
    expect(model.misses).toEqual([]);
    expect(message).toBeTruthy();
    expect(message).toContain(reading.sourceUrl);
  });
  it('holds an injected wrong opening date after a real independent model parse', async () => {
    const input = registrationAcceptanceInput('open', 'en');
    const message = historicalMessage(
      '3229d2b9f54c7e262bb9b4f9b09d02e1073a15cf0b625a3397bb8504f530c814',
    );
    const wrong = message.replace('today, August 12, 2026', 'August 13, 2026');
    expect(wrong).not.toBe(message);
    expect(
      await verifyMessageDates(
        wrong,
        input.copy.now,
        openingFact(registrationDate(input.reading, false), input.reading.timeZone),
        [],
        model.client(),
      ),
    ).toBe(false);
    expect(model.misses).toEqual([]);
  });
  it('holds a quoted wrong French weekday after a real independent model parse', async () => {
    const input = registrationAcceptanceInput('open', 'fr-CA');
    expect(
      await verifyMessageDates(
        'Les inscriptions ouvrent jeudi 12 août 2026 à 6 h 30, heure de Toronto.',
        input.copy.now,
        openingFact(registrationDate(input.reading, false), input.reading.timeZone),
        [],
        model.client(),
      ),
    ).toBe(false);
    expect(model.misses).toEqual([]);
  });
});
