import * as DocumentPicker from 'expo-document-picker';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
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
import { AskHistorySheet } from '@/components/hale/ask-history-sheet';
import { AttachmentChips } from '@/components/hale/attachment-chips';
import { ConnectorCard } from '@/components/hale/connector-card';
import { QuickLogCard } from '@/components/hale/quick-log-card';
import { StreamingCursor } from '@/components/hale/streaming-cursor';
import { TypingDots } from '@/components/hale/typing-dots';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { Markdown } from '@/components/ui/markdown';
import { LoadingState } from '@/components/ui/screen-state';
import { TintChip } from '@/components/ui/tint-chip';
import { type AskSuggestion, ASK_SUGGESTIONS } from '@/constants/ask-data';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type {
  ChatAttachmentUpload,
  MobileConversationTranscriptResponse,
  MobileFamilyResponse,
} from '@/lib/api-types';
import {
  MAX_ATTACHMENTS,
  type PendingAttachment,
  attachmentTone,
  buildCoachSendPayload,
  canSendAsk,
  readyAttachmentIds,
  uploadErrorMessage,
} from '@/lib/ask-attachments';
import { transcriptToMessages } from '@/lib/ask-history';
import { type ActionIntent, type ActivityEvent, askHale } from '@/lib/coach-api';
import { conversationStorage } from '@/lib/conversation-storage';
import { orderByIntents } from '@/lib/intent-ordering';
import { useApi } from '@/lib/use-api';
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
  | { id: string; role: 'user'; text: string; attachments?: { name: string }[] }
  | HaleTurn
  | { id: string; role: 'quicklog'; match: QuickLogMatch };

