import { createHash } from 'node:crypto';
import type { BlobContainerReader, BlobDownload, BlobItem } from '../../src/corpus/blob.js';
import { extensionOf } from '../../src/corpus/policy.js';
import type {
  CorpusDocument,
  CorpusEnumerationOptions,
  CorpusReadOptions,
  CorpusReadResult,
  CorpusSource,
  CorpusSourceKind,
} from '../../src/corpus/types.js';

const revisionOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 16);

export interface MemoryCorpusOptions {
  readonly kind?: CorpusSourceKind;
  readonly listError?: () => Error | undefined;
  readonly readError?: () => Error | undefined;
  readonly delayMs?: number;
}

/** In-memory corpus source used to exercise ingestion, lifecycle and search without any I/O. */
export class MemoryCorpusSource implements CorpusSource {
  public readonly kind: CorpusSourceKind;
  public listCalls = 0;
  public readCalls = 0;

  public constructor(
    private files: Record<string, string>,
    private readonly options: MemoryCorpusOptions = {},
  ) {
    this.kind = options.kind ?? 'filesystem';
  }

  public replace(files: Record<string, string>): void {
    this.files = files;
  }

  public async *list(options: CorpusEnumerationOptions = {}): AsyncIterable<CorpusDocument> {
    this.listCalls += 1;
    const failure = this.options.listError?.();
    if (failure) throw failure;
    for (const [id, content] of Object.entries(this.files).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      options.signal?.throwIfAborted();
      if (this.options.delayMs)
        await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      yield {
        id,
        extension: extensionOf(id),
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        revision: revisionOf(content),
        modifiedAt: '2026-01-01T00:00:00.000Z',
      };
    }
  }

  public read(
    document: CorpusDocument,
    options: CorpusReadOptions,
  ): Promise<CorpusReadResult | undefined> {
    this.readCalls += 1;
    const failure = this.options.readError?.();
    if (failure) return Promise.reject(failure);
    const content = this.files[document.id];
    if (content === undefined) return Promise.resolve(undefined);
    const truncated = Buffer.byteLength(content, 'utf8') > options.maxBytes;
    const text = truncated
      ? Buffer.from(content, 'utf8').subarray(0, options.maxBytes).toString('utf8')
      : content;
    return Promise.resolve({ text, truncated, revision: revisionOf(content) });
  }
}

export interface FakeBlobOptions {
  readonly pageSize?: number;
  readonly listError?: () => Error;
  readonly downloadError?: (name: string) => Error | undefined;
  readonly missing?: readonly string[];
}

/** Fake container reader with paging and range downloads. No Azure account or network is used. */
export class FakeBlobContainerReader implements BlobContainerReader {
  public listedPrefixes: string[] = [];

  public constructor(
    private readonly blobs: Record<string, string>,
    private readonly options: FakeBlobOptions = {},
  ) {}

  public async *list({ prefix }: { prefix: string }): AsyncIterable<BlobItem> {
    this.listedPrefixes.push(prefix);
    if (this.options.listError) throw this.options.listError();
    const names = Object.keys(this.blobs)
      .filter((name) => name.startsWith(prefix))
      .sort();
    const pageSize = this.options.pageSize ?? 2;
    for (let start = 0; start < names.length; start += pageSize) {
      const page = names.slice(start, start + pageSize);
      // Yield page-by-page, mirroring the SDK's paged iteration.
      await Promise.resolve();
      for (const name of page) {
        const content = this.blobs[name] ?? '';
        yield {
          name,
          contentLength: Buffer.byteLength(content, 'utf8'),
          etag: `"${revisionOf(content)}"`,
          lastModified: '2026-01-01T00:00:00.000Z',
        };
      }
    }
  }

  public download(name: string, options: { maxBytes: number }): Promise<BlobDownload | undefined> {
    const failure = this.options.downloadError?.(name);
    if (failure) return Promise.reject(failure);
    if (this.options.missing?.includes(name)) return Promise.resolve(undefined);
    const content = this.blobs[name];
    if (content === undefined) return Promise.resolve(undefined);
    const buffer = Buffer.from(content, 'utf8');
    return Promise.resolve({
      content: buffer.subarray(0, options.maxBytes),
      truncated: buffer.length > options.maxBytes,
      etag: `"${revisionOf(content)}"`,
    });
  }
}
