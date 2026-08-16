import { createHash } from 'node:crypto';
import type { IndexLimits, CorpusLimits } from '../config/index.js';
import {
  CorpusUnavailableError,
  type CorpusSource,
  type CorpusSourceKind,
  type SkipSummaryEntry,
} from '../corpus/types.js';
import type { MetricsRecorder } from '../observability/metrics.js';
import { NoopMetrics } from '../observability/metrics.js';
import { ingestCorpus, type LimitName } from './ingest.js';
import { LexicalIndex, type RankingAlgorithm } from './inverted-index.js';

export type IndexState = 'building' | 'ready' | 'ready_empty' | 'degraded' | 'failed';

export type IndexErrorCode =
  | 'not_configured'
  | 'corpus_not_found'
  | 'corpus_forbidden'
  | 'corpus_unreachable'
  | 'build_failed';

export interface IndexSnapshot {
  readonly state: IndexState;
  readonly sourceKind: CorpusSourceKind | 'none';
  readonly configured: boolean;
  readonly indexVersion: number;
  readonly indexedAt: string | undefined;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly termCount: number;
  readonly skippedCount: number;
  readonly skips: readonly SkipSummaryEntry[];
  readonly limitsReached: readonly LimitName[];
  readonly truncatedDocuments: number;
  readonly lastOutcome: 'pending' | 'success' | 'partial' | 'failed';
  readonly lastErrorCode: IndexErrorCode | undefined;
  readonly lastBuildDurationMs: number | undefined;
}

export interface CorpusChangeWatcher {
  start(onChange: () => void): void;
  close(): void;
}

export interface IndexManagerOptions {
  readonly source: CorpusSource | undefined;
  readonly sourceKind: CorpusSourceKind | 'none';
  readonly corpusLimits: CorpusLimits;
  readonly indexLimits: IndexLimits;
  readonly algorithm: RankingAlgorithm;
  readonly refreshIntervalMs: number;
  readonly watcher?: CorpusChangeWatcher;
  readonly metrics?: MetricsRecorder;
  readonly onEvent?: (event: IndexLifecycleEvent) => void;
}

export interface IndexLifecycleEvent {
  readonly event:
    | 'index.build.started'
    | 'index.build.succeeded'
    | 'index.build.failed'
    | 'index.build.cancelled'
    | 'index.build.unchanged';
  readonly state: IndexState;
  readonly indexVersion: number;
  readonly chunkCount: number;
  readonly documentCount: number;
  readonly durationMs?: number;
  readonly errorCode?: IndexErrorCode;
  readonly limitsReached?: readonly LimitName[];
}

const errorCodeFor = (error: unknown): IndexErrorCode => {
  if (error instanceof CorpusUnavailableError) {
    if (error.reason === 'not_found') return 'corpus_not_found';
    if (error.reason === 'forbidden') return 'corpus_forbidden';
    return 'corpus_unreachable';
  }
  return 'build_failed';
};

const emptySnapshot = (
  sourceKind: CorpusSourceKind | 'none',
  configured: boolean,
): IndexSnapshot => ({
  state: configured ? 'building' : 'failed',
  sourceKind,
  configured,
  indexVersion: 0,
  indexedAt: undefined,
  documentCount: 0,
  chunkCount: 0,
  termCount: 0,
  skippedCount: 0,
  skips: [],
  limitsReached: [],
  truncatedDocuments: 0,
  lastOutcome: configured ? 'pending' : 'failed',
  lastErrorCode: configured ? undefined : 'not_configured',
  lastBuildDurationMs: undefined,
});

/**
 * Owns index freshness. Candidate indexes are built asynchronously and swapped atomically only
 * after they validate; a failed build never discards the last good index.
 */
export class IndexManager {
  private index: LexicalIndex | undefined;
  private state: IndexSnapshot;
  private manifest = '';
  private activeBuild: AbortController | undefined;
  private buildChain: Promise<void> = Promise.resolve();
  private refreshTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private waiters: Array<() => void> = [];
  private readonly metrics: MetricsRecorder;

  public constructor(private readonly options: IndexManagerOptions) {
    this.metrics = options.metrics ?? new NoopMetrics();
    this.state = emptySnapshot(options.sourceKind, options.source !== undefined);
  }

  public snapshot(): IndexSnapshot {
    return this.state;
  }

  public currentIndex(): LexicalIndex | undefined {
    return this.index;
  }

  /** True when the process can answer searches from a validated index. */
  public isUsable(): boolean {
    return (
      this.index !== undefined && ['ready', 'ready_empty', 'degraded'].includes(this.state.state)
    );
  }

