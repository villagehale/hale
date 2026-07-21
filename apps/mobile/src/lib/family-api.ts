import { api } from './api-client';
import type {
  MobileFamilyUpdateRequest,
  MobileFamilyUpdateResponse,
  MobileInviteResponse,
  MobileLoopPrefUpdateRequest,
  MobileLoopPrefUpdateResponse,
  MobilePreferencesUpdateRequest,
  MobilePreferencesUpdateResponse,
  MobilePushPrefsUpdateRequest,
  MobilePushPrefsUpdateResponse,
  MobileSettingsUpdateRequest,
  MobileSettingsUpdateResponse,
  MobileTextRevokeResponse,
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

/** Set one F11 loop time preference (quiet-hours start/end, weekly-plan send time).
 * PATCHes the loop route, which validates the field/value, resolves the family, and
 * audits the change (rules #1/#6). Times go as a 24h 'HH:MM'. */
export async function updateLoopPref(body: MobileLoopPrefUpdateRequest): Promise<void> {
  await api<MobileLoopPrefUpdateResponse>('/api/mobile/settings/loop', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** Upload a child's avatar photo (multipart field `file`). Hits the SHARED
 * /api/family/children/:id/avatar route (Bearer-bridged, family-scoped): the server
 * byte-sniffs the type (jpeg/png/webp only), caps at 5 MB, and returns the freshly-
 * signed, cache-busted URL. A 413/415 surfaces as an ApiError the caller maps to honest
 * copy (rules #1/#6). */
export async function uploadChildAvatar(
  childId: string,
  file: { uri: string; name: string; type: string },
): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  return api<{ avatarUrl: string }>(`/api/family/children/${childId}/avatar`, {
    method: 'POST',
    body: form,
    // A photo upload over a mobile network needs more than the 15s default.
    timeoutMs: 60_000,
  });
}

/** Remove a child's avatar photo (back to initials). DELETEs the same route. */
export async function removeChildAvatar(childId: string): Promise<void> {
  await api(`/api/family/children/${childId}/avatar`, { method: 'DELETE' });
}

/** Turn off the parent's SMS channel (VIL-212). DELETEs the text-notifications
 * route, which soft-revokes the channel + records a CASL consent withdrawal + audit
 * in one transaction (rules #1/#6). Re-enrolling requires re-verifying a number. */
export async function revokeTextChannel(): Promise<void> {
  await api<MobileTextRevokeResponse>('/api/mobile/settings/text-notifications', {
    method: 'DELETE',
  });
}
