import type { TextConnectProvider } from '~/lib/channel/connect/text-connect';

/**
 * Outward copy for /connect and /connected. Strings match connect-design-final
 * HTML, including curly quotes and the non-breaking spaces the design uses
 * before "ticked" and "confirm". SMS receipts stay in text-connect.ts (GSM-7,
 * straight apostrophes). The bubble on the done page is that locked receipt
 * set in type, so the apostrophes are the only difference.
 *
 * Redeem error sentences are the ones channel-link-actions.ts returns. They
 * are matched here, not rewritten.
 */

export type CopyPart = string | { nw: string } | { br: true };

export const CONNECT_PREVIEW_STATES = [
  'gmail-landing',
  'gcal-landing',
  'gmail-handoff',
  'gmail-success',
  'gcal-success',
  'denied',
  'partial-scope',
  'expired',
  'error',
  'retry',
  'already-connected',
  'missing-link',
  'disconnect',
] as const;

export type ConnectPreviewState = (typeof CONNECT_PREVIEW_STATES)[number];

export function isConnectPreviewState(value: string | undefined): value is ConnectPreviewState {
  return CONNECT_PREVIEW_STATES.some((state) => state === value);
}

/** Dev-server screenshots only. Production and vitest never take this path. */
export function connectPreviewEnabled(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv === 'development';
}

const NBSP = '\u00A0';

export interface LandingCopy {
  provider: TextConnectProvider;
  aria: string;
  eyebrow: string;
  title: CopyPart[];
  lede: CopyPart[];
  note: string;
  reads: CopyPart[][];
  never: CopyPart[][];
  disconnect: CopyPart[];
}

export interface StatusCopy {
  aria: string;
  icon: 'mail' | 'calendar' | 'x' | 'check' | 'clock' | 'info' | 'link' | 'people';
  paired?: boolean;
  amber?: boolean;
  heading: CopyPart[];
  lede: CopyPart[];
  detail?: CopyPart[];
  help?: { title: string; body: CopyPart[] };
  bubble?: CopyPart[];
  sms?: boolean;
  retry?: boolean;
}

const BOX: Record<TextConnectProvider, string> = {
  gmail: 'Gmail',
  gcal: 'Google Calendar',
};

const NEVER_SHARED: CopyPart[][] = [
  ['See ', { nw: 'your password.' }],
  ['Sell your data, use it for ads, or use it to ', { nw: 'train AI.' }],
];

export function landingCopy(provider: TextConnectProvider): LandingCopy {
  if (provider === 'gmail') {
    return {
      provider,
      aria: 'Connect Gmail',
      eyebrow: 'Gmail',
      title: [{ nw: 'Connect Gmail' }],
      lede: ['So Hale can flag daycare and school notices ', { nw: 'for you.' }],
      note: `Google may show an “unverified app” screen. Tap Advanced, then continue. Make sure the box for Gmail is${NBSP}ticked.`,
      reads: [
        ['The subject, the sender and the first line of each ', { nw: 'new email.' }],
        [
          'It opens an email only when it looks like a date your family has to be somewhere. Hale’s AI reads that one email to pull out ',
          { nw: 'the date.' },
        ],
      ],
      never: [['Send, delete or change ', { nw: 'your email.' }], ...NEVER_SHARED],
      disconnect: [
        'You can disconnect any time. Tell Hale in your texts, and it deletes its keys to your Gmail ',
        { nw: 'right away.' },
      ],
    };
  }
  return {
    provider,
    aria: 'Connect your calendar',
    eyebrow: 'Google Calendar',
    title: ['Connect ', { nw: 'your calendar' }],
    lede: ['So Hale can catch class invites and trip dates for ', { nw: 'the kids.' }],
    note: `Google may show an “unverified app” screen. Tap Advanced, then continue. Make sure the box for Google Calendar is${NBSP}ticked.`,
    reads: [
      ['Each event’s title, notes, time ', { nw: 'and place.' }],
      ['Whether an event moved or ', { nw: 'was cancelled.' }],
    ],
    never: [['Add, change or ', { nw: 'delete events.' }], ...NEVER_SHARED],
    disconnect: [
      'You can disconnect any time. Tell Hale in your texts, and it deletes its keys to your Google Calendar ',
      { nw: 'right away.' },
    ],
  };
}