  public start(): void {
    if (!this.options.source) return;
    void this.refresh('startup');
    if (this.options.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refresh('interval');
      }, this.options.refreshIntervalMs);
      this.refreshTimer.unref?.();
    }
    this.options.watcher?.start(() => {
      void this.refresh('watch');
    });
  }

  /** Resolves once the first build settles, or after the timeout. */
  public async whenSettled(timeoutMs = 30_000): Promise<IndexSnapshot> {
    if (this.state.lastOutcome !== 'pending') return this.state;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== notify);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const notify = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(notify);
    });
    return this.state;
  }

  public refresh(reason: 'startup' | 'interval' | 'watch' | 'manual'): Promise<void> {
    if (this.closed || !this.options.source) return Promise.resolve();
    this.activeBuild?.abort();
    const controller = new AbortController();
    this.activeBuild = controller;
    this.buildChain = this.buildChain.then(() => this.build(controller, reason));
    return this.buildChain;
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.options.watcher?.close();
    this.activeBuild?.abort();
    await this.buildChain.catch(() => undefined);
    this.settle();
  }

  private settle(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private emit(event: IndexLifecycleEvent): void {
    this.metrics.increment(event.event);
    this.options.onEvent?.(event);
  }

  private async build(
    controller: AbortController,
    reason: 'startup' | 'interval' | 'watch' | 'manual',
  ): Promise<void> {
    const source = this.options.source;
    if (!source || controller.signal.aborted || this.closed) return;

    const startedAt = Date.now();
    this.emit({
      event: 'index.build.started',
      state: this.state.state,
      indexVersion: this.state.indexVersion,
      chunkCount: this.state.chunkCount,
      documentCount: this.state.documentCount,
    });
    if (!this.index) {
      this.state = { ...this.state, state: 'building' };
    }

    const timeout = setTimeout(() => controller.abort(), this.options.indexLimits.buildTimeoutMs);
    timeout.unref?.();

    try {
      if (reason !== 'startup' && (await this.unchanged(controller.signal))) {
        this.emit({
          event: 'index.build.unchanged',
          state: this.state.state,
          indexVersion: this.state.indexVersion,
          chunkCount: this.state.chunkCount,
          documentCount: this.state.documentCount,
        });
        return;
      }

      const ingestion = await ingestCorpus({
        source,
        corpusLimits: this.options.corpusLimits,
        indexLimits: this.options.indexLimits,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();

      const { index, limitsReached } = LexicalIndex.build(ingestion.chunks, {
        algorithm: this.options.algorithm,
        maxTerms: this.options.indexLimits.maxTerms,
      });
      controller.signal.throwIfAborted();

      const allLimits = [...new Set([...ingestion.limitsReached, ...limitsReached])].sort();
      const durationMs = Date.now() - startedAt;

      // Atomic swap: the candidate only becomes visible once it is fully built and validated.
      this.index = index;
      this.manifest = await this.manifestOf(controller.signal).catch(() => this.manifest);
      this.state = {
        state: index.chunkCount === 0 ? 'ready_empty' : 'ready',
        sourceKind: this.options.sourceKind,
        configured: true,
        indexVersion: this.state.indexVersion + 1,
        indexedAt: new Date().toISOString(),
        documentCount: ingestion.documentCount,
        chunkCount: index.chunkCount,
        termCount: index.termCount,
        skippedCount: ingestion.skippedCount,
        skips: ingestion.skips,
        limitsReached: allLimits,
        truncatedDocuments: ingestion.truncatedDocuments,
        lastOutcome: allLimits.length > 0 || ingestion.skippedCount > 0 ? 'partial' : 'success',
        lastErrorCode: undefined,
        lastBuildDurationMs: durationMs,
      };
      this.metrics.observe('index.build.duration', durationMs);
      this.metrics.increment('index.chunks', index.chunkCount);
      this.metrics.increment('index.documents', ingestion.documentCount);
      for (const limit of allLimits) this.metrics.increment(`index.limit.${limit}`);
      this.emit({
        event: 'index.build.succeeded',
        state: this.state.state,
        indexVersion: this.state.indexVersion,
        chunkCount: this.state.chunkCount,
        documentCount: this.state.documentCount,
        durationMs,
        limitsReached: allLimits,
      });
    } catch (error) {
      if (controller.signal.aborted && !this.closed && this.activeBuild !== controller) {
        this.emit({
          event: 'index.build.cancelled',
          state: this.state.state,
          indexVersion: this.state.indexVersion,
          chunkCount: this.state.chunkCount,
          documentCount: this.state.documentCount,
        });
        return;
      }
      const errorCode = controller.signal.aborted ? 'build_failed' : errorCodeFor(error);
      this.state = {
        ...this.state,
        // A failed build keeps serving the last good index instead of dropping evidence.
        state: this.index ? 'degraded' : 'failed',
        lastOutcome: 'failed',
        lastErrorCode: errorCode,
        lastBuildDurationMs: Date.now() - startedAt,
      };
      this.emit({
        event: 'index.build.failed',
        state: this.state.state,
        indexVersion: this.state.indexVersion,
        chunkCount: this.state.chunkCount,
        documentCount: this.state.documentCount,
        durationMs: Date.now() - startedAt,
        errorCode,
      });
    } finally {
      clearTimeout(timeout);
      if (this.activeBuild === controller) this.activeBuild = undefined;
      this.settle();
    }
  }

  /** Bounded freshness probe: metadata only, never content. */
  private async manifestOf(signal: AbortSignal): Promise<string> {
    const source = this.options.source;
    if (!source) return '';
    const digest = createHash('sha256');
    let counted = 0;
    for await (const document of source.list({ signal })) {
      signal.throwIfAborted();
      digest.update(`${document.id}:${document.revision}\n`);
      counted += 1;
      if (counted >= this.options.corpusLimits.maxDocuments) break;
    }
    return digest.digest('hex');
  }

  private async unchanged(signal: AbortSignal): Promise<boolean> {
    if (!this.index || this.manifest === '') return false;
    const manifest = await this.manifestOf(signal);
    return manifest === this.manifest;
  }
}
