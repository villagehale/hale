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
 * Step 12 — "Connect to unlock even more." The post-auth connect step, reached from
 * the getting-ready screen once provisioning has landed — so the user is authed and
 * their family exists, which the connect-url flow needs. A TOP-LEVEL route (not the
 * (onboarding) group) so the routing gate, which bounces authed users OUT of
 * onboarding, leaves the post-auth tail alone. "Maybe later" and "Continue" both go
 * on to the closer (step 13); nothing here is required — connecting is opt-in,
 * read-only, and reversible (rule #1/#4).
 */
export default function ConnectScreen() {
  const integrations = useApi<MobileIntegrationsResponse>('/api/mobile/integrations');
  const toClose = () => router.replace('/consent');

  return (
    <Screen scroll className="gap-6">
      <View className="items-center gap-2 pt-4">
        <AppText variant="display" className="text-center text-[27px] leading-[34px]">
          Connect to unlock{'\n'}even more.
        </AppText>
        <AppText variant="meta" className="text-center text-caption">
          You can always add these later.
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip for now"
          onPress={toClose}
          className="items-center py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            Maybe later
          </AppText>
        </Pressable>
        <Button label="Continue" onPress={toClose} />
      </View>
    </Screen>
  );
}