const UserBubble = memo(function UserBubble({
  text,
  attachments,
}: {
  text: string;
  attachments?: { name: string }[];
}) {
  // Brand navy, right-aligned — the handoff's user chat bubble (distinct from the
  // ink used for body text). Any sent files ride above it as compact name-only chips;
  // an attachments-only send renders just the chips (no empty navy box).
  const fileColor = useMeadowColor('ink3');
  return (
    <View className="mb-3 max-w-[85%] items-end gap-1.5 self-end">
      {attachments?.length ? (
        <View className="flex-row flex-wrap justify-end gap-1.5">
          {attachments.map((a, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: a bubble's sent files are a fixed, ordered snapshot
              key={i}
              className="max-w-[180px] flex-row items-center gap-1.5 rounded-[12px] border border-rule bg-card px-2.5 py-1.5"
            >
              <Icon name="file" size={12} color={fileColor} />
              <AppText variant="meta" numberOfLines={1} ellipsizeMode="middle" className="text-[12px] text-ink">
                {a.name}
              </AppText>
            </View>
          ))}
        </View>
      ) : null}
      {text ? (
        <View className="rounded-[18px] rounded-br-sm bg-brand px-4 py-3">
          <AppText variant="body" className="text-on-ink">
            {text}
          </AppText>
        </View>
      ) : null}
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

/** The rounded input pill (handoff): a leading paperclip, a text field, a voice
 * toggle, and a navy send button — with the attachment tray above it and the upload
 * note below. Shared by the empty-state and the in-conversation composer. Send is
 * gated on text-OR-a-ready-attachment and blocked while any upload is in flight
 * (canSendAsk). */
function Composer({
  draft,
  setDraft,
  onSend,
  listening,
  onToggleVoice,
  attachments,
  onPickFiles,
  onRemoveAttachment,
  onRetryAttachment,
  uploadNote,
  pending,
}: {
  draft: string;
  setDraft: (t: string) => void;
  onSend: () => void;
  listening: boolean;
  onToggleVoice: () => void;
  attachments: PendingAttachment[];
  onPickFiles: () => void;
  onRemoveAttachment: (localId: string) => void;
  onRetryAttachment: (batchId: string) => void;
  uploadNote: string | null;
  pending: boolean;
}) {
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const micColor = useMeadowColor('ink3');
  const clipColor = useMeadowColor('ink3');
  const sendColor = useMeadowColor('onAccent');
  const disabled = pending || !canSendAsk(draft, attachments);
  return (
    <View>
      <AttachmentChips
        attachments={attachments}
        onRemove={onRemoveAttachment}
        onRetry={onRetryAttachment}
      />
      <View className="flex-row items-center gap-2 rounded-[18px] border-[1.5px] border-rule-strong bg-card py-1.5 pl-2 pr-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach a file"
          onPress={onPickFiles}
          hitSlop={6}
          className="h-9 w-9 items-center justify-center rounded-[12px] active:opacity-70"
        >
          <Icon name="paperclip" size={18} color={clipColor} />
        </Pressable>
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
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onSend}
          className={`h-10 w-10 items-center justify-center rounded-[14px] bg-brand ${
            disabled ? 'opacity-40' : 'active:opacity-90'
          }`}
        >
          <Icon name="arrow-up" size={18} color={sendColor} />
        </Pressable>
      </View>
      {uploadNote ? (
        <AppText variant="meta" className="mt-1.5 text-berry" accessibilityLiveRegion="polite">
          {uploadNote}
        </AppText>
      ) : null}
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
  composer,
  onPick,
  listening,
}: {
  composer: ReactNode;
  onPick: (prompt: string) => void;
  listening: boolean;
}) {
  const first = viewerFirstName();
  const sparkleColor = useMeadowColor('accentFill');
  const greeting = first ? `${timeGreeting()}, ${first}.` : `${timeGreeting()}.`;
  // Float a suggestion the family's stated intents map to (health → well-baby,
  // childcare → daycare email) up the starter list; the honest order otherwise. The
  // section header stays "Suggestions for you" — this is a reorder, not a new claim.
  const { data } = useApi<MobileFamilyResponse>('/api/mobile/family');
  const suggestions = orderByIntents(ASK_SUGGESTIONS, (s) => s.intent, data?.basics.intents ?? []);
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

      {composer}
      <AppText variant="meta" className="mt-2 text-center text-caption">
        {listening ? 'Listening…' : 'Try: “Napped 1h 20m and ate most of lunch”'}
      </AppText>

      <AppText variant="eyebrow" className="mb-2.5 mt-6">
        Suggestions for you
      </AppText>
      <View className="gap-2.5">
        {suggestions.map((s) => (
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Starts true so the first frame is a neutral loader, not a greeting that would
  // flash before the stored id is read. Resolved to false once restore settles (or
  // when there is nothing to restore).
  const [restoring, setRestoring] = useState(true);
  const conversationId = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const historyIcon = useMeadowColor('brand');
  const voice = useVoiceInput(setDraft);

  // Reopen the last active thread on a cold start: restore its transcript so the
  // conversation persists across restarts. A gone/foreign id (404) clears the stored
  // id and falls back to a fresh chat, quietly.
  useEffect(() => {
    let live = true;
    (async () => {
      const stored = await conversationStorage.get();
      if (!live) return;
      if (!stored) {
        setRestoring(false);
        return;
      }
      try {
        const data = await api<MobileConversationTranscriptResponse>(
          `/api/mobile/conversations/${stored}`,
        );
        if (!live) return;
        const restored = transcriptToMessages(data.turns);
        if (restored.length > 0) {
          setMessages(restored);
          conversationId.current = data.conversationId;
        } else {
          await conversationStorage.clear();
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        await conversationStorage.clear();
      } finally {
        if (live) setRestoring(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Upload one pick's files together (one request → one 'coach' rate-limit hit, not
  // one per file). On success each chip settles to its server id + authoritative
  // name/size; on failure the whole batch flips to an errored chip with an honest note
  // — never silently dropped. The file uris are kept so a retryable batch re-uploads.
  const uploadBatch = async (batch: PendingAttachment[]) => {
    const form = new FormData();
    for (const a of batch) {
      form.append('files', {
        uri: a.file.uri,
        name: a.file.name,
        type: a.file.type,
      } as unknown as Blob);
    }
    try {
      const stored = await api<ChatAttachmentUpload[]>('/api/coach/attachments', {
        method: 'POST',
        body: form,
      });
      setAttachments((prev) =>
        prev.map((a) => {
          const idx = batch.findIndex((b) => b.localId === a.localId);
          if (idx === -1) return a;
          const s = stored[idx];
          if (!s) return { ...a, status: 'error', retryable: true };
          return { ...a, status: 'ready', serverId: s.id, name: s.name, sizeBytes: s.sizeBytes };
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      const status = e instanceof ApiError ? e.status : 0;
      const code = e instanceof ApiError ? e.message : undefined;
      const { note, retryable } = uploadErrorMessage(status, code);
      setUploadNote(note);
      setAttachments((prev) =>
        prev.map((a) =>
          batch.some((b) => b.localId === a.localId) && a.status === 'uploading'
            ? { ...a, status: 'error', retryable }
            : a,
        ),
      );
    }
  };

  const pickFiles = async () => {
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      setUploadNote(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/*', 'application/pdf'],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const picked = result.assets.slice(0, remaining);
    setUploadNote(
      result.assets.length > remaining ? `You can attach up to ${MAX_ATTACHMENTS} files.` : null,
    );
    const batchId = `b-${Date.now()}`;
    const base = attachments.length;
    const batch: PendingAttachment[] = picked.map((f, i) => ({
      localId: `${batchId}-${i}`,
      batchId,
      name: f.name,
      sizeBytes: f.size ?? 0,
      tone: attachmentTone(base + i),
      status: 'uploading',
      file: { uri: f.uri, name: f.name, type: f.mimeType ?? 'application/octet-stream' },
    }));
    setAttachments((prev) => [...prev, ...batch]);
    await uploadBatch(batch);
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  };

  const retryBatch = (batchId: string) => {
    setUploadNote(null);
    const batch = attachments.filter((a) => a.batchId === batchId);
    if (batch.length === 0) return;
    setAttachments((prev) =>
      prev.map((a) => (a.batchId === batchId ? { ...a, status: 'uploading' } : a)),
    );
    void uploadBatch(batch.map((a) => ({ ...a, status: 'uploading' })));
  };

  const send = async (text: string) => {
    if (pending || !canSendAsk(text, attachments)) return;
    const q = text.trim();
    const ids = readyAttachmentIds(attachments);
    const sent = attachments.filter((a) => a.status === 'ready').map((a) => ({ name: a.name }));
    const newMessages: Message[] = [
      {
        id: `u-${Date.now()}`,
        role: 'user',
        text: q,
        ...(sent.length ? { attachments: sent } : {}),
      },
    ];
    const quickLog = q ? detectQuickLog(q) : null;
    if (quickLog) newMessages.push({ id: `ql-${Date.now()}`, role: 'quicklog', match: quickLog });
    setMessages((prev) => [...prev, ...newMessages]);
    setDraft('');
    setAttachments([]);
    setUploadNote(null);
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
        {
          ...buildCoachSendPayload(text, ids),
          ...(conversationId.current ? { conversationId: conversationId.current } : {}),
        },
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
            void conversationStorage.set(nextId);
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
    void conversationStorage.clear();
    setAttachments([]);
    setUploadNote(null);
    setHistoryOpen(false);
  };

  // Reopen a past conversation from the history sheet: rehydrate its transcript into
  // the message list, anchor the send pipeline to its id, persist it, and close the
  // sheet. A transient failure leaves the sheet open so the row can be retried.
  const openConversation = async (id: string) => {
    try {
      const data = await api<MobileConversationTranscriptResponse>(
        `/api/mobile/conversations/${id}`,
      );
      setMessages(transcriptToMessages(data.turns));
      conversationId.current = data.conversationId;
      void conversationStorage.set(data.conversationId);
      setAttachments([]);
      setUploadNote(null);
      setHistoryOpen(false);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
    }
  };

  // One composer, shared by the empty-state and the in-conversation view — carries the
  // paperclip, the attachment tray, and the send gate.
  const composer = (
    <Composer
      draft={draft}
      setDraft={setDraft}
      onSend={() => send(draft)}
      listening={voice.listening}
      onToggleVoice={voice.toggle}
      attachments={attachments}
      onPickFiles={pickFiles}
      onRemoveAttachment={removeAttachment}
      onRetryAttachment={retryBatch}
      uploadNote={uploadNote}
      pending={pending}
    />
  );

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
            accessibilityLabel="Chat history"
            onPress={() => setHistoryOpen(true)}
            hitSlop={6}
            className="h-9 w-9 items-center justify-center rounded-full border border-rule bg-card active:opacity-80"
          >
            <Icon name="history" size={17} color={historyIcon} />
          </Pressable>
        </View>

        {restoring ? (
          <LoadingState />
        ) : empty ? (
          <EmptyState composer={composer} onPick={send} listening={voice.listening} />
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
                if (m.role === 'user')
                  return <UserBubble key={m.id} text={m.text} attachments={m.attachments} />;
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
              {composer}
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

        <AskHistorySheet
          visible={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onNewChat={newConversation}
          onSelect={openConversation}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
