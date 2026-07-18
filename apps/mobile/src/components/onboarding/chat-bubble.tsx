import { useColorScheme, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { LogoMark } from '@/components/ui/logo-mark';

/**
 * The onboarding prompt bubble: the Hale chip beside a warm incoming-message bubble
 * (the handoff's `#F3F1EB`, with a dark-scheme equivalent so the ink text stays
 * readable). Used where Hale "asks" the parent something (first child, anyone else).
 * An optional `sub` line sits under the bubble, indented to align past the chip.
 */
const BUBBLE_LIGHT = '#f3f1eb';
const BUBBLE_DARK = '#282318';

export function ChatBubble({ prompt, sub }: { prompt: string; sub?: string }) {
  const bubbleBg = useColorScheme() === 'dark' ? BUBBLE_DARK : BUBBLE_LIGHT;
  return (
    <View className="gap-2.5">
      <View className="flex-row items-start gap-2.5">
        <LogoMark size={38} />
        <View
          className="max-w-[270px] self-start rounded-[16px] rounded-tl-[4px] px-3.5 py-3"
          style={{ backgroundColor: bubbleBg }}
        >
          <AppText variant="section" className="text-[14px] leading-[19px]">
            {prompt}
          </AppText>
        </View>
      </View>
      {sub ? (
        <AppText variant="meta" className="ml-12 text-caption">
          {sub}
        </AppText>
      ) : null}
    </View>
  );
}
