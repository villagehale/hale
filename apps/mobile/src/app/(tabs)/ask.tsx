import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionChip } from '@/components/hale/action-chip';
import {
  ActivityTrail,
  LiveActivityTrail,
  type TrailEntry,
} from '@/components/hale/activity-trail';
import { QuickLogCard } from '@/components/hale/quick-log-card';
import { StreamingCursor } from '@/components/hale/streaming-cursor';
import { TypingDots } from '@/components/hale/typing-dots';
import { AppText } from '@/components/ui/app-text';
import { IconButton } from '@/components/ui/icon-button';
import { Markdown } from '@/components/ui/markdown';
import { STARTER_CHIPS } from '@/constants/ask-data';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import { type ActionIntent, type ActivityEvent, askHale } from '@/lib/coach-api';
import { type QuickLogMatch, detectQuickLog } from '@/lib/quick-log-detect';
import { useVoiceInput } from '@/lib/use-voice-input';

/** A streaming Concierge turn. `text` grows as deltas arrive; `trail` is the live
 * step list (with the in-flight tool pulsing); once `streaming` is false the trail
 * folds to the settled `activity` and the text renders as markdown. */
interface HaleTurn {
  id: string;
  role: 'hale';
  text: string;
  trail: TrailEntry[];
  activity: ActivityEvent[];
  actionIntents: ActionIntent[];
  streaming: boolean;
  errored: boolean;
}

type Message =
  | { id: string; role: 'user'; text: string }
  | HaleTurn
  | { id: string; role: 'quicklog'; match: QuickLogMatch };

function UserBubble({ text }: { text: string }) {
  return (
    <View className="mb-3 max-w-[85%] self-end rounded-lg rounded-br-sm bg-ink px-4 py-3">
      <AppText variant="body" className="text-on-ink">
        {text}
      </AppText>
    </View>
  );
}

function HaleBubble({ turn }: { turn: HaleTurn }) {
  const { text, trail, activity, actionIntents, streaming } = turn;
  // While streaming with no answer text yet: the trail carries the progress if a
  // tool is running; otherwise the typing dots keep the "working" signal alive so
  // the turn is never a blank Hale label (e.g. between the first step and the first
  // token, or after a reset that ran no tools).
  const showBubble = text.length > 0 || !streaming;
  const showDots = streaming && text.length === 0 && trail.length === 0;
  return (
    <>
      <View className="mb-3 max-w-[92%] self-start">
        <AppText variant="meta" className="mb-1 uppercase tracking-eyebrow text-ink-3">
          Hale
        </AppText>
        {/* Live while working (each step reveals with a breathing dot), then folds
            to "▸ Explored N steps" above the settled answer. */}
        {streaming ? (
          <LiveActivityTrail entries={trail} />
        ) : (
          <ActivityTrail activity={activity} />
        )}
        {showBubble ? (
          <View className="rounded-lg rounded-bl-sm border border-rule bg-card px-4 py-3">
            {/* While streaming, render raw text token-by-token with a live cursor so
                the answer reads as it arrives; on settle, render real markdown (bold,
                lists, headings) with no leftover cursor bar. */}
            {streaming ? (
              <AppText variant="body">
                {text}
                <StreamingCursor />
              </AppText>
            ) : (
              <Markdown>{text}</Markdown>
            )}
          </View>
        ) : showDots ? (
          <View className="self-start rounded-lg rounded-bl-sm border border-rule bg-card px-4 py-3">
            <TypingDots />
          </View>
        ) : null}
      </View>
      {/* Gated action chips settle once the answer stops streaming — each drafts a
          DRAFT the parent must approve (rule #4). Rule #1: only intent.label. */}
      {!streaming
        ? actionIntents.map((intent) => (
            <ActionChip key={intent.kind} intent={intent} sourceAnswer={text} />
          ))
        : null}
    </>
  );
}

function StarterChips({ onPick }: { onPick: (q: string) => void }) {
  return (
    <View className="flex-1 gap-4 pt-6">
      <AppText variant="display">How can I help you today?</AppText>
      <AppText variant="meta" className="text-ink-3">
        Hale is here for you, 24/7.
      </AppText>
      <View className="mt-1 gap-2">
        {STARTER_CHIPS.map((q) => (
          <Pressable
            key={q}
            accessibilityRole="button"
            accessibilityLabel={q}
            onPress={() => onPick(q)}
            className="rounded-lg border border-rule bg-card px-4 py-3.5 active:opacity-80"
          >
            <AppText variant="body" className="text-ink">
              {q}
            </AppText>
          </Pressable>
        ))}
      </View>
      <AppText variant="meta" className="mt-1">
        Hale offers general guidance, never medical advice. For anything urgent, contact your care
        provider.
      </AppText>
    </View>
  );
}

