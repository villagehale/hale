import { Pressable } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';
import { Icon, type IconName } from './icon';

type PillProps = {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  className?: string;
};

export function Pill({ label, icon, onPress, className }: PillProps) {
  const iconColor = useMeadowColor('ink2');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`h-11 flex-row items-center justify-center gap-1.5 rounded-full border border-rule bg-card px-4 active:opacity-80 ${className ?? ''}`}
    >
      {icon ? <Icon name={icon} size={15} color={iconColor} /> : null}
      <AppText variant="meta" numberOfLines={1} className="text-ink">
        {label}
      </AppText>
    </Pressable>
  );
}
