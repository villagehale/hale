import { Pressable } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary';
  className?: string;
};

export function Button({ label, onPress, variant = 'primary', className }: ButtonProps) {
  const isPrimary = variant === 'primary';
  const onAccent = useMeadowColor('onAccent');
  const base =
    'min-h-12 flex-row items-center justify-center rounded-full px-6 py-3.5 active:opacity-80';
  const surface = isPrimary ? 'bg-accent-fill' : 'border border-rule-strong bg-transparent';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`${base} ${surface} ${className ?? ''}`}
    >
      <AppText
        variant="meta"
        className={isPrimary ? '' : 'text-ink'}
        style={isPrimary ? { color: onAccent } : undefined}
      >
        {label}
      </AppText>
    </Pressable>
  );
}
