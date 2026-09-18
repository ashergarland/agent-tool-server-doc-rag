import type { SearchLimits } from '../../src/config/index.js';
import type { DocumentChunk } from '../../src/indexing/chunking.js';
import type { ScoredChunk } from '../../src/indexing/inverted-index.js';
import {
  selectSearchResults,
  type SearchResultItem,
  type SearchWarning,
} from '../../src/search/service.js';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../helpers/config.js';

const limits: SearchLimits = {
  ...testConfig().search,
  maxContentChars: 8_000,
  maxTotalChars: 16_000,
  maxResultsPerSource: 10,
};

const chunk = (
  id: string,
  startLine: number,
  endLine: number,
  content: string,
  sectionPath: readonly string[] = ['Operations', 'Readiness'],
): DocumentChunk => ({
  id,
  source: 'operations.md',
  sectionPath,
  startLine,
  endLine,
  content,
  revision: 'rev1',
  truncated: false,
});

const scored = (entry: DocumentChunk, score: number): ScoredChunk => ({
  chunk: entry,
  score,
});

const select = (matches: readonly ScoredChunk[]): SearchResultItem[] =>
  selectSearchResults(matches, matches[0]?.score ?? 0, 10, limits, new Set<SearchWarning>())
    .results;

const expectCitationCoverage = (result: SearchResultItem, sourceLines: readonly string[]): void => {
  expect(result.content).toBe(sourceLines.slice(result.startLine - 1, result.endLine).join('\n'));
};

describe('provenance-safe search result merging', () => {
  const sourceLines = [
    '# Operations',
    '## Readiness',
    'Open the configured runtime port.',
    'Establish a TCP socket connection.',
    'Do not infer HTTP route behavior.',
    'Treat a successful connection as process readiness.',
    '## Diagnostics',
    'Inspect the configured probe mode.',
  ];
  const earlier = chunk('1111111111111111', 3, 4, sourceLines.slice(2, 4).join('\n'));
  const later = chunk('2222222222222222', 5, 6, sourceLines.slice(4, 6).join('\n'));

  it('merges source-adjacent chunks in source order with complete provenance', () => {
    const results = select([scored(earlier, 0.9), scored(later, 0.8)]);

    expect(results).toHaveLength(1);
    const merged = results[0]!;
    expect(merged.content).toBe(sourceLines.slice(2, 6).join('\n'));
    expect(merged.startLine).toBe(3);
    expect(merged.endLine).toBe(6);
    expect(merged.sectionPath).toEqual(['Operations', 'Readiness']);
    expect(merged.section).toBe('Readiness');
    expect(merged.id).toMatch(/^[0-9a-f]{16}$/);
    expect(merged.id).not.toBe(earlier.id);
    expect(merged.id).not.toBe(later.id);
    expectCitationCoverage(merged, sourceLines);
  });

  it('orders reverse-ranked adjacent chunks by source position', () => {
    const results = select([scored(later, 0.9), scored(earlier, 0.8)]);

    expect(results).toHaveLength(1);
    const merged = results[0]!;
    expect(merged.content).toBe(sourceLines.slice(2, 6).join('\n'));
    expect(merged.startLine).toBe(3);
    expect(merged.endLine).toBe(6);
    expectCitationCoverage(merged, sourceLines);
  });

  it('does not merge across a section transition', () => {
    const nextSection = chunk('3333333333333333', 7, 8, sourceLines.slice(6, 8).join('\n'), [
      'Operations',
      'Diagnostics',
    ]);
    const results = select([scored(later, 0.9), scored(nextSection, 0.8)]);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.sectionPath)).toEqual([
      ['Operations', 'Readiness'],
      ['Operations', 'Diagnostics'],
    ]);
    expect(results.map((result) => result.id)).toEqual([later.id, nextSection.id]);
  });

  it('does not merge non-adjacent chunks from the same source and section', () => {
    const nonAdjacent = chunk('4444444444444444', 8, 8, sourceLines[7]!);
    const results = select([scored(earlier, 0.9), scored(nonAdjacent, 0.8)]);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.id)).toEqual([earlier.id, nonAdjacent.id]);
  });

  it('keeps merged identity deterministic across retrieval and ranking order', () => {
    const sourceOrdered = select([scored(earlier, 0.9), scored(later, 0.8)])[0]!;
    const reverseRanked = select([scored(later, 0.9), scored(earlier, 0.8)])[0]!;
    const repeated = select([scored(earlier, 0.9), scored(later, 0.8)])[0]!;

    expect(sourceOrdered.id).toBe(reverseRanked.id);
    expect(sourceOrdered.id).toBe(repeated.id);
    expectCitationCoverage(sourceOrdered, sourceLines);
    expectCitationCoverage(reverseRanked, sourceLines);
    expectCitationCoverage(repeated, sourceLines);
  });
});
