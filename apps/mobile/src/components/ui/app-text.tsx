import { Text, type TextProps } from 'react-native';

export type AppTextVariant = 'display' | 'title' | 'body' | 'meta' | 'mono';

export type AppTextProps = TextProps & {
  variant?: AppTextVariant;
};

// On native each weight is a separate font file, so a single family + fontWeight
// won't switch files — we set the weight-named family that _layout.tsx loads.
const VARIANT_FAMILY: Record<AppTextVariant, string> = {
  display: 'Inter_600SemiBold',
  title: 'Inter_600SemiBold',
  body: 'Inter_400Regular',
  meta: 'Inter_500Medium',
  mono: 'JetBrainsMono_500Medium',
};

const VARIANT_CLASS: Record<AppTextVariant, string> = {
  display: 'text-[32px] leading-[38px] tracking-display text-ink',
  title: 'text-[20px] leading-[26px] text-ink',
  body: 'text-[16px] leading-[24px] text-ink-2',
  meta: 'text-[13px] leading-[18px] text-ink-3',
  mono: 'text-[14px] leading-[20px] text-ink-2',
};

export function AppText({ variant = 'body', className, style, ...rest }: AppTextProps) {
  return (
    <Text
      className={`${VARIANT_CLASS[variant]} ${className ?? ''}`}
      style={[{ fontFamily: VARIANT_FAMILY[variant] }, style]}
      {...rest}
    />
  );
}
