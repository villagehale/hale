import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';
import type { SharedLink } from '@/lib/api-types';
import {
  type DeleteState,
  nextDeleteState,
  scheduledDeletionCopy,
  shareLinkLabel,
} from '@/lib/privacy-data';
import {
  exportData,
  listSharedLinks,
  revokeSharedLink,
  scheduleAccountDeletion,
} from '@/lib/rights-api';

/**
 * The Settings "Privacy & data" section — account-management parity with web
 * /settings: export a copy of everything Hale holds, request account deletion
 * (reversible 7-day grace), and revoke any public shared links. Every action hits a
 * mobile route that delegates to the SAME web lib the browser uses, so the teen
 * redaction and the audit writes are single-sourced (rules #1/#6). This surface only
 * gathers the intent and shows an honest state — it never fabricates a success.
 */
export function PrivacyDataSection() {
  return (
    <View className="gap-2">
      <AppText variant="eyebrow">
        Privacy & data
      </AppText>
      <Card className="gap-5">
        <ExportRow />
        <View className="border-t border-rule pt-4">
          <SharedLinksRow />
        </View>
        <View className="border-t border-rule pt-4">
          <DeleteRow />
        </View>
      </Card>
    </View>
  );
}

type ExportState = 'idle' | 'pending' | 'error';

/** Fetch the teen-redacted export document, then hand it to the native Share sheet
 * as pretty-printed JSON. The document is already redacted server-side — this only
 * shares what the route returns (rule #1). Honest states: pending in flight, the
 * error surfaced — never a silent failure. */
function ExportRow() {
  const [state, setState] = useState<ExportState>('idle');

  async function share() {
    setState('pending');
    try {
      const document = await exportData();
      await Share.share({ message: JSON.stringify(document, null, 2) });
      setState('idle');
    } catch (e) {
      // A user-dismissed Share is not a failure; only an ApiError (the fetch) is.
      setState(e instanceof ApiError ? 'error' : 'idle');
    }
  }

  return (
    <View className="gap-2">
      <AppText variant="section">Export your data</AppText>
      <AppText variant="meta">
        Download everything Hale holds about your family (PIPEDA / Law 25). A teen's private content
        stays redacted, exactly as you see it in the app.
      </AppText>
      <Button
        label={state === 'pending' ? 'Preparing…' : 'Export a copy'}
        variant="secondary"
        onPress={share}
        disabled={state === 'pending'}
        className="self-start px-5 py-2.5"
      />
      {state === 'error' ? (
        <AppText variant="meta" className="text-berry" accessibilityRole="alert">
          Couldn't export just now — please try again.
        </AppText>
      ) : null}
    </View>
  );
}

/** The account-deletion request. Confirm-gated (rule #4: no autonomous destructive
 * action) via the pure nextDeleteState machine: the first tap reveals the real scope,
 * only an explicit confirm POSTs {confirm:true}, and success shows the reversible
 * grace date the parent can still cancel before. */
function DeleteRow() {
  const [state, setState] = useState<DeleteState>('idle');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);

  async function confirmDelete() {
    setState(nextDeleteState('confirming', 'confirm'));
    try {
      const { scheduledDeletionAt } = await scheduleAccountDeletion();
      setScheduledFor(scheduledDeletionAt);
      setState((s) => nextDeleteState(s, 'success'));
    } catch {
      setState((s) => nextDeleteState(s, 'failure'));
    }
  }

  if (state === 'scheduled') {
    return (
      <View className="gap-2">
        <AppText variant="section">Delete your account</AppText>
        <AppText variant="meta" accessibilityLiveRegion="polite">
          {scheduledDeletionCopy(scheduledFor)}
        </AppText>
      </View>
    );
  }

  if (state === 'idle') {
    return (
      <View className="gap-2">
        <AppText variant="section">Delete your account</AppText>
        <AppText variant="meta">
          Remove your family and everything Hale holds. Deletion begins after a grace period, so you
          can still change your mind.
        </AppText>
        <Pressable
          accessibilityRole="button"
          onPress={() => setState(nextDeleteState('idle', 'start'))}
          className="self-start active:opacity-70"
        >
          <AppText variant="meta" className="text-berry">
            Delete my account
          </AppText>
        </Pressable>
      </View>
    );
  }

  const pending = state === 'pending';
  return (
    <View className="gap-3" accessibilityLiveRegion="polite">
      <AppText variant="section">Delete your account</AppText>
      <AppText variant="meta">
        This removes everything Hale holds about your family — your children, your history, and every
        connected service. It can't be undone once the grace period ends.
      </AppText>
      <View className="flex-row items-center gap-4">
        <Button
          label={pending ? 'Scheduling…' : 'Yes, delete my account'}
          variant="secondary"
          onPress={confirmDelete}
          disabled={pending}
          className="px-5 py-2.5"
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => setState(nextDeleteState(state, 'cancel'))}
          disabled={pending}
          className="active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            Keep my account
          </AppText>
        </Pressable>
      </View>
      {state === 'error' ? (
        <AppText variant="meta" className="text-berry" accessibilityRole="alert">
          Couldn't schedule deletion — please try again.
        </AppText>
      ) : null}
    </View>
  );
}

