import { describe, expect, it } from 'vitest';
import type { CoParentRefusal } from '~/lib/channel/caregiver/invites';
import {
  coParentDeclineAck,
  coParentDepartedNotice,
  coParentInviteExpired,
  coParentRefusal,
  coParentReferrerUnnamed,
  coParentWelcome,
  inviterNameIsAffordable,
} from './copy';

/**
 * The scripted model writes these lines. The product no longer keeps a
 * sentence table. A name the alphabet cannot carry is still refused before
 * a cold text goes out.
 */

const LONGEST_NAME = 'Marie-Claude Bergeron-Ly';

describe('co-parent copy', () => {
  it('writes a welcome in the language asked, and a different one in French', async () => {
    const en = await coParentWelcome(LONGEST_NAME, 'en');
    const fr = await coParentWelcome(LONGEST_NAME, 'fr');
    expect(en).toBeTruthy();
    expect(fr).toBeTruthy();
    expect(fr).not.toBe(en);
    expect(en).toContain(LONGEST_NAME);
    expect(fr).toContain(LONGEST_NAME);
  });

  it('refuses a name the GSM-7 alphabet cannot carry, and accepts one it can', () => {
    expect(inviterNameIsAffordable(LONGEST_NAME)).toBe(true);
    expect(inviterNameIsAffordable('Zoë')).toBe(false);
    expect(inviterNameIsAffordable('李明')).toBe(false);
    expect(inviterNameIsAffordable('François')).toBe(false);
    expect(inviterNameIsAffordable(null)).toBe(false);
    expect(inviterNameIsAffordable('   ')).toBe(false);
    expect(inviterNameIsAffordable('A'.repeat(25))).toBe(false);
  });

  it('does not name whose account a busy number belongs to', async () => {
    for (const language of ['en', 'fr'] as const) {
      const body = await coParentRefusal('number_in_use', language);
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/family|famille|their|leur/);
    }
  });

  it('writes a French refusal that is not the English one', async () => {
    const reasons: CoParentRefusal[] = [
      'referrer_unnamed',
      'number_in_use',
      'co_parent_seat_taken',
      'previously_declined',
    ];
    for (const reason of reasons) {
      const en = await coParentRefusal(reason, 'en');
      const fr = await coParentRefusal(reason, 'fr');
      expect(en).toBeTruthy();
      expect(fr).not.toBe(en);
    }
    expect(await coParentDeclineAck('fr')).not.toBe(await coParentDeclineAck('en'));
    expect(await coParentReferrerUnnamed('fr')).not.toBe(await coParentReferrerUnnamed('en'));
  });

  it('writes the expired invite and the departure notice without a placeholder', async () => {
    for (const language of ['en', 'fr'] as const) {
      const expired = await coParentInviteExpired(language);
      const departed = await coParentDepartedNotice(language);
      expect(expired).toBeTruthy();
      expect(departed).toBeTruthy();
      expect(departed).not.toMatch(/\$\{|\{\{/);
      expect(departed?.toLowerCase()).toContain('co-parent');
    }
    expect(await coParentDepartedNotice('fr')).not.toBe(await coParentDepartedNotice('en'));
  });
});
