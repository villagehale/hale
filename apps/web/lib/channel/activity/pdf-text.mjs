import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Text of a fetched page, including a schedule that arrived as a PDF.
 *
 * A `web_fetch` of a PDF comes back as base64 (`source.type === 'base64'`,
 * `media_type: application/pdf`). Treating those bytes as markdown dumps the
 * encoding into the notes, so a schedule that prints days and times looks
 * unread. The extract is the page. An empty extract is empty: the encoding
 * itself is not something the page said.
 */

const MAX_INFLATED = 8 * 1024 * 1024;

function isPdfSource(source) {
  const media = source.media_type ?? '';
  const data = typeof source.data === 'string' ? source.data : '';
  if (media === 'application/pdf') return true;
  if (data.startsWith('%PDF')) return true;
  return source.type === 'base64' && data.startsWith('JVBERi0');
}

/** Page text for one fetch `source`. A PDF that yields no text yields ''. */
export function textOfFetchSource(source) {
  if (source == null || typeof source !== 'object') return '';
  const data = typeof source.data === 'string' ? source.data : '';
  if (!isPdfSource(source)) return data;
  try {
    const bytes = Buffer.from(data, 'base64');
    return textFromPdf(bytes);
  } catch {
    return '';
  }
}

function inflateStream(data) {
  const attempts = [data];
  if (data.length > 2) attempts.push(data.subarray(0, data.length - 1));
  if (data.length > 3) attempts.push(data.subarray(0, data.length - 2));
  for (const candidate of attempts) {
    for (const inflate of [inflateSync, inflateRawSync]) {
      try {
        const out = inflate(candidate);
        if (out.length > 0 && out.length <= MAX_INFLATED) return out;
      } catch {
        // The next trim or wrapper is the one that fits this stream.
      }
    }
  }
  return null;
}

function streamsOf(buf) {
  const src = buf.toString('latin1');
  const found = [];
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('stream', i);
    if (at < 0) break;
    const before = at > 0 ? src.charCodeAt(at - 1) : 10;
    const boundary =
      before === 32 || before === 10 || before === 13 || before === 9 || before === 62;
    if (!boundary) {
      i = at + 6;
      continue;
    }
    let start = at + 6;
    if (src.charCodeAt(start) === 13 && src.charCodeAt(start + 1) === 10) start += 2;
    else if (src.charCodeAt(start) === 10 || src.charCodeAt(start) === 13) start += 1;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    const dict = src.slice(Math.max(0, at - 400), at);
    let data = buf.subarray(start, end);
    if (data.length > 0 && (data[data.length - 1] === 10 || data[data.length - 1] === 13)) {
      data = data.subarray(0, data.length - 1);
    }
    if (data.length > 0 && data[data.length - 1] === 13) data = data.subarray(0, data.length - 1);
    found.push({ dict, data });
    i = end + 9;
  }
  return found;
}

function unescapeLiteral(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '(' || n === ')' || n === '\\') out += n;
    else if (n >= '0' && n <= '7') {
      let oct = n;
      let k = i + 2;
      while (k < body.length && k < i + 4 && body[k] >= '0' && body[k] <= '7') {
        oct += body[k];
        k += 1;
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i = k - 1;
      continue;
    } else if (n === '\n' || n === '\r') {
      if (n === '\r' && body[i + 2] === '\n') i += 1;
    } else out += n;
    i += 1;
  }
  return out;
}

function isDelim(code) {
  return (
    code === 32 ||
    code === 10 ||
    code === 13 ||
    code === 9 ||
    code === 0 ||
    code === 40 ||
    code === 41 ||
    code === 60 ||
    code === 62 ||
    code === 91 ||
    code === 93 ||
    code === 123 ||
    code === 125 ||
    code === 47 ||
    code === 37
  );
}