export const FALLBACK_HEADING = 'Connect';
export const FALLBACK_LEDE = 'One tap signs you in and opens your connected apps.';
export const GOOGLE_BUTTON_LABEL = 'Continue with Google';
export const CONTINUE_LABEL = 'Continue';
export const SIGNING_IN = 'Signing you in…';
export const BACK_TO_TEXTS = 'Back to your texts';
export const TRY_AGAIN_LABEL = 'Try again';
export const READS_TAG = 'What Hale reads · read-only';
export const NEVER_TAG = 'What Hale never does';
export const CHANGED_TAG = 'Changed your mind?';
export const BUBBLE_LABEL = 'In your texts';
export const FOOTER_LEAD = 'Never sold.';
export const FOOTER_PRIVACY = 'Privacy policy';
export const PRONUNCIATION = 'Hale /HAH-leh/ — Hawaiian for home.';

export function connectPageMeta(provider: TextConnectProvider | null): {
  title: string;
  description: string;
} {
  if (provider === 'gmail') {
    return {
      title: 'Connect Gmail',
      description: 'So Hale can flag daycare and school notices for you.',
    };
  }
  if (provider === 'gcal') {
    return {
      title: 'Connect your calendar',
      description: 'So Hale can catch class invites and trip dates for the kids.',
    };
  }
  return { title: 'Connect', description: FALLBACK_LEDE };
}

export const MISSING_TITLE = 'This link is incomplete';
export const MISSING_DESCRIPTION = 'This link is missing or incomplete.';

function freshLine(sentence: string, fresh: boolean | undefined): CopyPart[] {
  if (!fresh) return [sentence];
  return [sentence, { br: true }, 'A fresh link is in ', { nw: 'your texts.' }];
}

function success(provider: TextConnectProvider): StatusCopy {
  if (provider === 'gmail') {
    return {
      aria: 'Connected',
      icon: 'mail',
      paired: true,
      amber: true,
      heading: ['Connected'],
      lede: [
        'Gmail is connected. You can close this page, and Hale will text ',
        { nw: `you to${NBSP}confirm.` },
      ],
      bubble: ['Gmail’s connected. I’ll flag daycare and ', { nw: 'school notices.' }],
      detail: ['Changed your mind? Tell Hale in your texts and it ', { nw: 'disconnects Gmail.' }],
    };
  }
  return {
    aria: 'Connected',
    icon: 'calendar',
    paired: true,
    amber: true,
    heading: ['Connected'],
    lede: [
      'Google Calendar is connected. You can close this page, and Hale will text ',
      { nw: `you to${NBSP}confirm.` },
    ],
    bubble: ['Calendar’s connected. I’ll catch class invites and ', { nw: 'trip dates.' }],
    detail: [
      'Changed your mind? Tell Hale in your texts and it disconnects ',
      { nw: 'Google Calendar.' },
    ],
  };
}

function denied(provider: TextConnectProvider | null, fresh: boolean | undefined): StatusCopy {
  return {
    aria: 'Nothing changed',
    icon: 'x',
    heading: ['Nothing changed'],
    lede: freshLine('No changes made.', fresh),
    help: provider
      ? {
          title: 'Trying again?',
          body: [
            `On Google’s screen, make sure the box for ${BOX[provider]} is ticked, then `,
            { nw: 'tap Continue.' },
          ],
        }
      : undefined,
    sms: true,
  };
}

function partial(provider: TextConnectProvider, fresh: boolean | undefined): StatusCopy {
  const box = BOX[provider];
  const lede: CopyPart[] = fresh
    ? [
        'Hale needs that one box to connect, so nothing changed. A fresh link is in ',
        { nw: 'your texts.' },
      ]
    : ['Hale needs that one box to connect, so nothing changed.'];
  return {
    aria: `The box for ${box} wasn’t ticked`,
    icon: 'check',
    heading: [`The box for ${box} wasn’t ticked`],
    lede,
    help: {
      title: 'Next time',
      body: [
        `On Google’s screen, tick the box for ${box}. The box for your name `,
        { nw: 'is optional.' },
      ],
    },
    sms: true,
  };
}

