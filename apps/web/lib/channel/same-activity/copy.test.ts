import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import { readSameActivityChoice } from './choice';
import {
  SAME_ACTIVITY_CONFIRMATION_EN,
  SAME_ACTIVITY_CONFIRMATION_FR,
  SAME_ACTIVITY_OFFER_EN,
  SAME_ACTIVITY_OFFER_FR,
  SAME_ACTIVITY_WAITING_EN,
  SAME_ACTIVITY_WAITING_FR,
  deliverSameActivityReply,
  renderSameActivityReply,
  sameActivityCopyMayLeave,
  sameActivityDeclineToOtherSide,
} from './copy';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const BANNED = /\bSTOP\b|unsubscribe/i;

const OFFER_EN_SWIM =
  "Another family nearby is looking at the same swim. Want me to check if they'd go together? I won't share anything about you unless they say yes too.";
const OFFER_FR_SWIM =
  'Une autre famille pres de chez vous regarde la meme activite: swim. Voulez-vous que je voie si elle serait partante pour y aller ensemble? Je ne partage rien sur vous sans son accord aussi.';
const CONFIRM_EN_SAM =
  "You're both up for it. The other parent is Sam, and they got your first name too. Want me to start a chat with the two of you?";
const CONFIRM_FR_SAM =
  "Vous etes tous les deux partants. L'autre parent s'appelle Sam, et elle ou il a recu votre prenom aussi. Voulez-vous que je lance une conversation a deux?";

describe('same-activity copy', () => {
  it('keeps the six locked lines byte for byte', () => {
    expect(SAME_ACTIVITY_OFFER_EN).toBe(
      "Another family nearby is looking at the same {activity}. Want me to check if they'd go together? I won't share anything about you unless they say yes too.",
    );
    expect(SAME_ACTIVITY_OFFER_FR).toBe(
      'Une autre famille pres de chez vous regarde la meme activite: {activity}. Voulez-vous que je voie si elle serait partante pour y aller ensemble? Je ne partage rien sur vous sans son accord aussi.',
    );
    expect(SAME_ACTIVITY_WAITING_EN).toBe(
      "Asked. If they're in, I'll let you know; if not, I won't bring it up again. Nothing to do for now.",
    );
    expect(SAME_ACTIVITY_WAITING_FR).toBe(
      "C'est demande. Si elle est partante, je vous le dis; sinon, je n'en reparle pas. Rien a faire pour l'instant.",
    );
    expect(SAME_ACTIVITY_CONFIRMATION_EN).toBe(
      "You're both up for it. The other parent is {firstName}, and they got your first name too. Want me to start a chat with the two of you?",
    );
    expect(SAME_ACTIVITY_CONFIRMATION_FR).toBe(
      "Vous etes tous les deux partants. L'autre parent s'appelle {firstName}, et elle ou il a recu votre prenom aussi. Voulez-vous que je lance une conversation a deux?",
    );
    for (const line of [
      SAME_ACTIVITY_OFFER_EN,
      SAME_ACTIVITY_OFFER_FR,
      SAME_ACTIVITY_WAITING_EN,
      SAME_ACTIVITY_WAITING_FR,
      SAME_ACTIVITY_CONFIRMATION_EN,
      SAME_ACTIVITY_CONFIRMATION_FR,
    ]) {
      expect(line).not.toMatch(BANNED);
      expect(line).not.toContain(OPT_OUT_LINE);
      expect(line).not.toContain(OPT_OUT_SHORT);
      expect(line.includes('\n')).toBe(false);
      expect(line.startsWith('TODO-Design')).toBe(false);
    }
  });

  it('fills the activity and the other parent’s given name, and lets only that leave', () => {
    const offer = renderSameActivityReply('not_opted_in', { activity: 'swim', language: 'en' });
    expect(offer.text).toBe(OFFER_EN_SWIM);
    expect(offer.mayLeave).toBe(true);
    expect(offer.text).not.toContain('Sam');
    expect(
      renderSameActivityReply('unread', { activity: 'swim', language: 'fr', firstName: 'Sam' })
        .text,
    ).toBe(OFFER_FR_SWIM);
    expect(renderSameActivityReply('waiting', { language: 'en' }).text).toBe(
      SAME_ACTIVITY_WAITING_EN,
    );
    expect(renderSameActivityReply('waiting', { language: 'fr', firstName: 'Sam' }).text).toBe(
      SAME_ACTIVITY_WAITING_FR,
    );
    const confirmation = renderSameActivityReply('mutual', {
      language: 'en',
      firstName: 'Sam Lee',
    });
    expect(confirmation.text).toBe(CONFIRM_EN_SAM);
    expect(confirmation.mayLeave).toBe(true);
    expect(renderSameActivityReply('mutual', { language: 'fr', firstName: 'Sam' }).text).toBe(
      CONFIRM_FR_SAM,
    );
    expect(renderSameActivityReply('mutual', { language: 'en' }).mayLeave).toBe(false);
    expect(sameActivityCopyMayLeave('Both households said yes.')).toBe(false);
    expect(sameActivityCopyMayLeave(`${OFFER_EN_SWIM}\nSay stop`)).toBe(false);
    expect(deliverSameActivityReply(confirmation.text)).toEqual({
      sent: false,
      skipped: 'not_configured',
    });
    expect(sameActivityDeclineToOtherSide()).toEqual({ sent: false, skipped: 'decline' });
  });

  it('reads only a whole-message meet, join, or no', () => {
    expect(readSameActivityChoice('Meet.')).toBe('meet');
    expect(readSameActivityChoice(' JOIN ')).toBe('join_group');
    expect(readSameActivityChoice('no')).toBe('no');
    for (const body of ['STOP', 'stop', 'meet please', 'join the group', 'yes', '']) {
      expect(readSameActivityChoice(body)).toBeNull();
    }
  });

  it('does not wire a send, and does not read who signed up', () => {
    const files = readdirSync(DIR).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toContain('offer.ts');
    expect(files).toContain('store.ts');
    expect(files).not.toContain('placeholders.ts');
    for (const name of files) {
      const source = readFileSync(`${DIR}${name}`, 'utf8');
      expect(source, name).not.toMatch(
        /twilio|sendSms|withOptOut|activity_bookings|activityBookings/,
      );
      expect(source, name).not.toMatch(/schema\.children|schema\.families/);
    }
  });
});
