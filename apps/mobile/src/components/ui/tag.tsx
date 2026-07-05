import { View } from 'react-native';

import { AppText } from './app-text';

export type TagTone = 'neutral' | 'done' | 'attention' | 'coach';

const TONE: Record<TagTone, { bg: string; text: string }> = {
  neutral: { bg: 'bg-raised', text: 'text-ink-2' },
  done: { bg: 'bg-sage-tint', text: 'text-sage' },
  attention: { bg: 'bg-berry-tint', text: 'text-berry' },
  coach: { bg: 'bg-sky-tint', text: 'text-sky' },
};

export function Tag({ label, tone = 'neutral' }: { label: string; tone?: TagTone }) {
  const t = TONE[tone];
  return (
    <View className={`h-6 min-w-6 items-center justify-center self-start rounded-full px-2.5 ${t.bg}`}>
      <AppText
        variant="meta"
        className={`text-[11px] uppercase leading-none tracking-eyebrow ${t.text}`}
      >
        {label}
      </AppText>
    </View>
  );
}
