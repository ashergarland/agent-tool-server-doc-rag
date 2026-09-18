import { createHash } from 'node:crypto';
import { rateLimited } from '@agent-tool-platform/runtime/errors';
import type { SearchLimits } from '../config/index.js';
import type { DocumentChunk } from '../indexing/chunking.js';
import type { IndexManager, IndexSnapshot } from '../indexing/lifecycle.js';
import type { ScoredChunk } from '../indexing/inverted-index.js';
import { measureContext } from '../observability/measure.js';
import { NoopMetrics, type MetricsRecorder } from '../observability/metrics.js';

export type SearchStatus = 'ok' | 'no_match' | 'degraded' | 'unavailable';

export type SearchWarning =
  | 'index_building'
  | 'index_not_configured'
  | 'corpus_unreachable'
  | 'corpus_empty'
  | 'stale_index'
  | 'search_deadline_exceeded'
  | 'results_truncated'
  | 'content_truncated'
  | 'document_truncated'
  | 'ingestion_limits_reached'
  | 'weak_evidence';

export interface SearchResultItem {
  readonly id: string;
  readonly source: string;
  readonly section?: string;
  readonly sectionPath: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly score: number;
  readonly truncated: boolean;
}

export interface SearchResponse {
  readonly status: SearchStatus;
  readonly results: readonly SearchResultItem[];
  readonly corpus: {
    readonly sourceKind: IndexSnapshot['sourceKind'];
    readonly indexVersion: number;
    readonly indexedAt?: string;
    readonly documentCount: number;
    readonly chunkCount: number;
  };
  readonly counts: {
    readonly candidates: number;
    readonly returned: number;
    readonly contentCharacters: number;
    readonly approximateTokens: number;
  };
  readonly truncated: boolean;
  readonly limitsReached: readonly string[];
  readonly warnings: readonly SearchWarning[];
}

export interface SearchInput {
  readonly query: string;
  readonly limit: number;
  readonly sourcePrefix?: string;
}

const fingerprint = (content: string): string =>
  createHash('sha256')
    .update(content.toLowerCase().replaceAll(/\s+/gu, ' ').trim().slice(0, 400))
    .digest('hex');

const sectionOf = (chunk: DocumentChunk): string | undefined => chunk.sectionPath.at(-1);
const round = (value: number): number => Number(value.toFixed(4));

const sameSectionPath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((section, index) => section === right[index]);

const mergedResultId = (
  source: string,
  sectionPath: readonly string[],
  startLine: number,
  endLine: number,
  content: string,
): string =>
  createHash('sha256')
    .update('doc-rag-merged-result-v1\0')
    .update(JSON.stringify({ source, sectionPath, startLine, endLine, content }))
    .digest('hex')
    .slice(0, 16);

const mergeAdjacentResult = (
  previous: SearchResultItem,
  chunk: DocumentChunk,
  maxContentChars: number,
): SearchResultItem | undefined => {
  if (
    previous.source !== chunk.source ||
    previous.truncated ||
    chunk.truncated ||
    !sameSectionPath(previous.sectionPath, chunk.sectionPath) ||
    previous.startLine < 1 ||
    chunk.startLine < 1 ||
    previous.endLine < previous.startLine ||
    chunk.endLine < chunk.startLine
  ) {
    return undefined;
  }

  const chunkBeforePrevious = chunk.endLine + 1 === previous.startLine;
  const previousBeforeChunk = previous.endLine + 1 === chunk.startLine;
  if (!chunkBeforePrevious && !previousBeforeChunk) return undefined;

  const content = chunkBeforePrevious
    ? `${chunk.content}\n${previous.content}`
    : `${previous.content}\n${chunk.content}`;
  if (content.length > maxContentChars) return undefined;

  const startLine = Math.min(previous.startLine, chunk.startLine);
  const endLine = Math.max(previous.endLine, chunk.endLine);
  return {
    ...previous,
    id: mergedResultId(previous.source, previous.sectionPath, startLine, endLine, content),
    startLine,
    endLine,
    content,
  };
};

