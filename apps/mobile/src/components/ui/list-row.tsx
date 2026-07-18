import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from './app-text';

/**
 * The handoff list-row idiom: 13px/16px padding, a 1px hairline divider (none on
 * the last row), an optional leading slot (icon / tint-chip), a 14/600 title with a
 * caption-gray sub, and an optional trailing slot (chevron / badge). Rows sit inside
 * a bordered card container that owns the outer radius; the row itself is flush.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  last = false,
  onPress,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  last?: boolean;
  onPress?: () => void;
}) {
  const body = (
    <View
      className={`flex-row items-center gap-3 px-4 py-[13px] ${last ? '' : 'border-b border-hairline'}`}
    >
      {leading}
      <View className="flex-1">
        <AppText
          variant="body"
          numberOfLines={1}
          className="text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="meta" numberOfLines={1} className="text-[12.5px] text-caption">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      className="active:opacity-80"
    >
      {body}
    </Pressable>
  );
}
