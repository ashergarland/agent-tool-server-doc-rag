import { createHash } from 'node:crypto';
import type { IndexLimits } from '../config/index.js';
import type { DocumentFormat } from '../corpus/policy.js';

export interface DocumentChunk {
  /** Stable opaque identifier derived from the source, location and content. */
  readonly id: string;
  /** Safe corpus-relative source identifier. */
  readonly source: string;
  readonly sectionPath: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly revision: string;
  /** True when the containing document was truncated at the configured read limit. */
  readonly truncated: boolean;
}

export interface ChunkDocumentInput {
  readonly source: string;
  readonly format: DocumentFormat;
  readonly text: string;
  readonly revision: string;
  readonly truncated: boolean;
  readonly limits: IndexLimits;
}

interface Block {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly sectionPath: readonly string[];
  /** Prefer starting a new chunk at this block. */
  readonly boundary: boolean;
}

const boundSection = (value: string, maxChars: number): string =>
  value.trim().replace(/\s+/gu, ' ').slice(0, maxChars);

const splitGraphemes = (value: string): string[] => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(value)].map((entry) => entry.segment);
};

/** Splits over-long text without breaking Unicode grapheme clusters. */
const splitLongText = (value: string, maxChars: number): string[] => {
  if (value.length <= maxChars) return [value];
  const pieces: string[] = [];
  let current = '';
  for (const grapheme of splitGraphemes(value)) {
    if (current.length + grapheme.length > maxChars && current.length > 0) {
      pieces.push(current);
      current = '';
    }
    current += grapheme;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
};

const headingPattern = /^(#{1,6})\s+(.*\S)\s*$/;
const fencePattern = /^\s*(```|~~~)/;

const markdownBlocks = (lines: readonly string[], limits: IndexLimits): Block[] => {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let insideFence = false;
  let fenceMarker = '';

  const flush = (endLine: number): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      blocks.push({
        startLine: bufferStart,
        endLine,
        text,
        sectionPath: [...headings],
        boundary: false,
      });
    }
    buffer = [];
  };

  lines.forEach((line, position) => {
    const lineNumber = position + 1;
    const fence = fencePattern.exec(line);
    if (fence) {
      if (!insideFence) {
        flush(lineNumber - 1);
        insideFence = true;
        fenceMarker = fence[1] ?? '```';
        bufferStart = lineNumber;
        buffer.push(line);
        return;
      }
      if (line.trim().startsWith(fenceMarker)) {
        buffer.push(line);
        flush(lineNumber);
        insideFence = false;
        return;
      }
    }
    if (insideFence) {
      if (buffer.length === 0) bufferStart = lineNumber;
      buffer.push(line);
      return;
    }

    const heading = headingPattern.exec(line);
    if (heading) {
      flush(lineNumber - 1);
      const level = (heading[1] ?? '#').length;
      headings.length = Math.max(0, level - 1);
      headings[level - 1] = boundSection(heading[2] ?? '', limits.sectionMaxChars);
      blocks.push({
        startLine: lineNumber,
        endLine: lineNumber,
        text: line.trim(),
        sectionPath: [...headings],
        boundary: true,
      });
      return;
    }

    if (line.trim() === '') {
      flush(lineNumber - 1);
      return;
    }
    if (buffer.length === 0) bufferStart = lineNumber;
    buffer.push(line);
  });
  flush(lines.length);
  return blocks;
};

const paragraphBlocks = (lines: readonly string[]): Block[] => {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;

  const flush = (endLine: number): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      blocks.push({ startLine: bufferStart, endLine, text, sectionPath: [], boundary: true });
    }
    buffer = [];
  };

  lines.forEach((line, position) => {
    const lineNumber = position + 1;
    if (line.trim() === '') {
      flush(lineNumber - 1);
      return;
    }
    if (buffer.length === 0) bufferStart = lineNumber;
    buffer.push(line);
  });
  flush(lines.length);
  return blocks;
};

const namedEntities = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ensp', ' '],
  ['emsp', ' '],
  ['thinsp', ' '],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
]);

/**
 * Decodes entities in a single pass. Chained replacements would double-unescape: `&amp;lt;` must
 * decode to the literal text `&lt;`, never to `<`.
 */
const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/giu, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint =
        entity.startsWith('#x') || entity.startsWith('#X')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      // Lone surrogates are not valid scalar values.
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
      return String.fromCodePoint(codePoint);
    }
    return namedEntities.get(entity.toLowerCase()) ?? match;
  });

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/** Elements whose content is never visible text and must never be indexed. */
const rawTextElements = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math']);

/** Elements that end a visible text run, so chunks follow the document's own structure. */
const blockLevelElements = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const isNameCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[a-z0-9:-]/iu.test(character);

