import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The village illustration — a warm cluster of homes in the brand palette (chip
 * blue / cream / chip green), sun and tree. Recreated as react-native-svg from the
 * approved illustration draft; decorative, so it carries no accessible name (the
 * surrounding copy does). Scales from a fixed 320×170 art board — pass `width` and
 * the height follows the aspect ratio.
 */
export function VillageHouses({ width = 260 }: { width?: number }) {
  return (
    <Svg
      width={width}
      height={(width * 170) / 320}
      viewBox="0 0 320 170"
      fill="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* sun */}
      <Circle cx={282} cy={34} r={16} fill="#F28C45" />
      {/* ground */}
      <Path d="M12 150 C80 142 240 142 308 150 L308 154 L12 154 Z" fill="#EEEBE4" />
      {/* left house — chip blue */}
      <Rect x={34} y={92} width={64} height={58} rx={4} fill="#EDF0FA" />
      <Path d="M28 96 L66 62 L104 96 Z" fill="#1B2160" />
      <Rect x={56} y={116} width={20} height={34} rx={2} fill="#1B2160" />
      <Rect x={42} y={104} width={12} height={12} rx={2} fill="#FFFFFF" />
      <Rect x={80} y={104} width={12} height={12} rx={2} fill="#FFFFFF" />
      {/* middle house — cream, tallest */}
      <Rect x={118} y={70} width={76} height={80} rx={4} fill="#FFF6E9" />
      <Path d="M110 74 L156 34 L202 74 Z" fill="#3B5BDB" />
      <Rect x={144} y={112} width={24} height={38} rx={2} fill="#B26B1F" />
      <Circle cx={156} cy={92} r={9} fill="#1B2160" />
      <Circle cx={156} cy={92} r={4} fill="#FFF6E9" />
      {/* right house — chip green */}
      <Rect x={214} y={98} width={58} height={52} rx={4} fill="#E7F6EC" />
      <Path d="M208 102 L243 70 L278 102 Z" fill="#1F8A4C" />
      <Rect x={232} y={120} width={18} height={30} rx={2} fill="#17294A" />
      <Rect x={220} y={110} width={11} height={11} rx={2} fill="#FFFFFF" />
      <Rect x={253} y={110} width={11} height={11} rx={2} fill="#FFFFFF" />
      {/* tree */}
      <Rect x={294} y={122} width={7} height={28} rx={3} fill="#B26B1F" />
      <Circle cx={297} cy={112} r={16} fill="#35B5A5" />
      {/* path dots between houses */}
      <Circle cx={108} cy={146} r={3} fill="#D9DEE8" />
      <Circle cx={206} cy={146} r={3} fill="#D9DEE8" />
      {/* birds */}
      <Path
        d="M52 44 C56 40 60 40 64 44 M64 44 C68 40 72 40 76 44"
        stroke="#8B95A9"
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}
