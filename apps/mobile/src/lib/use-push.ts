import * as Notifications from 'expo-notifications';
import { type Href, router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { notificationRouteFor } from './push-deep-link';
import { currentOsPermission, pushSupported, registerPushToken } from './push-registration';

// Present foreground notifications so a tap flow is reachable while the app is open. The
// per-surface suppression the ticket notes (hide the banner for the thread already open)
// is a follow-up refinement on this handler.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Launch-time token sync: if the OS permission is ALREADY granted, (re)register the
 * token so a rotated one stays current — with NO prompt. A parent who hasn't granted is
 * left alone until a moment of value (see PushPrime); Hale never asks at launch.
 */
export function usePushTokenSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !pushSupported()) return;
    let cancelled = false;
    (async () => {
      if ((await currentOsPermission()) !== 'granted' || cancelled) return;
      await registerPushToken();
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
}

/**
 * Route a notification tap to its deep-linked surface — the cold-start tap that launched
 * the app AND taps while it runs. The target is whitelisted (notificationRouteFor); an
 * unmappable tap is ignored, so a push can never open an arbitrary path.
 */
export function usePushDeepLinks() {
  const handledCold = useRef(false);
  useEffect(() => {
    if (!pushSupported()) return;

    const go = (data: unknown) => {
      const route = notificationRouteFor(data);
      if (route) router.push(route as Href);
    };

    (async () => {
      if (handledCold.current) return;
      handledCold.current = true;
      const last = await Notifications.getLastNotificationResponseAsync();
      if (last) go(last.notification.request.content.data);
    })();

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      go(response.notification.request.content.data);
    });
    return () => sub.remove();
  }, []);
}
