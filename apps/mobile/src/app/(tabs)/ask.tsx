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

import { AppText } from '@/components/ui/app-text';
import { IconButton } from '@/components/ui/icon-button';
import { LogoMark } from '@/components/ui/logo-mark';
import { Markdown } from '@/components/ui/markdown';
import { STARTER_CHIPS } from '@/constants/ask-data';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import { askHale } from '@/lib/coach-api';
import { useTypewriter } from '@/lib/use-typewriter';
import { useVoiceInput } from '@/lib/use-voice-input';

type Message = { id: string; role: 'user' | 'hale'; text: string };

function UserBubble({ text }: { text: string }) {
  return (
    <View className="mb-3 max-w-[85%] self-end rounded-lg rounded-br-sm bg-ink px-4 py-3">
      <AppText variant="body" className="text-canvas">
        {text}
      </AppText>
    </View>
  );
}

function HaleBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const [shown, isStreaming] = useTypewriter(message.text, streaming);
  return (
    <View className="mb-3 max-w-[92%] self-start">
      <AppText variant="meta" className="mb-1 text-ink-3">
        Hale
      </AppText>
      <View className="rounded-lg rounded-bl-sm border border-rule bg-card px-4 py-3">
        {isStreaming ? (
          // Reveal raw text word-by-word while streaming; once settled, render the
          // full answer as formatted markdown (bold, lists, headings).
          <AppText variant="body">
            {shown}
            <AppText variant="body" className="text-accent">
              {' ▍'}
            </AppText>
          </AppText>
        ) : (
          <Markdown>{message.text}</Markdown>
        )}
      </View>
    </View>
  );
}

function StarterChips({ onPick }: { onPick: (q: string) => void }) {
  return (
    <View className="flex-1 justify-end gap-3 pb-2">
      <AppText variant="title">What can I help with?</AppText>
      <AppText variant="meta">Tap a question, or ask your own below.</AppText>
      <View className="mt-1 gap-2">
        {STARTER_CHIPS.map((q) => (
          <Pressable
            key={q}
            accessibilityRole="button"
            accessibilityLabel={q}
            onPress={() => onPick(q)}
            className="rounded-lg border border-rule bg-card px-4 py-3 active:opacity-80"
          >
            <AppText variant="body" className="text-ink">
              {q}
            </AppText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function AskScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const conversationId = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const voice = useVoiceInput(setDraft);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', text: q };
    setMessages((prev) => [...prev, userMsg]);
    setDraft('');
    voice.reset();
    setPending(true);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

    try {
      const { answer, conversationId: nextId } = await askHale({
        question: q,
        ...(conversationId.current ? { conversationId: conversationId.current } : {}),
      });
      conversationId.current = nextId;
      const replyId = `h-${Date.now()}`;
      setMessages((prev) => [...prev, { id: replyId, role: 'hale', text: answer }]);
      setStreamingId(replyId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      const replyId = `h-err-${Date.now()}`;
      setMessages((prev) => [...prev, { id: replyId, role: 'hale', text: (e as Error).message }]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  };

  const empty = messages.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-row items-center gap-2 px-5 pt-2">
          <LogoMark size={26} />
          <AppText variant="display">Ask Hale</AppText>
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
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} text={m.text} />
              ) : (
                <HaleBubble key={m.id} message={m} streaming={m.id === streamingId} />
              ),
            )}
            {pending ? (
              <View className="mb-3 max-w-[92%] self-start">
                <AppText variant="meta" className="mb-1 text-ink-3">
                  Hale
                </AppText>
                <View className="rounded-lg rounded-bl-sm border border-rule bg-card px-4 py-3">
                  <AppText variant="body" className="text-ink-3">
                    Thinking…
                  </AppText>
                </View>
              </View>
            ) : null}
          </ScrollView>
        )}

        <View className="border-t border-rule bg-card px-5 pb-3 pt-3">
          <AppText variant="meta" className="mb-1.5 text-ink-2">
            {voice.listening ? 'Listening…' : 'Ask a question'}
          </AppText>
          <View className="flex-row items-end gap-2">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Type, or tap the mic to talk"
              placeholderTextColor={placeholderColor}
              accessibilityLabel="Ask Hale a question"
              multiline
              returnKeyType="send"
              onSubmitEditing={() => send(draft)}
              style={{ color: inputColor, fontFamily: 'Inter_400Regular', maxHeight: 120 }}
              className="min-h-11 flex-1 rounded-lg border border-rule bg-canvas px-4 py-3 text-[16px] leading-[22px]"
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
