import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

describe('OpenAPI generation', () => {
  it('includes every registry tool, probes and the MCP endpoint', () => {
    const document = buildOpenApiDocument(testConfig(), createToolRegistry());
    const paths = document['paths'] as Record<string, Record<string, unknown>>;

    expect(paths['/mcp']).toBeDefined();
    expect(paths['/health']).toBeDefined();
    expect(paths['/ready']).toBeDefined();
    expect(paths['/metrics']).toBeDefined();

    for (const tool of createToolRegistry().list()) {
      const operation = paths[`/tools/${tool.name}`]?.['post'] as Record<string, unknown>;
      expect(operation['operationId']).toBe(tool.name);
      expect(operation['x-openai-isConsequential']).toBe(false);
    }
  });

  it('documents the retrieval-only positioning', () => {
    const document = buildOpenApiDocument(testConfig(), createToolRegistry());
    const info = document['info'] as Record<string, string>;

    expect(info['description']).toContain('does not generate answers');
    expect((document['tags'] as { name: string }[]).map((tag) => tag.name)).toEqual(['read']);
  });
});
