import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  parseConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

const parse = (values: Record<string, unknown>) => envSchema.parse(values);

describe('capability configuration', () => {
  it('ignores blank optional values and applies bounded defaults', () => {
    const config = parseConfig({
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: 'tests/fixtures/corpus',
    });
    expect(config.corpus.kind).toBe('filesystem');
    expect(config.search.algorithm).toBe('bm25');
    expect(config.corpusLimits.maxDocuments).toBeGreaterThan(0);
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('validates chunk bounds', () => {
    expect(() => buildConfig(parse({ CHUNK_MAX_CHARS: 400, CHUNK_MIN_CHARS: 400 }))).toThrow(
      'smaller',
    );
  });

  it('treats an unconfigured corpus as an explicit not-ready choice', () => {
    expect(buildConfig(parse({})).corpus.kind).toBe('none');
    expect(buildConfig(parse({ CORPUS_SOURCE: 'none' })).corpus.kind).toBe('none');
  });

  it('requires a configured filesystem root', () => {
    expect(() => buildConfig(parse({ CORPUS_SOURCE: 'filesystem' }))).toThrow('requires DOCS_ROOT');
  });

  it('requires an absolute dedicated corpus root in production', () => {
    expect(() => buildConfig(parse({ DOCS_ROOT: './docs' }), true)).toThrow('absolute');
    expect(() => buildConfig(parse({ DOCS_ROOT: process.cwd() }), true)).toThrow(
      'dedicated corpus directory',
    );
    expect(() => buildConfig(parse({ DOCS_ROOT: resolve(process.cwd(), '..') }), true)).toThrow(
      'dedicated corpus directory',
    );
  });

  it('surfaces invalid environment configuration', () => {
    expect(() => parseConfig({ SEARCH_MIN_SCORE: 'outside-the-range' })).toThrow(
      ConfigurationError,
    );
  });
});
