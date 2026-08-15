import { evaluate } from '../tests/retrieval/harness.js';

/**
 * Compares ranking algorithms on the committed fixture corpus so the default is chosen from
 * evidence rather than preference. No model and no network are involved.
 *
 * Scores are normalized to a 0..1 share of the evidence a query could attain, so one threshold is
 * meaningful across corpus sizes and across both algorithms.
 */
const thresholds = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];
const algorithms = ['bm25', 'tfidf'] as const;

const rows: string[] = [];

for (const algorithm of algorithms) {
  for (const threshold of thresholds) {
    const report = await evaluate(algorithm, 5, threshold);
    rows.push(
      [
        algorithm.padEnd(6),
        threshold.toFixed(2).padStart(6),
        report.recallAtK.toFixed(3).padStart(6),
        report.meanReciprocalRank.toFixed(3).padStart(6),
        report.meanNdcg.toFixed(3).padStart(6),
        String(report.falsePositives).padStart(3),
        String(report.maxContentCharacters).padStart(6),
        String(report.maxLatencyMs).padStart(4),
      ].join('  '),
    );
  }
}

console.log('algo    thresh  recall     mrr    ndcg   fp   chars    ms');
for (const row of rows) console.log(row);

const detail = await evaluate('bm25', 5);
console.log('\nDefault BM25 configuration, per case:');
for (const outcome of detail.cases) {
  console.log(
    `  ${outcome.id.padEnd(24)} ${outcome.status.padEnd(11)} rr=${outcome.reciprocalRank.toFixed(2)} ${outcome.sources.join(', ')}`,
  );
}
