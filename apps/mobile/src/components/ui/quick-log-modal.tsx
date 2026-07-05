import { useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { api, ApiError } from '@/lib/api-client';

import { AppText } from './app-text';
import { Button } from './button';
import { Field } from './field';

export type LogKind = 'feed' | 'nap' | 'milestone';

type ChildOption = { id: string; name: string | null };

const KIND_META: Record<
  LogKind,
  { title: string; field: string; placeholder: string; keyboard: 'numeric' | 'default'; empty: string }
> = {
  feed: {
    title: 'Log a feed',
    field: 'Amount (ml)',
    placeholder: '120',
    keyboard: 'numeric',
    empty: 'Enter how much (ml) before saving.',
  },
  nap: {
    title: 'Log a nap',
    field: 'Duration (min)',
    placeholder: '45',
    keyboard: 'numeric',
    empty: 'Enter how long (minutes) before saving.',
  },
  milestone: {
    title: 'Note a milestone',
    field: 'What happened',
    placeholder: 'Rolled over for the first time',
    keyboard: 'default',
    empty: 'Enter what happened before saving.',
  },
};

/** Minutes-ago presets for the "when" control. A quick-log is almost always
 * "just now" or a short while ago — steppers beat a full date picker at 3am and
 * need no extra native dependency. */
const WHEN_PRESETS: { label: string; minutesAgo: number }[] = [
  { label: 'now', minutesAgo: 0 },
  { label: '30m ago', minutesAgo: 30 },
  { label: '1h ago', minutesAgo: 60 },
  { label: '2h ago', minutesAgo: 120 },
];

function buildPayload(kind: LogKind, childId: string, entry: string, occurredAt: string) {
  const base = { childId, occurredAt };
  if (kind === 'feed') return { kind, ...base, amountMl: entry };
  if (kind === 'nap') return { kind, ...base, durationMin: entry };
  return { kind, ...base, milestone: entry };
}

/**
 * The shared in-place quick-log sheet. Opens for the tapped kind with the right
 * field (feed=amount, nap=duration, milestone=text) plus a "when" control that
 * defaults to now. Sends occurredAt (ISO) so an earlier event lands at the right
 * time. POSTs the SAME /api/mobile/companion/log endpoint the companion uses —
 * one write path, one audit row (rule #6). Errors surface in place, never a
 * silent success.
 */
export function QuickLogModal({
  visible,
  kind,
  kids,
  onClose,
  onLogged,
}: {
  visible: boolean;
  kind: LogKind | null;
  kids: ChildOption[];
  onClose: () => void;
  onLogged: () => void;
}) {
  const [childId, setChildId] = useState('');
  const [value, setValue] = useState('');
  const [minutesAgo, setMinutesAgo] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setChildId(kids[0]?.id ?? '');
      setValue('');
      setMinutesAgo(0);
      setError(null);
      setSaving(false);
    }
  }, [visible, kids]);

  if (!kind) return null;
  const meta = KIND_META[kind];

  const save = async () => {
    const entry = value.trim();
    if (!entry) {
      setError(meta.empty);
      return;
    }
    if (!childId) {
      setError('Add a child first.');
      return;
    }
    setError(null);
    setSaving(true);
    const occurredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(buildPayload(kind, childId, entry, occurredAt)),
      });
      onLogged();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/40" onPress={onClose} accessibilityLabel="Close">
        <Pressable className="rounded-t-[24px] border-t border-rule bg-canvas px-5 pb-8 pt-3">
          <View className="mb-4 h-1.5 w-10 self-center rounded-full bg-rule-strong" />

          <AppText variant="title" className="mb-4">
            {meta.title}
          </AppText>

          {kids.length > 1 ? (
            <View className="mb-4 flex-row gap-2 rounded-full border border-rule bg-card p-1">
              {kids.map((child) => {
                const active = child.id === childId;
                return (
                  <Pressable
                    key={child.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Log for ${child.name ?? 'child'}`}
                    accessibilityState={active ? { selected: true } : {}}
                    onPress={() => setChildId(child.id)}
                    className={`flex-1 items-center rounded-full py-2 ${active ? 'bg-raised' : ''}`}
                  >
                    <AppText variant="meta" className={active ? 'text-ink' : 'text-ink-3'}>
                      {child.name ?? 'Child'}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View className="mb-4">
            <Field
              label={meta.field}
              value={value}
              onChangeText={setValue}
              keyboardType={meta.keyboard}
              placeholder={meta.placeholder}
              autoCapitalize={kind === 'milestone' ? 'sentences' : 'none'}
              autoFocus
            />
          </View>

          <View className="mb-4 gap-1.5">
            <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
              When
            </AppText>
            <View className="flex-row gap-2">
              {WHEN_PRESETS.map((preset) => {
                const active = preset.minutesAgo === minutesAgo;
                return (
                  <Pressable
                    key={preset.label}
                    accessibilityRole="button"
                    accessibilityLabel={`When: ${preset.label}`}
                    accessibilityState={active ? { selected: true } : {}}
                    onPress={() => setMinutesAgo(preset.minutesAgo)}
                    className={`h-10 flex-1 items-center justify-center rounded-full border ${
                      active ? 'border-ink bg-ink' : 'border-rule bg-card'
                    }`}
                  >
                    <AppText variant="meta" className={active ? 'text-canvas' : 'text-ink-2'}>
                      {preset.label}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {error ? (
            <AppText variant="meta" className="mb-3 text-berry" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}

          <Button label={saving ? 'Saving…' : 'Save log'} onPress={save} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
