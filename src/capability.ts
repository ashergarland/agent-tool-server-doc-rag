import { defineAgentToolCapability } from '@agent-tool-platform/runtime/capability';
import {
  readinessDegraded,
  readinessNotReady,
  readinessReady,
} from '@agent-tool-platform/runtime/lifecycle';
import { docRagCapabilityConfig, type AppConfig } from './config/index.js';
import { createCorpusSource } from './corpus/index.js';
import type { CorpusSource } from './corpus/types.js';
import { FileSystemChangeWatcher } from './corpus/watch.js';
import { IndexManager, type IndexLifecycleEvent } from './indexing/lifecycle.js';
import { capabilityManifest } from './manifest.js';
import { InMemoryMetrics, type MetricsRecorder } from './observability/metrics.js';
import { DocumentationSearchService } from './search/service.js';
import { createServices, type Services } from './services/index.js';
import { capabilityTools } from './tools/definitions.js';
import { capabilityInstructions } from './tools/guidance.js';

export const createIndexManager = (
  config: AppConfig,
  source: CorpusSource | undefined,
  metrics: MetricsRecorder,
  onEvent?: (event: IndexLifecycleEvent) => void,
): IndexManager => {
  const watcher =
    config.corpus.kind === 'filesystem' && config.corpus.watch
      ? new FileSystemChangeWatcher(config.corpus.rootPath)
      : undefined;
  return new IndexManager({
    source,
    sourceKind: config.corpus.kind,
    corpusLimits: config.corpusLimits,
    indexLimits: config.indexLimits,
    algorithm: config.search.algorithm,
    refreshIntervalMs: config.refreshIntervalMs,
    metrics,
    ...(watcher ? { watcher } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
};

const readinessDetail = (state: ReturnType<IndexManager['snapshot']>): string => {
  switch (state.lastErrorCode) {
    case 'not_configured':
      return 'the documentation corpus is not configured';
    case 'corpus_not_found':
      return 'the configured documentation corpus was not found';
    case 'corpus_forbidden':
      return 'the configured documentation corpus is not readable';
    case 'corpus_unreachable':
      return 'the configured documentation corpus is unreachable';
    case 'build_failed':
      return 'the documentation index build failed';
    case undefined:
      return state.state === 'building'
        ? 'the documentation index is building'
        : 'the documentation index is not ready';
  }
};

export const capability = defineAgentToolCapability({
  manifest: capabilityManifest,
  instructions: capabilityInstructions,
  config: docRagCapabilityConfig,
  tools: capabilityTools,

  createServices({ config, logger }): Services {
    const metrics = new InMemoryMetrics();
    const index = createIndexManager(config, createCorpusSource(config), metrics, (event) => {
      logger.info({ ...event }, 'index lifecycle');
    });
    return createServices(index, new DocumentationSearchService(index, config.search, metrics));
  },

  lifecycle: {
    start({ services }): void {
      services.index.start();
    },
    async stop({ services }): Promise<void> {
      await services.index.close();
    },
  },

  readiness: [
    ({ services }) => {
      const snapshot = services.index.snapshot();
      if (snapshot.state === 'degraded' && services.index.isUsable() && snapshot.chunkCount > 0) {
        return readinessDegraded(
          'corpus-index',
          `serving the last validated index with ${snapshot.chunkCount} chunks`,
        );
      }
      if (snapshot.state === 'ready' && services.index.isUsable() && snapshot.chunkCount > 0) {
        return readinessReady(
          'corpus-index',
          `the documentation index is ready with ${snapshot.chunkCount} chunks`,
        );
      }
      if (snapshot.state === 'ready_empty') {
        return readinessNotReady(
          'corpus-index',
          'the documentation corpus contains no indexable evidence',
        );
      }
      return readinessNotReady('corpus-index', readinessDetail(snapshot));
    },
  ],
});
