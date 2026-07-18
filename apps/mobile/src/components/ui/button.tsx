import { Pressable } from 'react-native';

import { AppText } from './app-text';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** Blocks onPress and dims the control — pass while a submit is in flight so a
   * slow network can't double-fire (sign-in, approvals, family save). */
  disabled?: boolean;
  className?: string;
};

// Handoff button set. primary = navy brand fill + white 15/600 label; secondary =
// white card face + input-border outline; ghost = bare text (e.g. onboarding
// "Maybe later"). All are rounded-rect (radius 16px), full-width by column stretch
// or `flex-1` in a row — never a pill.
const VARIANT: Record<ButtonVariant, { surface: string; label: string }> = {
  primary: { surface: 'bg-brand border border-brand', label: 'text-on-ink' },
  secondary: { surface: 'border border-rule-strong bg-card active:bg-canvas', label: 'text-ink' },
  ghost: { surface: 'bg-transparent', label: 'text-ink-3' },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  className,
}: ButtonProps) {
  const { surface, label: labelColor } = VARIANT[variant];
  const base = `min-h-12 flex-row items-center justify-center rounded-[16px] px-6 py-4 ${
    disabled ? 'opacity-50' : 'active:opacity-90'
  }`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`${base} ${surface} ${className ?? ''}`}
    >
      <AppText variant="section" className={labelColor}>
        {label}
      </AppText>
    </Pressable>
  );
}
