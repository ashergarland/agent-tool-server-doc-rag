import { describe, expect, it } from 'vitest';
import {
  assertConsistentMetadata,
  isPlaceholderEndpoint,
  serverSchema,
} from '../../scripts/metadata-schema.js';

const validServer = {
  name: 'io.github.ashergarland/agent-tool-server-doc-rag',
  description: 'Retrieve bounded evidence from one configured documentation corpus.',
  repository: {
    url: 'https://github.com/ashergarland/agent-tool-server-doc-rag',
    source: 'github' as const,
  },
  version: '0.2.0',
};

describe('metadata validation', () => {
  it('identifies placeholder endpoints by hostname, not substring', () => {
    for (const placeholder of [
      'https://tools.example.com/mcp',
      'https://example.com/mcp',
      'https://api.example.org/mcp',
      'https://replace.invalid/mcp',
      'https://service.test/mcp',
      'https://localhost/mcp',
      'https://tools.localhost:8080/mcp',
      'not-a-url',
    ]) {
      expect(isPlaceholderEndpoint(placeholder), placeholder).toBe(true);
    }

    for (const real of [
      // A real host that merely mentions the placeholder elsewhere in the URL.
      'https://tools.contoso.com/mcp?ref=example.com',
      'https://example.com.contoso.com/mcp',
      'https://mcp.contoso.io/mcp',
    ]) {
      expect(isPlaceholderEndpoint(real), real).toBe(false);
    }
  });

  it('rejects placeholder and insecure remote endpoints', () => {
    expect(
      serverSchema.safeParse({
        ...validServer,
        remotes: [{ type: 'streamable-http', url: 'https://tools.example.com/mcp' }],
      }).success,
    ).toBe(false);

    expect(
      serverSchema.safeParse({
        ...validServer,
        remotes: [{ type: 'streamable-http', url: 'http://tools.contoso.com/mcp' }],
      }).success,
    ).toBe(false);

    expect(
      serverSchema.safeParse({
        ...validServer,
        remotes: [{ type: 'streamable-http', url: 'https://tools.contoso.com/mcp' }],
      }).success,
    ).toBe(true);
  });

  it('accepts metadata that advertises nothing unpublished', () => {
    expect(serverSchema.safeParse(validServer).success).toBe(true);
  });

  it('rejects metadata that contradicts the package manifest', () => {
    const server = serverSchema.parse(validServer);

    expect(() => assertConsistentMetadata(server, { version: '0.1.0' })).toThrow('does not match');
    expect(() =>
      assertConsistentMetadata(
        serverSchema.parse({
          ...validServer,
          packages: [
            {
              registryType: 'npm',
              identifier: 'agent-tool-server-doc-rag',
              version: '0.2.0',
              transport: { type: 'stdio' },
            },
          ],
        }),
        { version: '0.2.0', private: true },
      ),
    ).toThrow('private');
    expect(() =>
      assertConsistentMetadata(server, { version: '0.2.0', private: true }),
    ).not.toThrow();
  });
});
