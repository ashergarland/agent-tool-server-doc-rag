import { z } from 'zod';
import type { Services } from '../services/index.js';
import { fieldDescriptions, searchDocsDescription } from './guidance.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

const searchResultSchema = z.object({
  id: z.string().min(1).max(64).describe(fieldDescriptions.resultId),
  source: z.string().min(1).max(512).describe(fieldDescriptions.resultSource),
  section: z.string().max(512).optional().describe(fieldDescriptions.resultSection),
  sectionPath: z.array(z.string().max(512)).max(8).describe(fieldDescriptions.resultSectionPath),
  startLine: z.number().int().min(0).max(10_000_000).describe(fieldDescriptions.resultLines),
  endLine: z.number().int().min(0).max(10_000_000).describe(fieldDescriptions.resultLines),
  content: z.string().max(8_000).describe(fieldDescriptions.resultContent),
  score: z.number().min(0).max(1).describe(fieldDescriptions.resultScore),
  truncated: z.boolean().describe(fieldDescriptions.resultTruncated),
});

export const searchDocsOutputSchema = z.object({
  status: z.enum(['ok', 'no_match', 'degraded', 'unavailable']).describe(fieldDescriptions.status),
  results: z.array(searchResultSchema).max(25).describe(fieldDescriptions.results),
  corpus: z
    .object({
      sourceKind: z.enum(['filesystem', 'azure-blob', 'none']),
      indexVersion: z.number().int().min(0).max(1_000_000_000),
      indexedAt: z.string().max(40).optional(),
      documentCount: z.number().int().min(0).max(1_000_000),
      chunkCount: z.number().int().min(0).max(10_000_000),
    })
    .describe(fieldDescriptions.corpus),
  counts: z
    .object({
      candidates: z.number().int().min(0).max(10_000_000),
      returned: z.number().int().min(0).max(25),
      contentCharacters: z.number().int().min(0).max(1_000_000),
      approximateTokens: z.number().int().min(0).max(1_000_000),
    })
    .describe(fieldDescriptions.counts),
  truncated: z.boolean().describe(fieldDescriptions.truncated),
  limitsReached: z.array(z.string().max(40)).max(16).describe(fieldDescriptions.limitsReached),
  warnings: z.array(z.string().max(64)).max(16).describe(fieldDescriptions.warnings),
});

export const searchDocsTool = defineTool({
  name: 'search_docs',
  title: 'Search the configured documentation corpus',
  summary: 'Retrieve the most relevant bounded chunks of the configured documentation corpus.',
  description: searchDocsDescription,
  inputSchema: z.object({
    query: z.string().trim().min(2).max(500).describe(fieldDescriptions.query),
    limit: z.number().int().min(1).max(10).default(5).describe(fieldDescriptions.limit),
    sourcePrefix: z
      .string()
      .trim()
      .max(200)
      .regex(/^[\p{L}\p{N}._\-/]*$/u, 'Prefix may only contain path-safe characters')
      .optional()
      .describe(fieldDescriptions.sourcePrefix),
  }),
  outputSchema: searchDocsOutputSchema,
  handler: async (input, services) => {
    const response = await services.search.search({
      query: input.query,
      limit: input.limit,
      ...(input.sourcePrefix ? { sourcePrefix: input.sourcePrefix } : {}),
    });
    return {
      ...response,
      results: response.results.map((result) => ({
        ...result,
        sectionPath: [...result.sectionPath],
      })),
      limitsReached: [...response.limitsReached],
      warnings: [...response.warnings],
    };
  },
});

export const toolDefinitions = [searchDocsTool] as const satisfies readonly ToolDefinition[];