/**
 * Extracts visible HTML text with a single-pass tokenizer.
 *
 * Regular expressions cannot filter HTML reliably: quoted attribute values may contain `>`, and end
 * tags may carry whitespace such as `</script >`. Both mis-parse into either indexed markup or
 * silently dropped content, so this walks the document with explicit state instead.
 */
const htmlBlocks = (lines: readonly string[], limits: IndexLimits): Block[] => {
  const text = lines.join('\n');
  const lower = text.toLowerCase();
  const blocks: Block[] = [];
  const headings: string[] = [];

  let index = 0;
  let line = 1;
  let buffer = '';
  let bufferStart = 1;
  let headingLevel: number | undefined;
  let headingText = '';

  const advanceTo = (target: number): void => {
    const limit = Math.min(target, text.length);
    for (let position = index; position < limit; position += 1) {
      if (text[position] === '\n') line += 1;
    }
    index = limit;
  };

  const flushText = (): void => {
    const content = collapseWhitespace(decodeEntities(buffer));
    buffer = '';
    if (content.length === 0) return;
    blocks.push({
      startLine: bufferStart,
      endLine: line,
      text: content,
      sectionPath: [...headings],
      boundary: false,
    });
  };

  const closeHeading = (): void => {
    if (headingLevel === undefined) return;
    const content = collapseWhitespace(decodeEntities(headingText));
    if (content.length > 0) {
      headings.length = Math.max(0, headingLevel - 1);
      headings[headingLevel - 1] = boundSection(content, limits.sectionMaxChars);
      blocks.push({
        startLine: bufferStart,
        endLine: line,
        text: content,
        sectionPath: [...headings],
        boundary: true,
      });
    }
    headingLevel = undefined;
    headingText = '';
  };

  const appendText = (value: string): void => {
    if (headingLevel !== undefined) {
      headingText += value;
      return;
    }
    if (buffer.length === 0) bufferStart = line;
    buffer += value;
  };

  /** Finds the end of a tag, treating `>` inside quoted attribute values as literal. */
  const endOfTag = (start: number): number => {
    let quote: string | undefined;
    for (let position = start; position < text.length; position += 1) {
      const character = text[position];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        return position + 1;
      }
    }
    return text.length;
  };

  /** Finds the matching end tag of a raw-text element, allowing `</script >` and newlines. */
  const endOfRawText = (name: string, start: number): { contentEnd: number; tagEnd: number } => {
    let position = start;
    while (position < lower.length) {
      const candidate = lower.indexOf(`</${name}`, position);
      if (candidate === -1) break;
      const after = text[candidate + name.length + 2];
      if (after === undefined || after === '>' || after === '/' || /\s/u.test(after)) {
        return { contentEnd: candidate, tagEnd: endOfTag(candidate) };
      }
      position = candidate + 1;
    }
    return { contentEnd: text.length, tagEnd: text.length };
  };

  while (index < text.length) {
    const next = text.indexOf('<', index);
    if (next === -1) {
      appendText(text.slice(index));
      advanceTo(text.length);
      break;
    }
    if (next > index) {
      appendText(text.slice(index, next));
      advanceTo(next);
    }

    if (lower.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      advanceTo(close === -1 ? text.length : close + 3);
      continue;
    }
    if (lower.startsWith('<!', index) || lower.startsWith('<?', index)) {
      advanceTo(endOfTag(index));
      continue;
    }

    const closing = lower.startsWith('</', index);
    let cursor = index + (closing ? 2 : 1);
    let name = '';
    while (isNameCharacter(text[cursor])) {
      name += text[cursor];
      cursor += 1;
    }
    name = name.toLowerCase();

    if (name === '') {
      // A stray `<` that opens no tag is literal text.
      appendText('<');
      advanceTo(index + 1);
      continue;
    }

    const tagEnd = endOfTag(cursor);

    if (!closing && rawTextElements.has(name)) {
      const selfClosing = text[tagEnd - 2] === '/';
      advanceTo(tagEnd);
      if (!selfClosing) {
        const { tagEnd: rawEnd } = endOfRawText(name, tagEnd);
        advanceTo(rawEnd);
      }
      continue;
    }

    const headingMatch = /^h([1-6])$/u.exec(name);
    if (headingMatch) {
      if (closing) {
        advanceTo(tagEnd);
        closeHeading();
        continue;
      }
      flushText();
      closeHeading();
      headingLevel = Number(headingMatch[1]);
      headingText = '';
      bufferStart = line;
      advanceTo(tagEnd);
      continue;
    }

    if (blockLevelElements.has(name)) {
      if (headingLevel === undefined) flushText();
      advanceTo(tagEnd);
      continue;
    }

    // Inline element: its tag contributes nothing, but it separates words.
    appendText(' ');
    advanceTo(tagEnd);
  }

  closeHeading();
  flushText();
  return blocks;
};

