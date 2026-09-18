import { createHash } from 'node:crypto';
import { RootBoundary, type ConfinedOpenedFile } from '@agent-tool-platform/runtime/fs';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { CorpusLimits } from '../config/index.js';
import {
  extensionOf,
  formatFor,
  isIgnoredSegment,
  looksBinary,
  normalizeIdentifier,
} from './policy.js';
import {
  CorpusUnavailableError,
  type CorpusDocument,
  type CorpusEnumerationOptions,
  type CorpusReadOptions,
  type CorpusReadResult,
  type CorpusSource,
} from './types.js';

export interface FileSystemCorpusSourceOptions {
  readonly rootPath: string;
  readonly limits: CorpusLimits;
}

const metadataRevisionOf = (sizeBytes: number, modifiedMs: number): string =>
  createHash('sha256')
    .update(`${sizeBytes}:${Math.trunc(modifiedMs)}`)
    .digest('hex')
    .slice(0, 16);

const contentRevisionOf = (sizeBytes: number, content: Buffer): string =>
  createHash('sha256').update(`${sizeBytes}:`).update(content).digest('hex').slice(0, 16);

const decode = (buffer: Buffer, truncated: boolean): string | undefined => {
  const strict = new TextDecoder('utf-8', { fatal: true });
  for (let trimmed = 0; trimmed <= (truncated ? 3 : 0); trimmed += 1) {
    try {
      return strict.decode(buffer.subarray(0, buffer.length - trimmed));
    } catch {
      continue;
    }
  }
  return undefined;
};

const readOpenedFile = async (
  opened: ConfinedOpenedFile,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  signal?.throwIfAborted();
  const readLimit = Math.min(opened.sizeBytes, maxBytes);
  if (readLimit === 0) return Buffer.alloc(0);

  const buffer = Buffer.allocUnsafe(readLimit);
  let offset = 0;
  const stream = opened.createReadStream({
    highWaterMark: Math.min(64 * 1_024, readLimit),
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) throw new Error('Confined corpus streams must emit buffers');
    const acceptedBytes = Math.min(chunk.byteLength, readLimit - offset);
    chunk.copy(buffer, offset, 0, acceptedBytes);
    offset += acceptedBytes;
    if (offset >= readLimit) break;
  }
  return buffer.subarray(0, offset);
};

/**
 * Reads a single canonical filesystem root. Symbolic links, traversal, ignored paths and
 * unsupported extensions never enter the corpus, and identifiers are always root-relative.
 */
export class FileSystemCorpusSource implements CorpusSource {
  public readonly kind = 'filesystem' as const;
  private readonly boundary: RootBoundary;

  public constructor(private readonly options: FileSystemCorpusSourceOptions) {
    this.boundary = new RootBoundary({
      root: options.rootPath,
      requireRegularFile: true,
      maxFileBytes: options.limits.maxDocumentBytes,
    });
  }

  public async *list(options: CorpusEnumerationOptions = {}): AsyncIterable<CorpusDocument> {
    const root = await this.canonicalRoot();
    yield* this.walk(root, root, 0, options);
  }

  public async read(
    document: CorpusDocument,
    options: CorpusReadOptions,
  ): Promise<CorpusReadResult | undefined> {
    options.signal?.throwIfAborted();
    const maxBytes = Math.max(1, options.maxBytes);
    let opened: ConfinedOpenedFile;
    try {
      opened = await this.boundary.openFile(document.id, { previewBytes: 0 });
    } catch {
      options.signal?.throwIfAborted();
      return undefined;
    }

    try {
      if (opened.relativePath !== document.id) return undefined;
      const content = await readOpenedFile(opened, maxBytes, options.signal);
      options.signal?.throwIfAborted();
      const truncated = opened.sizeBytes > maxBytes && content.byteLength === maxBytes;
      if (looksBinary(content)) return undefined;
      const text = decode(content, truncated);
      if (text === undefined) return undefined;
      return {
        text,
        truncated,
        revision: contentRevisionOf(opened.sizeBytes, content),
      };
    } catch {
      options.signal?.throwIfAborted();
      return undefined;
    } finally {
      await opened.close();
    }
  }

  private async canonicalRoot(): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(this.options.rootPath);
    } catch (error) {
      throw new CorpusUnavailableError(
        'The configured documentation root does not exist',
        'not_found',
        error,
      );
    }
    const stats = await stat(canonical).catch((error: unknown) => {
      throw new CorpusUnavailableError(
        'The configured documentation root is not readable',
        'forbidden',
        error,
      );
    });
    if (!stats.isDirectory()) {
      throw new CorpusUnavailableError(
        'The configured documentation root is not a directory',
        'not_found',
      );
    }
    return canonical;
  }

  private async *walk(
    root: string,
    directory: string,
    depth: number,
    options: CorpusEnumerationOptions,
  ): AsyncIterable<CorpusDocument> {
    options.signal?.throwIfAborted();
    if (depth > this.options.limits.maxDepth) {
      options.skips?.record('limit_depth');
      return;
    }

    const names: string[] = [];
    try {
      const directoryHandle = await opendir(directory);
      for await (const entry of directoryHandle) {
        if (names.length >= this.options.limits.maxDirectoryEntries) {
          options.skips?.record('limit_directory_entries');
          break;
        }
        names.push(entry.name);
      }
    } catch {
      options.skips?.record('read_failed');
      return;
    }
    names.sort();

    for (const name of names) {
      options.signal?.throwIfAborted();
      const absolute = resolve(directory, name);
      let entryStats;
      try {
        entryStats = await lstat(absolute);
      } catch {
        options.skips?.record('read_failed');
        continue;
      }
      if (entryStats.isSymbolicLink()) {
        options.skips?.record('symbolic_link');
        continue;
      }

      if (entryStats.isDirectory()) {
        if (isIgnoredSegment(name, true)) {
          options.skips?.record('ignored_path');
          continue;
        }
        yield* this.walk(root, absolute, depth + 1, options);
        continue;
      }
      if (!entryStats.isFile()) {
        options.skips?.record('ignored_path');
        continue;
      }
      if (isIgnoredSegment(name, false)) {
        options.skips?.record('ignored_path');
        continue;
      }

      const identifier = normalizeIdentifier(relative(root, absolute));
      if (identifier === undefined) {
        options.skips?.record('unsafe_identifier');
        continue;
      }
      const extension = extensionOf(identifier);
      if (formatFor(extension) === undefined) {
        options.skips?.record('unsupported_extension');
        continue;
      }
      if (entryStats.size > this.options.limits.maxDocumentBytes) {
        options.skips?.record('oversized');
        continue;
      }
      if (entryStats.size === 0) {
        options.skips?.record('empty');
        continue;
      }

      yield {
        id: identifier,
        extension,
        sizeBytes: entryStats.size,
        revision: metadataRevisionOf(entryStats.size, entryStats.mtimeMs),
        modifiedAt: new Date(entryStats.mtimeMs).toISOString(),
      };
    }
  }
}
