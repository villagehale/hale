import { Text, View } from 'react-native';

import { AppText } from './app-text';

/**
 * A small markdown renderer for agent answers — enough of the syntax the model
 * actually emits (headings, bullet/numbered lists, bold, italic) so replies read
 * as formatted text instead of leaking raw `**asterisks**` and `- dashes`.
 *
 * Deliberately not a full CommonMark parser: react-native-markdown-display pulls
 * a heavy tree that's risky on this RN/React version, and the model's output is a
 * narrow subset. This is line-based and renders to the app's ink/body tokens.
 */

type Segment = { text: string; bold: boolean; italic: boolean };

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;

function parseInline(line: string): Segment[] {
  const segments: Segment[] = [];
  for (const part of line.split(INLINE)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      segments.push({ text: part.slice(2, -2), bold: true, italic: false });
    } else if (part.startsWith('__') && part.endsWith('__')) {
      segments.push({ text: part.slice(2, -2), bold: true, italic: false });
    } else if (part.startsWith('*') && part.endsWith('*')) {
      segments.push({ text: part.slice(1, -1), bold: false, italic: true });
    } else if (part.startsWith('_') && part.endsWith('_')) {
      segments.push({ text: part.slice(1, -1), bold: false, italic: true });
    } else {
      segments.push({ text: part, bold: false, italic: false });
    }
  }
  return segments;
}

function Inline({ line }: { line: string }) {
  return (
    <>
      {parseInline(line).map((seg, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: inline segments are positional, not identity-bearing
          key={i}
          style={{
            fontFamily: seg.bold ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_400Regular',
            fontStyle: seg.italic ? 'italic' : 'normal',
          }}
        >
          {seg.text}
        </Text>
      ))}
    </>
  );
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'item'; ordinal: string | null; text: string }
  | { type: 'paragraph'; text: string };

function toBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ type: 'item', ordinal: null, text: bullet[1] });
      continue;
    }

    const numbered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({ type: 'item', ordinal: `${numbered[1]}.`, text: numbered[2] });
      continue;
    }

    blocks.push({ type: 'paragraph', text: line });
  }
  return blocks;
}

export function Markdown({ children }: { children: string }) {
  const blocks = toBlocks(children);
  return (
    <View className="gap-2">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          return (
            <AppText
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
              key={i}
              variant={block.level <= 2 ? 'title' : 'section'}
              className={i === 0 ? '' : 'mt-1'}
            >
              <Inline line={block.text} />
            </AppText>
          );
        }
        if (block.type === 'item') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
            <View key={i} className="flex-row gap-2">
              <AppText variant="body">{block.ordinal ?? '•'}</AppText>
              <AppText variant="body" className="flex-1">
                <Inline line={block.text} />
              </AppText>
            </View>
          );
        }
        return (
          <AppText
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
            key={i}
            variant="body"
          >
            <Inline line={block.text} />
          </AppText>
        );
      })}
    </View>
  );
}
