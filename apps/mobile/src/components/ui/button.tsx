import { Pressable } from 'react-native';

import { AppText } from './app-text';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary';
  className?: string;
};

export function Button({ label, onPress, variant = 'primary', className }: ButtonProps) {
  const isPrimary = variant === 'primary';
  const base =
    'min-h-12 flex-row items-center justify-center rounded-full px-6 py-3.5 active:opacity-80';
  const surface = isPrimary ? 'bg-ink' : 'border border-rule-strong bg-transparent';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`${base} ${surface} ${className ?? ''}`}
    >
      <AppText variant="meta" className={isPrimary ? 'text-canvas' : 'text-ink'}>
        {label}
      </AppText>
    </Pressable>
  );
}
