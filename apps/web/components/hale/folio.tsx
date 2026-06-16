interface FolioProps {
  /** One-based index — rendered as a zero-padded arabic numeral. */
  index: number;
}

/**
 * Magazine-style folio, rendered as a zero-padded arabic numeral
 * ("01", "02", …) — index 1 reads as "01".
 */
export function Folio({ index }: FolioProps) {
  const label = String(index).padStart(2, '0');
  return <span className="folio">{label}</span>;
}
