import { hasLinkShape } from '../../format/link-shape';

/** Page-sourced text with every word that holds a link dropped, before a model sees it. */
export function withoutLinks(text: string): string {
  return text
    .normalize('NFKC')
    .split(/\s+/)
    .filter((word) => word && !hasLinkShape(word))
    .join(' ');
}
