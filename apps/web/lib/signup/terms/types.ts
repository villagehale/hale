import type {
  SignupTermsAmount,
  SignupTermsApproved,
  SignupTermsApprovedSession,
  SignupTermsHold,
  SignupTermsShown,
  SignupTermsTaxBound,
} from '@hale/db';
import { z } from 'zod';

export type {
  SignupTermsAmount,
  SignupTermsApproved,
  SignupTermsApprovedSession,
  SignupTermsHold,
  SignupTermsShown,
  SignupTermsTaxBound,
};

/** What differed between the approval and the cart. `unread`: the cart could not be read. */
export type CartDifference = 'price' | 'fees' | 'session' | 'kid' | 'quantity' | 'unread';

/** The `cart_read` block a bound run copies off the page. Null when the page does not show it. */
export const cartReadSchema = z.object({
  provider_course_id: z.string().trim().min(1).max(80).nullable(),
  session_label: z.string().trim().min(1).max(200).nullable(),
  session_date: z.string().trim().min(1).max(20).nullable(),
  session_time: z.string().trim().min(1).max(10).nullable(),
  participant_first_name: z.string().trim().min(1).max(80).nullable(),
  line_count: z.number().int().nonnegative().nullable(),
  quantity: z.number().int().nonnegative().nullable(),
});

export type CartRead = z.infer<typeof cartReadSchema>;

export const CART_READ_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'provider_course_id',
    'session_label',
    'session_date',
    'session_time',
    'participant_first_name',
    'line_count',
    'quantity',
  ],
  properties: {
    provider_course_id: { type: ['string', 'null'] },
    session_label: { type: ['string', 'null'] },
    session_date: { type: ['string', 'null'] },
    session_time: { type: ['string', 'null'] },
    participant_first_name: { type: ['string', 'null'] },
    line_count: { type: ['integer', 'null'], minimum: 0 },
    quantity: { type: ['integer', 'null'], minimum: 0 },
  },
};

/** Ontario's combined sales tax. The two registry portals (Markham, Oakville) charge it. */
export const ONTARIO_TAX_BASIS_POINTS = 1300;
/** The most tax that can pass on a portal whose province Hale does not know. */
export const TAX_CEILING_BASIS_POINTS = 1500;
