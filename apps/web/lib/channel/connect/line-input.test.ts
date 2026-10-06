import { describe, expect, it } from 'vitest';
import { fakeSpokenLineBody } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine } from '~/lib/channel/voice/spoken-line';
import {
  CONNECT_MAX_CHARS,
  CONNECT_VOICE_SKILL,
  type ConnectLineRequest,
  GOOGLE_PERMISSIONS_URL,
  connectLineInput,
  withConnectLinks,
} from './line-input';

/**
 * Per kind: what the model is handed, what it must carry, and which red lines code
 * holds. The model's actual words are proved by the cached eval
 * (apps/worker/evals/run-connect-voice-eval.mjs, rule #8).
 */

const EVERY_KIND: ConnectLineRequest[] = [
  { kind: 'offer', account: 'gcal' },
  { kind: 'offer', account: 'gmail' },
  { kind: 'offer', account: 'gdrive' },
  { kind: 'offer_both', first: 'gcal', second: 'gmail' },
  { kind: 'google_heads_up' },
  { kind: 'revoked', account: 'gcal' },
  { kind: 'not_connected', account: 'gmail' },
  { kind: 'revoke_failed', account: 'gcal' },
  { kind: 'mint_failed', account: 'gdrive' },
];

describe('connectLineInput', () => {
  it('is on the connect-voice skill, tu, no question, inside the budget, for every kind in both languages', () => {
    for (const request of EVERY_KIND) {
      for (const language of ['en', 'fr'] as const) {
        const input = connectLineInput(request, language, { parentWords: 'connect it' });
        expect(input.skill).toBe(CONNECT_VOICE_SKILL);
        expect(input.kind).toBe(request.kind);
        expect(input.language).toBe(language);
        expect(input.address).toBe('tu');
        expect(input.questions).toBe(0);
        expect(input.maxChars).toBe(CONNECT_MAX_CHARS);
        expect(input.parentWords).toBe('connect it');
        const note = request.kind === 'offer' || request.kind === 'offer_both';
        const heads = request.kind === 'google_heads_up';
        expect(input.forbidden?.map((rule) => rule.name)).toEqual(
          note
            ? [
                'keyword_ask',
                'google_side_claim',
                'we_for_hale',
                'google_coaching',
                'soft_safe',
                'heads_up_in_note',
              ]
            : heads
              ? ['keyword_ask', 'google_side_claim', 'we_for_hale', 'google_coaching', 'soft_safe']
              : ['keyword_ask', 'google_side_claim', 'we_for_hale'],
        );
        // The fake passes the judge the real model is held to, so the facts can be
        // carried by the kind's slots alone.
        expect(() => fakeSpokenLineBody(input)).not.toThrow();
      }
    }
  });

  it('hands the offer the account name and the minutes, and refuses coaching past the warning', () => {
    const en = connectLineInput({ kind: 'offer', account: 'gcal' }, 'en');
    expect(en.facts).toEqual({
      account: 'Google Calendar',
      goodForMinutes: 15,
    });
    expect(en.mustMention).toEqual(['Google Calendar', '15']);
    expect(en.linkFollows).toBe(true);
    expect(
      judgeSpokenLine(
        'Here you go - this link connects your Google Calendar and is good for 15 minutes.',
        en,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        'Here you go - this link connects your Google Calendar and is good for 15 minutes. Google may say Hale is not verified yet.',
        en,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:heads_up_in_note' });
    const heads = connectLineInput({ kind: 'google_heads_up' }, 'en');
    expect(heads.linkFollows).toBeUndefined();
    expect(heads.maxChars).toBe(CONNECT_MAX_CHARS);
    expect(
      judgeSpokenLine(
        "Google may say Hale is not verified yet, because I'm still in review. No problem if you'd rather wait.",
        heads,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        'Google may say Hale is not verified yet. This link will work while you wait.',
        heads,
      ),
    ).toEqual({ ok: false, reason: 'link' });
    expect(
      judgeSpokenLine(
        "Google may say Hale is not verified yet, because we are still in Google's review.",
        heads,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:we_for_hale' });
    expect(
      judgeSpokenLine(
        'Google may say Hale is not verified yet. No worries if you would rather wait.',
        heads,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:soft_safe' });
    expect(judgeSpokenLine('If Google warns you, tap Advanced and carry on.', heads)).toEqual({
      ok: false,
      reason: 'forbidden:google_coaching',
    });

    const fr = connectLineInput({ kind: 'offer', account: 'gcal' }, 'fr');
    expect(fr.facts).toEqual({
      account: 'Google Agenda',
      goodForMinutes: 15,
    });
    expect(
      judgeSpokenLine('Voilà - ce lien relie ton Google Agenda, bon pour 15 minutes.', fr),
    ).toEqual({ ok: true });
    expect(
      connectLineInput({ kind: 'offer', account: 'gcal' }, 'fr', { address: 'vous' }).address,
    ).toBe('vous');
  });

  it('hands the two-link offer both names in order; code appends the links in that order', () => {
    const both = connectLineInput({ kind: 'offer_both', first: 'gcal', second: 'gmail' }, 'en');
    expect(both.facts).toEqual({
      first: 'Google Calendar',
      second: 'Gmail',
      goodForMinutes: 15,
    });
    expect(both.mustMention).toEqual(['Google Calendar', 'Gmail', '15']);
    expect(
      withConnectLinks('First link is Google Calendar, second is Gmail.', [
        'https://x/connect?t=a&to=gcal',
        'https://x/connect?t=b&to=gmail',
      ]),
    ).toBe(
      'First link is Google Calendar, second is Gmail.\nhttps://x/connect?t=a&to=gcal\nhttps://x/connect?t=b&to=gmail',
    );
  });

  it('tells the revoked line what is true on each side, and the removal URL stays with code', () => {
    const revoked = connectLineInput({ kind: 'revoked', account: 'gcal' }, 'en');
    expect(revoked.facts).toEqual({
      account: 'Google Calendar',
      keysDeleted: true,
      googleStillListsHale: true,
    });
    expect(revoked.linkFollows).toBe(true);
    expect(
      judgeSpokenLine(
        'Done - your Google Calendar is disconnected on my side and I threw my keys away. Google still lists Hale until you remove it; this link is where.',
        revoked,
      ),
    ).toEqual({ ok: true });
    // The one lie this flow cannot afford.
    expect(
      judgeSpokenLine('Done - I disconnected your Google Calendar from Google.', revoked),
    ).toEqual({ ok: false, reason: 'forbidden:google_side_claim' });
    // The model never writes the URL; code appends it.
    expect(
      judgeSpokenLine(
        'Done - your Google Calendar is disconnected. Remove Hale at https://myaccount.google.com/permissions',
        revoked,
      ),
    ).toEqual({ ok: false, reason: 'invented' });
    expect(withConnectLinks('Done.', [GOOGLE_PERMISSIONS_URL])).toBe(
      `Done.\n${GOOGLE_PERMISSIONS_URL}`,
    );
  });

  it('refuses a line that hands the parent a word to type (the founder rule)', () => {
    const notConnected = connectLineInput({ kind: 'not_connected', account: 'gmail' }, 'en');
    expect(
      judgeSpokenLine(
        'I hold no keys for your Gmail, so there is nothing to undo. If you want it linked, just ask here.',
        notConnected,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine('Nothing connected for Gmail. Reply CONNECT to link it.', notConnected),
    ).toEqual({ ok: false, reason: 'forbidden:keyword_ask' });
    expect(
      judgeSpokenLine(
        'Rien de connecté pour Gmail. Écris CONNECTER pour le lier.',
        connectLineInput({ kind: 'not_connected', account: 'gmail' }, 'fr'),
      ),
    ).toEqual({ ok: false, reason: 'forbidden:keyword_ask' });
  });

  it('refuses a question anywhere: these lines state, they do not ask', () => {
    const failed = connectLineInput({ kind: 'mint_failed', account: 'gcal' }, 'en');
    expect(
      judgeSpokenLine(
        'I could not make the Google Calendar link just now - nothing has changed. Ask again in a minute and it should work.',
        failed,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine('I could not make the Google Calendar link. Try again in a minute?', failed),
    ).toEqual({ ok: false, reason: 'question' });
  });
});
