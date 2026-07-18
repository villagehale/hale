import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import type { MessageView, MobileMessagesResponse } from '@/lib/api-types';
import { type SampleThread, findSampleThread } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

/**
 * A message thread (handoff) — bubbles + optional quick-action rows + a reply
 * composer, over the two lanes the Messages list keeps separate (never blended):
 *
 *  - Real Hale note (`digest-…` / `action-…`): renders the note as a Hale bubble.
 *    A drafted-for-approval note carries a REAL "Review in Approvals" action; the rest
 *    are read-only (the feed is read-only, so a real note has no reply composer).
 *    Rule #1: a teenRedacted note NEVER opens into a raw thread — it degrades to the
 *    same category-only pattern the list shows, with no bubbles and no composer.
 *
 *  - Sample conversation (`sample-…`, from stub-data): the designed two-way experience,
 *    under an explicit "Sample" disclosure. Quick-action rows are display-only (no real
 *    event sits behind a sample message). The reply composer local-appends only: a sent
 *    bubble is stamped "Not delivered — messaging launches later", because there is no
 *    outbound-messaging backend and nothing is ever transmitted (data honesty).
 */

/** An incoming message — left-aligned, soft-gray (the prototype's #F3F1EB bubble). */
function InBubble({ text }: { text: string }) {
  return (
    <View className="mb-3 max-w-[82%] self-start rounded-[16px] rounded-tl-sm bg-chip-gray px-4 py-3">
      <AppText variant="body" className="text-ink">
        {text}
      </AppText>
    </View>
  );
}

/** An outgoing message — right-aligned brand navy (the prototype's user bubble). A
 * locally-appended reply sets `notDelivered` for the honest, never-sent stamp. */
function OutBubble({ text, notDelivered = false }: { text: string; notDelivered?: boolean }) {
  return (
    <View className="mb-3 max-w-[82%] self-end">
      <View className="rounded-[16px] rounded-br-sm bg-brand px-4 py-3">
        <AppText variant="body" className="text-on-ink">
          {text}
        </AppText>
      </View>
      {notDelivered ? (
        <AppText variant="meta" className="mt-1 self-end text-[11px] text-caption">
          Not delivered · messaging launches later
        </AppText>
      ) : null}
    </View>
  );
}

/** The rounded reply pill (handoff): a text field + navy send button. `onSend`
 * local-appends the drafted text — this composer never calls a backend. */
function ReplyComposer({ onSend }: { onSend: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const sendColor = useMeadowColor('onAccent');
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };
  return (
    <View className="flex-row items-center gap-1.5 rounded-[18px] border-[1.5px] border-rule-strong bg-card py-1.5 pl-4 pr-1.5">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Write a message…"
        placeholderTextColor={placeholderColor}
        accessibilityLabel="Write a message"
        returnKeyType="send"
        onSubmitEditing={send}
        style={{ color: inputColor, fontFamily: 'InstrumentSans_400Regular', minHeight: 40 }}
        className="flex-1 text-[16px] leading-[22px]"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        onPress={send}
        className="h-10 w-10 items-center justify-center rounded-[14px] bg-brand active:opacity-90"
      >
        <Icon name="arrow-up" size={18} color={sendColor} />
      </Pressable>
    </View>
  );
}

/** The shared thread frame: detail header, a scrolling bubble column, and an optional
 * pinned composer (real read-only notes pass none). */
