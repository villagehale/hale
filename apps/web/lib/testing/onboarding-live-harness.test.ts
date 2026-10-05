import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KidItemClassifier } from '~/lib/channel/connect/aha-kids';
import type {
  FriendComposed,
  FriendVoiceComposer,
  FriendVoiceInput,
} from '~/lib/channel/intake/friend-voice';
import { isIdentityChallenge } from '~/lib/channel/intake/identity-challenge';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  LIVE_FROM,
  LIVE_KID_CALENDAR,
  LIVE_KID_MAIL,
  LIVE_SCRIPT,
  runOnboardingReplay,
} from './onboarding-live-harness';

/**
 * The live replay's mechanics without a key: the same walk, the same stub
 * mailbox and calendar, Postgres in-process, with a scripted stand-in for the
 * model that answers the founder script the way the skill asks. Proves the
 * harness reaches every step, lands both receipts on the stored iMessage
 * chat, reads the right rows back, and that a correct conversation passes
 * every rule. The real model is the only thing onboarding-live.test.ts adds.
 */

const APP_KEY = Buffer.alloc(32, 7).toString('base64');

function nextDate(fromKey: string, weekday: number): string {
  const [year, month, day] = fromKey.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, day ?? 1));
  const ahead = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + ahead);
  return date.toISOString().slice(0, 10);
}

function todayKey(input: FriendVoiceInput): string {
  return (input.now ?? new Date('2026-10-05T14:00:00Z')).toISOString().slice(0, 10);
}

/** Answers the founder script. Production does not parse the parent's words; this stand-in does. */
function scripted(input: FriendVoiceInput): FriendComposed {
  const words = input.parentWords.trim();
  const capture: Record<string, unknown> = { children: [], scheduleAdds: [] };

  if (/L7G 4S8/i.test(words)) capture.postalCode = 'L7G 4S8';
  if (/Sebastian and Mia/.test(words)) {
    capture.children = [
      { name: 'Sebastian', ageMonths: 12, agePrecision: 'years' },
      { name: 'Mia', ageMonths: 72, agePrecision: 'years' },
    ];
  }
  if (input.step === 'names' && /^Barton$/.test(words)) capture.parentName = 'Barton';
  if (input.step === 'email' && /^(ok fine|yes|sure)$/i.test(words)) capture.connectGmail = true;
  if (input.step === 'calendar' && /^(ok|yes|sure)$/i.test(words)) capture.connectCalendar = true;
  if (input.step === 'schedule' && /Mia's swim on weekly/.test(words)) {
    const swim = input.findLines.findIndex((line) => /swim kids/i.test(line));
    const library = input.findLines.findIndex((line) => /library/i.test(line));
    const today = todayKey(input);
    capture.scheduleAdds = [
      { line: swim + 1, cadence: 'weekly', date: nextDate(today, 6), time: '11:00', weeks: null },
      { line: library + 1, cadence: 'once', date: nextDate(today, 4), time: '10:30', weeks: null },
    ];
  }
  if (input.step === 'schedule' && /^sounds good$/i.test(words)) capture.scheduleDone = true;
  if (input.step === 'coparent' && /her mom is on iMessage/i.test(words)) {
    capture.coparentGroup = true;
  }

  const known = input.checklist;
  const postalKnown = Boolean(capture.postalCode) || known?.postal === true;
  const kidsKnown = (capture.children as unknown[]).length > 0 || known?.kids === true;
  const nameKnown = Boolean(capture.parentName) || known?.name === true;
  const gmailKnown = capture.connectGmail != null || known?.gmail === true;
  const calendarKnown = capture.connectCalendar != null || known?.calendar === true;
  const scheduleKnown = capture.scheduleDone === true || known?.schedule === true;
  const coparentKnown = capture.coparentGroup != null || known?.coparent === true;
  const who = (capture.parentName as string | undefined) ?? input.parentName;

  if (input.step === 'find_show') {
    return {
      reply: 'Here is what is on near you for their ages.',
      capture,
      groupLeads: (input.findGroups ?? []).map(() => 'Worth a look.'),
    };
  }
  if (input.step === 'connected') {
    const synced = input.synced;
    if (input.connector === 'gmail') {
      const item = synced?.email[0];
      if (!item) return { reply: 'Gmail is connected.', capture, ahaMention: null };
      return {
        reply: `Gmail is connected. One thing for the kids: "${item.subject}" from ${item.fromName ?? 'the school'}. I will flag the date when it gets close.`,
        capture,
        ahaMention: item.subject,
      };
    }
    const swim = synced?.calendar.find((item) => item.title === 'Mia swim');
    const party = synced?.calendar.find((item) => item.title === 'Mia birthday party');
    if (!swim || !party) return { reply: 'Your calendar is connected.', capture, ahaMention: null };
    return {
      reply: `Your calendar is connected. Heads up: ${swim.title} runs right into ${party.title} the same morning.`,
      capture,
      ahaMention: swim.title,
    };
  }
  if (input.step === 'email' && capture.connectGmail === true) {
    return {
      reply:
        "Great, the link is right there. Tap it when you're ready and I'll text you what I see.",
      capture,
    };
  }
  if (input.step === 'email' && /read all my emails/i.test(words)) {
    return {
      reply:
        'I only keep what is about the kids, like school dates, and I never send anything from your account. You can disconnect anytime. Want me to go ahead?',
      capture,
    };
  }
  if (input.step === 'schedule' && (capture.scheduleAdds as unknown[]).length > 0) {
    return {
      reply:
        'Both are on as reminders: Swim Kids 3 on Saturdays and the storytime this Thursday. Anything else from the list?',
      capture,
    };
  }

  let ask: string;
  if (!postalKnown) ask = "Hey, it's Hale. What's your postal code?";
  else if (!kidsKnown) ask = "What are your kids' names?";
  else if (!nameKnown) ask = 'What should I call you?';
  else if (!gmailKnown) {
    ask = `${who ?? 'So'}, want me to watch school email for the kids' dates?`;
  } else if (!calendarKnown) ask = `Want me to check your calendar too, ${who ?? 'friend'}?`;
  else if (!scheduleKnown && input.findLines.length > 0) {
    ask = 'Want any of those on your calendar as reminders?';
  } else if (!coparentKnown) ask = 'Want me to set up a group chat with the other parent?';
  else if (capture.coparentGroup === true) {
    return {
      reply:
        'Great. She can text the line below with the phrase and I will loop her in. She sees the kids plans, not your email.',
      capture,
    };
  } else return { reply: 'Anytime. I am here when you need me.', capture };

  const aside = isIdentityChallenge(words)
    ? 'This is Hale, from Village Hale Technologies Inc. (villagehale.com); the plan details are on the site. '
    : '';
  return { reply: `${aside}${ask}`, capture };
}

