import { SymbolView, type SymbolViewProps } from 'expo-symbols';

export type IconName = SymbolViewProps['name'];

export type IconProps = {
  name: IconName;
  size?: number;
  color: string;
};

export function Icon({ name, size = 20, color }: IconProps) {
  return <SymbolView name={name} size={size} tintColor={color} />;
}
