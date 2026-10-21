import { z } from 'zod';

/**
 * The structured answer a Browser Use signup run must return. The skill
 * (`packages/agent/skills/browser-use-signup.md`) names these values; this file
 * is the schema sent as `outputSchema` and the parser for what comes back.
 */
export const BROWSER_USE_SIGNUP_OUTCOMES = [
  'reached_checkout',
  'waitlist',
  'sold_out',
  'needs_login',
  'needs_human',
  'error',
] as const;

export type BrowserUseSignupOutcome = (typeof BROWSER_USE_SIGNUP_OUTCOMES)[number];

export const BROWSER_USE_SIGNUP_DETAILS = [
  'none',
  'captcha',
  'verification_code',
  'login_wall',
  'waiting_room',
  'waiver',
  'medical',
  'unexpected_field',
  'session_not_found',
  'price_change',
  'page_error',
] as const;

export type BrowserUseSignupDetail = (typeof BROWSER_USE_SIGNUP_DETAILS)[number];

const signupOutput = z.object({
  outcome: z.enum(BROWSER_USE_SIGNUP_OUTCOMES),
  detail: z.enum(BROWSER_USE_SIGNUP_DETAILS),
  checkout_url: z.string().nullable(),
  cart_total_cents: z.number().int().nonnegative().nullable(),
  hold_minutes: z.number().int().positive().nullable(),
  payment_details_entered: z.boolean(),
});

export type BrowserUseSignupOutput = z.infer<typeof signupOutput>;

export const BROWSER_USE_SIGNUP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'detail',
    'checkout_url',
    'cart_total_cents',
    'hold_minutes',
    'payment_details_entered',
  ],
  properties: {
    outcome: { type: 'string', enum: [...BROWSER_USE_SIGNUP_OUTCOMES] },
    detail: { type: 'string', enum: [...BROWSER_USE_SIGNUP_DETAILS] },
    checkout_url: { type: ['string', 'null'] },
    cart_total_cents: { type: ['integer', 'null'], minimum: 0 },
    hold_minutes: { type: ['integer', 'null'], minimum: 1 },
    payment_details_entered: { type: 'boolean' },
  },
};

export function parseSignupOutput(raw: unknown): BrowserUseSignupOutput | null {
  const parsed = signupOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const confirmationOutput = z.object({
  on_confirmation_page: z.boolean(),
  confirmation_number: z.string().trim().min(1).max(100).nullable(),
});

export type BrowserUseConfirmationOutput = z.infer<typeof confirmationOutput>;

export const BROWSER_USE_CONFIRMATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['on_confirmation_page', 'confirmation_number'],
  properties: {
    on_confirmation_page: { type: 'boolean' },
    confirmation_number: { type: ['string', 'null'] },
  },
};

export function parseConfirmationOutput(raw: unknown): BrowserUseConfirmationOutput | null {
  const parsed = confirmationOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Only an https page on the provider's own host family is handed to the parent. */
export function sameProviderHttpsUrl(raw: string | null, registrationUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const home = new URL(registrationUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');
    const site = (host: string) => bare(host).split('.').slice(-2).join('.');
    return site(url.hostname) === site(home.hostname) ? url.href : null;
  } catch {
    return null;
  }
}
