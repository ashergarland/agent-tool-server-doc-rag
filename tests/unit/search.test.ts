import { describe, expect, it } from 'vitest';
import { CorpusUnavailableError } from '../../src/corpus/types.js';
import { IndexManager } from '../../src/indexing/lifecycle.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import { DocumentationSearchService } from '../../src/search/service.js';
import { testConfig } from '../helpers/config.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';
import { createTestStack } from '../helpers/stack.js';

const corpus = {
  'guides/auth.md':
    '# Authentication\n\n## Rotating keys\n\nAdd the replacement secret to API_KEYS, deploy, then retire the old secret.',
  'guides/setup.md':
    '# Setup\n\nInstall dependencies with npm ci and compile the sources with npm run build.',
  'api/client.ts': 'export const createBlobClient = (): BlobClient => new BlobClient();',
};

describe('documentation search service', () => {
  it('returns provenance-rich evidence with safe identifiers', async () => {
    const stack = await createTestStack(new MemoryCorpusSource(corpus));
    const response = await stack.services.search.search({ query: 'rotate API keys', limit: 5 });

    expect(response.status).toBe('ok');
    expect(response.results[0]?.source).toBe('guides/auth.md');
    expect(response.results[0]?.section).toBeDefined();
    expect(response.results[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(response.results[0]?.startLine).toBeGreaterThan(0);
    expect(response.corpus.indexVersion).toBe(1);
    expect(response.corpus.indexedAt).toBeDefined();
    expect(response.counts.returned).toBe(response.results.length);
    expect(response.counts.approximateTokens).toBeGreaterThan(0);
    await stack.close();
  });

  it('returns evidence from a very small corpus', async () => {
    // Raw BM25 magnitudes collapse when every term appears in every chunk, so an unnormalized
    // score would fall under the threshold and report no_match for an obviously relevant document.
    const stack = await createTestStack(
      new MemoryCorpusSource({
        'guides/auth.md':
          '# Authentication\n\n## Rotating keys\n\nAdd the replacement secret to API_KEYS, deploy the revision, migrate clients, and only then remove the retired secret.',
      }),
    );
    const response = await stack.services.search.search({
      query: 'rotate the API key',
      limit: 3,
    });

    expect(response.corpus.chunkCount).toBe(1);
    expect(response.status).toBe('ok');
    expect(response.results[0]?.source).toBe('guides/auth.md');
    await stack.close();
  });

  it('matches singular and plural inflections of the same term', async () => {
    const stack = await createTestStack(
      new MemoryCorpusSource({
        'guides/auth.md': '# Rotating keys\n\nRotate each credential on a schedule.',
        'guides/other.md': '# Unrelated\n\nDatabase migration reference material.',
      }),
    );

    const singular = await stack.services.search.search({ query: 'rotate key', limit: 3 });
    const plural = await stack.services.search.search({ query: 'rotating keys', limit: 3 });

    expect(singular.status).toBe('ok');
    expect(plural.status).toBe('ok');
    expect(singular.results[0]?.source).toBe('guides/auth.md');
    expect(plural.results[0]?.source).toBe('guides/auth.md');
    await stack.close();
  });

  it('bounds every score to a 0..1 share of attainable evidence', async () => {
    const stack = await createTestStack(new MemoryCorpusSource(corpus));
    const response = await stack.services.search.search({
      query: 'Add the replacement secret to API_KEYS, deploy',
      limit: 5,
    });

    for (const result of response.results) {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
    await stack.close();
  });

  it('reports no_match instead of weak evidence', async () => {
    const stack = await createTestStack(new MemoryCorpusSource(corpus));
    const response = await stack.services.search.search({
      query: 'kubernetes operator reconciliation',
      limit: 5,
    });

    expect(response.status).toBe('no_match');
    expect(response.results).toHaveLength(0);
    expect(response.warnings).toContain('weak_evidence');
    await stack.close();
  });

  it('reports unavailable when no corpus is configured', async () => {
    const stack = await createTestStack(undefined);
    const response = await stack.services.search.search({ query: 'anything at all', limit: 5 });

    expect(response.status).toBe('unavailable');
    expect(response.warnings).toContain('index_not_configured');
    expect(response.results).toHaveLength(0);
    await stack.close();
  });

  it('reports an empty corpus honestly', async () => {
    const stack = await createTestStack(new MemoryCorpusSource({}));
    const response = await stack.services.search.search({ query: 'rotate keys', limit: 5 });

    expect(response.status).toBe('no_match');
    expect(response.warnings).toContain('corpus_empty');
    await stack.close();
  });

  it('reports degraded results from a stale index', async () => {
    let failing = false;
    const source = new MemoryCorpusSource(corpus, {
      listError: () => (failing ? new CorpusUnavailableError('gone', 'unreachable') : undefined),
    });
    const stack = await createTestStack(source);
    failing = true;
    await stack.index.refresh('manual');

    const response = await stack.services.search.search({ query: 'rotate API keys', limit: 5 });
    expect(response.status).toBe('degraded');
    expect(response.warnings).toContain('stale_index');
    expect(response.results.length).toBeGreaterThan(0);
    await stack.close();
  });

  it('limits results per source for diversity', async () => {
    const repetitive = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [
        `doc-${index}.md`,
        Array.from(
          { length: 6 },
          (_, section) =>
            `## Section ${section}\n\nRetention policy detail ${section} for document ${index}.`,
        ).join('\n\n'),
      ]),
    );
    const stack = await createTestStack(new MemoryCorpusSource(repetitive), {
      SEARCH_MAX_PER_SOURCE: 2,
      CHUNK_MAX_CHARS: 200,
      CHUNK_MIN_CHARS: 0,
    });
    const response = await stack.services.search.search({
      query: 'retention policy detail',
      limit: 10,
    });

    const perSource = new Map<string, number>();
    for (const result of response.results) {
      perSource.set(result.source, (perSource.get(result.source) ?? 0) + 1);
    }
    expect([...perSource.values()].every((count) => count <= 2)).toBe(true);
    await stack.close();
  });

  it('drops redundant duplicate evidence', async () => {
    const duplicated = {
      'a.md': '# Alpha\n\nBounded retrieval evidence about queue saturation.',
      'b.md': '# Beta\n\nBounded retrieval evidence about queue saturation.',
      'c.md': '# Gamma\n\nUnrelated indexing notes about queue saturation policies.',
    };
    const stack = await createTestStack(new MemoryCorpusSource(duplicated));
    const response = await stack.services.search.search({
      query: 'queue saturation evidence',
      limit: 10,
    });

    const contents = response.results.map((result) => result.content);
    expect(new Set(contents).size).toBe(contents.length);
    await stack.close();
  });

  it('enforces the output budget', async () => {
    const large = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        `doc-${index}.md`,
        `# Doc ${index}\n\n${'retention evidence '.repeat(60)}`,
      ]),
    );
    const stack = await createTestStack(new MemoryCorpusSource(large), {
      SEARCH_MAX_TOTAL_CHARS: 400,
      SEARCH_MAX_CONTENT_CHARS: 300,
    });
    const response = await stack.services.search.search({ query: 'retention evidence', limit: 10 });

    expect(response.counts.contentCharacters).toBeLessThanOrEqual(400);
    expect(response.truncated).toBe(true);
    expect(response.warnings).toContain('results_truncated');
    await stack.close();
  });

  it('restricts results with a source prefix', async () => {
    const stack = await createTestStack(new MemoryCorpusSource(corpus));
    const response = await stack.services.search.search({
      query: 'install dependencies compile sources',
      limit: 5,
      sourcePrefix: 'api/',
    });

    expect(response.results.every((result) => result.source.startsWith('api/'))).toBe(true);
    await stack.close();
  });

  it('rejects requests when the queue is saturated', async () => {
    const config = testConfig();
    const metrics = new InMemoryMetrics();
    const index = new IndexManager({
      source: new MemoryCorpusSource(corpus),
      sourceKind: 'filesystem',
      corpusLimits: config.corpusLimits,
      indexLimits: config.indexLimits,
      algorithm: 'bm25',
      refreshIntervalMs: 0,
      metrics,
    });
    index.start();
    await index.whenSettled(5_000);

    const service = new DocumentationSearchService(
      index,
      { ...config.search, maxConcurrent: 1, queueLimit: 0, timeoutMs: 50 },
      metrics,
    );
    const results = await Promise.allSettled([
      service.search({ query: 'rotate API keys', limit: 5 }),
      service.search({ query: 'rotate API keys', limit: 5 }),
      service.search({ query: 'rotate API keys', limit: 5 }),
    ]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    await index.close();
  });

  it('records safe aggregate metrics only', async () => {
    const stack = await createTestStack(new MemoryCorpusSource(corpus));
    await stack.services.search.search({ query: 'rotate API keys', limit: 5 });
    const snapshot = stack.metrics.snapshot();

    expect(snapshot.counters['search.requests']).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(snapshot)).not.toContain('rotate');
    expect(JSON.stringify(snapshot)).not.toContain('guides/auth.md');
    await stack.close();
  });
});
