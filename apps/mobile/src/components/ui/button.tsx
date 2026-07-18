import { Pressable } from 'react-native';

import { type MeadowColor, useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';
import { Icon, type IconName } from './icon';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** Blocks onPress and dims the control — pass while a submit is in flight so a
   * slow network can't double-fire (sign-in, approvals, family save). */
  disabled?: boolean;
  /** Optional glyph after the label (e.g. the onboarding "Let's begin →" arrow),
   * tinted to match the label of the chosen variant. */
  trailingIcon?: IconName;
  className?: string;
};

// The label color literal per variant, for tinting a trailing icon to match.
const ICON_TINT: Record<ButtonVariant, MeadowColor> = {
  primary: 'onAccent',
  secondary: 'ink',
  ghost: 'ink3',
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
  trailingIcon,
  className,
}: ButtonProps) {
  const { surface, label: labelColor } = VARIANT[variant];
  const iconColor = useMeadowColor(ICON_TINT[variant]);
  const base = `min-h-12 flex-row items-center justify-center gap-2 rounded-[16px] px-6 py-4 ${
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
      {trailingIcon ? <Icon name={trailingIcon} size={17} color={iconColor} /> : null}
    </Pressable>
  );
}
