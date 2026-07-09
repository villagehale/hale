import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { api } from './api-client';

/**
 * Requests notification permission, fetches the Expo push token at app start, and
 * registers it with the backend token-store for the signed-in user. Runs once when
 * the user is authenticated (`enabled`). The token is a device address, never
 * logged (rule #1); a registration failure is swallowed (best-effort — a missing
 * push token isn't worth surfacing an error to the user).
 */
export function usePushRegistration(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web' || !Device.isDevice) return;

    let cancelled = false;
    (async () => {
      const existing = await Notifications.getPermissionsAsync();
      let status = existing.status;
      if (status !== 'granted') {
        status = (await Notifications.requestPermissionsAsync()).status;
      }
      if (status !== 'granted' || cancelled) return;

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      if (!projectId) return; // Fails closed if app config ever loses extra.eas.projectId.

      const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
      if (cancelled) return;

      try {
        await api('/api/push/register', {
          method: 'POST',
          body: JSON.stringify({
            expoPushToken: token,
            platform: Platform.OS === 'ios' ? 'ios' : 'android',
          }),
        });
      } catch {
        // Best-effort: a failed registration just means no pushes yet, not an error
        // worth surfacing. The token is never logged (rule #1).
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
