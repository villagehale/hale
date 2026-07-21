import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The heavy markdown renderer (react-markdown + the remark-gfm / unified-mdast chain,
 * ~50-70KB gz). Split into its own chunk and loaded lazily by ./markdown so the parser
 * never rides into the coach route's initial First Load JS — it arrives only when the
 * first model answer actually renders. react-markdown renders to React elements (no raw
 * HTML), so model output can't inject markup.
 */
export function MarkdownBody({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
}
