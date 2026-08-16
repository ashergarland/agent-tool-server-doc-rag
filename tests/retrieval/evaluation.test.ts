import { describe, expect, it } from 'vitest';
import { evaluate } from './harness.js';

/**
 * Retrieval quality gates. These run entirely on the committed fixture corpus with no model and no
 * network, so ranking regressions fail in CI instead of in production.
 */
describe('retrieval quality', () => {
  it('meets the ranking gates with the default BM25 configuration', async () => {
    const report = await evaluate('bm25');

    expect(report.recallAtK).toBeGreaterThanOrEqual(0.9);
    expect(report.meanReciprocalRank).toBeGreaterThanOrEqual(0.9);
    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.9);
    expect(report.falsePositives).toBe(0);
    expect(report.meanUniqueSourceRatio).toBeGreaterThanOrEqual(0.9);
    expect(report.maxContentCharacters).toBeLessThanOrEqual(8_000);
    expect(report.maxLatencyMs).toBeLessThanOrEqual(1_000);
  });

  it('keeps quality stable across the whole usable threshold band', async () => {
    // Normalized scores must make one configured threshold meaningful, not knife-edge.
    for (const threshold of [0.1, 0.2, 0.35]) {
      const report = await evaluate('bm25', 5, threshold);
      expect(report.recallAtK, `threshold ${threshold}`).toBeGreaterThanOrEqual(0.9);
      expect(report.falsePositives, `threshold ${threshold}`).toBe(0);
    }
  });

  it('keeps the alternative TF-IDF ranking usable with a calibrated threshold', async () => {
    const report = await evaluate('tfidf', 5, 0.1);

    expect(report.recallAtK).toBeGreaterThanOrEqual(0.9);
    expect(report.falsePositives).toBe(0);
  });

  it('never reports evidence for out-of-corpus questions', async () => {
    const report = await evaluate('bm25');
    const noMatchCases = report.cases.filter((entry) => entry.id.startsWith('no-match'));

    expect(noMatchCases).toHaveLength(3);
    for (const outcome of noMatchCases) {
      expect(outcome.status).toBe('no_match');
      expect(outcome.sources).toHaveLength(0);
    }
  });
});
