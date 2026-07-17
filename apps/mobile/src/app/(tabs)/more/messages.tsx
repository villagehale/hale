import { router } from 'expo-router';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type { MessageView, MobileMessagesResponse } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

/**
 * Messages — "Hale's notes to you": the family's daily digests + the action
 * lifecycle a parent should see (a draft awaiting their yes, something Hale did,
 * something that needs them), newest first. Read-only: a drafted row navigates to
 * Approvals (the only surface that decides — rule #4); the rest are notes.
 *
 * Honest by construction: there is NO read/unread state here — the More badge is
 * the pending-approvals count, so the header says so rather than pretending to
 * track what you've seen. Rule #1: teen content arrives already redacted from the
 * server (teenRedacted rows carry only the placeholder); this screen never
 * un-redacts.
 */

function MessageRow({ message }: { message: MessageView }) {
  const chevron = useMeadowColor('ink3');
  // Only a drafted action leads somewhere — the parent's yes lives on Approvals.
  const navigates = message.actionState === 'drafted_for_approval';
  const tone = message.teenRedacted ? 'attention' : message.kind === 'digest' ? 'coach' : 'neutral';

  const body = (
    <View className="flex-row items-start gap-3">
      <View className="flex-1 gap-1.5">
        <View className="flex-row items-center justify-between gap-3">
          <Tag label={message.eyebrow} tone={tone} />
          <AppText variant="mono" className="text-ink-3">
            {message.when}
          </AppText>
        </View>
        <AppText variant="body" className="text-ink">
          {message.body}
        </AppText>
      </View>
      {navigates ? <Icon name="chevron-right" size={14} color={chevron} /> : null}
    </View>
  );

  if (navigates) {
    return (
      <Card
        onPress={() => router.push('/more/approvals')}
        accessibilityRole="button"
        accessibilityLabel={`${message.body} Opens Activity.`}
      >
        {body}
      </Card>
    );
  }
  return <Card>{body}</Card>;
}

function MessagesBody({ messages }: { messages: MessageView[] }) {
  if (messages.length === 0) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">Nothing yet</AppText>
        <AppText variant="meta" className="text-center">
          Hale will leave notes here — your daily brief, and anything it drafts or handles.
        </AppText>
      </Card>
    );
  }
  return (
    <View className="gap-3">
      <AppText variant="meta" className="-mt-2">
        Hale's notes to you — your daily brief and what it's been doing. Anything awaiting your okay
        is counted on the More menu.
      </AppText>
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </View>
  );
}

export default function MessagesScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileMessagesResponse>('/api/mobile/messages');

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Messages" back />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <MessagesBody messages={data.messages} /> : null}
    </Screen>
  );
}
