import { useRef, useState } from 'react';
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
import { IconButton } from '@/components/ui/icon-button';
import { Tag } from '@/components/ui/tag';
import {
  PLACEHOLDER_REPLY,
  PLACEHOLDER_SOURCE,
  STARTER_CHIPS,
  type SourceCard,
} from '@/constants/ask-data';
import { useMeadowColor } from '@/constants/meadow';
import { useTypewriter } from '@/lib/use-typewriter';

type Message = { id: string; role: 'user' | 'hale'; text: string; source?: SourceCard };

function UserBubble({ text }: { text: string }) {
  return (
    <View className="mb-3 max-w-[85%] self-end rounded-lg rounded-br-sm bg-ink px-4 py-3">
      <AppText variant="body" className="text-canvas">
        {text}
      </AppText>
    </View>
  );
}

function SourceBlock({ source }: { source: SourceCard }) {
  return (
    <Card raised className="mt-2 gap-1">
      <Tag label={`Source · ${source.framework}`} tone="coach" />
      <AppText variant="title" className="mt-1">
        {source.title}
      </AppText>
      <AppText variant="meta">{source.summary}</AppText>
    </Card>
  );
}

function HaleBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const [shown, isStreaming] = useTypewriter(message.text, streaming);
  const text = streaming ? shown : message.text;
  return (
    <View className="mb-3 max-w-[92%] self-start">
      <AppText variant="meta" className="mb-1 uppercase tracking-eyebrow text-ink-3">
        Hale
      </AppText>
      <View className="rounded-lg rounded-bl-sm border border-rule bg-card px-4 py-3">
        <AppText variant="body">
          {text}
          {isStreaming ? (
            <AppText variant="body" className="text-accent">
              {' ▍'}
            </AppText>
          ) : null}
        </AppText>
      </View>
      {message.source && !isStreaming ? <SourceBlock source={message.source} /> : null}
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
  const scrollRef = useRef<ScrollView>(null);
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');

  const send = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', text: q };
    const replyId = `h-${Date.now()}`;
    const haleMsg: Message = {
      id: replyId,
      role: 'hale',
      text: PLACEHOLDER_REPLY,
      source: PLACEHOLDER_SOURCE,
    };
    setMessages((prev) => [...prev, userMsg, haleMsg]);
    setStreamingId(replyId);
    setDraft('');
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  };

  const empty = messages.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="px-5 pt-2">
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
          </ScrollView>
        )}

        <View className="border-t border-rule bg-card px-5 pb-3 pt-3">
          <AppText variant="meta" className="mb-1.5 uppercase tracking-eyebrow text-ink-3">
            Ask a question
          </AppText>
          <View className="flex-row items-end gap-2">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Type, or hold the mic to talk"
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
              <IconButton icon="mic" accessibilityLabel="Ask Hale by voice" className="bg-raised" />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
