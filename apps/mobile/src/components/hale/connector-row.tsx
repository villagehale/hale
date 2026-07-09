import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, View, Platform } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type { ConnectorState, IntegrationStatus } from '@/lib/api-types';
import { type ConnectorMeta, statusChip } from '@/lib/connectors';
import { disconnectIntegration, fetchConnectUrl } from '@/lib/connectors-api';

/**
 * One connector row — icon, name, one-line benefit, an honest status chip, and a
 * Connect/Disconnect affordance. Shared by the Settings "Connected accounts" section
 * and the onboarding connect step. Connection PLUMBING only: the benefit copy never
 * describes mailbox/calendar content (rule #1).
 *
 * Honesty rules baked in: after opening the consent browser we NEVER assume success
 * — we show a "Checking…" state and re-read the list (onRefresh), so the chip flips
 * to Connected only once the server says so. Disconnect confirms first, then applies
 * an optimistic 'not_connected' that reverts if the POST fails.
 */
export function ConnectorRow({
  meta,
  state,
  onRefresh,
}: {
  meta: ConnectorMeta;
  state: ConnectorState;
  onRefresh: () => Promise<void>;
}) {
  const iconColor = useMeadowColor('ink2');
  const [busy, setBusy] = useState<'connecting' | 'checking' | 'disconnecting' | null>(null);
  // A local, optimistic status that overrides the server state until the next
  // refresh replaces this row's props (e.g. show 'not_connected' the instant a
  // disconnect is confirmed). Cleared back to null once we've re-read.
  const [optimistic, setOptimistic] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = optimistic ?? state.status;
  const chip = statusChip(status);
  const isConnected = status === 'connected';
  const working = busy !== null;

  async function refreshThenClear() {
    await onRefresh();
    setOptimistic(null);
  }

  async function connect() {
    setError(null);
    setBusy('connecting');
    try {
      const url = await fetchConnectUrl(meta.provider);
      // Only iOS resolves this on browser dismiss; Android/web resolve immediately
      // (before the grant lands). We can never read the outcome here — the callback
      // lands it server-side — so this re-read is best-effort, and the list ALSO
      // re-reads when the app returns to the foreground (ConnectorsList) so the chip
      // is correct on every platform once the user comes back.
      setBusy('checking');
      await WebBrowser.openBrowserAsync(url);
      await refreshThenClear();
    } catch (e) {
      setError(connectError(e));
    } finally {
      setBusy(null);
    }
  }

  function confirmDisconnect() {
    // Alert.alert is a silent no-op on react-native-web — the RN-web preview needs
    // the browser confirm or the Disconnect affordance is dead there.
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`Disconnect ${meta.name}? Hale will stop reading from it.`)) {
        void disconnect();
      }
      return;
    }
    Alert.alert(
      `Disconnect ${meta.name}?`,
      'Hale will stop reading from it. You can reconnect any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: disconnect },
      ],
    );
  }

  async function disconnect() {
    setError(null);
    setBusy('disconnecting');
    setOptimistic('not_connected');
    try {
      await disconnectIntegration(meta.provider);
      await refreshThenClear();
    } catch {
      setOptimistic(null);
      setError("Couldn't disconnect just now — please try again.");
      // Re-read rather than trust the last snapshot: in the already-revoked/404
      // case a retry can never succeed and only a fresh read clears the stale chip.
      await onRefresh().catch(() => {});
    } finally {
      setBusy(null);
    }
  }

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-raised">
          <Icon name={meta.icon} size={18} color={iconColor} />
        </View>
        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <AppText variant="section">{meta.name}</AppText>
            <Tag label={busy === 'checking' ? 'Checking…' : chip.label} tone={chip.tone} />
          </View>
          <AppText variant="meta">{meta.benefit}</AppText>
        </View>
      </View>
      <View className="self-start">
        {isConnected ? (
          <Button
            label={busy === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
            variant="secondary"
            onPress={confirmDisconnect}
            disabled={working}
            className="px-5 py-2.5"
          />
        ) : (
          <Button
            label={busy === 'connecting' || busy === 'checking' ? 'Connecting…' : 'Connect'}
            variant="secondary"
            onPress={connect}
            disabled={working}
            className="px-5 py-2.5"
          />
        )}
      </View>
      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

function connectError(e: unknown): string {
  if (e instanceof ApiError && e.message === 'no_family_for_user') {
    return 'Finish setting up your family first, then connect.';
  }
  return "Couldn't start connecting just now — please try again.";
}
