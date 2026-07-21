import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from './api-client';
import type { OsPermission } from './push-permission';

/**
 * The push transport: OS-permission reads/prompt and token register/deregister against
 * the backend. Split from the hooks so the value-moment flow, the launch sync, the
 * Settings enable path, and sign-out all share one implementation. The token is a device
 * address — never logged (rule #1); every network step is best-effort (a missing push
 * token isn't worth surfacing an error).
 */

function normalize(status: string): OsPermission {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

/** Whether push can run on this build at all — a real device, not web / the simulator. */
export function pushSupported(): boolean {
  return Platform.OS !== 'web' && Device.isDevice;
}

export async function currentOsPermission(): Promise<OsPermission> {
  return normalize((await Notifications.getPermissionsAsync()).status);
}

/** Show the OS prompt (only meaningful when currently undetermined) and report the result. */
export async function requestOsPermission(): Promise<OsPermission> {
  return normalize((await Notifications.requestPermissionsAsync()).status);
}

async function fetchExpoPushToken(): Promise<string | null> {
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null; // Fails closed if app config ever loses extra.eas.projectId.
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

/** Register this device's Expo token for the signed-in user (upsert on the token). */
export async function registerPushToken(): Promise<void> {
  if (!pushSupported()) return;
  const token = await fetchExpoPushToken();
  if (!token) return;
  try {
    await api('/api/push/register', {
      method: 'POST',
      body: JSON.stringify({
        expoPushToken: token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      }),
    });
  } catch {
    // Best-effort: a failed registration just means no pushes yet (rule #1: no logging).
  }
}

/**
 * Remove this device's token binding — sign-out hygiene. Must run while the session is
 * still authed (the api client attaches the Bearer), so the caller invokes this BEFORE
 * clearing the session. No permission → no token was ever minted → nothing to delete.
 */
export async function deregisterPushToken(): Promise<void> {
  if (!pushSupported()) return;
  if ((await currentOsPermission()) !== 'granted') return;
  const token = await fetchExpoPushToken();
  if (!token) return;
  try {
    await api('/api/push/register', {
      method: 'DELETE',
      body: JSON.stringify({ expoPushToken: token }),
    });
  } catch {
    // Best-effort: an un-deleted token simply dies on its next send (DeviceNotRegistered).
  }
}
