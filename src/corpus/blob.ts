import { createHash } from 'node:crypto';
import type { CorpusLimits } from '../config/index.js';
import {
  extensionOf,
  formatFor,
  isIgnoredIdentifier,
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

/**
 * Minimal container port. Only bounded listing and bounded range downloads are exposed, so no
 * caller can select a different container, mint credentials, or reach an arbitrary endpoint.
 */
export interface BlobItem {
  readonly name: string;
  readonly contentLength: number;
  readonly etag: string;
  readonly lastModified: string | undefined;
}

export interface BlobDownload {
  readonly content: Buffer;
  readonly etag: string;
  readonly truncated: boolean;
}

export interface BlobContainerReader {
  list(options: {
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<BlobItem>;
  download(
    name: string,
    options: { readonly maxBytes: number; readonly signal?: AbortSignal },
  ): Promise<BlobDownload | undefined>;
}

export interface AzureBlobCorpusSourceOptions {
  readonly prefix: string;
  readonly limits: CorpusLimits;
  readonly reader: BlobContainerReader;
}

const normalizeRevision = (etag: string, sizeBytes: number): string =>
  createHash('sha256')
    .update(`${etag.replaceAll('"', '')}:${sizeBytes}`)
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
 * Reads one private container and prefix. Identifiers are prefix-relative so no response can reveal
 * the storage account, container or full blob path.
 */
export class AzureBlobCorpusSource implements CorpusSource {
  public readonly kind = 'azure-blob' as const;

  public constructor(private readonly options: AzureBlobCorpusSourceOptions) {}

  public async *list(options: CorpusEnumerationOptions = {}): AsyncIterable<CorpusDocument> {
    const iterator = this.options.reader.list({
      prefix: this.options.prefix,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for await (const item of iterator) {
      options.signal?.throwIfAborted();
      if (!item.name.startsWith(this.options.prefix)) {
        options.skips?.record('unsafe_identifier');
        continue;
      }
      const identifier = normalizeIdentifier(item.name.slice(this.options.prefix.length));
      if (identifier === undefined) {
        options.skips?.record('unsafe_identifier');
        continue;
      }
      if (identifier.split('/').length - 1 > this.options.limits.maxDepth) {
        options.skips?.record('limit_depth');
        continue;
      }
      if (isIgnoredIdentifier(identifier)) {
        options.skips?.record('ignored_path');
        continue;
      }
      const extension = extensionOf(identifier);
      if (formatFor(extension) === undefined) {
        options.skips?.record('unsupported_extension');
        continue;
      }
      if (item.contentLength > this.options.limits.maxDocumentBytes) {
        options.skips?.record('oversized');
        continue;
      }
      if (item.contentLength === 0) {
        options.skips?.record('empty');
        continue;
      }

      yield {
        id: identifier,
        extension,
        sizeBytes: item.contentLength,
        revision: normalizeRevision(item.etag, item.contentLength),
        modifiedAt: item.lastModified,
      };
    }
  }

  public async read(
    document: CorpusDocument,
    options: CorpusReadOptions,
  ): Promise<CorpusReadResult | undefined> {
    const maxBytes = Math.max(1, options.maxBytes);
    const download = await this.options.reader.download(`${this.options.prefix}${document.id}`, {
      maxBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!download) return undefined;
    const truncated = download.truncated || download.content.length > maxBytes;
    const content = download.content.subarray(0, maxBytes);
    if (looksBinary(content)) return undefined;
    const text = decode(content, truncated);
    if (text === undefined) return undefined;
    return {
      text,
      truncated,
      revision: normalizeRevision(download.etag, document.sizeBytes),
    };
  }
}

/** Translates adapter failures into a corpus-level failure without exposing storage identity. */
export const toCorpusUnavailable = (error: unknown): CorpusUnavailableError => {
  const status =
    (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  if (status === 403 || status === 401) {
    return new CorpusUnavailableError(
      'The configured corpus container is not authorized for this identity',
      'forbidden',
      error,
    );
  }
  if (status === 404) {
    return new CorpusUnavailableError(
      'The configured corpus container was not found',
      'not_found',
      error,
    );
  }
  return new CorpusUnavailableError('The configured corpus is unreachable', 'unreachable', error);
};
