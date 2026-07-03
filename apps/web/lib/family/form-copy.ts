/**
 * Shared user-facing copy for the family / settings form outcomes, so the two
 * distinct auth boundaries never drift apart or blur into one another:
 *
 *  - PREVIEW_NOTE: auth genuinely isn't configured here (a dev/preview deploy).
 *    Nothing can be saved — an honest statement of the environment.
 *  - SIGNED_OUT_NOTE: auth IS configured but the caller's session expired. This
 *    is a real user who must sign in again; showing them the preview note would
 *    imply their edit could never save, which is false. The message keeps the
 *    typed input intact so their change saves once they sign back in.
 */
export const PREVIEW_NOTE = "sign-in isn't configured in this preview, so nothing was saved.";

export const SIGNED_OUT_NOTE =
  "you've been signed out — sign in again and your changes will save.";
