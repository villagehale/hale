import { z } from 'zod';

/**
 * One real option the Browser Use agent copied off the provider page.
 * Hale never invents these; the parent picks.
 */
export const siteChoiceSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  starts_at: z.string().trim().min(1).max(80).nullable(),
  price_cents: z.number().int().nonnegative().nullable(),
  waitlist: z.boolean(),
  billing_note: z.string().trim().max(240).nullable(),
  provider_email: z.string().trim().email().max(200).nullable().optional(),
});

export type SiteChoice = z.infer<typeof siteChoiceSchema>;

export const siteFeesSchema = z.object({
  session_cents: z.number().int().nonnegative().nullable(),
  admin_cents: z.number().int().nonnegative().nullable(),
  membership_cents: z.number().int().nonnegative().nullable(),
  total_cents: z.number().int().nonnegative().nullable(),
  billing_note: z.string().trim().max(240).nullable(),
});

export type SiteFees = z.infer<typeof siteFeesSchema>;

export const SITE_CHOICE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'starts_at', 'price_cents', 'waitlist', 'billing_note'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    starts_at: { type: ['string', 'null'] },
    price_cents: { type: ['integer', 'null'], minimum: 0 },
    waitlist: { type: 'boolean' },
    billing_note: { type: ['string', 'null'] },
    provider_email: { type: ['string', 'null'] },
  },
};

export const SITE_FEES_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['session_cents', 'admin_cents', 'membership_cents', 'total_cents', 'billing_note'],
  properties: {
    session_cents: { type: ['integer', 'null'], minimum: 0 },
    admin_cents: { type: ['integer', 'null'], minimum: 0 },
    membership_cents: { type: ['integer', 'null'], minimum: 0 },
    total_cents: { type: ['integer', 'null'], minimum: 0 },
    billing_note: { type: ['string', 'null'] },
  },
};
