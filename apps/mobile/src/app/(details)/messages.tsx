import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { LogoMark } from '@/components/ui/logo-mark';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { type MeadowColor, useMeadowColor } from '@/constants/meadow';
import type { MessageView, MobileMessagesResponse } from '@/lib/api-types';
import { messageUnread, useNotifsAcknowledged } from '@/lib/notif-dot';
import { SAMPLE_THREADS, type SampleThread } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

/**
 * Messages — restyled to the handoff's conversation-row look, over TWO strictly
 * separated lanes (data honesty — they are never blended):
 *
 *  1. Hale's notes to you — the REAL, read-only feed of the family's daily digests +
 *     the action lifecycle a parent should see, newest first. Every real row is
 *     genuinely FROM Hale, so it carries the Hale mark and the name "Hale"; tapping
 *     opens that note as a real thread. Rule #1: a 13+ teen's content arrives already
 *     redacted from the server (a teenRedacted row's body IS the placeholder) — this
 *     screen renders what the server sends and never un-redacts, and the redacted
 *     row's thread degrades to a category-only view (see thread/[id]).
 *
 *  2. Sample — the prototype's demo provider/parent conversations (Little Steps
 *     Daycare, Sarah, Georgetown Pediatrics). Hale has no provider-messaging backend
 *     yet, so these live under an explicit "Sample" disclosure and open stub-data
 *     threads — a parent sees the designed experience without believing a real daycare
 *     messaged them.
 *
 * Unread dots are DERIVED, never invented: a real row's dot follows `messageUnread`
 * (the note is stamped on the family's current day and the session isn't acknowledged);
 * sample rows carry no unread (there is no real unseen state to show).
 */

const AVATAR: Record<SampleThread['tone'], { bg: string; icon: MeadowColor }> = {
  blue: { bg: 'bg-chip-blue', icon: 'chipBlueIcon' },
  green: { bg: 'bg-chip-green', icon: 'chipGreenIcon' },
  yellow: { bg: 'bg-chip-yellow', icon: 'chipYellowIcon' },
};

/** A conversation-row avatar: the Hale brand mark for a real note, or the sample
 * sender's tinted initial disc (the prototype's 38px coloured circle). */
function RowAvatar({ sample }: { sample?: SampleThread }) {
  const tone = sample ? AVATAR[sample.tone] : null;
  const color = useMeadowColor(tone ? tone.icon : 'ink');
  if (!sample || !tone) return <LogoMark size={38} />;
  return (
    <View className={`h-[38px] w-[38px] items-center justify-center rounded-full ${tone.bg}`}>
      <AppText className="text-[14px]" style={{ color, fontFamily: 'InstrumentSans_700Bold' }}>
        {sample.initial}
      </AppText>
    </View>
  );
}

/** The earned-orange unread dot — mirrors the approval dot on Notifications. */
function UnreadDot() {
  return <View className="h-2 w-2 rounded-full bg-accent" />;
}

/** The shared conversation row: avatar, name over a one-line preview, a right column
 * with the timestamp and (when unread) the dot. */
function ConversationRow({
  sample,
  name,
  preview,
  when,
  unread,
  onPress,
  last,
}: {
  sample?: SampleThread;
  name: string;
  preview: string;
  when: string;
  unread: boolean;
  onPress: () => void;
  last: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${preview}.${unread ? ' Unread.' : ''}`}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
        last ? '' : 'border-b border-hairline'
      }`}
    >
      <RowAvatar sample={sample} />
      <View className="flex-1">
        <AppText
          numberOfLines={1}
          className="text-[14px] text-ink"
          style={{ fontFamily: 'InstrumentSans_700Bold' }}
        >
          {name}
        </AppText>
        <AppText variant="meta" numberOfLines={1} className="text-caption">
          {preview}
        </AppText>
      </View>
      <View className="items-end gap-1.5">
        <AppText variant="mono" className="text-[11px] leading-none text-ink-3">
          {when}
        </AppText>
        {unread ? <UnreadDot /> : null}
      </View>
    </Pressable>
  );
}

const INTRO =
  "Hale’s notes to you — your daily brief and what it’s been doing. Anything awaiting your okay is counted on the More menu.";

function RealSection({
  messages,
  acknowledged,
}: {
  messages: MessageView[];
  acknowledged: boolean;
}) {
  return (
    <View className="gap-2.5">
      <AppText variant="meta" className="-mt-1">
        {INTRO}
      </AppText>
      {messages.length === 0 ? (
        <Card className="items-center gap-2 py-8">
          <AppText variant="title">Nothing yet</AppText>
          <AppText variant="meta" className="text-center">
            Hale will leave notes here — your daily brief, and anything it drafts or handles.
          </AppText>
        </Card>
      ) : (
        <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
          {messages.map((message, i) => (
            <ConversationRow
              key={message.id}
              name="Hale"
              preview={message.body}
              when={message.when}
              unread={messageUnread(Boolean(message.today), acknowledged)}
              onPress={() => router.push(`/thread/${message.id}`)}
              last={i === messages.length - 1}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function SampleSection() {
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">Sample — until providers can message you</AppText>
      <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
        {SAMPLE_THREADS.map((thread, i) => (
          <ConversationRow
            key={thread.id}
            sample={thread}
            name={thread.name}
            preview={thread.preview}
            when={thread.when}
            unread={false}
            onPress={() => router.push(`/thread/${thread.id}`)}
            last={i === SAMPLE_THREADS.length - 1}
          />
        ))}
      </View>
      <AppText variant="meta" className="text-caption">
        Sample conversations — no provider has messaged you. Two-way messaging with daycares, clinics
        and other parents is coming.
      </AppText>
    </View>
  );
}

function MessagesBody({ messages }: { messages: MessageView[] }) {
  const acknowledged = useNotifsAcknowledged();
  return (
    <>
      <RealSection messages={messages} acknowledged={acknowledged} />
      <SampleSection />
    </>
  );
}

export default function MessagesScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileMessagesResponse>('/api/mobile/messages');

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <DetailHeader title="Messages" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <MessagesBody messages={data.messages} /> : null}
    </Screen>
  );
}
