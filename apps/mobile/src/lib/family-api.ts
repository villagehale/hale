import { api } from './api-client';
import type {
  MobileFamilyUpdateRequest,
  MobileFamilyUpdateResponse,
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

export async function updateSettings(body: MobileSettingsUpdateRequest): Promise<void> {
  await api<MobileSettingsUpdateResponse>('/api/mobile/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
