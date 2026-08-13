# Agent Tool Server Doc RAG

Local documentation retrieval for agents exposed through stdio MCP, stateless Streamable HTTP MCP,
and HTTP/OpenAPI. It recursively indexes bounded text and source files at startup, then returns only
the chunks relevant to each query instead of sending complete documentation sets to the agent.

## Included contract

| Method            | Path                | Authentication | Purpose                                 |
| ----------------- | ------------------- | -------------- | --------------------------------------- |
| `GET`             | `/health`           | Public         | Liveness/readiness                      |
| `GET`             | `/version`          | Public         | Build and capability metadata           |
| `GET`             | `/openapi.json`     | Public         | OpenAPI 3.1 generated from the registry |
| `GET`             | `/tools`            | Required       | Tool catalogue and input/output schemas |
| `POST`            | `/tools/{toolName}` | Required       | Invoke one registered tool              |
| `GET/POST/DELETE` | `/mcp`              | Required       | Stateless Streamable HTTP MCP           |

`src/tools/definitions.ts` is the single source of truth. Zod schemas drive runtime input and
output validation, MCP registration, JSON Schema, OpenAPI operations, read/write annotations, and
mutation policy. Do not independently define transport-specific tool lists.

## Architecture

`search_local_docs` accepts a query and an optional result limit (1–10, default 5). Results include
the relative source path, nearest Markdown section, bounded chunk content, and relevance score. The
local adapter uses TF-IDF vectors and cosine similarity, with no external embedding API or data
transfer. Supported files include Markdown, text, JSON, YAML, HTML, and common source code.

```text
HTTP / OpenAPI / MCP transports
             |
       ToolRegistry
             |
          Services
             |
       Provider port
             |
    Local TF-IDF index
```

- Transports contain no provider or product logic.
- Services implement domain behavior and use provider interfaces, never SDK types.
- Provider adapters translate external failures to `AppError`.
- Every transport uses the same `ToolRegistry`.
- Documentation remains local to the configured index.

## Start locally

Node.js 22 is required.

```bash
npm ci
cp .env.example .env
npm run dev
```

The default example uses disabled authentication only in development. For API-key mode, use a
random key of at least 32 characters:

```bash
API_KEY="$(openssl rand -hex 32)"
AUTH_MODE=api-key API_KEYS="$API_KEY" npm run dev
curl -H "x-api-key: $API_KEY" http://localhost:8080/tools
```

Build and run stdio MCP:

```bash
npm run build
npm run mcp:stdio
```

Generate the OpenAPI artifact:

```bash
npm run openapi:emit
```

## Security defaults

- Production refuses `AUTH_MODE=disabled`.
- API keys are compared as fixed-width HMAC digests and only non-reversible fingerprints are
  logged.
- Authentication is rate-limited before and after credential verification.
- Request bodies are limited to 1 MB.
- Caller-provided request IDs are bounded; generated IDs are returned on every response.
- Logger redaction covers authorization and API-key headers.
- Production masks unhandled 5xx details.
- Inputs and outputs are validated at the registry boundary.
- Mutations default off. A preview is always available with `dryRun=true`; execution additionally
  requires deployment enablement and, by default, `confirm=true`.
- The runtime container executes as the unprivileged Node user.
- Stateless MCP creates no server-side session store.

The in-process limiter is appropriate for scale-to-zero instances but is not a globally consistent
quota. Put a distributed gateway in front of the service if callers require a cross-replica quota.

## Configuration

See `.env.example`. Production requires `AUTH_MODE=api-key` and `API_KEYS`. Multiple keys are
comma-separated to support rotation. Keep `MUTATIONS_ENABLED=false` until write tools and provider
roles have been reviewed.

Set `DOCS_PATH` to the local directory or mounted volume to index. `DOCS_CHUNK_SIZE`,
`DOCS_CHUNK_OVERLAP`, and `DOCS_MAX_FILE_SIZE_MB` bound ingestion and returned context. Files larger
than the configured per-file limit and unsupported or symbolic-link entries are ignored. Restart
the server to rebuild the index after documentation changes.

## Deployment

The Azure Container Apps example uses a user-assigned managed identity, Azure Container Registry,
Key Vault references, Log Analytics, Application Insights, scale-to-zero, HTTP scaling, and health
probes. Follow [`docs/deployment.md`](docs/deployment.md); the bootstrap performs a safe two-pass
deployment so no application starts before its Key Vault secret exists.

The deployment is an example, not an implied Azure dependency in the application. Replace or remove
it for another hosting platform.

## Metadata

- `server.json` contains MCP registry metadata.
- `examples/central-registry-entry.json` demonstrates the family registry entry.
- `npm run metadata:validate` validates both local examples.

Check the current upstream registry schema before publishing because external registry contracts
can evolve.

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
docker build -t agent-tool-server-doc-rag .
az bicep build --file infra/main.bicep
az bicep lint --file infra/main.bicep
```

CI additionally smoke-tests the container, compiles every Bicep entry point, audits production
dependencies, scans for secrets, and runs CodeQL.

## License

MIT
