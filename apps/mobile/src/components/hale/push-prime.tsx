import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { pushDecisionStorage } from '@/lib/push-decision-storage';
import { nextPromptAction } from '@/lib/push-permission';
import {
  currentOsPermission,
  pushSupported,
  registerPushToken,
  requestOsPermission,
} from '@/lib/push-registration';

/**
 * The moment-of-value push explainer. Drop `<PushPrime active={…}/>` at a value surface
 * (a first approval, a Sunday plan enrollment); when `active` turns true it decides via
 * nextPromptAction whether to silently register (OS already granted), offer this
 * explainer (undetermined + not recently declined), or do nothing. The OS prompt only
 * fires after the parent accepts here — Hale never surfaces the raw OS prompt cold. A
 * decline (or dismiss) is remembered so it doesn't ask again for the re-ask window.
 */
export function PushPrime({ active }: { active: boolean }) {
  const [offering, setOffering] = useState(false);

  useEffect(() => {
    if (!active || !pushSupported()) return;
    let cancelled = false;
    (async () => {
      const [os, stored] = await Promise.all([
        currentOsPermission(),
        pushDecisionStorage.get(),
      ]);
      if (cancelled) return;
      const action = nextPromptAction(os, stored, new Date());
      if (action === 'register') await registerPushToken();
      else if (action === 'offer') setOffering(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const onEnable = async () => {
    setOffering(false);
    const os = await requestOsPermission();
    if (os === 'granted') await registerPushToken();
    // A denial at the OS prompt is a decline — remember it so we don't re-offer.
    else await pushDecisionStorage.recordDecline();
  };

  const onDismiss = async () => {
    setOffering(false);
    await pushDecisionStorage.recordDecline();
  };

  return (
    <Sheet visible={offering} onClose={onDismiss} title="Stay a step ahead">
      <View className="gap-5 pb-2">
        <AppText variant="body" className="text-ink-2">
          Hale can nudge you before things are due — a check-up next week, your Sunday plan, an
          activity worth grabbing nearby. No spam, just the heads-up you&rsquo;d want.
        </AppText>
        <View className="gap-2.5">
          <Button label="Turn on notifications" onPress={onEnable} />
          <Button label="Not now" variant="secondary" onPress={onDismiss} />
        </View>
      </View>
    </Sheet>
  );
}
