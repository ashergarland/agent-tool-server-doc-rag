import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import {
  generateTestApiKey,
  runAuthConformance,
  runConfigConformance,
  runHttpConformance,
  runLifecycleConformance,
  runMcpConformance,
  runMetadataConformance,
  runOpenApiConformance,
  runRegistryConformance,
  runRoutingConformance,
  runTransportParity,
} from '@agent-tool-platform/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { capability } from '../../src/capability.js';
import type { DocRagConfig } from '../../src/config/index.js';
import { capabilityManifest } from '../../src/manifest.js';
import type { Services } from '../../src/services/index.js';
import { capabilityTools } from '../../src/tools/definitions.js';
import { capabilityInstructions } from '../../src/tools/guidance.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';
import { createTestStack } from '../helpers/stack.js';

type TestApplication = AgentToolApplication<DocRagConfig, Services>;

const apiKey = generateTestApiKey();
const applications: TestApplication[] = [];
const temporaryRoots: string[] = [];
const readSample = {
  name: 'search_docs',
  input: { query: 'runtime port configuration contract', limit: 3 },
} as const;
let populatedRoot: string;
let emptyRoot: string;

const createRoot = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'doc-rag-platform-'));
  temporaryRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
};

beforeAll(() => {
  populatedRoot = createRoot({
    'runbooks/runtime.md':
      '# Runtime\n\nThe runtime port configuration contract requires PORT to match the listener.',
  });
  emptyRoot = createRoot({});
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.shutdown()));
});

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createApplication = async (
  options: { readonly start?: boolean; readonly corpus?: 'populated' | 'empty' | 'none' } = {},
): Promise<TestApplication> => {
  const corpus = options.corpus ?? 'populated';
  const application = await createAgentToolApplication(capability, {
    logger: createSilentLogger(),
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: apiKey,
      CORPUS_SOURCE: corpus === 'none' ? 'none' : 'filesystem',
      ...(corpus === 'none' ? {} : { DOCS_ROOT: corpus === 'empty' ? emptyRoot : populatedRoot }),
      CORPUS_WATCH: 'false',
    },
    readinessCacheMs: 0,
  });
  applications.push(application);
  if (options.start !== false) {
    await application.start();
    await application.services.index.whenSettled(10_000);
  }
  return application;
};

describe('Platform conformance', () => {
  it('satisfies registry and routing contracts', async () => {
    const stack = await createTestStack(
      new MemoryCorpusSource({
        'runbooks/runtime.md':
          '# Runtime\n\nThe runtime port configuration contract requires PORT to match the listener.',
      }),
    );
    try {
      const registry = createToolRegistry(capabilityTools);
      expect(
        (
          await runRegistryConformance({
            registry,
            services: stack.services,
            invalidInputSample: { name: 'search_docs', input: {} },
          })
        ).failures,
      ).toEqual([]);
      expect(
        runRoutingConformance({
          registry,
          instructions: capabilityInstructions,
        }).failures,
      ).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it('satisfies authentication and configuration contracts', async () => {
    expect((await runAuthConformance()).failures).toEqual([]);
    expect(
      (
        await runConfigConformance({
          serviceName: capabilityManifest.name,
          serviceVersion: capabilityManifest.version,
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies HTTP, MCP, OpenAPI, and transport parity contracts', async () => {
    const application = await createApplication();
    expect(
      (
        await runHttpConformance({
          app: application.http,
          registry: application.registry,
          apiKey,
          readSample: { name: readSample.name, body: readSample.input },
        })
      ).failures,
    ).toEqual([]);
    expect(
      (
        await runMcpConformance({
          createServer: () => application.createStdioServer(),
          registry: application.registry,
          instructions: capabilityInstructions,
          readSample,
        })
      ).failures,
    ).toEqual([]);
    expect(
      runOpenApiConformance({
        document: application.openApiDocument(),
        registry: application.registry,
      }).failures,
    ).toEqual([]);
    expect(
      (
        await runTransportParity({
          app: application.http,
          createMcpServer: () => application.createStdioServer(),
          apiKey,
          samples: [readSample],
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies lifecycle behavior', async () => {
    expect(
      (
        await runLifecycleConformance({
          createApplication: () => createApplication({ start: false }),
        })
      ).failures,
    ).toEqual([]);
  });

  it('publishes truthful repository metadata', async () => {
    const load = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    expect(
      runMetadataConformance({
        server: await load('../../server.json'),
        packageManifest: await load('../../package.json'),
        registryEntry: await load('../../examples/central-registry-entry.json'),
      }).failures,
    ).toEqual([]);
  });
});

describe('corpus readiness', () => {
  it('reports ready only after a useful index exists', async () => {
    const application = await createApplication();
    const report = await application.readiness();
    const ready = await application.http.inject({ method: 'GET', url: '/ready' });

    expect(application.lifecycle.state).toBe('ready');
    expect(report.ready).toBe(true);
    expect(ready.statusCode).toBe(200);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'corpus-index', state: 'ready' }),
    );
  });

  it('keeps an unconfigured live process not-ready and model-visible', async () => {
    const application = await createApplication({ corpus: 'none' });
    const report = await application.readiness();
    const response = await application.services.search.search({
      query: 'runtime port configuration contract',
      limit: 3,
    });
    const health = await application.http.inject({ method: 'GET', url: '/health' });
    const ready = await application.http.inject({ method: 'GET', url: '/ready' });

    expect(application.lifecycle.state).toBe('ready');
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'corpus-index',
        state: 'not_ready',
        detail: 'the documentation corpus is not configured',
      }),
    );
    expect(response.status).toBe('unavailable');
    expect(response.results).toEqual([]);
    expect(response.warnings).toContain('index_not_configured');
  });

  it('does not call an empty corpus useful retrieval readiness', async () => {
    const application = await createApplication({ corpus: 'empty' });
    const report = await application.readiness();
    const response = await application.services.search.search({
      query: 'runtime port configuration contract',
      limit: 3,
    });
    const health = await application.http.inject({ method: 'GET', url: '/health' });
    const ready = await application.http.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'corpus-index',
        state: 'not_ready',
        detail: 'the documentation corpus contains no indexable evidence',
      }),
    );
    expect(response.status).toBe('no_match');
    expect(response.results).toEqual([]);
    expect(response.warnings).toContain('corpus_empty');
  });
});
