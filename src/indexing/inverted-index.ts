import type { DocumentChunk } from './chunking.js';
import type { LimitName } from './ingest.js';
import { isCompoundTerm, stopWords, tokenize } from './tokenize.js';

export type RankingAlgorithm = 'bm25' | 'tfidf';

export interface IndexBuildOptions {
  readonly algorithm: RankingAlgorithm;
  readonly maxTerms: number;
}

export interface IndexBuildResult {
  readonly index: LexicalIndex;
  readonly limitsReached: readonly LimitName[];
}

export interface LexicalSearchOptions {
  readonly limit: number;
  readonly maxCandidates: number;
  readonly deadlineMs?: number;
  readonly sourcePrefix?: string;
  readonly now?: () => number;
}

export interface ScoredChunk {
  readonly chunk: DocumentChunk;
  readonly score: number;
}

export interface LexicalSearchOutcome {
  readonly matches: readonly ScoredChunk[];
  readonly candidates: number;
  readonly timedOut: boolean;
}

interface Posting {
  readonly chunk: number;
  readonly frequency: number;
}

const sectionWeight = 2.5;
const sourceWeight = 1.5;
const compoundQueryWeight = 2;
const exactPhraseBoost = 1.25;
const bm25K1 = 1.2;
const bm25B = 0.75;
const deadlineCheckInterval = 512;
/** Terms present in more than this share of chunks carry no selective evidence. */
const nonSelectiveDocumentRatio = 0.6;
/** A query with no term below this share of chunks cannot produce real evidence. */
const selectiveDocumentRatio = 0.4;
const nonSelectiveMinimumChunks = 10;

/**
 * Immutable inverted index over one immutable set of chunks. Building and searching never touch the
 * corpus, so an index candidate can be validated before it is swapped in.
 */
export class LexicalIndex {
  private constructor(
    private readonly chunks: readonly DocumentChunk[],
    private readonly postings: ReadonlyMap<string, readonly Posting[]>,
    private readonly documentFrequency: ReadonlyMap<string, number>,
    private readonly lengths: Float64Array,
    private readonly norms: Float64Array,
    private readonly averageLength: number,
    private readonly algorithm: RankingAlgorithm,
    public readonly documentCount: number,
  ) {}

  public get chunkCount(): number {
    return this.chunks.length;
  }

  public get termCount(): number {
    return this.postings.size;
  }

