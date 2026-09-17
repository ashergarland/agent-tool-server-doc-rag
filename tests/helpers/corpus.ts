import { createHash } from 'node:crypto';
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
