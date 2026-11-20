import { z } from 'zod';
import {
  SITE_CHOICE_JSON_SCHEMA,
  SITE_FEES_JSON_SCHEMA,
  siteChoiceSchema,
  siteFeesSchema,
} from '../site-choices';

/**
 * The structured answer a Browser Use signup run must return. The skill
 * (`packages/agent/skills/browser-use-signup.md`) names these values; this file
 * is the schema sent as `outputSchema` and the parser for what comes back.
 */
export const BROWSER_USE_SIGNUP_OUTCOMES = [
  'reached_checkout',
  'rush',
  'waitlist',
  'sold_out',
  'options_mismatch',
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
  'password_rejected',
  'waiting_room',
  'timed_open',
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
  opens_at: z.string().trim().min(1).max(120).nullable().default(null),
  cart_currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/)
    .nullable()
    .catch(null)
    .default(null),
  payment_hosts: z.array(z.string()).max(40).catch([]).default([]),
  password_rejection_message: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .catch(null)
    .default(null),
  password_rule: z.string().trim().min(1).max(240).nullable().catch(null).default(null),
  site_choices: z.array(siteChoiceSchema).max(20).catch([]).default([]),
  seats_open: z.number().int().nonnegative().nullable().catch(null).default(null),
  fees: siteFeesSchema.nullable().catch(null).default(null),
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
    'opens_at',
    'cart_currency',
    'payment_hosts',
    'password_rejection_message',
    'password_rule',
    'site_choices',
    'seats_open',
    'fees',
  ],
  properties: {
    outcome: { type: 'string', enum: [...BROWSER_USE_SIGNUP_OUTCOMES] },
    detail: { type: 'string', enum: [...BROWSER_USE_SIGNUP_DETAILS] },
    checkout_url: { type: ['string', 'null'] },
    cart_total_cents: { type: ['integer', 'null'], minimum: 0 },
    hold_minutes: { type: ['integer', 'null'], minimum: 1 },
    payment_details_entered: { type: 'boolean' },
    opens_at: { type: ['string', 'null'] },
    cart_currency: { type: ['string', 'null'] },
    payment_hosts: { type: 'array', items: { type: 'string' } },
    password_rejection_message: { type: ['string', 'null'] },
    password_rule: { type: ['string', 'null'] },
    site_choices: { type: 'array', items: SITE_CHOICE_JSON_SCHEMA },
    seats_open: { type: ['integer', 'null'], minimum: 0 },
    fees: { anyOf: [SITE_FEES_JSON_SCHEMA, { type: 'null' }] },
  },
};

export function parseSignupOutput(raw: unknown): BrowserUseSignupOutput | null {
  const parsed = signupOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * VIL-558 · the answer a day-before-plan run returns (`browser-use-plan-signup`). The
 * run waits through the open's queue, so there is no `rush`; `not_open` means the
 * registration still had not opened when the run had to stop.
 */
export const BROWSER_USE_PLAN_OUTCOMES = [
  'reached_checkout',
  'not_open',
  'waitlist',
  'sold_out',
  'options_mismatch',
  'needs_login',
  'needs_human',
  'error',
] as const;

const planOutput = z.object({
  outcome: z.enum(BROWSER_USE_PLAN_OUTCOMES),
  detail: z.enum(BROWSER_USE_SIGNUP_DETAILS),
  choice_index: z.number().int().nonnegative().nullable(),
  checkout_url: z.string().nullable(),
  cart_total_cents: z.number().int().nonnegative().nullable(),
  cart_currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/)
    .nullable()
    .catch(null),
  hold_minutes: z.number().int().positive().nullable(),
  saved_card_on_file: z.boolean(),
  security_code_required: z.boolean(),
  payment_details_entered: z.boolean(),
  password_rejection_message: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .catch(null)
    .default(null),
  password_rule: z.string().trim().min(1).max(240).nullable().catch(null).default(null),
  site_choices: z.array(siteChoiceSchema).max(20).catch([]).default([]),
  seats_open: z.number().int().nonnegative().nullable().catch(null).default(null),
  fees: siteFeesSchema.nullable().catch(null).default(null),
});

export type BrowserUsePlanOutput = z.infer<typeof planOutput>;

