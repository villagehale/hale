import { describe, expect, it } from 'vitest';
import {
  type EmailAlertVoiceFacts,
  echoEmailAlertLine,
  emailAlertAccepts,
  emailAlertRejection,
  writeEmailAlert,
} from './email-alert-voice';

const FACTS: EmailAlertVoiceFacts = {
  kind: 'new_event',
  sender: 'Riverside Pool',
  title: 'Gymnastics',
  titleCarriesVerb: false,
  change: null,
  whenLabel: 'Sunday, Oct 4 at 9:00 a.m.',
  wasLabel: null,
  place: null,
  going: null,
  offer: 'week',
  teen: false,
  calendarNotice: false,
  language: 'en',
  withheld: [],
};

const GOOD = 'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?';

describe('writeEmailAlert', () => {
  it('sends the first line that names the occasion and the rendered instant', async () => {
    const pages: string[] = [];
    const written = await writeEmailAlert(FACTS, {
      attempt: async () => GOOD,
      alert: async (text) => {
        pages.push(text);
      },
    });
    expect(written).toEqual({ line: GOOD, going: null });
    expect(pages).toEqual([]);
  });

  it('retries once after a line about a different day, then sends the good one', async () => {
    const seen: number[] = [];
    const written = await writeEmailAlert(FACTS, {
      attempt: async (_facts, tryIndex) => {
        seen.push(tryIndex);
        return tryIndex === 0
          ? 'Riverside Pool Gymnastics was Thursday, Oct 1 at 4:15 p.m. Want this on your week?'
          : GOOD;
      },
      alert: async () => undefined,
    });
    expect(seen).toEqual([0, 1]);
    expect(written?.line).toBe(GOOD);
  });

  it('sends nothing and pages ops when both attempts miss', async () => {
    const pages: string[] = [];
    const written = await writeEmailAlert(FACTS, {
      attempt: async () => 'Thursday, Oct 1 at 4:15 p.m.?',
      alert: async (text) => {
        pages.push(text);
      },
    });
    expect(written).toBeNull();
    expect(pages).toEqual(['email alert: unsent after retry (new_event, title)']);
    expect(pages[0]).not.toContain('Gymnastics');
  });

  it('drops the going clause only when the first line does not fit', async () => {
    const withGoing: EmailAlertVoiceFacts = {
      ...FACTS,
      going: ', with two other Hale families',
      offer: 'calendar',
      kind: 'booking_confirmation',
    };
    const fitted = echoEmailAlertLine(withGoing);
    const written = await writeEmailAlert(withGoing, {
      attempt: async (facts, tryIndex) =>
        tryIndex === 0 ? `${fitted}${'x'.repeat(400)}` : echoEmailAlertLine(facts),
      alert: async () => undefined,
    });
    expect(written?.going).toBeNull();
    expect(written?.line).not.toContain('Hale families');
    expect(emailAlertAccepts(fitted, withGoing)).toBe(true);
  });
});

describe('emailAlertAccepts', () => {
  it('refuses a question when no offer row will exist, and a statement when one will', () => {
    expect(emailAlertRejection('Riverside Pool Gymnastics Sunday, Oct 4 at 9:00 a.m.', FACTS)).toBe(
      'no_question',
    );
    expect(emailAlertRejection(`${GOOD.slice(0, -1)}.`, { ...FACTS, offer: null })).toBeNull();
    expect(emailAlertRejection(`${GOOD}`, { ...FACTS, offer: null })).toBe('question');
  });

  it('refuses a keyword instruction and a leaked teen sender', () => {
    expect(
      emailAlertAccepts(
        'Reply YES to keep Riverside Pool Gymnastics on Sunday, Oct 4 at 9:00 a.m.?',
        FACTS,
      ),
    ).toBe(false);
    const teen: EmailAlertVoiceFacts = {
      ...FACTS,
      teen: true,
      sender: null,
      whenLabel: null,
      offer: null,
      withheld: ['Riverside Pool', 'Sunday, Oct 4 at 9:00 a.m.'],
    };
    expect(emailAlertAccepts('Gymnastics. Details stay out of this text.', teen)).toBe(true);
    expect(
      emailAlertAccepts('Riverside Pool says Gymnastics. Details stay out of this text.', teen),
    ).toBe(false);
  });

  it('folds an accent and a curly apostrophe instead of refusing the line', async () => {
    const titled = {
      ...FACTS,
      title: 'Fete de la rentrée',
    };
    const raw =
      'Riverside Pool, Fête de la rentrée is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?';
    expect(emailAlertRejection(raw, titled)).toBeNull();
    const written = await writeEmailAlert(titled, {
      attempt: async () => raw,
      alert: async () => undefined,
    });
    expect(written?.line).toContain('Fete de la rentrée');
    expect(written?.line).not.toContain('ê');

    const theatre = { ...FACTS, title: "Children's Theatre" };
    const curly =
      'Riverside Pool, Children\u2019s Theatre is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?';
    const sent = await writeEmailAlert(theatre, {
      attempt: async () => curly,
      alert: async () => undefined,
    });
    expect(sent?.line).toContain("Children's Theatre");
  });

  it('refuses a keyword, a stray date, an amount, a person, and a stock opener', () => {
    expect(emailAlertRejection(`${GOOD} Écris OUI.`, FACTS)).toBe('keyword');
    expect(emailAlertRejection(`Say STOP. ${GOOD}`, FACTS)).toBe('keyword');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m., aussi jeudi. Want this on your week?',
        FACTS,
      ),
    ).toBe('stray_weekday');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. and le 5 octobre. Want this on your week?',
        FACTS,
      ),
    ).toBe('stray_date');
    expect(
      emailAlertRejection(
        'Riverside Pool will refund you $40 for Gymnastics on Sunday, Oct 4 at 9:00 a.m. Want this on your week?',
        FACTS,
      ),
    ).toBe('stray_money');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. at 16h30. Want this on your week?',
        FACTS,
      ),
    ).toBe('stray_clock');
    expect(
      emailAlertRejection(
        'Riverside Pool says Maya is free and Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?',
        FACTS,
      ),
    ).toBe('stray_name');
    expect(
      emailAlertRejection(
        'Hale got a booking confirmation: Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?',
        FACTS,
      ),
    ).toBe('hale');
    expect(
      emailAlertRejection(
        'Just a heads-up: Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?',
        FACTS,
      ),
    ).toBe('opener');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on their week?',
        FACTS,
      ),
    ).toBe('person');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on my week?',
        FACTS,
      ),
    ).toBe('person');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on our week?',
        FACTS,
      ),
    ).toBe('person');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on my calendar?',
        FACTS,
      ),
    ).toBe('person');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on our calendar?',
        FACTS,
      ),
    ).toBe('person');
    expect(
      emailAlertRejection(
        'Riverside Pool, Gymnastics is on Sunday, Oct 4 at 9:00 a.m., the coach is sick. Want this on your week?',
        FACTS,
      ),
    ).toBe('reason');
    expect(emailAlertRejection(GOOD, FACTS)).toBeNull();
  });

  it('accepts a sender shortened at a word boundary, and still requires the place', () => {
    const facts: EmailAlertVoiceFacts = {
      ...FACTS,
      sender: 'City of Toronto Parks',
      place: 'High Park',
    };
    expect(
      emailAlertRejection(
        'City of Toronto, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. at High Park. Want this on your week?',
        facts,
      ),
    ).toBeNull();
    expect(
      emailAlertRejection(
        'City of Toronto Parks, Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want this on your week?',
        facts,
      ),
    ).toBe('place');
  });
});
