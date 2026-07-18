import Svg, { Circle, Ellipse, Path } from 'react-native-svg';

/**
 * "Kai" — the Hale turtle mascot, a friendly side view in the brand palette (navy
 * shell echoing the logo, teal body, cream plates). Recreated as react-native-svg
 * from the approved illustration draft; decorative, so it carries no accessible name
 * (the surrounding copy does). Scales from a fixed 240×190 art board — pass `width`
 * and the height follows the aspect ratio.
 */
export function TurtleMascot({ width = 200 }: { width?: number }) {
  return (
    <Svg
      width={width}
      height={(width * 190) / 240}
      viewBox="0 0 240 190"
      fill="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* soft ground shadow */}
      <Ellipse cx={118} cy={168} rx={78} ry={10} fill="#EEEBE4" />
      {/* back flipper */}
      <Path d="M76 142 C62 152 48 156 40 152 C48 144 56 134 66 128 Z" fill="#2B9C8F" />
      {/* body / head */}
      <Path
        d="M170 118 C186 118 200 106 200 92 C200 78 188 68 174 68 C166 68 160 71 155 76 C142 60 118 52 96 56 C64 62 42 88 44 118 C45 136 58 150 78 154 L150 154 C162 150 168 136 170 118 Z"
        fill="#35B5A5"
      />
      {/* eye + smile */}
      <Circle cx={178} cy={86} r={4.5} fill="#17294A" />
      <Path
        d="M186 98 C190 101 195 101 198 98"
        stroke="#17294A"
        strokeWidth={3}
        strokeLinecap="round"
      />
      {/* front flipper */}
      <Path d="M120 140 C112 158 98 168 84 168 C90 156 96 144 106 134 Z" fill="#2B9C8F" />
      {/* shell */}
      <Path
        d="M58 118 C58 84 88 60 122 60 C154 60 176 84 176 112 C176 130 164 142 146 144 L84 144 C68 142 58 132 58 118 Z"
        fill="#1B2160"
      />
      {/* shell rim */}
      <Path
        d="M62 132 C90 142 146 142 172 126 C170 136 162 142 146 144 L84 144 C74 143 66 138 62 132 Z"
        fill="#141A4E"
      />
      {/* shell plates (white + cream, echoing the logo) */}
      <Path d="M104 76 L126 72 L140 86 L134 104 L110 106 L98 92 Z" fill="#FFFFFF" />
      <Path d="M88 84 L98 92 L94 108 L78 106 C79 97 82 90 88 84 Z" fill="#FFF6E9" />
      <Path d="M140 86 L156 82 C162 90 165 98 164 108 L150 112 L134 104 Z" fill="#FFF6E9" />
      <Path d="M110 106 L134 104 L146 118 L128 130 L106 124 Z" fill="#FFF6E9" />
      <Path d="M94 108 L106 124 L96 132 C88 128 82 122 78 114 Z" fill="#FFFFFF" />
      <Path d="M146 118 L160 112 C158 122 152 130 142 134 L136 128 Z" fill="#FFFFFF" />
      {/* tiny bubbles */}
      <Circle cx={212} cy={60} r={5} fill="#EDF0FA" />
      <Circle cx={222} cy={44} r={3.5} fill="#EDF0FA" />
    </Svg>
  );
}
