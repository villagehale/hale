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

import { StreamingCursor } from '@/components/hale/streaming-cursor';
import { TypingDots } from '@/components/hale/typing-dots';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type { MessageView, MobileMessagesResponse, MobileNoteThreadResponse } from '@/lib/api-types';
import { askHale } from '@/lib/coach-api';
import { type SampleThread, findSampleThread } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

/**
 * A message thread (handoff) — bubbles + optional quick-action rows + a reply
 * composer, over the two lanes the Messages list keeps separate (never blended):
 *
 *  - Real Hale note (`digest-…` / `action-…`): renders the note as a Hale bubble.
 *    A drafted-for-approval note carries a REAL "Review in Approvals" action. Replying
 *    is REAL: the composer starts/continues a coach conversation anchored to the note
 *    (POST /api/coach with noteKey + the redacted note as seeded context), streams
 *    Hale's answer back as bubbles, and persists — re-opening replays the exchange
 *    (GET /api/mobile/note-thread). Delivery is honest: sent → streaming → replied,
 *    and a failure shows a retry, never a fake success.
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

/** One turn of the REAL reply exchange, live in this session: the parent's reply
 * (`you`) or Hale's coach answer (`hale`, which streams then settles, or errors with
 * a retry). Prior persisted turns render straight from the server as In/Out bubbles;
 * this shape only tracks the turns added since the thread opened. */
type ReplyTurn =
  | { id: string; role: 'you'; text: string }
  | {
      id: string;
      role: 'hale';
      text: string;
      streaming: boolean;
      errored: boolean;
      /** The reply that produced this answer — re-sent on retry. */
      question: string;
    };

type HaleReplyTurn = Extract<ReplyTurn, { role: 'hale' }>;

/** Hale's reply bubble while it's live: typing dots until the first token, a growing
 * answer with a blinking cursor as it streams, or — on failure — an honest error in
 * berry with a "Try again" affordance (never a fake-delivered bubble). */
function HaleReplyBubble({ turn, onRetry }: { turn: HaleReplyTurn; onRetry: () => void }) {
  if (turn.errored) {
    return (
      <View className="mb-3 max-w-[82%] self-start">
        <View className="rounded-[16px] rounded-tl-sm bg-chip-gray px-4 py-3">
          <AppText variant="body" className="text-berry">
            {turn.text}
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={onRetry}
          className="mt-1 self-start active:opacity-70"
        >
          <AppText
            variant="meta"
            className="text-accent"
            style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
          >
            Try again
          </AppText>
        </Pressable>
      </View>
    );
  }
  if (turn.streaming && turn.text.length === 0) {
    return (
      <View className="mb-3 max-w-[82%] self-start rounded-[16px] rounded-tl-sm bg-chip-gray px-4 py-3">
        <TypingDots />
      </View>
    );
  }
  return (
    <View className="mb-3 max-w-[82%] self-start rounded-[16px] rounded-tl-sm bg-chip-gray px-4 py-3">
      <AppText variant="body" className="text-ink">
        {turn.text}
        {turn.streaming ? <StreamingCursor /> : null}
      </AppText>
    </View>
  );
}

/**
 * A real Hale note as a two-way coach thread. The note renders as a Hale bubble; the
 * composer starts/continues the note's persistent coach conversation (POST /api/coach
 * carries the noteKey + the ALREADY-REDACTED note as seeded context — the app never
 * re-fetches raw content, rule #1). Hale's answer streams in as a Hale bubble and
 * persists, so a re-open replays the exchange from GET /api/mobile/note-thread.
 *
 * Delivery is honest (data honesty): a reply goes sent → streaming → replied, and a
 * failed run leaves an error bubble with "Try again" — never a fake-delivered bubble.
 * Replies aren't gated on each other; each streams independently on its own turn.
 */
function RealHaleThreadView({ message }: { message: MessageView }) {
  const actionColor = useMeadowColor('ink3');
  // Prior persisted exchange for this note, replayed on open. Never carries raw note
  // content (the transcript holds only replies + answers — rule #1).
  const { status, data, error, reload } = useApi<MobileNoteThreadResponse>(
    `/api/mobile/note-thread?noteKey=${encodeURIComponent(message.id)}`,
  );
  // Turns added THIS session. Server turns render separately (static — no refetch on
  // focus), so a just-sent reply never double-renders against a re-read.
  const [turns, setTurns] = useState<ReplyTurn[]>([]);

  const patchHale = (id: string, fn: (t: HaleReplyTurn) => HaleReplyTurn) =>
    setTurns((prev) =>
      prev.map((t) => (t.id === id && t.role === 'hale' ? fn(t) : t)),
    );

  const runStream = async (haleId: string, question: string) => {
    try {
      await askHale(
        {
          question,
          // The note anchors ONE persistent thread; the server resolves-or-creates it
          // by noteKey, so every reply continues the same conversation (no client id
          // to carry across restarts). The redacted note seeds the agent's context.
          noteKey: message.id,
          sourceNote: {
            eyebrow: message.eyebrow,
            body: message.body,
            when: message.when,
          },
        },
        {
          onDelta: (delta) => patchHale(haleId, (t) => ({ ...t, text: t.text + delta })),
          // An intermediate tool turn streamed text that is NOT the answer — drop it.
          onReset: () => patchHale(haleId, (t) => ({ ...t, text: '' })),
          onDone: () => patchHale(haleId, (t) => ({ ...t, streaming: false })),
        },
      );
      // Settle by construction even if the stream closed without a `done` event, so a
      // cursor is never left blinking forever.
      patchHale(haleId, (t) => (t.streaming ? { ...t, streaming: false } : t));
    } catch (e) {
      // A 401 already bounced to sign-in; leave the bubble as-is on the way out.
      if (e instanceof ApiError && e.status === 401) return;
      const messageText = (e as Error).message;
      patchHale(haleId, (t) => ({
        ...t,
        streaming: false,
        errored: true,
        text: t.text || messageText,
      }));
    }
  };

  const sendReply = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const haleId = `hale-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      { id: `you-${Date.now()}`, role: 'you', text: q },
      { id: haleId, role: 'hale', text: '', streaming: true, errored: false, question: q },
    ]);
    void runStream(haleId, q);
  };

  const retry = (haleId: string, question: string) => {
    patchHale(haleId, (t) => ({ ...t, text: '', streaming: true, errored: false }));
    void runStream(haleId, question);
  };

  const note = (
    <>
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
    </>
  );

  return (
    <ThreadShell
      title="Hale"
      composer={status === 'ready' ? <ReplyComposer onSend={sendReply} /> : undefined}
    >
      {note}
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' ? (
        <>
          {data?.turns.map((t, i) =>
            t.role === 'user' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted turns are a fixed, ordered replay
              <OutBubble key={`prior-${i}`} text={t.content} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted turns are a fixed, ordered replay
              <InBubble key={`prior-${i}`} text={t.content} />
            ),
          )}
          {turns.map((t) =>
            t.role === 'you' ? (
              <OutBubble key={t.id} text={t.text} />
            ) : (
              <HaleReplyBubble key={t.id} turn={t} onRetry={() => retry(t.id, t.question)} />
            ),
          )}
        </>
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
