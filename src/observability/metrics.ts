/**
 * Safe aggregate counters. Values are never keyed by query text, document content, absolute paths,
 * or storage identity, so a snapshot can be logged or exposed without leaking corpus data.
 *
 * This module is deliberately independent of ranking, corpus and transport code so it can be
 * extracted into a shared measurement package later.
 */
export interface MetricsRecorder {
  increment(name: string, value?: number): void;
  observe(name: string, milliseconds: number): void;
  snapshot(): MetricsSnapshot;
}

export interface DurationSummary {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly durations: Readonly<Record<string, DurationSummary>>;
}

const maxSeries = 200;

export class InMemoryMetrics implements MetricsRecorder {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  public increment(name: string, value = 1): void {
    if (!this.counters.has(name) && this.counters.size >= maxSeries) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public observe(name: string, milliseconds: number): void {
    let summary = this.durations.get(name);
    if (!summary) {
      if (this.durations.size >= maxSeries) return;
      summary = { count: 0, totalMs: 0, maxMs: 0 };
      this.durations.set(name, summary);
    }
    summary.count += 1;
    summary.totalMs += milliseconds;
    summary.maxMs = Math.max(summary.maxMs, milliseconds);
  }

  public snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(
        [...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      durations: Object.fromEntries(
        [...this.durations.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, summary]) => [name, { ...summary }]),
      ),
    };
  }
}

export class NoopMetrics implements MetricsRecorder {
  public increment(): void {}
  public observe(): void {}
  public snapshot(): MetricsSnapshot {
    return { counters: {}, durations: {} };
  }
}
