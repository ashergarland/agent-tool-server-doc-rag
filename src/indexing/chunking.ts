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

const stripHtmlTags = (value: string): string =>
  value
    .replaceAll(/<[^>]*>/gu, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\s+/gu, ' ')
    .trim();

/** Visible HTML text only: script, style and comment content never enters the index. */
const htmlBlocks = (lines: readonly string[], limits: IndexLimits): Block[] => {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let skipUntil: RegExp | undefined;
  let insideComment = false;

  lines.forEach((line, position) => {
    const lineNumber = position + 1;
    let content = line;

    if (insideComment) {
      const end = content.indexOf('-->');
      if (end === -1) return;
      content = content.slice(end + 3);
      insideComment = false;
    }
    if (skipUntil) {
      const match = skipUntil.exec(content);
      if (!match) return;
      content = content.slice(match.index + match[0].length);
      skipUntil = undefined;
    }
    content = content.replaceAll(/<!--[\s\S]*?-->/gu, ' ');
    content = content.replaceAll(/<script[\s\S]*?<\/script>/giu, ' ');
    content = content.replaceAll(/<style[\s\S]*?<\/style>/giu, ' ');
    if (/<!--/u.test(content)) {
      content = content.slice(0, content.indexOf('<!--'));
      insideComment = true;
    }
    const openScript = /<(script|style)\b[^>]*>/iu.exec(content);
    if (openScript) {
      content = content.slice(0, openScript.index);
      skipUntil = new RegExp(`</${openScript[1] ?? 'script'}\\s*>`, 'iu');
    }

    const headingMatches = [...content.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu)];
    for (const heading of headingMatches) {
      const level = Number(heading[1] ?? '1');
      headings.length = Math.max(0, level - 1);
      headings[level - 1] = boundSection(stripHtmlTags(heading[2] ?? ''), limits.sectionMaxChars);
      blocks.push({
        startLine: lineNumber,
        endLine: lineNumber,
        text: stripHtmlTags(heading[2] ?? ''),
        sectionPath: [...headings],
        boundary: true,
      });
    }
    if (headingMatches.length > 0) {
      content = content.replaceAll(/<h([1-6])[^>]*>[\s\S]*?<\/h\1>/giu, ' ');
    }

    const text = stripHtmlTags(content);
    if (text.length === 0) return;
    blocks.push({
      startLine: lineNumber,
      endLine: lineNumber,
      text,
      sectionPath: [...headings],
      boundary: false,
    });
  });
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
