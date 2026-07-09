import { useEffect, useRef } from 'react';
import { AppState, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import type { ConnectorState } from '@/lib/api-types';
import { CONNECTORS } from '@/lib/connectors';
import { ConnectorRow } from './connector-row';

/**
 * The three connector rows, in the fixed CONNECTORS order, each paired with its
 * server state (or a default 'not_connected' when the read hasn't returned a row for
 * it). Shared by the Settings "Connected accounts" section and the onboarding connect
 * step. onRefresh re-reads the list so a row's chip reflects the true server state
 * after a connect/disconnect (never an assumed success).
 *
 * The consent flow opens an external browser whose close only reliably resolves on
 * iOS; on Android/web openBrowserAsync returns before the grant lands, so we ALSO
 * re-read whenever the app returns to the foreground — the moment the user comes back
 * from granting — so the chip flips to Connected without a stale "Not connected".
 */
export function ConnectorsList({
  connectors,
  onRefresh,
}: {
  connectors: ConnectorState[];
  onRefresh: () => Promise<void>;
}) {
  useRefreshOnForeground(onRefresh);
  return (
    <View className="gap-5">
      {CONNECTORS.map((meta) => {
        const state = connectors.find((c) => c.provider === meta.provider) ?? {
          provider: meta.provider,
          status: 'not_connected' as const,
        };
        return <ConnectorRow key={meta.provider} meta={meta} state={state} onRefresh={onRefresh} />;
      })}
    </View>
  );
}

/** Re-read the connector list each time the app returns to the foreground. This is
 * what makes the connect flow honest on Android/web, where the consent browser
 * resolves before the grant completes: coming back to the app is the reliable signal
 * that the user finished (or cancelled), so the chip reflects the true server state. */
function useRefreshOnForeground(onRefresh: () => Promise<void>) {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshRef.current();
    });
    return () => sub.remove();
  }, []);
}

/** The calm privacy line shown under the connector rows (onboarding + Settings) —
 * read-only, Hale never writes, disconnect anytime. */
export function ConnectorsPrivacyNote() {
  return (
    <AppText variant="meta" className="text-ink-3">
      Read-only access. Hale never sends or edits anything — and you can disconnect any time in
      Settings.
    </AppText>
  );
}