type LoadState = 'loading' | 'loaded' | 'error';

/** The "links you have shared" list with a per-row revoke. Fetches the family-scoped
 * list on mount; a revoke nulls the token server-side (the public page then fails
 * closed) and drops the row. Honest empty + error states — never a silent failure. */
function SharedLinksRow() {
  const [links, setLinks] = useState<SharedLink[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');

  useEffect(() => {
    let active = true;
    listSharedLinks()
      .then((body) => {
        if (active) {
          setLinks(body.links);
          setLoad('loaded');
        }
      })
      .catch((e) => {
        // A 401 already bounced to sign-in inside api(); anything else is retryable.
        if (active && !(e instanceof ApiError && e.status === 401)) setLoad('error');
      });
    return () => {
      active = false;
    };
  }, []);

  function onRevoked(id: string) {
    setLinks((prev) => prev.filter((l) => l.id !== id));
  }

  return (
    <View className="gap-2">
      <AppText variant="section">Shared links</AppText>
      {load === 'loading' ? (
        <AppText variant="meta">Loading your shared links…</AppText>
      ) : load === 'error' ? (
        <AppText variant="meta" className="text-berry" accessibilityRole="alert">
          Couldn't load your shared links — please try again.
        </AppText>
      ) : links.length === 0 ? (
        <AppText variant="meta">
          No shared links. When you share a week plan or a local pick, it'll appear here so you can
          turn it off any time.
        </AppText>
      ) : (
        <View>
          {links.map((link) => (
            <SharedLinkItem key={`${link.kind}-${link.id}`} link={link} onRevoked={onRevoked} />
          ))}
        </View>
      )}
    </View>
  );
}

type RowState = 'view' | 'confirm' | 'revoking' | 'error';

function SharedLinkItem({
  link,
  onRevoked,
}: {
  link: SharedLink;
  onRevoked: (id: string) => void;
}) {
  const [state, setState] = useState<RowState>('view');

  async function revoke() {
    setState('revoking');
    try {
      await revokeSharedLink({ kind: link.kind, id: link.id });
      onRevoked(link.id);
    } catch {
      setState('error');
    }
  }

  return (
    <View className="gap-1 border-t border-rule py-3 first:border-t-0 first:pt-0">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <AppText variant="eyebrow">
            {shareLinkLabel(link.kind)}
          </AppText>
          <AppText variant="body" className="text-ink">
            {link.title}
          </AppText>
        </View>
        {state === 'confirm' || state === 'revoking' ? (
          <View className="flex-row items-center gap-3" accessibilityLiveRegion="polite">
            <Pressable
              accessibilityRole="button"
              onPress={revoke}
              disabled={state === 'revoking'}
              className="active:opacity-70"
            >
              <AppText variant="meta" className="text-berry">
                {state === 'revoking' ? 'Turning off…' : 'Yes, turn off'}
              </AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setState('view')}
              disabled={state === 'revoking'}
              className="active:opacity-70"
            >
              <AppText variant="meta" className="text-ink-3">
                No
              </AppText>
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Revoke shared link: ${link.title}`}
            onPress={() => setState('confirm')}
            className="active:opacity-70"
          >
            <AppText variant="meta" className="text-berry">
              Revoke
            </AppText>
          </Pressable>
        )}
      </View>
      {state === 'error' ? (
        <AppText variant="meta" className="text-berry" accessibilityRole="alert">
          Couldn't turn off this link — please try again.
        </AppText>
      ) : null}
    </View>
  );
}
