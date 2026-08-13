import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import type { DocumentationProvider, DocumentationSearchResult } from './types.js';

interface IndexedChunk {
  readonly source: string;
  readonly section: string | undefined;
  readonly content: string;
  readonly terms: ReadonlyMap<string, number>;
}

export interface LocalDocsProviderOptions {
  readonly rootPath: string;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly maxFileBytes: number;
}

const supportedExtensions = new Set([
  '.c',
  '.cs',
  '.cpp',
  '.go',
  '.html',
  '.java',
  '.js',
  '.json',
  '.md',
  '.py',
  '.rs',
  '.text',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);

const tokenize = (value: string): string[] =>
  value.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

const termFrequency = (value: string): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const term of tokenize(value)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
};

interface ContentChunk {
  readonly content: string;
  readonly offset: number;
}

const sectionAt = (content: string, offset: number): string | undefined => {
  const lineEnd = content.indexOf('\n', offset);
  const headings = content
    .slice(0, lineEnd === -1 ? content.length : lineEnd)
    .match(/^#{1,6}\s+(.+)$/gm);
  return headings
    ?.at(-1)
    ?.replace(/^#{1,6}\s+/, '')
    .trim();
};

const splitContent = (content: string, chunkSize: number, overlap: number): ContentChunk[] => {
  const chunks: ContentChunk[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + chunkSize, content.length);
    if (end < content.length) {
      const boundary = Math.max(content.lastIndexOf('\n\n', end), content.lastIndexOf('\n#', end));
      if (boundary > start + chunkSize / 2) end = boundary;
    }
    const rawChunk = content.slice(start, end);
    const chunk = rawChunk.trim();
    if (chunk) chunks.push({ content: chunk, offset: start + rawChunk.indexOf(chunk) });
    if (end === content.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
};

export class LocalDocsProvider implements DocumentationProvider {
  private readonly chunks: readonly IndexedChunk[];
  private readonly documentFrequency: ReadonlyMap<string, number>;

  public constructor(private readonly options: LocalDocsProviderOptions) {
    this.chunks = this.indexFiles();
    const frequencies = new Map<string, number>();
    for (const chunk of this.chunks) {
      for (const term of chunk.terms.keys()) {
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      }
    }
    this.documentFrequency = frequencies;
  }

  public search(query: string, limit: number): Promise<readonly DocumentationSearchResult[]> {
    const queryTerms = termFrequency(query);
    if (queryTerms.size === 0 || this.chunks.length === 0) return Promise.resolve([]);

    const scored = this.chunks
      .map((chunk) => ({ chunk, score: this.cosineSimilarity(queryTerms, chunk.terms) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({
        source: chunk.source,
        section: chunk.section,
        content: chunk.content,
        score: Number(score.toFixed(4)),
      }));
    return Promise.resolve(scored);
  }

  private indexFiles(): readonly IndexedChunk[] {
    const root = resolve(this.options.rootPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];

    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase()))
          files.push(path);
      }
    };
    visit(root);

    return files.sort().flatMap((path) => {
      if (statSync(path).size > this.options.maxFileBytes) return [];
      const content = readFileSync(path, 'utf8');
      return splitContent(content, this.options.chunkSize, this.options.chunkOverlap).map(
        ({ content: chunk, offset }) => {
          const source = relative(root, path);
          return {
            source,
            section: sectionAt(content, offset),
            content: chunk,
            terms: termFrequency(chunk),
          };
        },
      );
    });
  }

  private inverseDocumentFrequency(term: string): number {
    return Math.log((this.chunks.length + 1) / ((this.documentFrequency.get(term) ?? 0) + 1)) + 1;
  }

  private cosineSimilarity(
    query: ReadonlyMap<string, number>,
    document: ReadonlyMap<string, number>,
  ): number {
    let dotProduct = 0;
    let queryMagnitude = 0;
    let documentMagnitude = 0;
    for (const [term, frequency] of query) {
      const weight = frequency * this.inverseDocumentFrequency(term);
      queryMagnitude += weight * weight;
      dotProduct += weight * (document.get(term) ?? 0) * this.inverseDocumentFrequency(term);
    }
    for (const [term, frequency] of document) {
      const weight = frequency * this.inverseDocumentFrequency(term);
      documentMagnitude += weight * weight;
    }
    return dotProduct / (Math.sqrt(queryMagnitude) * Math.sqrt(documentMagnitude) || 1);
  }
}
