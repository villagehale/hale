import { View } from 'react-native';

import { type MeadowColor, useMeadowColor } from '@/constants/meadow';

import { Icon, type IconName } from './icon';

/**
 * The handoff's 34×34 tinted icon chip (radius 11) — a soft tone background with a
 * matching-hue outline icon. One of six tones from the token layer; the background
 * is a NativeWind class and the icon color comes from the mirrored chip*Icon token
 * so the glyph tints to match. Tone carries meaning by label + placement, never
 * color alone (rule: tone is never the only signal).
 */
export type ChipTone = 'blue' | 'green' | 'yellow' | 'red' | 'teal' | 'gray';

const TONE_BG: Record<ChipTone, string> = {
  blue: 'bg-chip-blue',
  green: 'bg-chip-green',
  yellow: 'bg-chip-yellow',
  red: 'bg-chip-red',
  teal: 'bg-chip-teal',
  gray: 'bg-chip-gray',
};

const TONE_ICON: Record<ChipTone, MeadowColor> = {
  blue: 'chipBlueIcon',
  green: 'chipGreenIcon',
  yellow: 'chipYellowIcon',
  red: 'chipRedIcon',
  teal: 'chipTealIcon',
  gray: 'chipGrayIcon',
};

export function TintChip({
  icon,
  tone,
  size = 34,
}: {
  icon: IconName;
  tone: ChipTone;
  size?: number;
}) {
  const iconColor = useMeadowColor(TONE_ICON[tone]);
  return (
    <View
      className={`items-center justify-center rounded-[11px] ${TONE_BG[tone]}`}
      style={{ width: size, height: size }}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} color={iconColor} />
    </View>
  );
}
