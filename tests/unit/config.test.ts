import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

const parse = (values: Record<string, unknown>) => envSchema.parse(values);

/** Generated rather than hard-coded, matching what `openssl rand -hex 32` produces. */
const strongApiKey = randomBytes(32).toString('hex');

describe('configuration', () => {
  it('ignores blank optional values and applies bounded defaults', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: strongApiKey,
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

  it('requires API keys to encode enough randomness', () => {
    expect(() =>
      buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' }), {}),
    ).toThrow('64 hex characters');
  });

  it('rejects keys a human could have typed', () => {
    for (const weak of [
      'passwordpasswordpasswordpassword',
      // Long enough to clear a naive length check, and long enough that a base64 reading would
      // have accepted it. Prose contains non-hex letters, so the format contract is decisive.
      'passwordpasswordpasswordpasswordpasswordpassword',
      'correct-horse-battery-staple-correct-horse-battery',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'abcabcabcabcabcabcabcabcabcabcabcabc',
      // Valid hex encoding 32 bytes, but degenerate material.
      'a'.repeat(64),
      'ab'.repeat(32),
      'key-0000000000000000000000000000000000',
    ]) {
      expect(
        () => buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: weak }), {}),
        weak,
      ).toThrow('hex');
    }
  });

  it('accepts generated hex keys, with or without a label', () => {
    // Repeated to catch a label rule that consumes key material for some random draws.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const key = randomBytes(32).toString('hex');
      expect(
        () => buildConfig(parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: key }), {}),
        key,
      ).not.toThrow();
      expect(
        () =>
          buildConfig(
            parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: `prod_${key}` }),
            {},
          ),
        key,
      ).not.toThrow();
    }
  });

  it('rejects well-formed hex that carries too few random bytes', () => {
    expect(() =>
      buildConfig(
        parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'api-key',
          API_KEYS: randomBytes(16).toString('hex'),
        }),
        {},
      ),
    ).toThrow('64 hex characters');
  });

  it('supports rotation with multiple generated keys', () => {
    const keys = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')].join(',');
    const config = buildConfig(
      parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: keys }),
      {},
    );
    expect(config.auth).toMatchObject({ mode: 'api-key' });
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
          API_KEYS: strongApiKey,
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
          API_KEYS: strongApiKey,
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
