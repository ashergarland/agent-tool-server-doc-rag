import { describe, expect, it } from 'vitest';
import type { DocumentChunk } from '../../src/indexing/chunking.js';
import { LexicalIndex } from '../../src/indexing/inverted-index.js';
import { isCompoundTerm, normalizeSuffix, tokenize } from '../../src/indexing/tokenize.js';

const chunk = (
  id: string,
  source: string,
  content: string,
  sectionPath: string[] = [],
): DocumentChunk => ({
  id,
  source,
  sectionPath,
  startLine: 1,
  endLine: 5,
  content,
  revision: 'rev1',
  truncated: false,
});

describe('tokenization', () => {
  it('expands identifier variants while keeping the whole identifier', () => {
    // "create" also contributes its stem so "creating a blob client" matches the same code.
    expect(tokenize('createBlobClient')).toEqual([
      'createblobclient',
      'create',
      'creat',
      'blob',
      'client',
    ]);
    expect(tokenize('max_file_bytes')).toContain('max');
    expect(tokenize('max_file_bytes')).toContain('bytes');
    expect(tokenize('guides/getting-started.md')).toContain('guides/getting-started.md');
    expect(tokenize('guides/getting-started.md')).toContain('started');
    expect(tokenize('sha256')).toEqual(['sha256', 'sha', '256']);
  });

  it('marks compound identifiers', () => {
    expect(isCompoundTerm('guides/setup.md')).toBe(true);
    expect(isCompoundTerm('setup')).toBe(false);
  });
});

