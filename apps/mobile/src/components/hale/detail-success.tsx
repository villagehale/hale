import type { ReactNode } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';

/**
 * The handoff's inline success confirmation — STATE, not a modal (README:
 * "Success states are inline green confirmations, not modals"). A centered green
 * check, a serif headline, optional subcopy, a caller-supplied summary body, and a
 * stacked action column (an optional secondary above the primary). Shared by the
 * Appointment "added to your approvals" and Activity "You're interested!" states so
 * both read as one system. The green check reuses the tint-chip green token
 * (chipGreenIcon on bg-chip-green), same as every other green glyph in the app.
 */
export function DetailSuccess({
  headline,
  subcopy,
  children,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  headline: string;
  subcopy?: string;
  children?: ReactNode;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const check = useMeadowColor('chipGreenIcon');
  return (
    <View className="items-center pt-10" accessibilityLiveRegion="polite">
      <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-chip-green">
        <Icon name="check" size={28} color={check} />
      </View>
      <AppText variant="title" className="text-center">
        {headline}
      </AppText>
      {subcopy ? (
        <AppText variant="meta" className="mt-1.5 text-center">
          {subcopy}
        </AppText>
      ) : null}
      {children ? <View className="mt-5 w-full">{children}</View> : null}
      <View className="mt-5 w-full gap-2.5">
        {secondaryLabel && onSecondary ? (
          <Button label={secondaryLabel} variant="secondary" onPress={onSecondary} />
        ) : null}
        <Button label={primaryLabel} onPress={onPrimary} />
      </View>
    </View>
  );
}
