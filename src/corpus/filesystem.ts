import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
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

const revisionOf = (sizeBytes: number, modifiedMs: number): string =>
  createHash('sha256')
    .update(`${sizeBytes}:${Math.trunc(modifiedMs)}`)
    .digest('hex')
    .slice(0, 16);

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

/**
 * Reads a single canonical filesystem root. Symbolic links, traversal, ignored paths and
 * unsupported extensions never enter the corpus, and identifiers are always root-relative.
 */
export class FileSystemCorpusSource implements CorpusSource {
  public readonly kind = 'filesystem' as const;

  public constructor(private readonly options: FileSystemCorpusSourceOptions) {}

  public async *list(options: CorpusEnumerationOptions = {}): AsyncIterable<CorpusDocument> {
    const root = await this.canonicalRoot();
    yield* this.walk(root, root, 0, options);
  }

  public async read(
    document: CorpusDocument,
    options: CorpusReadOptions,
  ): Promise<CorpusReadResult | undefined> {
    const root = await this.canonicalRoot();
    const absolute = resolve(root, document.id);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;

    const maxBytes = Math.max(1, options.maxBytes);
    const linkStats = await lstat(absolute).catch(() => undefined);
    if (!linkStats || linkStats.isSymbolicLink() || !linkStats.isFile()) return undefined;
    let handle;
    try {
      handle = await open(absolute, 'r');
    } catch {
      return undefined;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return undefined;
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      options.signal?.throwIfAborted();
      const truncated = bytesRead > maxBytes;
      const content = buffer.subarray(0, truncated ? maxBytes : bytesRead);
      if (looksBinary(content)) return undefined;
      const text = decode(content, truncated);
      if (text === undefined) return undefined;
      return {
        text,
        truncated,
        revision: revisionOf(stats.size, stats.mtimeMs),
      };
    } catch {
      return undefined;
    } finally {
      await handle.close().catch(() => undefined);
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
        revision: revisionOf(entryStats.size, entryStats.mtimeMs),
        modifiedAt: new Date(entryStats.mtimeMs).toISOString(),
      };
    }
  }
}
