import { describe, expect, it } from 'vitest';
import { ingestCorpus } from '../../src/indexing/ingest.js';
import { testConfig } from '../helpers/config.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';

const config = testConfig();

const ingest = (
  files: Record<string, string>,
  overrides: {
    corpus?: Partial<typeof config.corpusLimits>;
    index?: Partial<typeof config.indexLimits>;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
) =>
  ingestCorpus({
    source: new MemoryCorpusSource(files),
    corpusLimits: { ...config.corpusLimits, ...overrides.corpus },
    indexLimits: { ...config.indexLimits, ...overrides.index },
    ...(overrides.signal ? { signal: overrides.signal } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });

describe('bounded ingestion', () => {
  it('produces deterministic chunks in document order', async () => {
    const first = await ingest({
      'b.md': '# B\n\nBeta content.',
      'a.md': '# A\n\nAlpha content.',
    });
    const second = await ingest({
      'a.md': '# A\n\nAlpha content.',
      'b.md': '# B\n\nBeta content.',
    });

    expect(first.chunks.map((chunk) => chunk.source)).toEqual(['a.md', 'b.md']);
    expect(first.chunks.map((chunk) => chunk.id)).toEqual(second.chunks.map((chunk) => chunk.id));
    expect(first.documentCount).toBe(2);
  });

  it('enforces the document budget', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`doc-${index}.md`, `# Doc ${index}\n\nBody.`]),
    );
    const result = await ingest(files, { corpus: { maxDocuments: 3 } });

    expect(result.documentCount).toBe(3);
    expect(result.limitsReached).toContain('documents');
    expect(result.skips.map((entry) => entry.reason)).toContain('limit_documents');
  });

  it('enforces the total byte budget', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`doc-${index}.md`, 'x'.repeat(500)]),
    );
    const result = await ingest(files, {
      corpus: { maxTotalBytes: 600, maxConcurrentReads: 1 },
    });

    expect(result.totalBytes).toBeLessThanOrEqual(1_100);
    expect(result.limitsReached).toContain('total_bytes');
  });

  it('enforces the chunk budget', async () => {
    const result = await ingest(
      {
        'big.md': Array.from(
          { length: 40 },
          (_, index) => `## Section ${index}\n\nBody ${index}.`,
        ).join('\n\n'),
      },
      { index: { maxChunks: 5, chunkMaxChars: 60, chunkMinChars: 0 } },
    );

    expect(result.chunks.length).toBeLessThanOrEqual(5);
    expect(result.limitsReached).toContain('chunks');
  });

  it('enforces the estimated memory budget', async () => {
    const document = Array.from({ length: 20 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
    const generous = await ingest(
      { 'big.md': document },
      { index: { maxMemoryBytes: 1_048_576, chunkMaxChars: 200, chunkMinChars: 0 } },
    );
    const bounded = await ingest(
      { 'big.md': document },
      { index: { maxMemoryBytes: 700, chunkMaxChars: 200, chunkMinChars: 0 } },
    );

    expect(generous.limitsReached).not.toContain('memory');
    expect(bounded.limitsReached).toContain('memory');
    expect(bounded.chunks.length).toBeLessThan(generous.chunks.length);
  });

  it('enforces the time budget', async () => {
    let clock = 0;
    const result = await ingest(
      { 'a.md': '# A\n\nBody.', 'b.md': '# B\n\nBody.' },
      {
        index: { buildTimeoutMs: 1_000 },
        now: () => {
          clock += 900;
          return clock;
        },
      },
    );

    expect(result.limitsReached).toContain('time');
  });

  it('skips duplicate, empty and unreadable documents without leaking identifiers', async () => {
    const result = await ingest({
      'a.md': '# Same\n\nIdentical content.',
      'b.md': '# Same\n\nIdentical content.',
      'c.md': '   ',
    });

    const reasons = result.skips.map((entry) => entry.reason);
    expect(reasons).toContain('duplicate_content');
    expect(reasons).toContain('empty');
    expect(JSON.stringify(result.skips)).not.toContain('a.md');
    expect(result.skippedCount).toBeGreaterThanOrEqual(2);
  });

  it('is cancellable', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ingest({ 'a.md': '# A\n\nBody.' }, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('reports truncated documents', async () => {
    const result = await ingest(
      { 'long.md': 'word '.repeat(500) },
      { corpus: { maxDocumentBytes: 200 } },
    );

    expect(result.truncatedDocuments).toBe(1);
    expect(result.chunks.every((chunk) => chunk.truncated)).toBe(true);
  });
});
