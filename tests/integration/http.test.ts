import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/server/http.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testApiKey } from '../helpers/config.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';
import { createTestStack, type TestStack } from '../helpers/stack.js';

const corpus = {
  'guides/auth.md':
    '# Authentication\n\n## Rotating keys\n\nAdd the replacement secret to API_KEYS and redeploy.',
  'guides/setup.md': '# Setup\n\nInstall dependencies and compile the sources.',
};

const stacks: TestStack[] = [];
const servers: ReturnType<typeof createHttpServer>[] = [];

const server = async (
  files: Record<string, string> | null = corpus,
  overrides: Record<string, unknown> = {},
) => {
  const stack = await createTestStack(
    files === null ? undefined : new MemoryCorpusSource(files),
    overrides,
  );
  stacks.push(stack);
  const app = createHttpServer({
    config: stack.config,
    logger: pino({ level: 'silent' }),
    services: stack.services,
    registry: createToolRegistry(),
    metrics: new InMemoryMetrics(),
  });
  servers.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
});

describe('HTTP API', () => {
  it('separates liveness from readiness', async () => {
    const app = await server();
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().index.state).toBe('ready');
    expect(ready.json().index.chunkCount).toBeGreaterThan(0);
  });

  it('is not ready without a configured corpus', async () => {
    const app = await server(null);
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe('not_ready');
    expect(ready.json().index.lastErrorCode).toBe('not_configured');
  });

  it('is not ready with an empty production corpus', async () => {
    const app = await server({}, { NODE_ENV: 'production', DOCS_ROOT: process.cwd() + '/tests' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json().index.state).toBe('ready_empty');
  });

  it('serves public metadata and request IDs', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'GET',
      url: '/version',
      headers: { 'x-request-id': 'caller-id' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('caller-id');
    expect(response.json().capabilities.transports).toContain('streamable-http');
    expect(response.json().capabilities.corpusSource).toBe('filesystem');
    expect(response.json().capabilities.readOnly).toBe(true);
    expect(response.json().capabilities).not.toHaveProperty('mutationsEnabled');
  });

  it('authenticates protected routes', async () => {
    const app = await server();
    expect((await app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': 'not-the-configured-key-but-long-enough' },
        })
      ).statusCode,
    ).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': testApiKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools).toHaveLength(1);
    expect(response.json().tools[0].name).toBe('search_docs');
    expect(response.json().instructions).toContain('does not generate answers');
  });

  it('accepts bearer tokens of differing lengths in constant time paths', async () => {
    const app = await server();
    const short = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: 'Bearer short' },
    });
    const valid = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: `Bearer ${testApiKey}` },
    });

    expect(short.statusCode).toBe(401);
    expect(valid.statusCode).toBe(200);
  });

  it('rate limits repeated unauthenticated attempts by client IP', async () => {
    const app = await server(corpus, { RATE_LIMIT_MAX: 1 });
    const attempt = (ip: string) =>
      app.inject({ method: 'GET', url: '/tools', headers: { 'x-forwarded-for': ip } });

    expect((await attempt('192.0.2.1')).statusCode).toBe(401);
    expect((await attempt('192.0.2.2')).statusCode).toBe(401);
    expect((await attempt('192.0.2.3')).statusCode).toBe(429);
  });

  it('rate limits principals', async () => {
    const app = await server(corpus, { RATE_LIMIT_MAX: 1 });
    const call = () =>
      app.inject({ method: 'GET', url: '/tools', headers: { 'x-api-key': testApiKey } });

    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
  });

  it('invokes search_docs and maps validation failures', async () => {
    const app = await server();
    const success = await app.inject({
      method: 'POST',
      url: '/tools/search_docs',
      headers: { 'x-api-key': testApiKey },
      payload: { query: 'rotate the API key' },
    });

    expect(success.statusCode).toBe(200);
    expect(success.json().result.status).toBe('ok');
    expect(success.json().result.results[0].source).toBe('guides/auth.md');
    expect(success.json().result.results[0].startLine).toBeGreaterThan(0);

    const invalid = await app.inject({
      method: 'POST',
      url: '/tools/search_docs',
      headers: { 'x-api-key': testApiKey },
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.details.issues).toHaveLength(1);
    expect(invalid.json().error.retryable).toBe(false);
  });

  it('never exposes absolute paths or corpus locations in errors', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/tools/unknown_tool',
      headers: { 'x-api-key': testApiKey },
      payload: { query: 'anything' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(process.cwd());
    expect(response.json().error.requestId).toBeDefined();
  });

  it('exposes safe aggregate metrics behind authentication', async () => {
    const app = await server();
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-api-key': testApiKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('counters');
  });

  it('publishes the generated OpenAPI document', async () => {
    const app = await server();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/tools/search_docs']).toBeDefined();
    expect(response.json().paths['/tools/search_local_docs']).toBeUndefined();
  });

  it('supports development-only disabled authentication', async () => {
    const app = await server(corpus, { AUTH_MODE: 'disabled' });
    expect((await app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(200);
  });
});
