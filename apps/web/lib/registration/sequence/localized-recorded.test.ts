import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordedModel } from '~/lib/testing/recorded-model';
import {
  registrationAcceptanceCases,
  registrationAcceptanceInput,
} from '~/lib/testing/registration-acceptance';
import { composeRegistrationReminder } from './compose';
import { composeRegistrationLinkReply } from './link-reply';
import { openingFact, verifyMessageDates } from './message-dates';
import { registrationDate } from '../read';

const model = recordedModel(join(import.meta.dirname, '__recordings__', 'localized.json'), () => {
  throw new Error('Use the approved capped acceptance runner to record; tests only replay.');
});

describe('actual localized registration writer → independent date parser (recorded Claude)', () => {
  it.each(
    registrationAcceptanceCases.filter(
      ([state, language]) => state !== 'closing-soon' || language !== 'fr-CA',
    ),
  )('%s %s reminder', async (state, language) => {
    const input = registrationAcceptanceInput(state, language);
    const message = await composeRegistrationReminder(input, model.client());
    expect(model.misses).toEqual([]);
    expect(message).toBeTruthy();
    expect(message).toContain(input.reading.sourceUrl);
  });
  it('holds the recorded corrupted French text whose parser quote is not in the actual message', async () => {
    expect(
      await composeRegistrationReminder(
        registrationAcceptanceInput('closing-soon', 'fr-CA'),
        model.client(),
      ),
    ).toBeNull();
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
    const message = await composeRegistrationReminder(input, model.client());
    if (!message) throw new Error('Expected the recorded baseline message');
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
