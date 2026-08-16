import type { AppConfig } from '../config/index.js';
import { serverInstructions } from '../tools/guidance.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

type JsonObject = Record<string, unknown>;

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const errorResponses: JsonObject = Object.fromEntries(
  [
    [400, 'Invalid input'],
    [401, 'Missing or invalid credentials'],
    [403, 'Not permitted'],
    [404, 'Unknown tool or resource'],
    [429, 'Rate limited or search queue full'],
    [500, 'Tool server failure'],
    [502, 'Corpus failure'],
    [503, 'No usable index'],
    [504, 'Search deadline exceeded'],
  ].map(([status, description]) => [
    String(status),
    {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  ]),
);

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description: tool.description,
    tags: ['read'],
    'x-openai-isConsequential': false,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

export const buildOpenApiDocument = (config: AppConfig, registry: ToolRegistry): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe. Does not consider index state.',
        security: [],
        responses: { '200': { description: 'Process is alive' } },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness probe. Requires a usable configured index.',
        security: [],
        responses: {
          '200': { description: 'A usable index is serving searches' },
          '503': { description: 'No usable index' },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: { '200': { description: 'Service metadata' } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'Generated OpenAPI document.',
        security: [],
        responses: { '200': { description: 'OpenAPI 3.1 document' } },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List every registered tool, routing instructions and JSON Schema.',
        responses: { '200': { description: 'Tool catalogue' }, ...errorResponses },
      },
    },
    '/metrics': {
      get: {
        operationId: 'metrics',
        summary: 'Safe aggregate index and search counters.',
        responses: { '200': { description: 'Aggregate counters' }, ...errorResponses },
      },
    },
    '/mcp': {
      post: {
        operationId: 'mcp',
        summary: 'Stateless Streamable HTTP MCP endpoint.',
        responses: { '200': { description: 'MCP response' }, ...errorResponses },
      },
    },
  };
  for (const tool of registry.list()) paths[`/tools/${tool.name}`] = toolPath(tool);

  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Tool Server Doc RAG',
      version: config.service.version,
      description: `Bounded lexical documentation retrieval generated from one typed tool registry. ${serverInstructions}`,
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Static API key supplied as a bearer token or x-api-key header.',
        },
      },
    },
    paths,
    tags: [{ name: 'read', description: 'Read-only retrieval tools.' }],
  };
};
