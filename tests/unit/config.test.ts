import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

const parse = (values: Record<string, unknown>) => envSchema.parse(values);

describe('configuration', () => {
  it('ignores blank optional values and applies bounded defaults', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: '12345678901234567890123456789012',
      PUBLIC_BASE_URL: '',
      DOCS_ROOT: 'tests/fixtures/corpus',
    });
    expect(config.service.publicBaseUrl).toBeUndefined();
    expect(config.corpus.kind).toBe('filesystem');
    expect(config.search.algorithm).toBe('bm25');
    expect(config.corpusLimits.maxDocuments).toBeGreaterThan(0);
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('rejects disabled production authentication', () => {
    expect(() => buildConfig(parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }), {})).toThrow(
      ConfigurationError,
    );
  });

  it('requires strong API keys', () => {
    expect(() =>
      buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' }), {}),
    ).toThrow('at least 32');
  });

  it('validates chunk bounds', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          CHUNK_MAX_CHARS: 400,
          CHUNK_MIN_CHARS: 400,
        }),
        {},
      ),
    ).toThrow('smaller');
  });

  it('treats an unconfigured corpus as an explicit choice', () => {
    const config = buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'disabled' }), {});
    expect(config.corpus.kind).toBe('none');
  });

  it('requires an absolute dedicated corpus root in production', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'production',
          AUTH_MODE: 'api-key',
          API_KEYS: '12345678901234567890123456789012',
          DOCS_ROOT: './docs',
        }),
        {},
      ),
    ).toThrow('absolute');

    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'production',
          AUTH_MODE: 'api-key',
          API_KEYS: '12345678901234567890123456789012',
          DOCS_ROOT: process.cwd(),
        }),
        {},
      ),
    ).toThrow('dedicated corpus directory');
  });

  it('configures a blob corpus from deployment values only', () => {
    const config = buildConfig(
      parse({
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        CORPUS_SOURCE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT_NAME: 'corpusaccount',
        AZURE_STORAGE_CONTAINER: 'corpus',
        AZURE_STORAGE_PREFIX: 'docs',
      }),
      {},
    );
    expect(config.corpus).toEqual({
      kind: 'azure-blob',
      accountName: 'corpusaccount',
      containerName: 'corpus',
      prefix: 'docs/',
    });
  });

  it('rejects shared-key and SAS credentials for blob corpora', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          CORPUS_SOURCE: 'azure-blob',
          AZURE_STORAGE_ACCOUNT_NAME: 'corpusaccount',
          AZURE_STORAGE_CONTAINER: 'corpus',
        }),
        { AZURE_STORAGE_SAS_TOKEN: 'sv=2024-01-01&sig=redacted' },
      ),
    ).toThrow('managed identity only');
  });

  it('rejects traversal in the blob prefix', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          CORPUS_SOURCE: 'azure-blob',
          AZURE_STORAGE_ACCOUNT_NAME: 'corpusaccount',
          AZURE_STORAGE_CONTAINER: 'corpus',
          AZURE_STORAGE_PREFIX: 'docs/../secrets',
        }),
        {},
      ),
    ).toThrow('relative segments');
  });

  it('requires container configuration for blob corpora', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          CORPUS_SOURCE: 'azure-blob',
          AZURE_STORAGE_ACCOUNT_NAME: 'corpusaccount',
        }),
        {},
      ),
    ).toThrow('AZURE_STORAGE_CONTAINER');
  });
});
