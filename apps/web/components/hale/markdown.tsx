import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders an agent answer (markdown from the model) as formatted text — bold,
 * lists, headings, links — instead of leaking raw `**asterisks**`. react-markdown
 * renders to React elements (no raw HTML), so model output can't inject markup.
 * Styling lives in `.hale-markdown` (globals.css), keyed to the design tokens.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="hale-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