const composer: FriendVoiceComposer = { compose: async (input) => scripted(input) };

/** Ground truth for the stub source: the two kid subjects and the two kid events. */
const oracle: KidItemClassifier = {
  async classify(input) {
    const kid = [...LIVE_KID_MAIL, ...LIVE_KID_CALENDAR];
    return {
      kidItemIds: input.items
        .filter((item) => kid.some((title) => item.text.includes(title)))
        .map((item) => item.id),
    };
  },
};

describe('live onboarding replay harness (scripted model)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LIVE_FROM);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('/typing') || target.includes('share_contact_card')) {
          return new Response(null, { status: 204 });
        }
        if (target.includes('/contact_card')) {
          if ((init?.method ?? 'GET') === 'GET') {
            return Response.json({
              contact_cards: [
                { phone_number: LIVE_FROM, first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
              ],
            });
          }
          return Response.json({
            phone_number: LIVE_FROM,
            first_name: HALE_CONTACT_FIRST_NAME,
            is_active: true,
          });
        }
        return new Response(null, { status: 204 });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await db.close();
  });

  it('walks the founder script end to end and a correct conversation passes every rule', async () => {
    const lines: string[] = [];
    const report = await runOnboardingReplay(db.database, {
      friendVoice: composer,
      kidItems: oracle,
      print: (line) => {
        lines.push(line);
        process.stdout.write(`${line}\n`);
      },
    });

    expect(report.turns.map((turn) => turn.inbound)).toEqual([...LIVE_SCRIPT]);
    expect(report.stored.parentName).toBe('Barton');
    expect(report.stored.kidNames.sort()).toEqual(['Mia', 'Sebastian']);
    expect(report.p50Ms).not.toBeNull();
    expect(lines.join('\n')).toContain('--- rule checks ---');
    expect(report.violations).toEqual([]);
  }, 60_000);
});
