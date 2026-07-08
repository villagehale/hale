import { Pressable } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';
import { Icon, type IconName } from './icon';

type PillProps = {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  className?: string;
  /** Tints the icon with the scarce orange accent (e.g. the Milestone quick-log
   * chip). Off by default — orange is reserved for a few important marks. */
  accent?: boolean;
};

export function Pill({ label, icon, onPress, className, accent = false }: PillProps) {
  const inkIcon = useMeadowColor('ink2');
  const accentIcon = useMeadowColor('accentFill');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`h-11 flex-row items-center justify-center gap-1.5 rounded-full border border-rule bg-card px-4 active:opacity-80 ${className ?? ''}`}
    >
      {icon ? <Icon name={icon} size={15} color={accent ? accentIcon : inkIcon} /> : null}
      <AppText variant="meta" numberOfLines={1} className="text-ink">
        {label}
      </AppText>
    </Pressable>
  );
}
