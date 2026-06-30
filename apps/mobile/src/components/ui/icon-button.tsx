import { Pressable } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { Icon, type IconName } from './icon';

type IconButtonProps = {
  icon: IconName;
  accessibilityLabel: string;
  onPress?: () => void;
  size?: number;
  className?: string;
};

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 20,
  className,
}: IconButtonProps) {
  const tint = useMeadowColor('ink2');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={`h-11 w-11 items-center justify-center rounded-full border border-rule bg-card active:opacity-80 ${className ?? ''}`}
    >
      <Icon name={icon} size={size} color={tint} />
    </Pressable>
  );
}
