import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { createHttpServer } from '../../src/server/http.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testApiKey } from '../helpers/config.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';
import { createTestStack, type TestStack } from '../helpers/stack.js';

const corpus = {
  'guides/auth.md':
    '# Authentication\n\n## Rotating keys\n\nAdd the replacement secret to API_KEYS and redeploy the revision.',
};

const closeables: Array<{ close(): Promise<void> }> = [];
let stack: TestStack | undefined;

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((value) => value.close()));
  await stack?.close();
  stack = undefined;
});

describe('transport parity', () => {
  it('returns identical evidence through HTTP and MCP', async () => {
    stack = await createTestStack(new MemoryCorpusSource(corpus));
    const registry = createToolRegistry();

    const http = createHttpServer({
      config: stack.config,
      logger: pino({ level: 'silent' }),
      services: stack.services,
      registry,
    });
    closeables.push(http);

    const mcpServer = createMcpServer(stack.config, registry, stack.services, {
      requestId: 'parity',
      principal: 'parity-client',
    });
    const client = new Client({ name: 'parity-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, mcpServer);
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const payload = { query: 'rotate the API key', limit: 3 };
    const httpResponse = await http.inject({
      method: 'POST',
      url: '/tools/search_docs',
      headers: { 'x-api-key': testApiKey },
      payload,
    });
    const mcpResponse = await client.callTool({ name: 'search_docs', arguments: payload });

    expect(httpResponse.statusCode).toBe(200);
    expect(httpResponse.json().result).toEqual(mcpResponse.structuredContent);
  });

  it('publishes the same tool catalogue on every transport', async () => {
    stack = await createTestStack(new MemoryCorpusSource(corpus));
    const registry = createToolRegistry();

    const http = createHttpServer({
      config: stack.config,
      logger: pino({ level: 'silent' }),
      services: stack.services,
      registry,
    });
    closeables.push(http);

    const mcpServer = createMcpServer(stack.config, registry, stack.services, {
      requestId: 'parity',
      principal: 'parity-client',
    });
    const client = new Client({ name: 'parity-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, mcpServer);
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const httpTools = (
      await http.inject({ method: 'GET', url: '/tools', headers: { 'x-api-key': testApiKey } })
    ).json().tools as Array<{ name: string; description: string }>;
    const mcpTools = (await client.listTools()).tools;
    const openApi = (await http.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, unknown>;
    }>();

    expect(httpTools.map((tool) => tool.name)).toEqual(mcpTools.map((tool) => tool.name));
    expect(httpTools[0]?.description).toBe(mcpTools[0]?.description);
    for (const tool of registry.list()) {
      expect(openApi.paths[`/tools/${tool.name}`]).toBeDefined();
    }
  });
});
