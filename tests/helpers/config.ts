import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';

export const testConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
  buildConfig(
    envSchema.parse({
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: 'tests/fixtures/corpus',
      CORPUS_WATCH: false,
      ...overrides,
    }),
  );
