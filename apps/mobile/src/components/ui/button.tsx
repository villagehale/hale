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
    'min-h-12 flex-row items-center justify-center rounded-full px-6 py-3.5 active:opacity-90';
  // Primary = spruce fill + PURE-WHITE label (text-on-ink, mirroring web
  // --color-on-spruce). Off-white canvas read grey on the Prussian fill. Apricot
  // stays FILL-for-graphics only (global.css) — never a small-text ground — so
  // the CTA keeps the ink surface, matching web .btn-primary.
  const surface = isPrimary
    ? 'bg-ink border border-ink'
    : 'border border-rule-strong bg-transparent active:bg-card';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`${base} ${surface} ${className ?? ''}`}
    >
      <AppText variant="meta" className={isPrimary ? 'text-on-ink' : 'text-ink'}>
        {label}
      </AppText>
    </Pressable>
  );
}
