import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { ConnectorsList, ConnectorsPrivacyNote } from '@/components/hale/connectors-list';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import type { MobileIntegrationsResponse } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

/**
 * The post-account connect step. Reached AFTER account creation succeeds (the root
 * layout's resume effect provisions the family, then routes here) — so the user is
 * authed and their family exists, which the connect-url flow needs. It lives as a
 * TOP-LEVEL route (not in the (onboarding) group) precisely so the routing gate,
 * which bounces authed users OUT of onboarding, leaves them here.
 *
 * Skippable: "Maybe later" and "Continue" both go to the tabs. Nothing here is
 * required — connecting is opt-in, read-only, and reversible (rule #1/#4).
 */
export default function ConnectScreen() {
  const integrations = useApi<MobileIntegrationsResponse>('/api/mobile/integrations');
  const toApp = () => router.replace('/(tabs)');

  return (
    <Screen scroll className="gap-6">
      <View className="gap-2 pt-4">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-accent">
          You're in control
        </AppText>
        <AppText variant="display">Connect to unlock even more</AppText>
        <AppText variant="body">
          Link a read-only Google account and Hale can help with what's already on your plate.
          Everything below is optional — connect what you like, skip the rest.
        </AppText>
      </View>

      {integrations.status === 'loading' ? <LoadingState /> : null}
      {integrations.status === 'error' ? (
        <ErrorState message={integrations.error ?? ''} onRetry={integrations.reload} />
      ) : null}
      {integrations.status === 'ready' && integrations.data ? (
        <View className="gap-6">
          <ConnectorsList
            connectors={integrations.data.connectors}
            onRefresh={integrations.refresh}
          />
          <ConnectorsPrivacyNote />
        </View>
      ) : null}

      <View className="gap-3">
        <Button label="Continue" onPress={toApp} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip for now"
          onPress={toApp}
          className="items-center py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            Maybe later
          </AppText>
        </Pressable>
      </View>
    </Screen>
  );
}
