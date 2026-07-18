import { memo, useRef, useState } from 'react';
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
import { ConnectorCard } from '@/components/hale/connector-card';
import { QuickLogCard } from '@/components/hale/quick-log-card';
import { StreamingCursor } from '@/components/hale/streaming-cursor';
import { TypingDots } from '@/components/hale/typing-dots';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { Markdown } from '@/components/ui/markdown';
import { TintChip } from '@/components/ui/tint-chip';
import { type AskSuggestion, ASK_SUGGESTIONS } from '@/constants/ask-data';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import { type ActionIntent, type ActivityEvent, askHale } from '@/lib/coach-api';
import { cardsFromActivity } from '@/lib/connector-card';
import { timeGreeting } from '@/lib/greeting';
import { type QuickLogMatch, detectQuickLog } from '@/lib/quick-log-detect';
import { useVoiceInput } from '@/lib/use-voice-input';
import { viewerFirstName } from '@/lib/viewer-name';

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

const UserBubble = memo(function UserBubble({ text }: { text: string }) {
  // Brand navy, right-aligned — the handoff's user chat bubble (distinct from the
  // ink used for body text).
  return (
    <View className="mb-3 max-w-[85%] self-end rounded-[18px] rounded-br-sm bg-brand px-4 py-3">
      <AppText variant="body" className="text-on-ink">
        {text}
      </AppText>
    </View>
  );
});

const HaleBubble = memo(function HaleBubble({ turn }: { turn: HaleTurn }) {
  const { text, trail, activity, actionIntents, streaming } = turn;
  // While streaming with no answer text yet: the trail carries the progress if a
  // tool is running; otherwise the typing dots keep the "working" signal alive so
  // the turn is never a blank Hale label (e.g. between the first step and the first
  // token, or after a reset that ran no tools).
  const showBubble = text.length > 0 || !streaming;
  const showDots = streaming && text.length === 0 && trail.length === 0;
  return (
    <>
      {/* Handoff: the Hale reply is a small logo chip + plain text — no bordered
          bubble (the connector/action cards below carry the borders). */}
      <View className="mb-3 max-w-[92%] flex-row gap-2.5 self-start">
        <LogoMark size={24} />
        <View className="flex-1 pt-0.5">
          {streaming ? (
            <LiveActivityTrail entries={trail} />
          ) : (
            <ActivityTrail activity={activity} />
          )}
          {showBubble ? (
            // While streaming, render raw text token-by-token with a live cursor so
            // the answer reads as it arrives; on settle, render real markdown.
            streaming ? (
              <AppText variant="body" className="text-ink">
                {text}
                <StreamingCursor />
              </AppText>
            ) : (
              <Markdown>{text}</Markdown>
            )
          ) : showDots ? (
            <TypingDots />
          ) : null}
        </View>
      </View>
      {/* Honest connector cards settle with the answer — Drive files / Calendar
          agenda / not-connected. Rule #1: whitelisted fields only, streamed by the
          server; never raw content or a token. */}
      {!streaming
        ? cardsFromActivity(activity).map((card, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cards are an ordered, append-only slice of one turn's activity
            <ConnectorCard key={i} card={card} />
          ))
        : null}
      {/* Gated action chips settle once the answer stops streaming — each drafts a
          DRAFT the parent must approve (rule #4). Rule #1: only intent.label. */}
      {!streaming
        ? actionIntents.map((intent) => (
            <ActionChip key={intent.kind} intent={intent} sourceAnswer={text} />
          ))
        : null}
    </>
  );
});

/** The rounded input pill (handoff): a text field with a voice toggle and a navy
 * send button. Shared by the empty-state and the in-conversation composer. */
function Composer({
  draft,
  setDraft,
  onSend,
  listening,
  onToggleVoice,
}: {
  draft: string;
  setDraft: (t: string) => void;
  onSend: () => void;
  listening: boolean;
  onToggleVoice: () => void;
}) {
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const micColor = useMeadowColor('ink3');
  const sendColor = useMeadowColor('onAccent');
  return (
    <View className="flex-row items-center gap-1.5 rounded-[18px] border-[1.5px] border-rule-strong bg-card py-1.5 pl-4 pr-1.5">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Ask Hale anything…"
        placeholderTextColor={placeholderColor}
        accessibilityLabel="Ask Hale a question"
        multiline
        returnKeyType="send"
        onSubmitEditing={onSend}
        style={{
          color: inputColor,
          fontFamily: 'InstrumentSans_400Regular',
          minHeight: 40,
          maxHeight: 120,
        }}
        className="flex-1 text-[16px] leading-[22px]"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Stop listening' : 'Ask Hale by voice'}
        onPress={onToggleVoice}
        hitSlop={6}
        className="h-9 w-9 items-center justify-center active:opacity-70"
      >
        <Icon name={listening ? 'circle-stop' : 'mic'} size={18} color={micColor} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send question"
        onPress={onSend}
        className="h-10 w-10 items-center justify-center rounded-[14px] bg-brand active:opacity-90"
      >
        <Icon name="arrow-up" size={18} color={sendColor} />
      </Pressable>
    </View>
  );
}