export default function AskScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const conversationId = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const voice = useVoiceInput(setDraft);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const newMessages: Message[] = [{ id: `u-${Date.now()}`, role: 'user', text: q }];
    const quickLog = detectQuickLog(q);
    if (quickLog) newMessages.push({ id: `ql-${Date.now()}`, role: 'quicklog', match: quickLog });
    setMessages((prev) => [...prev, ...newMessages]);
    setDraft('');
    voice.reset();
    setPending(true);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

    // The assistant turn the stream fills. Created lazily on the FIRST event so the
    // typing dots hold until Hale actually starts working, then the live turn grows.
    const replyId = `h-${Date.now()}`;
    let created = false;
    const ensureTurn = () => {
      if (created) return;
      created = true;
      setPending(false);
      setMessages((prev) => [
        ...prev,
        {
          id: replyId,
          role: 'hale',
          text: '',
          trail: [],
          activity: [],
          actionIntents: [],
          streaming: true,
          errored: false,
        },
      ]);
    };
    const patch = (fn: (t: HaleTurn) => HaleTurn) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === replyId && m.role === 'hale' ? fn(m) : m)),
      );
    };

    try {
      await askHale(
        { question: q, ...(conversationId.current ? { conversationId: conversationId.current } : {}) },
        {
          onStep: () => ensureTurn(),
          onToolCall: (name) => {
            ensureTurn();
            // The in-flight tool: a breathing pending line until its result lands.
            patch((t) => ({ ...t, trail: [...t.trail, { kind: 'pending', name }] }));
          },
          onToolResult: (event) => {
            ensureTurn();
            // Settle the pending line for this tool into a result; keep the order.
            patch((t) => {
              const idx = t.trail.findIndex(
                (e) => e.kind === 'pending' && e.name === event.name,
              );
              const settled: TrailEntry = { kind: 'result', ...event };
              const trail =
                idx === -1
                  ? [...t.trail, settled]
                  : t.trail.map((e, i) => (i === idx ? settled : e));
              return { ...t, trail, activity: [...t.activity, event] };
            });
          },
          onDelta: (delta) => {
            ensureTurn();
            patch((t) => ({ ...t, text: t.text + delta }));
          },
          onReset: () => {
            // An intermediate tool turn streamed text that is NOT the answer — clear
            // it. The trail is real completed work, so it survives.
            patch((t) => ({ ...t, text: '' }));
          },
          onActionIntents: (intents) => {
            ensureTurn();
            patch((t) => ({ ...t, actionIntents: intents }));
          },
          onDone: (nextId) => {
            conversationId.current = nextId;
            patch((t) => ({ ...t, streaming: false }));
          },
        },
      );
      // A stream that ended without ever creating a turn (no events) still needs to
      // clear the typing dots. And if the stream closed without a `done` event (a
      // truncated response), force-settle the turn so a cursor is never left blinking
      // forever — settling by construction, not by hoping `done` always arrives.
      if (!created) setPending(false);
      else patch((t) => (t.streaming ? { ...t, streaming: false } : t));
    } catch (e) {
      setPending(false);
      if (e instanceof ApiError && e.status === 401) return;
      const message = (e as Error).message;
      if (created) {
        patch((t) => ({ ...t, streaming: false, errored: true, text: t.text || message }));
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: replyId,
            role: 'hale',
            text: message,
            trail: [],
            activity: [],
            actionIntents: [],
            streaming: false,
            errored: true,
          },
        ]);
      }
    } finally {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  };

  const empty = messages.length === 0;

  const newConversation = () => {
    setMessages([]);
    conversationId.current = null;
  };

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-row items-center justify-between px-5 pt-2">
          {/* On the empty state the big display title is the question below, so the
              header demotes to a small nav-size label (mockup); once a conversation
              starts there's no competing title, so it reads at full display size. */}
          <AppText variant={empty ? 'title' : 'display'}>Hale</AppText>
          {!empty ? (
            <IconButton
              icon="square.and.pencil"
              accessibilityLabel="New conversation"
              onPress={newConversation}
              className="bg-raised"
            />
          ) : null}
        </View>

        {empty ? (
          <View className="flex-1 px-5">
            <StarterChips onPick={send} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="px-5 pt-4 pb-2"
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.map((m) => {
              if (m.role === 'user') return <UserBubble key={m.id} text={m.text} />;
              if (m.role === 'quicklog') return <QuickLogCard key={m.id} match={m.match} />;
              return <HaleBubble key={m.id} turn={m} />;
            })}
            {pending ? (
              <View className="mb-3 max-w-[92%] self-start">
                <AppText variant="meta" className="mb-1 uppercase tracking-eyebrow text-ink-3">
                  Hale
                </AppText>
                <View className="self-start rounded-lg rounded-bl-sm border border-rule bg-card px-4 py-3">
                  <TypingDots />
                </View>
              </View>
            ) : null}
          </ScrollView>
        )}

        <View className="border-t border-rule bg-card px-5 pb-3 pt-3">
          <AppText variant="meta" className="mb-1.5 uppercase tracking-eyebrow text-ink-3">
            {voice.listening ? 'Listening…' : 'Ask a question'}
          </AppText>
          <View className="flex-row items-center gap-2">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Type, or tap the mic to talk"
              placeholderTextColor={placeholderColor}
              accessibilityLabel="Ask Hale a question"
              multiline
              returnKeyType="send"
              onSubmitEditing={() => send(draft)}
              style={{
                color: inputColor,
                fontFamily: 'Inter_400Regular',
                minHeight: 44,
                maxHeight: 120,
              }}
              className="flex-1 rounded-md border border-rule bg-canvas px-4 py-2.5 text-[16px] leading-[22px]"
            />
            {draft.trim() ? (
              <IconButton
                icon="arrow.up"
                accessibilityLabel="Send question"
                onPress={() => send(draft)}
                className="bg-raised"
              />
            ) : (
              <IconButton
                icon={voice.listening ? 'stop.fill' : 'mic'}
                accessibilityLabel={voice.listening ? 'Stop listening' : 'Ask Hale by voice'}
                onPress={voice.toggle}
                className="bg-raised"
              />
            )}
          </View>
          {voice.error ? (
            <View className="mt-1.5 flex-row items-baseline gap-2">
              <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
                {voice.error}
              </AppText>
              {voice.permissionBlocked ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open Settings to enable the microphone"
                  onPress={() => Linking.openSettings()}
                  className="active:opacity-80"
                >
                  <AppText variant="meta" className="text-accent underline">
                    Open Settings
                  </AppText>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