export const selectSearchResults = (
  matches: readonly ScoredChunk[],
  best: number,
  limit: number,
  limits: SearchLimits,
  warnings: Set<SearchWarning>,
): { results: SearchResultItem[]; truncated: boolean } => {
  const relativeFloor = best * limits.relativeCutoff;
  const results: SearchResultItem[] = [];
  const perSource = new Map<string, number>();
  const seen = new Set<string>();
  let budget = limits.maxTotalChars;
  let truncated = false;

  for (const match of matches) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    if (match.score < limits.minScore || match.score < relativeFloor) {
      truncated = truncated || matches.length > results.length;
      break;
    }
    const used = perSource.get(match.chunk.source) ?? 0;
    if (used >= limits.maxResultsPerSource) continue;

    const key = fingerprint(match.chunk.content);
    if (seen.has(key)) continue;

    const previous = results.at(-1);
    if (previous) {
      const merged = mergeAdjacentResult(previous, match.chunk, limits.maxContentChars);
      if (merged) {
        const addedCharacters = merged.content.length - previous.content.length;
        if (addedCharacters <= budget) {
          results[results.length - 1] = {
            ...merged,
            score: Math.max(previous.score, round(match.score)),
          };
          budget -= addedCharacters;
          seen.add(key);
          seen.add(fingerprint(merged.content));
          continue;
        }
      }
    }

    let content = match.chunk.content;
    let contentTruncated = match.chunk.truncated;
    if (content.length > limits.maxContentChars) {
      content = content.slice(0, limits.maxContentChars);
      contentTruncated = true;
      warnings.add('content_truncated');
    }
    if (content.length > budget) {
      content = content.slice(0, Math.max(0, budget));
      contentTruncated = true;
      truncated = true;
      warnings.add('results_truncated');
      if (content.trim().length === 0) break;
    }
    budget -= content.length;
    if (match.chunk.truncated) warnings.add('document_truncated');

    seen.add(key);
    perSource.set(match.chunk.source, used + 1);
    const section = sectionOf(match.chunk);
    results.push({
      id: match.chunk.id,
      source: match.chunk.source,
      ...(section ? { section } : {}),
      sectionPath: match.chunk.sectionPath,
      startLine: match.chunk.startLine,
      endLine: match.chunk.endLine,
      content,
      score: round(match.score),
      truncated: contentTruncated,
    });
    if (budget <= 0) {
      truncated = true;
      warnings.add('results_truncated');
      break;
    }
  }

  if (truncated) warnings.add('results_truncated');
  return { results, truncated };
};

/**
 * Applies retrieval policy on top of the raw lexical index: evidence thresholds, redundancy
 * removal, per-source diversity, output budgets, deadlines, concurrency and queueing.
 */
export class DocumentationSearchService {
  private active = 0;
  private queued = 0;

  public constructor(
    private readonly manager: IndexManager,
    private readonly limits: SearchLimits,
    private readonly metrics: MetricsRecorder = new NoopMetrics(),
  ) {}

  public async search(input: SearchInput): Promise<SearchResponse> {
    this.metrics.increment('search.requests');
    if (this.active >= this.limits.maxConcurrent) {
      if (this.queued >= this.limits.queueLimit) {
        this.metrics.increment('search.queue.rejected');
        throw rateLimited('The search queue is full; retry shortly');
      }
      this.queued += 1;
      this.metrics.increment('search.queued');
      try {
        await this.waitForSlot();
      } finally {
        this.queued -= 1;
      }
    }
    this.active += 1;
    const startedAt = Date.now();
    try {
      return this.execute(input, startedAt);
    } finally {
      this.active -= 1;
      this.metrics.observe('search.duration', Date.now() - startedAt);
    }
  }

