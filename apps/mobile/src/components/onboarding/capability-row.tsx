import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { type MeadowColor, useMeadowColor } from '@/constants/meadow';

/**
 * One icon-chip row for the onboarding info cards (here's-tomorrow, one-place): a
 * 34×34 tint chip, a 14px title, and a caption sub. The tint keys map to the
 * handoff's chip pairs (background class + matching icon color).
 */
type Tint = 'red' | 'yellow' | 'green' | 'blue';

const CHIP_BG: Record<Tint, string> = {
  red: 'bg-chip-red',
  yellow: 'bg-chip-yellow',
  green: 'bg-chip-green',
  blue: 'bg-chip-blue',
};

const CHIP_ICON: Record<Tint, MeadowColor> = {
  red: 'chipRedIcon',
  yellow: 'chipYellowIcon',
  green: 'chipGreenIcon',
  blue: 'chipBlueIcon',
};

export function CapabilityRow({
  icon,
  tint,
  title,
  sub,
}: {
  icon: IconName;
  tint: Tint;
  title: string;
  sub: string;
}) {
  const iconColor = useMeadowColor(CHIP_ICON[tint]);
  return (
    <View className="flex-row items-center gap-3">
      <View
        className={`h-[34px] w-[34px] items-center justify-center rounded-[11px] ${CHIP_BG[tint]}`}
      >
        <Icon name={icon} size={15} color={iconColor} />
      </View>
      <View className="flex-1">
        <AppText variant="section" className="text-[14px] leading-[18px]">
          {title}
        </AppText>
        <AppText variant="meta" className="text-[12px] leading-[16px] text-caption">
          {sub}
        </AppText>
      </View>
    </View>
  );
}
