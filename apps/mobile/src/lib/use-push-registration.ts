import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Requests notification permission and fetches the Expo push token at app start,
 * then logs it. Storing the token server-side + sending pushes is a TODO (needs
 * a backend token-store endpoint + Apple APNs certs in EAS). Runs once when the
 * user is authenticated.
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
      if (!projectId) return; // TODO(push): set EAS projectId once the project is linked.

      const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
      if (cancelled) return;
      // TODO(push): POST this token to the backend token-store for this user.
      // biome-ignore lint/suspicious/noConsoleLog: scaffold placeholder — logs the token until the server store lands.
      console.log('Expo push token:', token);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
