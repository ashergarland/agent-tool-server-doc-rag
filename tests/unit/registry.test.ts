import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors.js';
import { defineTool } from '../../src/tools/definitions.js';
import { createToolRegistry, ToolRegistry } from '../../src/tools/registry.js';
import { MemoryCorpusSource } from '../helpers/corpus.js';
import { createTestStack } from '../helpers/stack.js';

const context = { requestId: 'test', principal: 'tester' };

describe('tool registry', () => {
  it('exposes one read-only tool with bounded schemas', () => {
    const registry = createToolRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual(['search_docs']);

    const [tool] = registry.list();
    expect(tool?.inputJsonSchema['type']).toBe('object');
    expect(JSON.stringify(tool?.outputJsonSchema)).toContain('maxLength');
    expect(tool?.description).toContain('status');
  });

  it('validates input and output', async () => {
    const stack = await createTestStack(new MemoryCorpusSource({ 'a.md': '# A\n\nAlpha.' }));
    await expect(
      createToolRegistry().invoke('search_docs', {}, stack.services, context),
    ).rejects.toMatchObject({ code: 'bad_request' });

    const invalid = defineTool({
      name: 'invalid_output',
      title: 'Invalid',
      summary: 'Invalid',
      description: 'Invalid',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: 'not-a-boolean' }) as never,
    });
    await expect(
      new ToolRegistry([invalid]).invoke('invalid_output', {}, stack.services, context),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await stack.close();
  });

  it('rejects duplicate and unknown tools', () => {
    const definition = createToolRegistry().list()[0]!;
    expect(() => new ToolRegistry([definition as never, definition as never])).toThrow('Duplicate');
    expect(() => createToolRegistry().get('missing')).toThrow(AppError);
  });

  it('returns a complete search envelope through the registry', async () => {
    const stack = await createTestStack(
      new MemoryCorpusSource({ 'guides/auth.md': '# Auth\n\nRotate the API key regularly.' }),
    );
    const result = (await createToolRegistry().invoke(
      'search_docs',
      { query: 'rotate the API key' },
      stack.services,
      context,
    )) as Record<string, unknown>;

    expect(result['status']).toBe('ok');
    expect(result['corpus']).toBeDefined();
    expect(result['counts']).toBeDefined();
    expect(Array.isArray(result['warnings'])).toBe(true);
    await stack.close();
  });
});