  private async waitForSlot(): Promise<void> {
    const deadline = Date.now() + this.limits.timeoutMs;
    while (this.active >= this.limits.maxConcurrent) {
      if (Date.now() > deadline) {
        this.metrics.increment('search.queue.timeout');
        throw rateLimited('The search queue is saturated; retry shortly');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private execute(input: SearchInput, startedAt: number): SearchResponse {
    const snapshot = this.manager.snapshot();
    const index = this.manager.currentIndex();
    const warnings = new Set<SearchWarning>();
    const corpus = {
      sourceKind: snapshot.sourceKind,
      indexVersion: snapshot.indexVersion,
      ...(snapshot.indexedAt ? { indexedAt: snapshot.indexedAt } : {}),
      documentCount: snapshot.documentCount,
      chunkCount: snapshot.chunkCount,
    };

    if (!index || !this.manager.isUsable()) {
      this.metrics.increment('search.unavailable');
      if (!snapshot.configured) warnings.add('index_not_configured');
      else if (snapshot.state === 'building') warnings.add('index_building');
      else if (snapshot.lastErrorCode) warnings.add('corpus_unreachable');
      return this.empty('unavailable', corpus, warnings, snapshot, 0);
    }

    if (snapshot.state === 'degraded') warnings.add('stale_index');
    if (snapshot.limitsReached.length > 0) warnings.add('ingestion_limits_reached');
    if (snapshot.state === 'ready_empty' || snapshot.chunkCount === 0) {
      warnings.add('corpus_empty');
      this.metrics.increment('search.no_match');
      return this.empty(
        snapshot.state === 'degraded' ? 'degraded' : 'no_match',
        corpus,
        warnings,
        snapshot,
        0,
      );
    }

    const limit = Math.min(Math.max(1, input.limit), this.limits.maxResults);
    const outcome = index.search(input.query, {
      limit: this.limits.maxCandidates,
      maxCandidates: this.limits.maxCandidates,
      deadlineMs: startedAt + this.limits.timeoutMs,
      ...(input.sourcePrefix ? { sourcePrefix: input.sourcePrefix } : {}),
    });
    if (outcome.timedOut) {
      warnings.add('search_deadline_exceeded');
      this.metrics.increment('search.deadline_exceeded');
    }

    const best = outcome.matches[0]?.score ?? 0;
    if (outcome.matches.length === 0 || best < this.limits.minScore) {
      warnings.add('weak_evidence');
      this.metrics.increment('search.no_match');
      return this.empty(
        outcome.timedOut || snapshot.state === 'degraded' ? 'degraded' : 'no_match',
        corpus,
        warnings,
        snapshot,
        outcome.candidates,
      );
    }

    const { results, truncated } = selectSearchResults(
      outcome.matches,
      best,
      limit,
      this.limits,
      warnings,
    );
    const measurement = measureContext(results.map((result) => result.content));
    const status: SearchStatus =
      snapshot.state === 'degraded' || outcome.timedOut ? 'degraded' : 'ok';
    this.metrics.increment(status === 'ok' ? 'search.ok' : 'search.degraded');
    this.metrics.increment('search.results', results.length);

    return {
      status,
      results,
      corpus,
      counts: {
        candidates: outcome.candidates,
        returned: results.length,
        contentCharacters: measurement.characters,
        approximateTokens: measurement.approximateTokens,
      },
      truncated,
      limitsReached: snapshot.limitsReached,
      warnings: [...warnings].sort(),
    };
  }

  private empty(
    status: SearchStatus,
    corpus: SearchResponse['corpus'],
    warnings: Set<SearchWarning>,
    snapshot: IndexSnapshot,
    candidates: number,
  ): SearchResponse {
    return {
      status,
      results: [],
      corpus,
      counts: { candidates, returned: 0, contentCharacters: 0, approximateTokens: 0 },
      truncated: false,
      limitsReached: snapshot.limitsReached,
      warnings: [...warnings].sort(),
    };
  }
}
