import { createHash } from 'node:crypto';
import type { CorpusLimits, IndexLimits } from '../config/index.js';
import { formatFor } from '../corpus/policy.js';
import {
  SkipTally,
  type CorpusDocument,
  type CorpusSource,
  type SkipSummaryEntry,
} from '../corpus/types.js';
import { chunkDocument, type DocumentChunk } from './chunking.js';

export type LimitName =
  | 'documents'
  | 'total_bytes'
  | 'chunks'
  | 'terms'
  | 'memory'
  | 'time'
  | 'depth'
  | 'directory_entries';

export interface IngestionResult {
  readonly chunks: readonly DocumentChunk[];
  readonly documentCount: number;
  readonly totalBytes: number;
  readonly truncatedDocuments: number;
  readonly skips: readonly SkipSummaryEntry[];
  readonly skippedCount: number;
  readonly limitsReached: readonly LimitName[];
}

export interface IngestOptions {
  readonly source: CorpusSource;
  readonly corpusLimits: CorpusLimits;
  readonly indexLimits: IndexLimits;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

const estimatedChunkBytes = (chunk: DocumentChunk): number =>
  chunk.content.length * 2 + chunk.source.length * 2 + 256;

/**
 * Bounded, cancellable ingestion. Every budget is enforced here so no request or corpus can grow
 * the working set beyond the deployment's configuration.
 */
export const ingestCorpus = async (options: IngestOptions): Promise<IngestionResult> => {
  const { source, corpusLimits, indexLimits } = options;
  const now = options.now ?? Date.now;
  const deadline = now() + indexLimits.buildTimeoutMs;
  const skips = new SkipTally();
  const limitsReached = new Set<LimitName>();

  const expired = (): boolean => now() > deadline;

  const documents: CorpusDocument[] = [];
  for await (const document of source.list({
    ...(options.signal ? { signal: options.signal } : {}),
    skips,
  })) {
    options.signal?.throwIfAborted();
    if (documents.length >= corpusLimits.maxDocuments) {
      limitsReached.add('documents');
      skips.record('limit_documents');
      break;
    }
    if (expired()) {
      limitsReached.add('time');
      skips.record('limit_time');
      break;
    }
    documents.push(document);
  }
  documents.sort((left, right) => left.id.localeCompare(right.id));

  const perDocumentChunks = new Array<readonly DocumentChunk[]>(documents.length).fill([]);
  const seenContent = new Set<string>();
  let totalBytes = 0;
  let truncatedDocuments = 0;
  let chunkCount = 0;
  let estimatedBytes = 0;
  let stopped = false;
  let cursor = 0;

  const nextIndex = (): number | undefined => {
    if (stopped || cursor >= documents.length) return undefined;
    return cursor++;
  };

  const worker = async (): Promise<void> => {
    for (let index = nextIndex(); index !== undefined; index = nextIndex()) {
      options.signal?.throwIfAborted();
      if (expired()) {
        limitsReached.add('time');
        skips.record('limit_time');
        stopped = true;
        return;
      }
      const document = documents[index];
      if (!document) return;

      const remainingBytes = corpusLimits.maxTotalBytes - totalBytes;
      if (remainingBytes <= 0) {
        limitsReached.add('total_bytes');
        skips.record('limit_total_bytes');
        stopped = true;
        return;
      }
      const maxBytes = Math.min(corpusLimits.maxDocumentBytes, remainingBytes);

      let read;
      try {
        read = await source.read(document, {
          maxBytes,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        skips.record('read_failed');
        continue;
      }
      if (!read) {
        skips.record('read_failed');
        continue;
      }
      if (read.text.trim().length === 0) {
        skips.record('empty');
        continue;
      }

      const fingerprint = createHash('sha256').update(read.text).digest('hex');
      if (seenContent.has(fingerprint)) {
        skips.record('duplicate_content');
        continue;
      }
      seenContent.add(fingerprint);

      totalBytes += Buffer.byteLength(read.text, 'utf8');
      if (read.truncated) truncatedDocuments += 1;

      const format = formatFor(document.extension);
      if (!format) {
        skips.record('unsupported_extension');
        continue;
      }

      const chunks = chunkDocument({
        source: document.id,
        format,
        text: read.text,
        revision: read.revision || document.revision,
        truncated: read.truncated,
        limits: indexLimits,
      });

      const accepted: DocumentChunk[] = [];
      for (const chunk of chunks) {
        if (chunkCount >= indexLimits.maxChunks) {
          limitsReached.add('chunks');
          skips.record('limit_chunks');
          stopped = true;
          break;
        }
        if (estimatedBytes + estimatedChunkBytes(chunk) > indexLimits.maxMemoryBytes) {
          limitsReached.add('memory');
          skips.record('limit_memory');
          stopped = true;
          break;
        }
        chunkCount += 1;
        estimatedBytes += estimatedChunkBytes(chunk);
        accepted.push(chunk);
      }
      perDocumentChunks[index] = accepted;
      if (stopped) return;
    }
  };

  const workerCount = Math.max(1, Math.min(corpusLimits.maxConcurrentReads, documents.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const chunks = perDocumentChunks.flat();
  const documentCount = perDocumentChunks.filter((entries) => entries.length > 0).length;

  return {
    chunks,
    documentCount,
    totalBytes,
    truncatedDocuments,
    skips: skips.entries(),
    skippedCount: skips.total,
    limitsReached: [...limitsReached].sort(),
  };
};
