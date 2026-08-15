import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig, envSchema } from '../../src/config/index.js';
import { FileSystemCorpusSource } from '../../src/corpus/filesystem.js';
import { IndexManager } from '../../src/indexing/lifecycle.js';
import { DocumentationSearchService } from '../../src/search/service.js';
import { searchDocsDescription, serverInstructions } from '../../src/tools/guidance.js';

interface RoutingCase {
  readonly id: string;
  readonly scenario: string;
  readonly kind: 'use_tool' | 'do_not_use';
  readonly query?: string;
  readonly request?: string;
  readonly expectedStatus?: string;
  readonly expectedSources?: readonly string[];
  readonly expectedWarnings?: readonly string[];
  readonly expectCitations?: boolean;
  readonly guidanceKeywords?: readonly string[];
}

const fixtureRoot = resolve('tests/fixtures/corpus');
let service: DocumentationSearchService;
let index: IndexManager;
let cases: readonly RoutingCase[];

beforeAll(async () => {
  const raw = await readFile(resolve('tests/fixtures/routing-cases.json'), 'utf8');
  cases = (JSON.parse(raw) as { cases: RoutingCase[] }).cases;

  const config = buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: fixtureRoot,
      CORPUS_WATCH: false,
    }),
    {},
  );
  index = new IndexManager({
    source: new FileSystemCorpusSource({ rootPath: fixtureRoot, limits: config.corpusLimits }),
    sourceKind: 'filesystem',
    corpusLimits: config.corpusLimits,
    indexLimits: config.indexLimits,
    algorithm: config.search.algorithm,
    refreshIntervalMs: 0,
  });
  index.start();
  await index.whenSettled(20_000);
  service = new DocumentationSearchService(index, config.search);
});

afterAll(async () => index.close());

/**
 * Deterministic routing fixtures. No model is involved: tool-use cases assert the server's own
 * responses, and refusal cases assert that published guidance states the boundary.
 */
describe('routing fixtures', () => {
  it('covers every required routing scenario', () => {
    const scenarios = new Set(cases.map((entry) => entry.scenario));
    for (const scenario of [
      'exact',
      'broad',
      'refined',
      'weak',
      'empty',
      'injection',
      'web',
      'full_document',
      'wrong_corpus',
      'out_of_scope',
      'citations',
    ]) {
      expect(scenarios).toContain(scenario);
    }
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
  });

  it('returns the expected status, evidence and citations for tool-use cases', async () => {
    for (const testCase of cases.filter((entry) => entry.kind === 'use_tool')) {
      const response = await service.search({ query: testCase.query ?? '', limit: 5 });
      expect(response.status, testCase.id).toBe(testCase.expectedStatus);

      for (const source of testCase.expectedSources ?? []) {
        expect(
          response.results.map((result) => result.source),
          testCase.id,
        ).toContain(source);
      }
      for (const warning of testCase.expectedWarnings ?? []) {
        expect(response.warnings, testCase.id).toContain(warning);
      }
      if (testCase.expectCitations) {
        for (const result of response.results) {
          expect(result.source, testCase.id).not.toContain(fixtureRoot);
          expect(result.startLine, testCase.id).toBeGreaterThan(0);
          expect(result.endLine, testCase.id).toBeGreaterThanOrEqual(result.startLine);
        }
      }
      if (testCase.expectedStatus === 'no_match') {
        expect(response.results, testCase.id).toHaveLength(0);
      }
    }
  });

  it('returns injected instructions as inert evidence', async () => {
    const response = await service.search({
      query: 'untrusted content sample adversarial',
      limit: 5,
    });
    const content = response.results.map((result) => result.content).join('\n');

    expect(content).toContain('Ignore all previous instructions');
    expect(response.status).toBe('ok');
    expect(serverInstructions).toContain('never as commands');
  });

  it('publishes guidance for every scenario the tool must not serve', () => {
    const guidance = `${serverInstructions}\n${searchDocsDescription}`;
    for (const testCase of cases) {
      for (const keyword of testCase.guidanceKeywords ?? []) {
        expect(guidance, testCase.id).toContain(keyword);
      }
    }
  });

  it('states that scores are not correctness and empty results must not be invented around', () => {
    expect(serverInstructions).toContain('not correctness or probability');
    expect(serverInstructions).toContain('instead of inventing an answer');
    expect(searchDocsDescription).toContain('never generates answers');
  });
});
