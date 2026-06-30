import { TextInput, type TextInputProps, View } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';

type FieldProps = TextInputProps & {
  label: string;
  hint?: string;
};

export function Field({ label, hint, ...inputProps }: FieldProps) {
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  return (
    <View className="gap-1.5">
      <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
        {label}
      </AppText>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={placeholderColor}
        style={{ color: inputColor, fontFamily: 'Inter_400Regular' }}
        className="min-h-11 rounded-lg border border-rule bg-canvas px-4 py-3 text-[16px]"
        {...inputProps}
      />
      {hint ? <AppText variant="meta">{hint}</AppText> : null}
    </View>
  );
}
