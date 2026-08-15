import type { AppConfig } from '../../src/config/index.js';
import type { CorpusSource } from '../../src/corpus/types.js';
import { IndexManager } from '../../src/indexing/lifecycle.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import { DocumentationSearchService } from '../../src/search/service.js';
import { createServices, type Services } from '../../src/services/index.js';
import { testConfig } from './config.js';

export interface TestStack {
  readonly config: AppConfig;
  readonly index: IndexManager;
  readonly services: Services;
  readonly metrics: InMemoryMetrics;
  close(): Promise<void>;
}

/** Builds a started index manager and search service over an injected corpus source. */
export const createTestStack = async (
  source: CorpusSource | undefined,
  overrides: Record<string, unknown> = {},
): Promise<TestStack> => {
  const config = testConfig(overrides);
  const metrics = new InMemoryMetrics();
  const index = new IndexManager({
    source,
    sourceKind: source ? source.kind : 'none',
    corpusLimits: config.corpusLimits,
    indexLimits: config.indexLimits,
    algorithm: config.search.algorithm,
    refreshIntervalMs: config.refreshIntervalMs,
    metrics,
  });
  index.start();
  await index.whenSettled(10_000);
  const services = createServices(
    index,
    new DocumentationSearchService(index, config.search, metrics),
  );
  return {
    config,
    index,
    services,
    metrics,
    close: () => index.close(),
  };
};