function ThreadShell({
  title,
  children,
  composer,
}: {
  title: string;
  children: ReactNode;
  composer?: ReactNode;
}) {
  const scrollRef = useRef<ScrollView>(null);
  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="px-5">
          <DetailHeader title={title} />
        </View>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName="px-5 pt-3 pb-2"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() =>
            composer ? scrollRef.current?.scrollToEnd({ animated: true }) : undefined
          }
        >
          {children}
        </ScrollView>
        {composer ? (
          <View className="border-t border-rule bg-canvas px-5 pb-3 pt-3">{composer}</View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** The "Sample" disclosure banner pinned atop a sample thread. */
function SampleNote() {
  return (
    <View className="mb-3 gap-1.5 rounded-[14px] border border-rule bg-raised px-3.5 py-3">
      <Tag label="Sample" tone="neutral" />
      <AppText variant="meta" className="text-ink-3">
        A preview of provider messaging — this isn’t a real conversation. Nothing you send here is
        delivered; two-way messaging launches later.
      </AppText>
    </View>
  );
}

/** The prototype's quick-action chips, DISPLAY-ONLY in a sample thread: no real event
 * sits behind a sample message, so they perform no action. */
function SampleQuickActions({ labels }: { labels: readonly string[] }) {
  return (
    <View className="mb-3 mt-1 flex-row gap-2.5">
      {labels.map((label) => (
        <View
          key={label}
          accessibilityLabel={`${label} — sample, not available yet`}
          className="flex-1 items-center rounded-[12px] border border-rule bg-card py-3 opacity-60"
        >
          <AppText
            className="text-[13px] text-ink"
            style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
          >
            {label}
          </AppText>
        </View>
      ))}
    </View>
  );
}

function SampleThreadView({ thread }: { thread: SampleThread }) {
  const [replies, setReplies] = useState<string[]>([]);
  return (
    <ThreadShell
      title={thread.name}
      composer={<ReplyComposer onSend={(text) => setReplies((prev) => [...prev, text])} />}
    >
      <SampleNote />
      {thread.rows.map((row, i) =>
        row.from === 'them' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered sample seed
          <InBubble key={i} text={row.text} />
        ) : (
          // Seed "you" bubbles carry the same never-sent stamp as a live reply, so no
          // outgoing bubble in a sample thread reads as if it were delivered.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered sample seed
          <OutBubble key={i} text={row.text} notDelivered />
        ),
      )}
      {replies.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only local reply list
        <OutBubble key={`reply-${i}`} text={text} notDelivered />
      ))}
      {thread.quickActions.length > 0 ? (
        <SampleQuickActions labels={thread.quickActions} />
      ) : null}
    </ThreadShell>
  );
}

/** Rule #1: a redacted teen note shows the category only — never a raw thread. */
function RedactedThreadView({ message }: { message: MessageView }) {
  return (
    <ThreadShell title={message.eyebrow}>
      <Card className="mt-2 items-center gap-2.5 py-8">
        <TintChip icon="shield" tone="red" size={44} />
        <AppText variant="title">Kept private</AppText>
        <AppText variant="meta" className="text-center">
          This note concerns your teenager, so only the category shows here — never the raw content.
          Hale surfaces the full details only with an explicit, logged consent, or when a safety
          concern means someone needs to know.
        </AppText>
      </Card>
    </ThreadShell>
  );
}

function RealHaleThreadView({ message }: { message: MessageView }) {
  const actionColor = useMeadowColor('ink3');
  return (
    <ThreadShell title="Hale">
      <AppText variant="meta" className="mb-3 text-center text-ink-3">
        {message.eyebrow} · {message.when}
      </AppText>
      <InBubble text={message.body} />
      {message.actionState === 'drafted_for_approval' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review in Approvals"
          onPress={() => router.push('/approvals')}
          className="mt-1 flex-row items-center justify-center gap-2 rounded-[12px] border border-rule bg-card py-3 active:opacity-80"
        >
          <Icon name="circle-check" size={15} color={actionColor} />
          <AppText
            className="text-[13px] text-ink"
            style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
          >
            Review in Approvals
          </AppText>
        </Pressable>
      ) : null}
    </ThreadShell>
  );
}

function RealThreadView({ id }: { id: string }) {
  const { status, data, error, reload } = useApi<MobileMessagesResponse>('/api/mobile/messages');

  if (status === 'loading') {
    return (
      <ThreadShell title="Hale">
        <LoadingState />
      </ThreadShell>
    );
  }
  if (status === 'error') {
    return (
      <ThreadShell title="Hale">
        <ErrorState message={error ?? ''} onRetry={reload} />
      </ThreadShell>
    );
  }

  const message = data?.messages.find((m) => m.id === id);
  if (!message) {
    return (
      <ThreadShell title="Message">
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">Message not found</AppText>
          <AppText variant="meta" className="text-center">
            This message isn’t available. Head back to Messages to see your notes from Hale.
          </AppText>
        </Card>
      </ThreadShell>
    );
  }
  if (message.teenRedacted) return <RedactedThreadView message={message} />;
  return <RealHaleThreadView message={message} />;
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sample = findSampleThread(id);
  if (sample) return <SampleThreadView thread={sample} />;
  return <RealThreadView id={id} />;
}
