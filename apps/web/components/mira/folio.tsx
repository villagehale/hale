interface FolioProps {
  /** One-based index — formatted with leading zero ("01", "02", …, "10"). */
  index: number;
}

/**
 * Magazine-style folio number. Ranged left in the editorial gutter on
 * desktop; inline above content on mobile.
 */
export function Folio({ index }: FolioProps) {
  const label = String(index).padStart(2, '0');
  return <span className="folio">{label}</span>;
}
