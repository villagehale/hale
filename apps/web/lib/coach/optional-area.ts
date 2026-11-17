import { z } from 'zod';

/**
 * The model sometimes fills an optional `area` with "" or whitespace to mean "none
 * named". That is the omitted case, so it is read as omitted before validation rather
 * than refused, which cost the turn a step (VIL-692, the same bug #1276 fixed in
 * `find_activities`).
 *
 * The wire schema is the inner string. `compileToolSchema` unwraps a preprocess, so
 * `search_village` and `find_activities` stay byte-identical to
 * `z.string().min(1).optional()` in what the model is shown.
 */
export const optionalArea = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);
