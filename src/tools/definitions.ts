import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
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
  source: z.string(),
  section: z.string().optional(),
  content: z.string(),
  score: z.number().min(0).max(1),
});

export const searchLocalDocsTool = defineTool({
  name: 'search_local_docs',
  title: 'Search local documentation',
  summary: 'Find the most relevant chunks in the configured local documentation index.',
  description:
    'Searches a local TF-IDF vector index and returns only the relevant bounded documentation chunks.',
  kind: 'read',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  outputSchema: z.object({ results: z.array(searchResultSchema) }),
  handler: (input, services) => services.documentation.search(input),
});

export const toolDefinitions = [searchLocalDocsTool] as const satisfies readonly ToolDefinition[];
