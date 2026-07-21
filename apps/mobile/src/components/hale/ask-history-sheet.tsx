import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { ConversationSummary, MobileConversationsResponse } from '@/lib/api-types';
import { type GroupedConversations, formatSessionTime, groupConversations } from '@/lib/ask-history';

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; conversations: ConversationSummary[] }
  | { status: 'error'; error: string };

/** One conversation row: title (single line) over its friendly last-active time, with
 * a trailing chevron — the app's standard list row. No category tag: the list
 * endpoint carries none (spec Feature 3 honesty note). */
function SessionRow({
  conversation,
  now,
  last,
  onSelect,
}: {
  conversation: ConversationSummary;
  now: Date;
  last: boolean;
  onSelect: (id: string) => void;
}) {
  const chevron = useMeadowColor('ink3');
  const title = conversation.title.trim() || 'Untitled chat';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open chat: ${title}`}
      onPress={() => onSelect(conversation.id)}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
        last ? '' : 'border-b border-hairline'
      }`}
    >
      <View className="flex-1">
        <AppText
          numberOfLines={1}
          className="text-[14px] text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          {title}
        </AppText>
        <AppText variant="meta" className="text-caption">
          {formatSessionTime(conversation.lastMessageAt, now)}
        </AppText>
      </View>
      <Icon name="chevron-right" size={14} color={chevron} />
    </Pressable>
  );
}

function SessionGroup({
  heading,
  conversations,
  now,
  onSelect,
}: {
  heading: string;
  conversations: ConversationSummary[];
  now: Date;
  onSelect: (id: string) => void;
}) {
  if (conversations.length === 0) return null;
  return (
    <View className="mb-4">
      <AppText variant="eyebrow" className="mb-2">
        {heading}
      </AppText>
      <View className="overflow-hidden rounded-[16px] border border-rule">
        {conversations.map((conversation, i) => (
          <SessionRow
            key={conversation.id}
            conversation={conversation}
            now={now}
            last={i === conversations.length - 1}
            onSelect={onSelect}
          />
        ))}
      </View>
    </View>
  );
}

/** Three muted placeholder rows while the list loads. */
function SkeletonRows() {
  return (
    <View className="overflow-hidden rounded-[16px] border border-rule">
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          className={`px-4 py-3.5 ${i === 2 ? '' : 'border-b border-hairline'}`}
        >
          <View className="h-3.5 w-2/3 rounded bg-chip-gray" />
          <View className="mt-2 h-2.5 w-16 rounded bg-chip-gray" />
        </View>
      ))}
    </View>
  );
}

/**
 * The Ask "Chat history" sheet: a "New chat" action over the family's real
 * conversations grouped into Today / Earlier. The list is (re)fetched each time the
 * sheet opens so a just-finished chat appears. Selecting a row or starting a new chat
 * is handled by the parent (which owns the Ask message list); this sheet only lists.
 */
export function AskHistorySheet({
  visible,
  onClose,
  onNewChat,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => Promise<void>;
}) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [selectError, setSelectError] = useState<string | null>(null);
  const plus = useMeadowColor('brand');
  // Only the latest fetch's response is applied — a stale in-flight read from a prior
  // open (or before a retry) is ignored.
  const requestSeq = useRef(0);

  // Open a row's transcript through the parent. A failed load surfaces an inline error
  // and leaves the sheet open so the row can be retried, instead of a silent no-op; a
  // 401 is the client's own sign-in bounce, so say nothing.
  const openRow = async (id: string) => {
    setSelectError(null);
    try {
      await onSelect(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setSelectError("Couldn't open that chat. Please try again.");
    }
  };

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setState({ status: 'loading' });
    api<MobileConversationsResponse>('/api/mobile/conversations')
      .then((data) => {
        if (seq === requestSeq.current) setState({ status: 'ready', conversations: data.conversations });
      })
      .catch((e) => {
        // A 401 is handled by the client (clears session, bounces to sign-in); don't
        // flash an error on the way out.
        if (e instanceof ApiError && e.status === 401) return;
        if (seq === requestSeq.current) setState({ status: 'error', error: (e as Error).message });
      });
  }, []);

  // (Re)fetch each time the sheet opens so a just-finished chat appears; clear any
  // stale row-open error from a prior open.
  useEffect(() => {
    if (visible) {
      setSelectError(null);
      load();
    }
  }, [visible, load]);

  const now = new Date();
  const grouped: GroupedConversations =
    state.status === 'ready'
      ? groupConversations(state.conversations, now)
      : { today: [], earlier: [] };
  const empty =
    state.status === 'ready' && grouped.today.length === 0 && grouped.earlier.length === 0;

  return (
    <Sheet visible={visible} onClose={onClose} title="Chat history">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start a new chat"
        onPress={onNewChat}
        className="mb-4 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card py-3.5 active:opacity-80"
      >
        <Icon name="plus" size={15} color={plus} />
        <AppText className="text-[14px] text-brand" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          New chat
        </AppText>
      </Pressable>

      {selectError ? (
        <AppText
          variant="meta"
          className="mb-3 text-center text-berry"
          accessibilityLiveRegion="polite"
        >
          {selectError}
        </AppText>
      ) : null}

      {state.status === 'loading' ? <SkeletonRows /> : null}

      {state.status === 'error' ? (
        <View className="items-center gap-2 py-8">
          <AppText variant="meta" className="text-center text-caption" accessibilityLiveRegion="polite">
            {state.error}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try loading chat history again"
            onPress={load}
            hitSlop={8}
            className="active:opacity-70"
          >
            <AppText variant="meta" className="text-accent">
              Try again
            </AppText>
          </Pressable>
        </View>
      ) : null}

      {empty ? (
        <View className="items-center py-10">
          <AppText variant="meta" className="text-caption">
            No past chats yet.
          </AppText>
        </View>
      ) : null}

      {state.status === 'ready' ? (
        <>
          <SessionGroup heading="Today" conversations={grouped.today} now={now} onSelect={openRow} />
          <SessionGroup
            heading="Earlier"
            conversations={grouped.earlier}
            now={now}
            onSelect={openRow}
          />
        </>
      ) : null}
    </Sheet>
  );
}