  public static build(
    chunks: readonly DocumentChunk[],
    options: IndexBuildOptions,
  ): IndexBuildResult {
    const postings = new Map<string, Posting[]>();
    const documentFrequency = new Map<string, number>();
    const lengths = new Float64Array(chunks.length);
    const limitsReached = new Set<LimitName>();
    const sources = new Set<string>();

    chunks.forEach((chunk, position) => {
      sources.add(chunk.source);
      const frequencies = new Map<string, number>();
      const add = (text: string, weight: number): void => {
        for (const term of tokenize(text)) {
          frequencies.set(term, (frequencies.get(term) ?? 0) + weight);
        }
      };
      add(chunk.content, 1);
      add(chunk.sectionPath.join(' '), sectionWeight);
      add(chunk.source.replaceAll('/', ' '), sourceWeight);

      let length = 0;
      for (const [term, frequency] of frequencies) {
        if (!postings.has(term) && postings.size >= options.maxTerms) {
          limitsReached.add('terms');
          continue;
        }
        const list = postings.get(term) ?? [];
        list.push({ chunk: position, frequency });
        postings.set(term, list);
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        length += frequency;
      }
      lengths[position] = length;
    });

    const total = chunks.length;
    const averageLength = total === 0 ? 0 : lengths.reduce((sum, value) => sum + value, 0) / total;

    const norms = new Float64Array(total);
    if (options.algorithm === 'tfidf') {
      for (const [term, list] of postings) {
        const idf = Math.log((total + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
        for (const posting of list) {
          const weight = posting.frequency * idf;
          norms[posting.chunk] = (norms[posting.chunk] ?? 0) + weight * weight;
        }
      }
      for (let position = 0; position < total; position += 1) {
        norms[position] = Math.sqrt(norms[position] ?? 0) || 1;
      }
    }

    return {
      index: new LexicalIndex(
        chunks,
        postings,
        documentFrequency,
        lengths,
        norms,
        averageLength,
        options.algorithm,
        sources.size,
      ),
      limitsReached: [...limitsReached],
    };
  }

  public search(query: string, options: LexicalSearchOptions): LexicalSearchOutcome {
    const now = options.now ?? Date.now;
    if (this.chunks.length === 0) return { matches: [], candidates: 0, timedOut: false };

    const queryTerms = new Map<string, number>();
    for (const term of tokenize(query)) {
      const weight = isCompoundTerm(term) ? compoundQueryWeight : 1;
      queryTerms.set(term, (queryTerms.get(term) ?? 0) + weight);
    }
    if (queryTerms.size === 0) return { matches: [], candidates: 0, timedOut: false };

    // Function words never carry evidence on their own, so a query made only of them cannot match.
    const meaningful = [...queryTerms.entries()].filter(([term]) => !stopWords.has(term));
    if (meaningful.length === 0) return { matches: [], candidates: 0, timedOut: false };

    // Rare terms first so the candidate budget is spent on the most selective evidence.
    const ordered = meaningful.sort(
      ([left], [right]) =>
        (this.documentFrequency.get(left) ?? 0) - (this.documentFrequency.get(right) ?? 0),
    );

    const scores = new Map<number, number>();
    const total = this.chunks.length;
    let timedOut = false;
    let visited = 0;
    let queryNorm = 0;

    const selective = ordered.some(([term]) => {
      const frequency = this.documentFrequency.get(term) ?? 0;
      return frequency > 0 && frequency / total <= selectiveDocumentRatio;
    });
    if (total >= nonSelectiveMinimumChunks && !selective) {
      return { matches: [], candidates: 0, timedOut: false };
    }

    for (const [term, weight] of ordered) {
      const list = this.postings.get(term);
      const frequency = this.documentFrequency.get(term) ?? 0;
      if (!list || frequency === 0) continue;
      if (total >= nonSelectiveMinimumChunks && frequency / total > nonSelectiveDocumentRatio) {
        continue;
      }
      const idf =
        this.algorithm === 'bm25'
          ? Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5))
          : Math.log((total + 1) / (frequency + 1)) + 1;
      queryNorm += weight * idf * (weight * idf);

      for (const posting of list) {
        visited += 1;
        if (
          visited % deadlineCheckInterval === 0 &&
          options.deadlineMs &&
          now() > options.deadlineMs
        ) {
          timedOut = true;
          break;
        }
        const chunk = this.chunks[posting.chunk];
        if (!chunk) continue;
        if (options.sourcePrefix && !chunk.source.startsWith(options.sourcePrefix)) continue;
        const existing = scores.get(posting.chunk);
        if (existing === undefined && scores.size >= options.maxCandidates) continue;

        const contribution =
          this.algorithm === 'bm25'
            ? weight *
              idf *
              ((posting.frequency * (bm25K1 + 1)) /
                (posting.frequency +
                  bm25K1 *
                    (1 -
                      bm25B +
                      (bm25B * (this.lengths[posting.chunk] ?? 0)) / (this.averageLength || 1))))
            : weight * idf * posting.frequency * idf;
        scores.set(posting.chunk, (existing ?? 0) + contribution);
      }
      if (timedOut) break;
    }

    const normalizer = this.algorithm === 'tfidf' ? Math.sqrt(queryNorm) || 1 : 1;
    const phrase = query.trim().toLowerCase();

    const matches = [...scores.entries()]
      .map(([position, rawScore]) => {
        const chunk = this.chunks[position];
        const base =
          this.algorithm === 'tfidf'
            ? rawScore / (normalizer * (this.norms[position] ?? 1))
            : rawScore;
        const boosted =
          chunk && phrase.length > 2 && chunk.content.toLowerCase().includes(phrase)
            ? base * exactPhraseBoost
            : base;
        return { chunk, score: boosted };
      })
      .filter((entry): entry is ScoredChunk => entry.chunk !== undefined && entry.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? left.chunk.id.localeCompare(right.chunk.id)
          : right.score - left.score,
      )
      .slice(0, options.limit);

    return { matches, candidates: scores.size, timedOut };
  }
}
