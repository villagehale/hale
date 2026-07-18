import { api } from './api-client';
import type {
  MobileFamilyUpdateRequest,
  MobileFamilyUpdateResponse,
  MobileInviteResponse,
  MobilePreferencesUpdateRequest,
  MobilePreferencesUpdateResponse,
  MobilePushPrefsUpdateRequest,
  MobilePushPrefsUpdateResponse,
  MobileSettingsUpdateRequest,
  MobileSettingsUpdateResponse,
} from './api-types';

/**
 * The native Family/Settings write calls. Both POST to the mobile routes that
 * delegate to the SAME web server actions the browser uses — the app never
 * re-implements validation or the audit write; it just posts the intent. The
 * shared api() client attaches the Bearer token, extracts the route's `error`
 * message on a non-2xx (surfaced to the caller), and bounces to sign-in on 401.
 */

export async function updateFamily(body: MobileFamilyUpdateRequest): Promise<void> {
  await api<MobileFamilyUpdateResponse>('/api/mobile/family', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Mint a co-parent invite and return its single-use redeem link. POSTs the mobile
 * invite route, which reuses the SAME createFamilyInvite lib the browser uses —
 * resolving the caller's family (rule #5 consent) and writing the audit row (rule
 * #6). A 403 (no family) / 501 (auth unconfigured) surfaces as an ApiError the caller
 * maps to an honest "not ready yet" state. */
export async function createInvite(): Promise<string> {
  const { link } = await api<MobileInviteResponse>('/api/mobile/invite', { method: 'POST' });
  return link;
}

export async function updateSettings(body: MobileSettingsUpdateRequest): Promise<void> {
  await api<MobileSettingsUpdateResponse>('/api/mobile/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Set the parent's display preferences (units + first day of week). POSTs the
 * preferences route, which delegates to the SAME shared web action the browser
 * uses — resolving the family and writing the audit row (rules #1/#6). */
export async function updatePreferences(body: MobilePreferencesUpdateRequest): Promise<void> {
  await api<MobilePreferencesUpdateResponse>('/api/mobile/preferences', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Toggle one PUSH stream (new picks / health reminders). PATCHes the notifications
 * route, which resolves the family + audits the change (rules #1/#6). */
export async function updatePushPref(body: MobilePushPrefsUpdateRequest): Promise<void> {
  await api<MobilePushPrefsUpdateResponse>('/api/mobile/settings/notifications', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
