/**
 * Corpus source port. Adapters expose bounded metadata enumeration and bounded content reads for
 * exactly one configured corpus. Nothing in this module knows about ranking, chunking or
 * transports, so the port stays an extraction candidate.
 */
export type CorpusSourceKind = 'filesystem' | 'azure-blob';

export interface CorpusDocument {
  /** Stable, relative, normalized, control-character-free identifier. Never an absolute path. */
  readonly id: string;
  /** Lowercase extension including the leading dot. */
  readonly extension: string;
  readonly sizeBytes: number;
  /** Opaque revision (content hash, ETag or timestamp/size digest). Never storage identity. */
  readonly revision: string;
  readonly modifiedAt: string | undefined;
}

export interface CorpusReadResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly revision: string;
}

export type SkipReason =
  | 'unsupported_extension'
  | 'ignored_path'
  | 'unsafe_identifier'
  | 'symbolic_link'
  | 'oversized'
  | 'empty'
  | 'binary_content'
  | 'decode_failed'
  | 'duplicate_content'
  | 'read_failed'
  | 'limit_depth'
  | 'limit_directory_entries'
  | 'limit_documents'
  | 'limit_total_bytes'
  | 'limit_chunks'
  | 'limit_terms'
  | 'limit_memory'
  | 'limit_time';

export interface SkipRecorder {
  /** Records an aggregate skip. Implementations must never retain paths or content. */
  record(reason: SkipReason, count?: number): void;
}

export interface SkipSummaryEntry {
  readonly reason: SkipReason;
  readonly count: number;
}

export class SkipTally implements SkipRecorder {
  private readonly counts = new Map<SkipReason, number>();

  public record(reason: SkipReason, count = 1): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + count);
  }

  public get total(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
  }

  public entries(): readonly SkipSummaryEntry[] {
    return [...this.counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => ({ reason, count }));
  }
}

export interface CorpusEnumerationOptions {
  readonly signal?: AbortSignal;
  readonly skips?: SkipRecorder;
}

export interface CorpusReadOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes: number;
}

export interface CorpusSource {
  readonly kind: CorpusSourceKind;
  /** Bounded, cancellable metadata enumeration. */
  list(options: CorpusEnumerationOptions): AsyncIterable<CorpusDocument>;
  /** Bounded content read. Returns undefined when the document is unreadable or unusable. */
  read(document: CorpusDocument, options: CorpusReadOptions): Promise<CorpusReadResult | undefined>;
}

/** Raised when the corpus itself is unreachable. Messages must stay free of storage identity. */
export class CorpusUnavailableError extends Error {
  public override readonly name = 'CorpusUnavailableError';

  public constructor(
    message: string,
    public readonly reason: 'not_found' | 'forbidden' | 'unreachable' = 'unreachable',
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
