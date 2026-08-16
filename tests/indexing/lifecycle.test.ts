import { describe, expect, it } from 'vitest';
import { CorpusUnavailableError } from '../../src/corpus/types.js';
import { IndexManager } from '../../src/indexing/lifecycle.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import { testConfig } from '../helpers/config.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';

const config = testConfig();

const manager = (
  source: MemoryCorpusSource | undefined,
  overrides: Partial<ConstructorParameters<typeof IndexManager>[0]> = {},
): IndexManager =>
  new IndexManager({
    source,
    sourceKind: source ? source.kind : 'none',
    corpusLimits: config.corpusLimits,
    indexLimits: config.indexLimits,
    algorithm: 'bm25',
    refreshIntervalMs: 0,
    metrics: new InMemoryMetrics(),
    ...overrides,
  });

describe('index lifecycle', () => {
  it('reports failed and unusable state when no corpus is configured', async () => {
    const index = manager(undefined);
    index.start();
    await index.whenSettled(1_000);

    expect(index.snapshot().state).toBe('failed');
    expect(index.snapshot().lastErrorCode).toBe('not_configured');
    expect(index.isUsable()).toBe(false);
    await index.close();
  });

  it('becomes ready with counts and a version after the first build', async () => {
    const index = manager(new MemoryCorpusSource({ 'a.md': '# A\n\nAlpha content.' }));
    index.start();
    await index.whenSettled(5_000);
    const snapshot = index.snapshot();

    expect(snapshot.state).toBe('ready');
    expect(snapshot.indexVersion).toBe(1);
    expect(snapshot.indexedAt).toBeDefined();
    expect(snapshot.documentCount).toBe(1);
    expect(snapshot.chunkCount).toBeGreaterThan(0);
    expect(index.isUsable()).toBe(true);
    await index.close();
  });

  it('distinguishes an empty corpus from a missing one', async () => {
    const index = manager(new MemoryCorpusSource({}));
    index.start();
    await index.whenSettled(5_000);

    expect(index.snapshot().state).toBe('ready_empty');
    expect(index.isUsable()).toBe(true);
    await index.close();
  });

  it('swaps atomically and retains the last good index when a refresh fails', async () => {
    let failing = false;
    const source = new MemoryCorpusSource(
      { 'a.md': '# A\n\nAlpha content.' },
      {
        listError: () =>
          failing ? new CorpusUnavailableError('corpus gone', 'unreachable') : undefined,
      },
    );
    const index = manager(source);
    index.start();
    await index.whenSettled(5_000);
    const firstVersion = index.snapshot().indexVersion;

    source.replace({ 'a.md': '# A\n\nAlpha content.', 'b.md': '# B\n\nBeta content.' });
    await index.refresh('manual');
    expect(index.snapshot().indexVersion).toBe(firstVersion + 1);
    expect(index.snapshot().documentCount).toBe(2);

    failing = true;
    await index.refresh('manual');
    expect(index.snapshot().state).toBe('degraded');
    expect(index.snapshot().lastOutcome).toBe('failed');
    expect(index.currentIndex()?.chunkCount).toBeGreaterThan(0);
    expect(index.isUsable()).toBe(true);
    await index.close();
  });

  it('skips rebuilding when the corpus manifest is unchanged', async () => {
    const source = new MemoryCorpusSource({ 'a.md': '# A\n\nAlpha content.' });
    const index = manager(source);
    index.start();
    await index.whenSettled(5_000);
    const version = index.snapshot().indexVersion;

    await index.refresh('interval');
    expect(index.snapshot().indexVersion).toBe(version);

    source.replace({ 'a.md': '# A\n\nAlpha content changed.' });
    await index.refresh('interval');
    expect(index.snapshot().indexVersion).toBe(version + 1);
    await index.close();
  });

  it('cancels obsolete builds instead of racing them', async () => {
    const source = new MemoryCorpusSource(
      { 'a.md': '# A\n\nAlpha.', 'b.md': '# B\n\nBeta.' },
      { delayMs: 20 },
    );
    const index = manager(source);
    index.start();
    const first = index.refresh('manual');
    const second = index.refresh('manual');
    await Promise.all([first, second]);
    await index.whenSettled(5_000);

    expect(index.snapshot().state).toBe('ready');
    expect(index.snapshot().indexVersion).toBeLessThanOrEqual(3);
    await index.close();
  });

  it('fails without a usable index when the corpus is unreachable at startup', async () => {
    const index = manager(
      new MemoryCorpusSource(
        {},
        { listError: () => new CorpusUnavailableError('gone', 'forbidden') },
      ),
    );
    index.start();
    await index.whenSettled(5_000);

    expect(index.snapshot().state).toBe('failed');
    expect(index.snapshot().lastErrorCode).toBe('corpus_forbidden');
    expect(index.isUsable()).toBe(false);
    await index.close();
  });
});
