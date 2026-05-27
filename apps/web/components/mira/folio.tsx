interface FolioProps {
  /** One-based index — rendered as a small caps roman numeral. */
  index: number;
}

const ROMAN: ReadonlyArray<string> = [
  '',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  'vi',
  'vii',
  'viii',
  'ix',
  'x',
  'xi',
  'xii',
  'xiii',
  'xiv',
  'xv',
  'xvi',
  'xvii',
  'xviii',
  'xix',
  'xx',
];

/**
 * Magazine-style folio. We use lowercase roman numerals to underline the
 * book/almanac idiom — distinct from the "01 / 02" arabic folios used
 * during the prior pass.
 */
export function Folio({ index }: FolioProps) {
  const label = ROMAN[index] ?? String(index);
  return <span className="folio">{label}</span>;
}
