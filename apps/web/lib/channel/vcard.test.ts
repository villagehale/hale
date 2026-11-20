import { describe, expect, it } from 'vitest';
import { parseContactCards } from './vcard';

const PHOTO = 'SECRETPHOTOBASE64TOKEN';

function card(lines: string[]): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n');
}

describe('parseContactCards', () => {
  it('reads a name, numbers, and the other useful fields, and drops a photo and a street', () => {
    const parsed = parseContactCards(
      card([
        'N:Smith;Jane;;;',
        'FN:Janey Smith',
        'ORG:Riverside Community Centre',
        'TITLE:Swimming coach',
        'TEL;TYPE=HOME:+1 (647) 555-0123',
        'TEL;TYPE=CELL,VOICE;TYPE=pref:+1 (416) 555-0100',
        'EMAIL;TYPE=INTERNET:jane@example.com',
        'ADR;TYPE=HOME:;;123 Secret St;Toronto;ON;M5V 1A1;Canada',
        'NOTE:Tuesday pickup',
        `PHOTO;ENCODING=b;TYPE=JPEG:${PHOTO}${'A'.repeat(80)}`,
        'BDAY:19700401',
      ]),
    );

    expect(parsed.truncated).toBe(false);
    expect(parsed.cards).toEqual([
      {
        name: 'Janey Smith',
        phones: [
          { number: '+14165550100', e164: '+14165550100', label: 'cell' },
          { number: '+16475550123', e164: '+16475550123', label: 'home' },
        ],
        emails: [{ address: 'jane@example.com', label: null }],
        org: 'Riverside Community Centre',
        title: 'Swimming coach',
        place: 'Toronto, ON, Canada',
      },
    ]);
    const dumped = JSON.stringify(parsed);
    expect(dumped).not.toContain(PHOTO);
    expect(dumped).not.toContain('123 Secret St');
    expect(dumped).not.toContain('M5V');
    expect(dumped).not.toContain('19700401');
    expect(dumped).not.toContain('Tuesday pickup');
  });

  it('uses the Apple group label, unfolds a folded name, and decodes a quoted-printable name', () => {
    const parsed = parseContactCards(
      [
        'BEGIN:VCARD',
        'FN:Jane ',
        ' Smith',
        'item1.TEL;type=CELL:+14165550199',
        'item1.X-ABLabel:Grandma',
        'END:VCARD',
        'BEGIN:VCARD',
        'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Garc=C3=ADa',
        'TEL;VALUE=uri:tel:+1-647-555-0123',
        'END:VCARD',
      ].join('\n'),
    );

    expect(parsed.cards.map((entry) => entry.name)).toEqual(['Jane Smith', 'José García']);
    expect(parsed.cards[0]?.phones).toEqual([
      { number: '+14165550199', e164: '+14165550199', label: 'Grandma' },
    ]);
    expect(parsed.cards[1]?.phones).toEqual([
      { number: '+16475550123', e164: '+16475550123', label: null },
    ]);
  });

  it('keeps a non-Canadian number without inventing a country code, and builds a name from N', () => {
    const parsed = parseContactCards(
      card(['N:Lovelace;Ada;;;', 'TEL:+44 20 7946 0958', 'EMAIL:ada@example.com']),
    );
    expect(parsed.cards).toEqual([
      {
        name: 'Ada Lovelace',
        phones: [{ number: '+442079460958', e164: null, label: null }],
        emails: [{ address: 'ada@example.com', label: null }],
      },
    ]);
  });

  it('drops a card with nothing to offer and a file that is not a vcard', () => {
    expect(parseContactCards('hello').cards).toEqual([]);
    expect(parseContactCards(card(['ORG:Only a company'])).cards).toEqual([]);
    expect(parseContactCards(card(['FN:Ada'])).cards).toEqual([{ name: 'Ada', phones: [] }]);
  });

  it('keeps the first three cards and says the file had more', () => {
    const raw = ['Ada', 'Grace', 'Joan', 'Radia']
      .map((name) => card([`FN:${name}`, 'TEL:+14165550100']))
      .join('\n');
    const parsed = parseContactCards(raw);
    expect(parsed.truncated).toBe(true);
    expect(parsed.cards.map((entry) => entry.name)).toEqual(['Ada', 'Grace', 'Joan']);
  });

  it('keeps the base number and never appends an extension to it', () => {
    const parsed = parseContactCards(
      card([
        'FN:Front Desk',
        'TEL;VALUE=uri:tel:+14165550100;ext=123',
        'TEL:+1 647 555 0123 x45',
        'TEL:(905) 555-0199 ext. 7',
        'TEL:+1 289 555 0111 #9',
      ]),
    );
    expect(parsed.cards[0]?.phones.map((p) => p.number)).toEqual([
      '+14165550100',
      '+16475550123',
      '+19055550199',
      '+12895550111',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('0100123');
  });

  it('keeps a preferred number listed fifth, and a preferred email listed fourth', () => {
    const parsed = parseContactCards(
      card([
        'FN:Many Numbers',
        'TEL;TYPE=WORK:+14165550101',
        'TEL;TYPE=HOME:+14165550102',
        'TEL;TYPE=OTHER:+14165550103',
        'TEL;TYPE=OLD:+14165550104',
        'TEL;TYPE=CELL,PREF:+14165550100',
        'EMAIL:a@example.com',
        'EMAIL:b@example.com',
        'EMAIL:c@example.com',
        'EMAIL;TYPE=PREF:best@example.com',
      ]),
    );
    const contact = parsed.cards[0];
    expect(contact?.phones).toHaveLength(4);
    expect(contact?.phones[0]?.number).toBe('+14165550100');
    expect(contact?.emails).toHaveLength(3);
    expect(contact?.emails?.[0]?.address).toBe('best@example.com');
  });
});
