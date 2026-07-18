import { Text, type TextProps } from 'react-native';

export type AppTextVariant =
  | 'display'
  | 'title'
  | 'section'
  | 'eyebrow'
  | 'body'
  | 'meta'
  | 'mono';

export type AppTextProps = TextProps & {
  variant?: AppTextVariant;
};

// On native each weight is a separate font file, so a single family + fontWeight
// won't switch files — we set the weight-named family that _layout.tsx loads.
const VARIANT_FAMILY: Record<AppTextVariant, string> = {
  display: 'SourceSerif4_600SemiBold',
  title: 'SourceSerif4_500Medium',
  section: 'InstrumentSans_600SemiBold',
  eyebrow: 'InstrumentSans_700Bold',
  body: 'InstrumentSans_400Regular',
  meta: 'InstrumentSans_500Medium',
  mono: 'InstrumentSans_500Medium',
};

const VARIANT_CLASS: Record<AppTextVariant, string> = {
  display: 'text-[34px] leading-[40px] tracking-display text-ink',
  title: 'text-[22px] leading-[28px] tracking-display text-ink',
  section: 'text-[15px] leading-[20px] tracking-display text-ink',
  // The prototype's section label: 11.5px / 700 / uppercase / 0.07em / caption gray.
  // Caption gray is policy-compliant here — an eyebrow is a non-essential section
  // label (the content beneath carries the meaning). See DESIGN.md.
  eyebrow: 'text-[11.5px] leading-[16px] uppercase tracking-eyebrow-tight text-caption',
  body: 'text-[14px] leading-[21px] text-ink-2',
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
