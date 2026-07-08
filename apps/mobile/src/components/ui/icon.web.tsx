import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

import type { IconName, IconProps } from './icon';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

// SF Symbols don't render on RN-web, so the preview shows bare circles. Map the
// symbols we actually use to the closest Ionicons glyph so the web preview reads
// true. Native keeps real SF Symbols (icon.tsx). Unmapped names fall back to a
// neutral dot.
const SF_TO_IONICON: Record<string, IoniconName> = {
  house: 'home-outline',
  'house.fill': 'home',
  'figure.2.and.child.holdinghands': 'people',
  sparkles: 'sparkles',
  map: 'map-outline',
  'map.fill': 'map',
  ellipsis: 'ellipsis-horizontal',
  mic: 'mic-outline',
  'mic.fill': 'mic',
  'stop.fill': 'stop',
  'arrow.up': 'arrow-up',
  'chevron.left': 'chevron-back',
  'chevron.right': 'chevron-forward',
  'chevron.up': 'chevron-up',
  'chevron.down': 'chevron-down',
  trash: 'trash-outline',
  plus: 'add',
  'square.and.arrow.up': 'share-outline',
  'square.and.pencil': 'create-outline',
  book: 'book-outline',
  calendar: 'calendar',
  checkmark: 'checkmark',
  envelope: 'mail-outline',
  'checkmark.circle': 'checkmark-circle',
  'arrow.up.right.square': 'open-outline',
  'person.2': 'people',
  gearshape: 'settings-outline',
  pencil: 'pencil',
  'mappin.and.ellipse': 'location-outline',
  'rectangle.portrait.and.arrow.right': 'log-out-outline',
  'drop.fill': 'water',
  'moon.fill': 'moon',
  'star.fill': 'star',
  'syringe.fill': 'medkit-outline',
  'book.fill': 'book',
  'lock.shield.fill': 'lock-closed-outline',
  'checkmark.shield.fill': 'shield-checkmark-outline',
  'cross.case.fill': 'medkit-outline',
  'doc.text.fill': 'document-text-outline',
  bookmark: 'bookmark-outline',
  'bookmark.fill': 'bookmark',
  'person.crop.circle': 'person-circle-outline',
  'slider.horizontal.3': 'options-outline',
  xmark: 'close',
  heart: 'heart-outline',
  'person.3': 'people',
  magnifyingglass: 'search-outline',
  clock: 'time-outline',
  creditcard: 'card-outline',
};

export type { IconName, IconProps };

export function Icon({ name, size = 20, color }: IconProps) {
  const glyph = SF_TO_IONICON[name as string] ?? 'ellipse';
  return <Ionicons name={glyph} size={size} color={color} />;
}
