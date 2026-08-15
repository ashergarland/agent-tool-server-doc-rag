import { describe, expect, it } from 'vitest';
import { AzureBlobCorpusSource, toCorpusUnavailable } from '../../src/corpus/blob.js';
import { SkipTally, type CorpusDocument } from '../../src/corpus/types.js';
import { testConfig } from '../helpers/config.js';
import { FakeBlobContainerReader } from '../helpers/corpus.js';

const limits = testConfig().corpusLimits;

const collect = async (
  source: AzureBlobCorpusSource,
  skips = new SkipTally(),
): Promise<{ documents: CorpusDocument[]; skips: SkipTally }> => {
  const documents: CorpusDocument[] = [];
  for await (const document of source.list({ skips })) documents.push(document);
  return { documents, skips };
};

describe('azure blob corpus source', () => {
  it('enumerates a paged prefix and returns prefix-relative identifiers', async () => {
    const reader = new FakeBlobContainerReader(
      {
        'docs/guides/setup.md': '# Setup',
        'docs/api/client.ts': 'export const client = 1;',
        'docs/notes/logo.png': 'binary',
        'docs/node_modules/pkg/readme.md': '# Ignored',
        'other/outside.md': '# Outside the prefix',
      },
      { pageSize: 2 },
    );
    const source = new AzureBlobCorpusSource({ prefix: 'docs/', limits, reader });
    const { documents, skips } = await collect(source);

    expect(documents.map((document) => document.id)).toEqual(['api/client.ts', 'guides/setup.md']);
    expect(reader.listedPrefixes).toEqual(['docs/']);
    const reasons = skips.entries().map((entry) => entry.reason);
    expect(reasons).toContain('ignored_path');
    expect(reasons).toContain('unsupported_extension');
  });

  it('bounds downloads and reports truncation without exposing blob names', async () => {
    const reader = new FakeBlobContainerReader({ 'docs/guides/setup.md': 'abcdefghij'.repeat(10) });
    const source = new AzureBlobCorpusSource({ prefix: 'docs/', limits, reader });
    const { documents } = await collect(source);

    const bounded = await source.read(documents[0]!, { maxBytes: 25 });
    expect(bounded?.truncated).toBe(true);
    expect(bounded?.text).toHaveLength(25);
    expect(bounded?.revision).not.toContain('docs/');
  });

  it('skips oversized and empty blobs', async () => {
    const reader = new FakeBlobContainerReader({
      'docs/big.md': 'x'.repeat(4_096),
      'docs/empty.md': '',
      'docs/ok.md': '# Fine',
    });
    const source = new AzureBlobCorpusSource({
      prefix: 'docs/',
      limits: { ...limits, maxDocumentBytes: 1_024 },
      reader,
    });
    const { documents, skips } = await collect(source);

    expect(documents.map((document) => document.id)).toEqual(['ok.md']);
    const reasons = skips.entries().map((entry) => entry.reason);
    expect(reasons).toContain('oversized');
    expect(reasons).toContain('empty');
  });

  it('returns undefined for missing blobs', async () => {
    const reader = new FakeBlobContainerReader(
      { 'docs/ok.md': '# Fine' },
      { missing: ['docs/ok.md'] },
    );
    const source = new AzureBlobCorpusSource({ prefix: 'docs/', limits, reader });
    const { documents } = await collect(source);
    expect(await source.read(documents[0]!, { maxBytes: 100 })).toBeUndefined();
  });

  it('maps storage failures to safe corpus failures', () => {
    expect(toCorpusUnavailable({ statusCode: 403 }).reason).toBe('forbidden');
    expect(toCorpusUnavailable({ statusCode: 404 }).reason).toBe('not_found');
    expect(toCorpusUnavailable(new Error('socket hang up')).reason).toBe('unreachable');
    expect(toCorpusUnavailable({ statusCode: 403 }).message).not.toContain('account');
  });
});