/** One "Suggestions for you" row — a tinted chip + title/sub, tapping sends its live
 * prompt to Hale. */
function SuggestionRow({
  suggestion,
  onPick,
}: {
  suggestion: AskSuggestion;
  onPick: (prompt: string) => void;
}) {
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${suggestion.title}. ${suggestion.sub}`}
      onPress={() => onPick(suggestion.prompt)}
      className="flex-row items-center gap-3 rounded-[16px] border border-rule bg-card px-3.5 py-3.5 active:opacity-80"
    >
      <TintChip icon={suggestion.icon} tone={suggestion.tone} />
      <View className="flex-1">
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {suggestion.title}
        </AppText>
        <AppText variant="meta" className="text-caption">
          {suggestion.sub}
        </AppText>
      </View>
      <Icon name="chevron-right" size={14} color={chevron} />
    </Pressable>
  );
}

function EmptyState({
  draft,
  setDraft,
  onSend,
  onPick,
  listening,
  onToggleVoice,
}: {
  draft: string;
  setDraft: (t: string) => void;
  onSend: () => void;
  onPick: (prompt: string) => void;
  listening: boolean;
  onToggleVoice: () => void;
}) {
  const first = viewerFirstName();
  const sparkleColor = useMeadowColor('accentFill');
  const greeting = first ? `${timeGreeting()}, ${first}.` : `${timeGreeting()}.`;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-5 pb-6"
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <AppText variant="display" className="mb-5 mt-6">
        {greeting} What can I do for your family today?
      </AppText>

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={onSend}
        listening={listening}
        onToggleVoice={onToggleVoice}
      />
      <AppText variant="meta" className="mt-2 text-center text-caption">
        {listening ? 'Listening…' : 'Try: “Napped 1h 20m and ate most of lunch”'}
      </AppText>

      <AppText variant="eyebrow" className="mb-2.5 mt-6">
        Suggestions for you
      </AppText>
      <View className="gap-2.5">
        {ASK_SUGGESTIONS.map((s) => (
          <SuggestionRow key={s.title} suggestion={s} onPick={onPick} />
        ))}
      </View>

      <Card variant="cream" className="mt-6 items-center gap-1.5 py-5">
        <Icon name="sparkle-filled" size={20} color={sparkleColor} />
        <AppText className="text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          Hale is here to help
        </AppText>
        <AppText variant="meta" className="text-center text-cream-accent">
          Your AI parenting partner. Always here, always in your corner.
        </AppText>
      </Card>
    </ScrollView>
  );
}

export default function AskScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const conversationId = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const sparkleColor = useMeadowColor('brand');
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
        <View className="flex-row items-center justify-between px-5 pb-1 pt-2">
          <View className="flex-row items-center gap-2.5">
            <LogoMark size={30} />
            <AppText variant="title">Hale</AppText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New conversation"
            onPress={newConversation}
            className="h-11 w-11 items-center justify-center rounded-full border border-rule bg-raised active:opacity-80"
          >
            <Icon name="sparkle-filled" size={18} color={sparkleColor} />
          </Pressable>
        </View>

        {empty ? (
          <EmptyState
            draft={draft}
            setDraft={setDraft}
            onSend={() => send(draft)}
            onPick={send}
            listening={voice.listening}
            onToggleVoice={voice.toggle}
          />
        ) : (
          <>
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
                <View className="mb-3 max-w-[92%] flex-row gap-2.5 self-start">
                  <LogoMark size={24} />
                  <View className="pt-0.5">
                    <TypingDots />
                  </View>
                </View>
              ) : null}
            </ScrollView>

            <View className="border-t border-rule bg-canvas px-5 pb-3 pt-3">
              <Composer
                draft={draft}
                setDraft={setDraft}
                onSend={() => send(draft)}
                listening={voice.listening}
                onToggleVoice={voice.toggle}
              />
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
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