function expired(fresh: boolean | undefined): StatusCopy {
  const lede: CopyPart[] = fresh
    ? ['That link has expired.', { br: true }, 'A fresh one is in ', { nw: 'your texts.' }]
    : ['That link has expired.'];
  return {
    aria: 'Link expired',
    icon: 'clock',
    heading: ['Link expired'],
    lede,
    detail: ['Connect links work for ', { nw: '15 minutes.' }],
    sms: true,
  };
}

function broken(fresh: boolean | undefined, lede?: string): StatusCopy {
  return {
    aria: 'Not connected',
    icon: 'info',
    heading: ['Not connected'],
    lede: lede ? [lede] : freshLine('That didn’t go through.', fresh),
    sms: true,
  };
}

export function missingLink(): StatusCopy {
  return {
    aria: MISSING_TITLE,
    icon: 'link',
    heading: [MISSING_TITLE],
    lede: ['This link is missing ', { nw: 'or incomplete.' }],
    detail: [
      'Open it straight from Hale’s text, or ask Hale in your texts for a ',
      { nw: 'new one.' },
    ],
    sms: true,
  };
}

function retry(): StatusCopy {
  return {
    aria: 'That didn’t open',
    icon: 'link',
    heading: ['That didn’t open'],
    lede: ['This link did not open.', { br: true }, 'Tap it again in ', { nw: 'a moment.' }],
    retry: true,
  };
}

function already(options?: { name?: string; language?: 'en' | 'fr' }): StatusCopy {
  const named = options?.name?.trim();
  if (options?.language === 'fr' && named) {
    return {
      aria: 'Deja connecte',
      icon: 'people',
      heading: ['Deja connecte'],
      lede: [`Ce lien est pour ${named}. Le tien est deja connecte.`],
    };
  }
  if (options?.language === 'fr') {
    return {
      aria: 'Deja connecte',
      icon: 'people',
      heading: ['Deja connecte'],
      lede: ['Ce lien est pour le parent a qui il a ete envoye. Le tien est deja connecte.'],
    };
  }
  if (named) {
    return {
      aria: 'Already connected',
      icon: 'people',
      heading: ['Already connected'],
      lede: [
        `This link is for ${named}. Your Google account is already connected to Hale, so `,
        { nw: 'nothing changed.' },
      ],
      detail: [`${named} can connect their own Google account from `, { nw: 'this link.' }],
    };
  }
  return {
    aria: 'Already connected',
    icon: 'people',
    heading: ['Already connected'],
    lede: [
      'This link is for the parent it was sent to. Your Google account is already connected to Hale, so nothing changed.',
    ],
  };
}

/**
 * The done page for a (status, provider) pair off the query string. Unknown
 * pairs fail closed. A fresh text is named only when the callback set fresh=sent.
 */
export function connectedStatus(
  status: string | undefined,
  provider: string | undefined,
  options?: { name?: string; language?: 'en' | 'fr'; freshLink?: boolean },
): StatusCopy {
  const connected = provider === 'gmail' || provider === 'gcal' ? provider : null;
  const fresh = options?.freshLink;
  if (status === 'ok' && connected) return success(connected);
  if (status === 'denied') return denied(connected, fresh);
  if (status === 'partial' && connected) return partial(connected, fresh);
  if (status === 'own_link') return already(options);
  if (status === 'invalid') return expired(fresh);
  return broken(fresh);
}

/** Redeem action messages. Kept identical to channel-link-actions.ts. */
export const REDEEM_EXPIRED = 'This link is invalid or has expired.';
export const REDEEM_FRESH_SENT =
  'This link is invalid or has expired. A fresh one is in your texts.';
export const REDEEM_TRY_AGAIN = 'This link did not open. Tap it again in a moment.';
export const REDEEM_UNAVAILABLE = 'Sign-in is not available right now.';

export function redeemErrorStatus(
  message: string,
  _provider: TextConnectProvider | null,
): StatusCopy {
  if (message === REDEEM_TRY_AGAIN) return retry();
  if (message === REDEEM_FRESH_SENT) return expired(true);
  if (message === REDEEM_EXPIRED) return expired(false);
  if (message === REDEEM_UNAVAILABLE) return broken(false, message);
  return broken(false, message);
}

export function flattenCopy(parts: readonly CopyPart[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if ('br' in part) return '\n';
      return part.nw;
    })
    .join('');
}
