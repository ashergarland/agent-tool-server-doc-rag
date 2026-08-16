import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildConfig, envSchema } from '../../src/config/index.js';
import { FileSystemCorpusSource } from '../../src/corpus/filesystem.js';
import { IndexManager } from '../../src/indexing/lifecycle.js';
import type { RankingAlgorithm } from '../../src/indexing/inverted-index.js';
import { DocumentationSearchService, type SearchResponse } from '../../src/search/service.js';

export interface RetrievalCase {
  readonly id: string;
  readonly query: string;
  readonly expectedSources?: readonly string[];
  readonly expectNoMatch?: boolean;
}

export interface CaseOutcome {
  readonly id: string;
  readonly status: SearchResponse['status'];
  readonly sources: readonly string[];
  readonly hit: boolean;
  readonly reciprocalRank: number;
  readonly ndcg: number;
  readonly uniqueSourceRatio: number;
  readonly contentCharacters: number;
  readonly latencyMs: number;
}

export interface EvaluationReport {
  readonly algorithm: RankingAlgorithm;
  readonly cases: readonly CaseOutcome[];
  readonly recallAtK: number;
  readonly meanReciprocalRank: number;
  readonly meanNdcg: number;
  readonly meanUniqueSourceRatio: number;
  readonly maxContentCharacters: number;
  readonly maxLatencyMs: number;
  readonly falsePositives: number;
}

export const fixtureRoot = resolve('tests/fixtures/corpus');

export const loadCases = async (): Promise<readonly RetrievalCase[]> => {
  const raw = await readFile(resolve('tests/fixtures/retrieval-cases.json'), 'utf8');
  return (JSON.parse(raw) as { cases: RetrievalCase[] }).cases;
};

const discountedGain = (relevances: readonly number[]): number =>
  relevances.reduce((total, relevance, position) => total + relevance / Math.log2(position + 2), 0);

/** Deterministic, model-free evaluation over the committed fixture corpus. */
export const evaluate = async (
  algorithm: RankingAlgorithm,
  k = 5,
  minScore?: number,
): Promise<EvaluationReport> => {
  const config = buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: fixtureRoot,
      CORPUS_WATCH: false,
      SEARCH_ALGORITHM: algorithm,
      ...(minScore === undefined ? {} : { SEARCH_MIN_SCORE: minScore }),
    }),
    {},
  );
  const source = new FileSystemCorpusSource({
    rootPath: fixtureRoot,
    limits: config.corpusLimits,
  });
  const index = new IndexManager({
    source,
    sourceKind: 'filesystem',
    corpusLimits: config.corpusLimits,
    indexLimits: config.indexLimits,
    algorithm,
    refreshIntervalMs: 0,
  });
  index.start();
  await index.whenSettled(20_000);
  const service = new DocumentationSearchService(index, config.search);

  const cases = await loadCases();
  const outcomes: CaseOutcome[] = [];
  let falsePositives = 0;

  for (const testCase of cases) {
    const startedAt = Date.now();
    const response = await service.search({ query: testCase.query, limit: k });
    const latencyMs = Date.now() - startedAt;
    const sources = response.results.map((result) => result.source);

    if (testCase.expectNoMatch) {
      if (response.status !== 'no_match') falsePositives += 1;
      outcomes.push({
        id: testCase.id,
        status: response.status,
        sources,
        hit: response.status === 'no_match',
        reciprocalRank: response.status === 'no_match' ? 1 : 0,
        ndcg: response.status === 'no_match' ? 1 : 0,
        uniqueSourceRatio: 1,
        contentCharacters: response.counts.contentCharacters,
        latencyMs,
      });
      continue;
    }

    const expected = new Set(testCase.expectedSources ?? []);
    // Each expected source counts once so repeated sources cannot inflate the gain.
    const credited = new Set<string>();
    const relevances = sources.map((source) => {
      if (!expected.has(source) || credited.has(source)) return 0;
      credited.add(source);
      return 1;
    });
    const firstHit = relevances.indexOf(1);
    const ideal = discountedGain(Array.from({ length: Math.min(expected.size, k) }, () => 1));
    outcomes.push({
      id: testCase.id,
      status: response.status,
      sources,
      hit: firstHit >= 0,
      reciprocalRank: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
      ndcg: ideal === 0 ? 0 : discountedGain(relevances) / ideal,
      uniqueSourceRatio: sources.length === 0 ? 1 : new Set(sources).size / sources.length,
      contentCharacters: response.counts.contentCharacters,
      latencyMs,
    });
  }

  await index.close();

  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

  return {
    algorithm,
    cases: outcomes,
    recallAtK: mean(outcomes.map((outcome) => (outcome.hit ? 1 : 0))),
    meanReciprocalRank: mean(outcomes.map((outcome) => outcome.reciprocalRank)),
    meanNdcg: mean(outcomes.map((outcome) => outcome.ndcg)),
    meanUniqueSourceRatio: mean(outcomes.map((outcome) => outcome.uniqueSourceRatio)),
    maxContentCharacters: Math.max(...outcomes.map((outcome) => outcome.contentCharacters), 0),
    maxLatencyMs: Math.max(...outcomes.map((outcome) => outcome.latencyMs), 0),
    falsePositives,
  };
};
