import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfig, envSchema } from '../../src/config/index.js';
import { FileSystemCorpusSource } from '../../src/corpus/filesystem.js';
import { IndexManager } from '../../src/indexing/lifecycle.js';
import { DocumentationSearchService } from '../../src/search/service.js';

const createService = async (
  root: string,
): Promise<{ readonly index: IndexManager; readonly search: DocumentationSearchService }> => {
  const config = buildConfig(
    envSchema.parse({
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: root,
      CORPUS_WATCH: false,
      CHUNK_MIN_CHARS: 0,
    }),
  );
  const index = new IndexManager({
    source: new FileSystemCorpusSource({ rootPath: root, limits: config.corpusLimits }),
    sourceKind: 'filesystem',
    corpusLimits: config.corpusLimits,
    indexLimits: config.indexLimits,
    algorithm: config.search.algorithm,
    refreshIntervalMs: 0,
  });
  index.start();
  await index.whenSettled(10_000);
  return { index, search: new DocumentationSearchService(index, config.search) };
};

describe('operations runbook benchmark retrieval', () => {
  it('retrieves the required scoped passages with provenance', async () => {
    const service = await createService(resolve('tests/fixtures/benchmark-corpus'));
    try {
      for (const { query, expected } of [
        {
          query: 'runtime PORT configuration contract listener target probe port',
          expected: ['PORT', 'must all agree'],
        },
        {
          query: 'TCP readiness socket semantics HTTP request URL path',
          expected: ['establishes a socket connection', 'does not send an HTTP request'],
        },
        {
          query: 'why health to healthz route rename is not causal for TCP readiness',
          expected: ['/healthz', 'cannot affect that probe'],
        },
      ]) {
        const response = await service.search.search({ query, limit: 3 });
        const first = response.results[0];
        expect(response.status, query).toBe('ok');
        expect(response.results.length, query).toBeGreaterThan(0);
        expect(first?.source, query).toBe('operations-runbook.md');
        expect(first?.startLine, query).toBeGreaterThan(0);
        expect(first?.endLine, query).toBeGreaterThanOrEqual(first?.startLine ?? 0);
        expect(first?.content.length, query).toBeLessThanOrEqual(1_600);
        const normalizedContent = first?.content.replace(/\s+/gu, ' ');
        for (const phrase of expected) expect(normalizedContent, query).toContain(phrase);
      }
    } finally {
      await service.index.close();
    }
  });

  it('reports explicit insufficient context when the corpus lacks the evidence', async () => {
    const service = await createService(resolve('tests/fixtures/benchmark-insufficient-corpus'));
    try {
      const response = await service.search.search({
        query: 'TCP readiness probe PORT healthz route causal evidence',
        limit: 3,
      });

      expect(response.status).toBe('no_match');
      expect(response.results).toEqual([]);
      expect(response.warnings).toContain('weak_evidence');
    } finally {
      await service.index.close();
    }
  });
});