describe('lexical index', () => {
  const chunks = [
    chunk('1', 'guides/auth.md', 'Rotate the API key and redeploy the revision.', [
      'Authentication',
    ]),
    chunk('2', 'guides/setup.md', 'Install dependencies and compile the sources.', ['Setup']),
    chunk('3', 'api/client.ts', 'export const createBlobClient = () => new BlobClient();'),
  ];

  it('ranks the most relevant chunk first', () => {
    const { index } = LexicalIndex.build(chunks, { algorithm: 'bm25', maxTerms: 10_000 });
    const outcome = index.search('rotate api key', { limit: 5, maxCandidates: 100 });

    expect(outcome.matches[0]?.chunk.id).toBe('1');
    expect(outcome.matches[0]?.score).toBeGreaterThan(0);
  });

  it('matches identifiers through case variants', () => {
    const { index } = LexicalIndex.build(chunks, { algorithm: 'bm25', maxTerms: 10_000 });

    expect(
      index.search('createBlobClient', { limit: 3, maxCandidates: 50 }).matches[0]?.chunk.id,
    ).toBe('3');
    expect(index.search('blob client', { limit: 3, maxCandidates: 50 }).matches[0]?.chunk.id).toBe(
      '3',
    );
  });

  it('boosts heading and source matches', () => {
    const { index } = LexicalIndex.build(chunks, { algorithm: 'bm25', maxTerms: 10_000 });
    const outcome = index.search('authentication', { limit: 5, maxCandidates: 50 });

    expect(outcome.matches[0]?.chunk.id).toBe('1');
  });

  it('normalizes common inflections while keeping exact terms', () => {
    expect(normalizeSuffix('keys')).toBe('key');
    expect(normalizeSuffix('deployed')).toBe('deploy');
    expect(normalizeSuffix('policies')).toBe('policy');
    // Related inflections must converge on one stem so either phrasing matches.
    expect(normalizeSuffix('rotating')).toBe('rotat');
    expect(normalizeSuffix('rotate')).toBe('rotat');
    expect(normalizeSuffix('rotates')).toBe('rotat');
    // Short, numeric and ambiguous terms are left alone so identifiers stay exact.
    expect(normalizeSuffix('key')).toBeUndefined();
    expect(normalizeSuffix('sha256')).toBeUndefined();
    expect(normalizeSuffix('access')).toBeUndefined();
    expect(tokenize('keys')).toContain('keys');
    expect(tokenize('keys')).toContain('key');
  });

  it('normalizes scores to a bounded share of attainable evidence', () => {
    const { index } = LexicalIndex.build(chunks, { algorithm: 'bm25', maxTerms: 10_000 });
    const outcome = index.search('rotate the API key and redeploy the revision', {
      limit: 5,
      maxCandidates: 50,
    });

    expect(outcome.matches[0]?.score).toBeGreaterThan(0);
    for (const match of outcome.matches) expect(match.score).toBeLessThanOrEqual(1);
  });

  it('keeps scores comparable regardless of corpus size', () => {
    const single = LexicalIndex.build([chunks[0]!], { algorithm: 'bm25', maxTerms: 10_000 }).index;
    const many = LexicalIndex.build(
      [
        ...chunks,
        ...Array.from({ length: 40 }, (_, position) =>
          chunk(`f${position}`, `filler-${position}.md`, 'unrelated filler prose about nothing'),
        ),
      ],
      { algorithm: 'bm25', maxTerms: 10_000 },
    ).index;

    const smallScore = single.search('rotate api key', { limit: 1, maxCandidates: 50 }).matches[0]
      ?.score;
    const largeScore = many.search('rotate api key', { limit: 1, maxCandidates: 50 }).matches[0]
      ?.score;

    // A one-chunk corpus must not score near zero purely because inverse document frequency
    // collapses when every term appears in every chunk.
    expect(smallScore).toBeGreaterThan(0.2);
    expect(largeScore).toBeGreaterThan(0.2);
  });

  it('supports a source prefix filter', () => {
    const { index } = LexicalIndex.build(chunks, { algorithm: 'bm25', maxTerms: 10_000 });
    const outcome = index.search('compile sources install', {
      limit: 5,
      maxCandidates: 50,
      sourcePrefix: 'api/',
    });

    expect(outcome.matches).toHaveLength(0);
  });

  it('breaks ties deterministically', () => {
    const identical = [
      chunk('bbb', 'a.md', 'identical evidence text'),
      chunk('aaa', 'b.md', 'identical evidence text'),
    ];
    const { index } = LexicalIndex.build(identical, { algorithm: 'bm25', maxTerms: 10_000 });
    const first = index.search('identical evidence', { limit: 5, maxCandidates: 50 });
    const second = index.search('identical evidence', { limit: 5, maxCandidates: 50 });

    expect(first.matches.map((match) => match.chunk.id)).toEqual(['aaa', 'bbb']);
    expect(second.matches.map((match) => match.chunk.id)).toEqual(['aaa', 'bbb']);
  });

  it('bounds the candidate set', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      chunk(`c${index}`, `doc-${index}.md`, 'shared evidence token'),
    );
    const { index } = LexicalIndex.build(many, { algorithm: 'bm25', maxTerms: 10_000 });
    const outcome = index.search('shared evidence', { limit: 5, maxCandidates: 10 });

    expect(outcome.candidates).toBeLessThanOrEqual(10);
    expect(outcome.matches.length).toBeLessThanOrEqual(5);
  });

  it('enforces the vocabulary limit', () => {
    const { limitsReached } = LexicalIndex.build(chunks, { algorithm: 'bm25', maxTerms: 3 });
    expect(limitsReached).toContain('terms');
  });

  it('honours a deadline', () => {
    // Enough postings on a selective term to reach the periodic deadline check.
    const many = Array.from({ length: 2_000 }, (_, index) =>
      chunk(
        `c${index}`,
        `doc-${index}.md`,
        index < 600 ? 'alpha evidence token repeated often' : 'beta unrelated filler content',
      ),
    );
    const { index } = LexicalIndex.build(many, { algorithm: 'bm25', maxTerms: 100_000 });
    const outcome = index.search('alpha', {
      limit: 5,
      maxCandidates: 2_000,
      deadlineMs: Date.now() - 1,
    });

    expect(outcome.timedOut).toBe(true);
  });

  it('returns nothing for queries made only of function words', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      chunk(`c${index}`, `doc-${index}.md`, `The quick document number ${index} of the corpus.`),
    );
    const { index } = LexicalIndex.build(many, { algorithm: 'bm25', maxTerms: 100_000 });

    expect(index.search('the and of', { limit: 5, maxCandidates: 100 }).matches).toHaveLength(0);
  });

  it('supports the alternative tfidf ranking', () => {
    const { index } = LexicalIndex.build(chunks, { algorithm: 'tfidf', maxTerms: 10_000 });
    const outcome = index.search('rotate api key', { limit: 5, maxCandidates: 100 });

    expect(outcome.matches[0]?.chunk.id).toBe('1');
    expect(outcome.matches[0]?.score).toBeLessThanOrEqual(2);
  });
});