export const BROWSER_USE_PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'detail',
    'choice_index',
    'checkout_url',
    'cart_total_cents',
    'cart_currency',
    'hold_minutes',
    'saved_card_on_file',
    'security_code_required',
    'payment_details_entered',
    'password_rejection_message',
    'password_rule',
    'site_choices',
    'seats_open',
    'fees',
  ],
  properties: {
    outcome: { type: 'string', enum: [...BROWSER_USE_PLAN_OUTCOMES] },
    detail: { type: 'string', enum: [...BROWSER_USE_SIGNUP_DETAILS] },
    choice_index: { type: ['integer', 'null'], minimum: 0 },
    checkout_url: { type: ['string', 'null'] },
    cart_total_cents: { type: ['integer', 'null'], minimum: 0 },
    cart_currency: { type: ['string', 'null'] },
    hold_minutes: { type: ['integer', 'null'], minimum: 1 },
    saved_card_on_file: { type: 'boolean' },
    security_code_required: { type: 'boolean' },
    password_rejection_message: { type: ['string', 'null'] },
    password_rule: { type: ['string', 'null'] },
    site_choices: { type: 'array', items: SITE_CHOICE_JSON_SCHEMA },
    seats_open: { type: ['integer', 'null'], minimum: 0 },
    fees: { anyOf: [SITE_FEES_JSON_SCHEMA, { type: 'null' }] },
    payment_details_entered: { type: 'boolean' },
  },
};

export function parsePlanOutput(raw: unknown): BrowserUsePlanOutput | null {
  const parsed = planOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The answer the checkout review returns (`browser-use-checkout-review`): the saved card
 * chosen, the last page before "place order" reached, and the total that would be charged
 * there. Hale's code, not the agent, decides from it whether the card may be used.
 */
export const BROWSER_USE_REVIEW_OUTCOMES = ['ready_to_place', 'needs_human', 'error'] as const;

export const BROWSER_USE_REVIEW_DETAILS = [
  'none',
  'captcha',
  'verification_code',
  'waiver',
  'medical',
  'unexpected_field',
  'no_saved_card',
  'page_error',
] as const;

const reviewOutput = z.object({
  outcome: z.enum(BROWSER_USE_REVIEW_OUTCOMES),
  detail: z.enum(BROWSER_USE_REVIEW_DETAILS),
  total_cents: z.number().int().nonnegative().nullable(),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/)
    .nullable()
    .catch(null),
  tax_cents: z.number().int().nonnegative().nullable(),
  fees_cents: z.number().int().nonnegative().nullable(),
  saved_card_selected: z.boolean(),
  order_placed: z.boolean(),
});

export type BrowserUseReviewOutput = z.infer<typeof reviewOutput>;

export const BROWSER_USE_REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'detail',
    'total_cents',
    'currency',
    'tax_cents',
    'fees_cents',
    'saved_card_selected',
    'order_placed',
  ],
  properties: {
    outcome: { type: 'string', enum: [...BROWSER_USE_REVIEW_OUTCOMES] },
    detail: { type: 'string', enum: [...BROWSER_USE_REVIEW_DETAILS] },
    total_cents: { type: ['integer', 'null'], minimum: 0 },
    currency: { type: ['string', 'null'] },
    tax_cents: { type: ['integer', 'null'], minimum: 0 },
    fees_cents: { type: ['integer', 'null'], minimum: 0 },
    saved_card_selected: { type: 'boolean' },
    order_placed: { type: 'boolean' },
  },
};

export function parseReviewOutput(raw: unknown): BrowserUseReviewOutput | null {
  const parsed = reviewOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const BROWSER_USE_PAYMENT_OUTCOMES = ['paid', 'declined', 'needs_human', 'error'] as const;

export const BROWSER_USE_PAYMENT_DETAILS = [
  'none',
  'amount_changed',
  'verification_code',
  'waiver',
  'medical',
  'unexpected_field',
  'page_error',
] as const;

const paymentOutput = z.object({
  outcome: z.enum(BROWSER_USE_PAYMENT_OUTCOMES),
  detail: z.enum(BROWSER_USE_PAYMENT_DETAILS),
  confirmation_number: z.string().trim().min(1).max(100).nullable(),
  amount_charged_cents: z.number().int().nonnegative().nullable(),
});

export type BrowserUsePaymentOutput = z.infer<typeof paymentOutput>;

export const BROWSER_USE_PAYMENT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'detail', 'confirmation_number', 'amount_charged_cents'],
  properties: {
    outcome: { type: 'string', enum: [...BROWSER_USE_PAYMENT_OUTCOMES] },
    detail: { type: 'string', enum: [...BROWSER_USE_PAYMENT_DETAILS] },
    confirmation_number: { type: ['string', 'null'] },
    amount_charged_cents: { type: ['integer', 'null'], minimum: 0 },
  },
};

export function parsePaymentOutput(raw: unknown): BrowserUsePaymentOutput | null {
  const parsed = paymentOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Where the card may be typed: the provider's own host first, then the payment
 * hosts the checkout page showed. Bare hostnames only, at most 20.
 */
export function cardAllowedDomains(registrationUrl: string, reported: readonly string[]): string[] {
  const home = new URL(registrationUrl).hostname.toLowerCase();
  const hosts = [home, ...reported.map((host) => host.trim().toLowerCase())];
  return [...new Set(hosts.filter((host) => HOSTNAME.test(host)))].slice(0, 20);
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
