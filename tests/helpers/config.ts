import { randomBytes } from 'node:crypto';
import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';

/**
 * Generated per test process rather than hard-coded. Configuration rejects low-entropy keys, and
 * committing a realistic-looking literal would be both a bad example and secret-scanner noise.
 */
export const testApiKey = randomBytes(32).toString('hex');

export const testConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: testApiKey,
      RATE_LIMIT_MAX: 120,
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: 'tests/fixtures/corpus',
      CORPUS_WATCH: false,
      ...overrides,
    }),
    {},
  );
