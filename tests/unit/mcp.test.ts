import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { serverInstructions } from '../../src/tools/guidance.js';
import { testConfig } from '../helpers/config.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';
import { createTestStack } from '../helpers/stack.js';

const closeables: { close(): Promise<void> }[] = [];

afterEach(async () => Promise.all(closeables.splice(0).map((value) => value.close())));

describe('MCP adapter', () => {
  it('publishes instructions, read-only annotations and the shared registry', async () => {
    const stack = await createTestStack(
      new MemoryCorpusSource({ 'guides/auth.md': '# Auth\n\nRotate the API key regularly.' }),
    );
    closeables.push(stack);
    const server = createMcpServer(testConfig(), createToolRegistry(), stack.services, {
      requestId: 'mcp-test',
      principal: 'test-client',
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getInstructions()).toBe(serverInstructions);

    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === 'search_docs');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.openWorldHint).toBe(false);

    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'rotate the API key' },
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { status: string }).status).toBe('ok');

    const failure = await client.callTool({ name: 'search_docs', arguments: {} });
    expect(failure.isError).toBe(true);
  });
});
