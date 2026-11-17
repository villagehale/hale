import { isEnabled } from '@hale/flags';

/**
 * VIL-541 — onboarding decisions come from fields the model fills, in any language.
 *
 * Off unless FRIEND_VOICE_MODEL_FIELDS_ENABLED is exactly `true`. A trailing
 * newline, `TRUE`, and `1` stay off. Unset stays off. Dark, friend-voice still
 * decides a question, a name ask, a yes, and a connector from `?` and
 * English/French word lists, and may drop a sentence. Lit, those decisions are
 * fields on the reply. A field the model leaves out is a failed reply: nothing
 * is sent, and this module writes no sentence of its own.
 */
export const FRIEND_VOICE_MODEL_FIELDS_ENABLED_ENV = 'FRIEND_VOICE_MODEL_FIELDS_ENABLED';

/** Exact `true`. A trailing newline stays off. */
export function friendVoiceModelFieldsEnabled(): boolean {
  return isEnabled('friend-voice-model-fields');
}
