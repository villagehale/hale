import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import { maskPhoneE164 } from '~/lib/channels/phone';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import type { LoadLoopPrefsResult } from '~/lib/settings/loop-prefs';

/** Fictional NANP number (555 exchange). Shown masked on Settings. */
export const DEMO_PHONE_E164 = '+14165554821';

export const DEMO_BASE = '/demo/portal';

export const DEMO_SIGN_IN = '/demo/sign-in';

/** Published Hale line, so Text Hale is a real `sms:` link in the demo. */
const DEMO_HALE_LINE = '+16462352164';

export const demoMembers: FamilyMembersView = {
  primary: { name: 'Pat', email: null, role: 'primary_parent' },
  coParent: null,
};

export const demoBasics: FamilyBasicsView = {
  location: {
    country: 'CA',
    province: 'ON',
    city: 'Toronto',
    postalCode: 'M5V 2T6',
  },
  planTier: 'free',
  intents: ['activities', 'health'],
  foundingNumber: null,
  children: [
    {
      id: 'demo-wren',
      name: 'Wren',
      lastName: null,
      dateOfBirth: '2024-06-01',
      gender: 'unspecified',
      biologicalSex: null,
      interests: [],
      stageLabel: 'toddler',
      avatarUrl: null,
    },
  ],
};

export const demoMaskedPhone = maskPhoneE164(DEMO_PHONE_E164);

export const demoLoop: LoadLoopPrefsResult = {
  status: 'ready',
  prefs: DEFAULT_LOOP_PREFS,
  smsEnrolled: true,
};

export function demoSmsHref(): string | null {
  return haleTextsHref(process.env.LINQ_FROM_E164?.trim() || DEMO_HALE_LINE);
}
