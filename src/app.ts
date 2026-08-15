import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/index.js';
import { createCorpusSource } from './corpus/index.js';
import type { CorpusSource } from './corpus/types.js';
import { FileSystemChangeWatcher } from './corpus/watch.js';
import { IndexManager, type IndexLifecycleEvent } from './indexing/lifecycle.js';
import { InMemoryMetrics, type MetricsRecorder } from './observability/metrics.js';
import { DocumentationSearchService } from './search/service.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createServices, type Services } from './services/index.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly metrics: MetricsRecorder;
  readonly http: HttpServer;
  close(): Promise<void>;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  /** Overrides corpus construction in tests. `null` models a deployment with no corpus. */
  readonly corpusSource?: CorpusSource | null;
  readonly metrics?: MetricsRecorder;
  readonly autoStart?: boolean;
}

export const createIndexManager = (
  config: AppConfig,
  source: CorpusSource | undefined,
  metrics: MetricsRecorder,
  logger?: Logger,
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
    ...(logger
      ? {
          onEvent: (event: IndexLifecycleEvent) => {
            logger.info({ ...event }, 'index lifecycle');
          },
        }
      : {}),
  });
};

export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const metrics = options.metrics ?? new InMemoryMetrics();
  const source =
    options.corpusSource === undefined
      ? createCorpusSource(config)
      : (options.corpusSource ?? undefined);

  const index = createIndexManager(config, source, metrics, logger);
  const services = createServices(
    index,
    new DocumentationSearchService(index, config.search, metrics),
  );
  const registry = createToolRegistry();
  const http = createHttpServer({ config, logger, services, registry, metrics });

  if (options.autoStart !== false) index.start();

  return {
    config,
    logger,
    services,
    registry,
    metrics,
    http,
    async close() {
      await http.close();
      await index.close();
    },
  };
};