/** Structured data splits on top-level members so a chunk always contains a whole logical entry. */
const structuredBlocks = (lines: readonly string[], limits: IndexLimits): Block[] => {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let section = '';

  const flush = (endLine: number): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      blocks.push({
        startLine: bufferStart,
        endLine,
        text,
        sectionPath: section ? [section] : [],
        boundary: true,
      });
    }
    buffer = [];
  };

  lines.forEach((line, position) => {
    const lineNumber = position + 1;
    const topLevel = /^[^\s{}[\],]/u.test(line) || /^\s{0,2}["']?[\w.-]+["']?\s*:/u.test(line);
    if (topLevel && buffer.length > 0) flush(lineNumber - 1);
    if (topLevel) {
      const key = /^[\s-]*["']?([\w.-]+)["']?\s*:/u.exec(line);
      if (key?.[1]) section = boundSection(key[1], limits.sectionMaxChars);
    }
    if (buffer.length === 0) bufferStart = lineNumber;
    buffer.push(line);
  });
  flush(lines.length);
  return blocks;
};

const declarationPattern =
  /^(export\s+)?(async\s+)?(public|private|protected|internal|static|final|abstract|open|const|let|var)?\s*(class|interface|type|enum|struct|trait|impl|func|function|def|fn|module|namespace|package)\b/u;

/** Source files split on top-level declarations so a chunk keeps a complete logical unit. */
const codeBlocks = (lines: readonly string[], limits: IndexLimits): Block[] => {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let section = '';

  const flush = (endLine: number): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      blocks.push({
        startLine: bufferStart,
        endLine,
        text,
        sectionPath: section ? [section] : [],
        boundary: true,
      });
    }
    buffer = [];
  };

  lines.forEach((line, position) => {
    const lineNumber = position + 1;
    const topLevel = line.length > 0 && !/^\s/u.test(line);
    const declaration = topLevel && declarationPattern.test(line);
    if (declaration && buffer.length > 0) flush(lineNumber - 1);
    if (declaration) section = boundSection(line, limits.sectionMaxChars);
    if (buffer.length === 0) bufferStart = lineNumber;
    buffer.push(line);
  });
  flush(lines.length);
  return blocks;
};

const blocksFor = (
  format: DocumentFormat,
  lines: readonly string[],
  limits: IndexLimits,
): Block[] => {
  switch (format) {
    case 'markdown':
      return markdownBlocks(lines, limits);
    case 'html':
      return htmlBlocks(lines, limits);
    case 'json':
    case 'yaml':
      return structuredBlocks(lines, limits);
    case 'code':
      return codeBlocks(lines, limits);
    case 'text':
      return paragraphBlocks(lines);
  }
};

const chunkIdFor = (source: string, startLine: number, content: string): string =>
  createHash('sha256').update(`${source}:${startLine}:${content}`).digest('hex').slice(0, 16);

/** Splits one document into bounded chunks that each carry complete provenance. */
export const chunkDocument = (input: ChunkDocumentInput): DocumentChunk[] => {
  const { limits } = input;
  const lines = input.text.split(/\r?\n/u);
  const blocks = blocksFor(input.format, lines, limits);

  const chunks: DocumentChunk[] = [];
  let current:
    | { startLine: number; endLine: number; parts: string[]; sectionPath: readonly string[] }
    | undefined;

  const flush = (): void => {
    if (!current) return;
    const content = current.parts.join('\n\n').trim();
    if (content.length > 0) {
      chunks.push({
        id: chunkIdFor(input.source, current.startLine, content),
        source: input.source,
        sectionPath: current.sectionPath,
        startLine: current.startLine,
        endLine: current.endLine,
        content,
        revision: input.revision,
        truncated: input.truncated,
      });
    }
    current = undefined;
  };

  for (const block of blocks) {
    const pieces = splitLongText(block.text, limits.chunkMaxChars);
    pieces.forEach((piece, index) => {
      const currentLength = current ? current.parts.join('\n\n').length : 0;
      const shouldBreak =
        current !== undefined &&
        ((block.boundary && index === 0 && currentLength >= limits.chunkMinChars) ||
          currentLength + piece.length + 2 > limits.chunkMaxChars);
      if (shouldBreak) flush();
      if (!current) {
        current = {
          startLine: block.startLine,
          endLine: block.endLine,
          parts: [piece],
          sectionPath: block.sectionPath,
        };
        return;
      }
      current.parts.push(piece);
      current = { ...current, endLine: block.endLine };
    });
  }
  flush();
  return chunks;
};