function tokenize(buf) {
  const s = buf.toString('latin1');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0) {
      i += 1;
      continue;
    }
    if (code === 37) {
      while (i < s.length && s.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (code === 40) {
      let depth = 1;
      let body = '';
      i += 1;
      while (i < s.length && depth > 0) {
        const c = s[i];
        if (c === '\\') {
          body += c;
          if (i + 1 < s.length) {
            body += s[i + 1];
            i += 2;
            continue;
          }
        } else if (c === '(') {
          depth += 1;
          body += c;
        } else if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
          body += c;
        } else body += c;
        i += 1;
      }
      tokens.push({ t: 'str', v: unescapeLiteral(body) });
      continue;
    }
    if (code === 60) {
      if (s.charCodeAt(i + 1) === 60) {
        tokens.push({ t: 'op', v: '<<' });
        i += 2;
        continue;
      }
      const end = s.indexOf('>', i + 1);
      if (end < 0) break;
      const hex = s.slice(i + 1, end).replace(/\s+/g, '');
      let text = '';
      for (let h = 0; h + 1 < hex.length; h += 2) {
        const byte = Number.parseInt(hex.slice(h, h + 2), 16);
        if (Number.isFinite(byte)) text += String.fromCharCode(byte);
      }
      tokens.push({ t: 'str', v: text });
      i = end + 1;
      continue;
    }
    if (code === 62 && s.charCodeAt(i + 1) === 62) {
      tokens.push({ t: 'op', v: '>>' });
      i += 2;
      continue;
    }
    if (code === 91 || code === 93) {
      tokens.push({ t: 'op', v: s[i] });
      i += 1;
      continue;
    }
    if (code === 47) {
      i += 1;
      let name = '';
      while (i < s.length && !isDelim(s.charCodeAt(i))) {
        name += s[i];
        i += 1;
      }
      tokens.push({ t: 'name', v: name });
      continue;
    }
    let j = i;
    while (j < s.length && !isDelim(s.charCodeAt(j))) j += 1;
    const word = s.slice(i, j);
    i = j;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ t: 'num', v: Number(word) });
    else if (word !== '') tokens.push({ t: 'op', v: word });
  }
  return tokens;
}

function takeNums(stack, n) {
  const nums = [];
  for (let i = stack.length - 1; i >= 0 && nums.length < n; i -= 1) {
    if (stack[i].t === 'num') nums.push(stack[i].v);
  }
  if (nums.length < n) return null;
  return nums.reverse();
}

function glyphsIn(buf) {
  const glyphs = [];
  const stack = [];
  let x = 0;
  let y = 0;
  let scale = 1;
  const place = (text, atX) => {
    if (text !== '') glyphs.push({ x: atX, y, text, scale });
  };
  for (const tok of tokenize(buf)) {
    if (tok.t === 'num' || tok.t === 'str' || tok.t === 'name') {
      stack.push(tok);
      continue;
    }
    if (tok.v === '[') {
      stack.push({ t: 'arr', v: [] });
      continue;
    }
    if (tok.v === ']') {
      const items = [];
      while (stack.length > 0 && stack[stack.length - 1].t !== 'arr') items.unshift(stack.pop());
      if (stack.length > 0 && stack[stack.length - 1].t === 'arr') {
        stack[stack.length - 1].v.push(...items);
      }
      continue;
    }
    if (tok.v === 'Tm') {
      const nums = takeNums(stack, 6);
      if (nums) {
        scale = Math.abs(nums[0]) || scale;
        x = nums[4];
        y = nums[5];
      }
    } else if (tok.v === 'Td' || tok.v === 'TD') {
      const nums = takeNums(stack, 2);
      if (nums) {
        x += nums[0];
        y += nums[1];
      }
    } else if (tok.v === 'Tj' || tok.v === "'") {
      const str = [...stack].reverse().find((item) => item.t === 'str');
      if (str) place(str.v, x);
    } else if (tok.v === '"') {
      const str = [...stack].reverse().find((item) => item.t === 'str');
      if (str) place(str.v, x);
    } else if (tok.v === 'TJ') {
      const arr = [...stack].reverse().find((item) => item.t === 'arr');
      if (arr) {
        let piece = '';
        for (const item of arr.v) {
          if (item.t === 'str') piece += item.v;
          else if (item.t === 'num' && item.v <= -80) piece += ' ';
        }
        place(piece, x);
      }
    }
    stack.length = 0;
  }
  return glyphs;
}

function layout(glyphs) {
  if (glyphs.length === 0) return '';
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const glyph of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y - glyph.y) < 1.2);
    if (line) line.items.push(glyph);
    else lines.push({ y: glyph.y, items: [glyph] });
  }
  const rows = [];
  for (const line of lines) {
    const items = line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const item of items) {
      const width = Math.max(item.text.length * item.scale * 0.45, item.scale * 0.3);
      if (end !== null && item.x - end > item.scale * 0.35) text += ' ';
      text += item.text;
      end = item.x + width;
    }
    const trimmed = text.replace(/[ \t]+/g, ' ').trim();
    if (trimmed !== '') rows.push(trimmed);
  }
  return rows.join('\n');
}

/** Readable text of a PDF's content streams. No shell, no poppler. */
export function textFromPdf(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const parts = [];
  for (const stream of streamsOf(buf)) {
    if (!/FlateDecode/.test(stream.dict) && !stream.dict.includes('/Filter')) continue;
    const inflated = /FlateDecode/.test(stream.dict) ? inflateStream(stream.data) : stream.data;
    if (!inflated) continue;
    const head = inflated.toString('latin1', 0, Math.min(inflated.length, 4000));
    if (!head.includes('Tj') && !head.includes('TJ') && !head.includes('Tm')) continue;
    const text = layout(glyphsIn(inflated));
    if (text !== '') parts.push(text);
  }
  return parts.join('\n').trim();
}
